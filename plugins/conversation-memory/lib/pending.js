// 待办状态机：LLM 自定过期时间；到期自动消失（不注入）。
// 像「记着明天问一下」——到点就忘，不靠模型每次维护。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';

const FILE = path.join(DATA_DIR, 'pending-todos.json');
const MAX = 40;

function read() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.todos) ? j.todos : [];
  } catch {
    return [];
  }
}

function write(todos) {
  // 顺手清掉过期
  const now = Date.now();
  const alive = todos.filter((t) => !t.expiresAt || Number(t.expiresAt) > now).slice(-MAX);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, todos: alive }, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
  return alive;
}

/**
 * 保存待办。expireInMinutes 由模型填（默认 120，上限 7 天）。
 */
export function saveTodo({ chatKey, text, expireInMinutes = 120, userId = '', note = '' }) {
  const body = String(text || '').trim().slice(0, 100);
  if (!body) return { ok: false, error: '待办内容不能为空' };
  let mins = Number(expireInMinutes);
  if (!Number.isFinite(mins) || mins <= 0) mins = 120;
  mins = Math.min(7 * 24 * 60, Math.round(mins));
  const now = Date.now();
  const todos = read();
  const uid = String(userId || '').replace(/^-?\d{5,15}$/, (m) => String(Math.abs(Number(m))));
  const fixedUid = /^\d{1,15}$/.test(uid) ? uid : '';
  // 同会话同文去重，刷新过期时间
  const key = `${chatKey}|${body.toLowerCase()}`;
  const existing = todos.find((t) => `${t.chatKey}|${String(t.text).toLowerCase()}` === key);
  if (existing) {
    existing.expiresAt = now + mins * 60000;
    existing.updatedAt = now;
    existing.note = String(note || '').slice(0, 80);
    if (fixedUid) existing.userId = fixedUid;
    write(todos);
    return { ok: true, todo: existing, deduped: true };
  }
  const todo = {
    id: `t${now.toString(36)}`,
    chatKey: String(chatKey || ''),
    userId: fixedUid,
    text: body,
    note: String(note || '').slice(0, 80),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + mins * 60000,
    expireInMinutes: mins
  };
  todos.push(todo);
  write(todos);
  return { ok: true, todo };
}

export function completeTodo({ chatKey, text }) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return false;
  const todos = read();
  const next = todos.filter((t) => {
    if (chatKey && t.chatKey && t.chatKey !== chatKey) return true;
    return String(t.text || '').toLowerCase() !== key;
  });
  if (next.length === todos.length) return false;
  write(next);
  return true;
}

/**
 * 未过期的待办。
 * @param {string|null} chatKey 会话过滤
 * @param {string[]} personIds 本轮触发里出现的 QQ 号——绑人的待办优先
 */
export function activeTodos({ chatKey = null, limit = 4, personIds = [] } = {}) {
  const now = Date.now();
  const people = new Set((personIds || []).map(String).filter(Boolean));
  return read()
    .filter((t) => {
      if (t.expiresAt && t.expiresAt <= now) return false;
      if (chatKey && t.chatKey && t.chatKey !== chatKey) return false;
      // 绑了人的待办：只有该人出现在本轮才注入
      if (t.userId && people.size && !people.has(String(t.userId))) return false;
      if (t.userId && people.size === 0) return false;
      return true;
    })
    .sort((a, b) => {
      const ap = a.userId && people.has(String(a.userId)) ? 0 : 1;
      const bp = b.userId && people.has(String(b.userId)) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return (a.expiresAt || 0) - (b.expiresAt || 0);
    })
    .slice(0, Math.max(1, limit))
    .map((t) => ({
      text: t.text,
      userId: t.userId || '',
      leftMin: Math.max(0, Math.round(((t.expiresAt || 0) - now) / 60000)),
      note: t.note || ''
    }));
}

export function renderTodosForPrompt(chatKey, { max = 3, personIds = [] } = {}) {
  const list = activeTodos({ chatKey, limit: max, personIds });
  if (!list.length) return '';
  const lines = list.map((t) => {
    const who = t.userId ? `@${t.userId}` : '';
    return `- ${who}${t.text}${t.leftMin <= 60 ? `（约${t.leftMin}分后忘）` : ''}`;
  });
  return `【未完待办·会自动过期】\n${lines.join('\n')}\n（记得就去办；到点没办完也会忘，别一直挂着）`;
}
