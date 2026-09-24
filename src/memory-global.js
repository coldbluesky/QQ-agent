// ─────────────────────────────────────────────────────────────
// 跨群聊长期记忆（memory-global）
//
// 这是三层记忆里的第三层：
//   1) store.js          → 原始聊天记录（ChatStore，按会话分文件）
//   2) memory.js         → 每个会话一份的「群友印象」（局部记忆，原地保留）
//   3) memory-global.js  → 跨群统一人物档案 + 长期事件/话题（本文件，全局记忆）
//
// 目录结构：
//   data/memory/_global/people/<QQ>.json   一个人一份，跨所有群/私聊
//   data/memory/_global/events.json        长期事件：约定 / 梗 / 恩怨 / 长期话题
//   data/memory/_global/_meta.json         维护时间戳（衰减、跨群整理）
//
// 设计要点（都是为了"能长期跑下去而不烂掉"）：
//   * 写入是"写穿"的 —— memory.js 记印象时同步镜像到人物档案，两个视图不会分叉。
//   * 遗忘曲线不是定时"扣分"，而是读取时按半衰期实时折算（effectiveWeight）；
//     定期维护只负责淘汰已经淡到阈值以下的条目 —— 少写盘、可解释、可回滚。
//   * 半衰期随 importance 放大：随口一提的小事 30 天衰减一半，
//     重要约定/雷点（importance 4~5）能活几个月，pinned 的永不过期。
//   * 跨群可见性有闸门：私聊学到的东西默认不进群；单个会话可拉黑（crossGroupExclude）。
//   * 全部 fs 操作都吞异常 —— 记忆是锦上添花，绝不能把聊天主流程带崩。
// ─────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { currentMemoryKey } from './persona-store.js';
import { writeJsonAtomic } from './util.js';

// 默认（未跟随人设时）的跨群目录。实际使用中由 #ensureRoot() 按当前人设覆盖。
export const GLOBAL_DIR = path.join(DATA_DIR, 'memory', '_global');
const PEOPLE_DIR = path.join(GLOBAL_DIR, 'people');
const EVENTS_FILE = path.join(GLOBAL_DIR, 'events.json');
const META_FILE = path.join(GLOBAL_DIR, '_meta.json');

/** 事件类别：约定、梗、恩怨、长期话题、长期偏好、普通事件。 */
export const EVENT_KINDS = ['event', 'topic', 'promise', 'joke', 'grudge', 'preference'];
const DEFAULT_KIND = 'event';

const DAY_MS = 86400000;

// ── 小工具 ────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    writeJsonAtomic(file, value, 1);
    return true;
  } catch (error) {
    console.warn('[memory-global] 写盘失败:', error?.message ?? error);
    return false;
  }
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** QQ 号白名单化：只接受纯数字，挡住路径穿越与原型污染。 */
export function safeUserId(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(s)) return '';
  return s;
}

/** 会话 key 白名单化（group:123 / private:456）。 */
function safeChatKey(value) {
  const s = String(value ?? '').trim();
  return /^(group|private):\d{1,15}$/.test(s) ? s : '';
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 文本归一化：用于去重比较（去掉空白与标点、统一小写）。 */
function normText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、,.!?;:：；"'“”‘’（）()\[\]【】~～…—-]/g, '')
    .slice(0, 400);
}

/** 会话 key 的默认显示名（没有 onebot 名字表时的兜底）。 */
export function chatLabel(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '未知会话');
}

function formatAgo(ts, now = Date.now()) {
  const t = Number(ts) || 0;
  if (!t) return '时间未知';
  const diff = now - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < DAY_MS) return `${Math.round(diff / 3600000)} 小时前`;
  const days = Math.round(diff / DAY_MS);
  if (days <= 30) return `${days} 天前`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 把「这条记忆是多久以前记下的」翻译成一段可注入的短标注。
 *
 * 为什么需要它（用户报障："她太容易被记忆影响"）：
 *   在这之前【记忆】【跨群档案】里的每一条都是**没有时间**的平铺断言 ——
 *   半年前记下的"他在考研"和昨天记下的"他明天要面试"在提示词里长得一模一样，
 *   模型手上没有任何依据去区分它们，只能一概当成"现在的事实"。
 *   补上时间与 ⚠ 过时标记后，"这条还作不作数"才变成模型能判断的事。
 *
 * 注意：只在**注入时**计算，不写回磁盘 —— 标注随读取时间变化，
 *      存下来就会过期（跟遗忘曲线同一个思路：实时折算，而不是定时扣分）。
 *
 * @param {number} ts 记下/最后触碰的时间戳
 * @param {number} [now]
 * @param {object} [opts]
 * @param {number} [opts.staleDays] 超过这么多天打 ⚠（默认 30）
 * @returns {{text:string, stale:boolean, ageDays:number}}
 *          text 为空串 = "一天内记的，不用标时间"
 */
export function memoryAgeLabel(ts, now = Date.now(), { staleDays = 30 } = {}) {
  const t = Number(ts) || 0;
  if (!t) return { text: '', stale: false, ageDays: 0 };
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  if (!Number.isFinite(ageDays) || ageDays < 1) return { text: '', stale: false, ageDays };
  const stale = ageDays >= Math.max(1, Number(staleDays) || 30);
  const ago = ageDays < 30
    ? `${Math.round(ageDays)} 天前`
    : (ageDays < 365
      ? `约 ${Math.round(ageDays / 30)} 个月前`
      : `约 ${(ageDays / 365).toFixed(1)} 年前`);
  return { text: stale ? `⚠ ${ago}，可能已过时` : ago, stale, ageDays };
}

/** 一条记忆「最后作数」的时间：优先最后触碰，退回更新/创建时间。 */
function memoryStampOf(entry) {
  return Number(entry?.lastTouchedAt)
    || Number(entry?.lastMentionAt)
    || Number(entry?.updatedAt)
    || Number(entry?.createdAt)
    || 0;
}

// ── 配置读取 ──────────────────────────────────────────────────
// 全部带兜底默认值：即使 config.js 还没升级到新版，本模块也能独立工作。
function mcfg() {
  const m = getConfig()?.memory || {};
  return {
    globalEnabled: m.globalEnabled !== false,
    crossGroupEnabled: m.crossGroupEnabled !== false,
    crossGroupPrivateToGroup: m.crossGroupPrivateToGroup !== false,
    crossGroupExclude: Array.isArray(m.crossGroupExclude) ? m.crossGroupExclude.map(String) : [],
    eventsEnabled: m.eventsEnabled !== false,
    peopleMaxInject: Math.max(0, Number(m.peopleMaxInject) || 6),
    eventsMaxInject: Math.max(0, Number(m.eventsMaxInject) || 6),
    crossGroupMaxChars: Math.max(300, Number(m.crossGroupMaxChars) || 1400),
    factsPerPersonInject: Math.max(1, Number(m.factsPerPersonInject) || 3),
    decayHalfLifeDays: Math.max(1, Number(m.decayHalfLifeDays) || 30),
    decayMinWeight: clamp(Number(m.decayMinWeight) || 0.08, 0, 1),
    decayMinAgeDays: Math.max(0, Number(m.decayMinAgeDays ?? 7)),
    keepImportance: clamp(Number(m.keepImportance) || 4, 1, 5),
    maxFactsPerPerson: Math.max(3, Number(m.maxFactsPerPerson) || 12),
    maxEventsPerChat: Math.max(10, Number(m.maxEventsPerChat) || 150),
    maxEventsTotal: Math.max(20, Number(m.maxEventsTotal) || 400),
    // ── 表层记忆（暂存区）──
    // 刚说过的话先在这里留一小段时间，任何会话都能查到，
    // 所以"私聊问完立刻去另一个群复述"才成立。
    surfaceEnabled: m.surfaceEnabled !== false,
    surfaceTtlMs: Math.max(60_000, Number(m.surfaceTtlMs) || 10 * 60 * 1000),   // 默认 10 分钟
    surfaceMaxPerPerson: Math.max(1, Number(m.surfaceMaxPerPerson) || 50),      // 每人最多 50 条
    surfaceMaxInject: Math.max(0, Number(m.surfaceMaxInject) || 6),             // 每次注入条数
    surfacePrivateToGroup: m.surfacePrivateToGroup !== false,                   // 默认允许私聊→群
    // ── 私聊加权（2026-09-16）──
    // 群聊那一套预算是"摊给一屏人"的；私聊只有对方一个人，摊无可摊。
    // 不单独放宽的话，同一个人的档案在私聊里会被压成三行 —— 见 formatForPrompt。
    privateBoost: m.privateBoost !== false,                                     // 总开关
    privateFactsPerPersonInject: Math.max(1, Number(m.privateFactsPerPersonInject) || 8),  // 私聊每人注入几条事实（群聊用 factsPerPersonInject）
    privateEventsMaxInject: Math.max(0, Number(m.privateEventsMaxInject) || 10),  // 私聊注入几条长期事件（群聊用 eventsMaxInject）
    // ── 记忆时效标注（2026-09-17）──
    // 注入的每条记忆后面带上"多久以前记的"，超过 staleDays 的打 ⚠。
    // 配合系统提示里"记忆只是以前记下的、以当场说的为准"的规则一起生效。
    annotateAge: m.annotateAge !== false,
    staleDays: Math.max(1, Number(m.staleDays) || 30),
    // 自动注入的年龄上限（天）：0 = 不限。超过的条目不再自动注入，
    // 但仍留在库里、memory_search 照样查得到 —— 这是"别张口就来旧印象"
    // 与"问起来还记得"之间的那个旋钮。
    injectMaxAgeDays: Math.max(0, Number(m.injectMaxAgeDays) || 0)
  };
}

/**
 * 半衰期（天）：importance 越高活得越久。
 * importance 1 → 1.0×base，3 → 2.5×base，5 → 4.0×base（base 默认 30 天）。
 */
function halfLifeDays(importance, base) {
  const i = clamp(Number(importance) || 3, 1, 5);
  return base * (1 + (i - 1) * 0.75);
}

/**
 * 遗忘曲线：把"权重 + 重要度 + 最后触碰时间"实时折算成当前有效权重。
 * 不用定时扣分，是为了让衰减可解释、可重算，也不会因为进程没开而漏算。
 */
export function effectiveWeight(entry, now = Date.now(), baseDays = 30) {
  if (!entry) return 0;
  if (entry.pinned === true) return 1;
  const w0 = clamp(entry.weight === undefined ? 1 : entry.weight, 0, 1);
  const touched = Number(entry.lastTouchedAt) || Number(entry.updatedAt) || Number(entry.createdAt) || now;
  const ageDays = Math.max(0, (now - touched) / DAY_MS);
  return clamp(w0 * Math.pow(0.5, ageDays / halfLifeDays(entry.importance, baseDays)), 0, 1);
}

/** 综合排序分：有效权重为主，重要度次之。 */
function scoreOf(entry, now, baseDays) {
  const w = effectiveWeight(entry, now, baseDays);
  const imp = clamp(Number(entry?.importance) || 3, 1, 5) / 5;
  return w * 0.65 + imp * 0.35;
}

// ── 检索用分词 ────────────────────────────────────────────────
// 中文没有空格：用「英文/数字词 + 中文二元组」混合切分，够用且零依赖。
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) out.add(cjk);
  return [...out];
}

export function matchScore(tokens, haystack) {
  if (!tokens.length) return 0;
  const hay = String(haystack ?? '').toLowerCase();
  let hit = 0;
  for (const t of tokens) if (hay.includes(t)) hit += 1;
  return hit / tokens.length;
}

// ── 主体 ──────────────────────────────────────────────────────

export class GlobalMemoryStore {
  constructor({ dir = '' } = {}) {
    // 显式给了 dir（测试/临时目录）就钉死不动；否则跟着「当前人设」走。
    this.fixedDir = String(dir || '');
    this.rootKey = null;
    // 先给一套默认路径，load() 里的 #ensureRoot() 会按人设覆盖。
    this.dir = this.fixedDir || GLOBAL_DIR;
    this.peopleDir = path.join(this.dir, 'people');
    this.eventsFile = path.join(this.dir, 'events.json');
    this.surfaceFile = path.join(this.dir, 'surface.json');
    this.metaFile = path.join(this.dir, '_meta.json');
    this.people = new Map();   // userId -> person
    this.events = [];          // 事件数组（单文件，量级小）
    this.surface = null;       // 表层记忆（懒加载：首次访问才读盘）
    this.loaded = false;
    this.lastMaintenanceAt = 0;
    this.load();
  }

  /**
   * 记忆目录跟着人设走。换人设时换根并整份重载 ——
   * 这样"人设 A 的跨群档案不会出现在人设 B 里"是目录决定的，不靠过滤。
   */
  #ensureRoot() {
    const key = this.fixedDir || currentMemoryKey();
    if (key === this.rootKey) return false;
    this.rootKey = key;
    this.dir = this.fixedDir || path.join(DATA_DIR, 'memory', key, '_global');
    this.peopleDir = path.join(this.dir, 'people');
    this.eventsFile = path.join(this.dir, 'events.json');
    this.surfaceFile = path.join(this.dir, 'surface.json');
    this.metaFile = path.join(this.dir, '_meta.json');
    this.people = new Map();
    this.events = [];
    this.surface = null;
    this.loaded = false;
    return true;
  }

  get enabled() {
    return mcfg().globalEnabled;
  }

  // ── 载入 ──
  load() {
    this.#ensureRoot();
    if (this.loaded) return this;
    this.loaded = true;
    try {
      fs.mkdirSync(this.peopleDir, { recursive: true });
    } catch { /* 目录建不出来时后面每一步都有兜底 */ }
    try {
      for (const f of fs.readdirSync(this.peopleDir)) {
        if (!f.endsWith('.json')) continue;
        const raw = readJson(path.join(this.peopleDir, f), null);
        const person = this.#sanitizePerson(raw);
        if (person) this.people.set(person.userId, person);
      }
    } catch { /* 目录不存在等 */ }
    try {
      const raw = readJson(this.eventsFile, null);
      const list = Array.isArray(raw?.events) ? raw.events : [];
      this.events = list.map((e) => this.#sanitizeEvent(e)).filter(Boolean);
    } catch { /* ignore */ }
    return this;
  }

  #sanitizePerson(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const userId = safeUserId(raw.userId);
    if (!userId) return null;
    const now = Date.now();
    const names = {};
    if (raw.names && typeof raw.names === 'object') {
      for (const [k, v] of Object.entries(raw.names)) {
        if (BAD_KEYS.has(k)) continue;
        const ck = safeChatKey(k);
        const nm = String(v ?? '').trim().slice(0, 60);
        if (ck && nm) names[ck] = nm;
      }
    }
    const facts = [];
    for (const f of Array.isArray(raw.facts) ? raw.facts : []) {
      const content = String(f?.content ?? '').trim().slice(0, 300);
      if (!content) continue;
      facts.push({
        id: String(f?.id || newId('f')),
        content,
        importance: clamp(Number(f?.importance) || 3, 1, 5),
        weight: clamp(f?.weight === undefined ? 1 : f.weight, 0, 1),
        pinned: f?.pinned === true,
        hits: Math.max(0, Number(f?.hits) || 0),
        createdAt: Number(f?.createdAt) || now,
        updatedAt: Number(f?.updatedAt) || Number(f?.createdAt) || now,
        lastTouchedAt: Number(f?.lastTouchedAt) || Number(f?.updatedAt) || Number(f?.createdAt) || now,
        sources: (Array.isArray(f?.sources) ? f.sources : [])
          .map((s) => ({ chatKey: safeChatKey(s?.chatKey), at: Number(s?.at) || 0 }))
          .filter((s) => s.chatKey)
          .slice(-12)
      });
    }
    return {
      userId,
      primaryName: String(raw.primaryName || '').trim().slice(0, 60),
      names,
      tags: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t ?? '').trim().slice(0, 20)).filter(Boolean).slice(0, 12),
      facts,
      firstSeenAt: Number(raw.firstSeenAt) || now,
      lastSeenAt: Number(raw.lastSeenAt) || now,
      updatedAt: Number(raw.updatedAt) || now,
      lastConsolidatedAt: Number(raw.lastConsolidatedAt) || 0,
      pinned: raw.pinned === true
    };
  }

  #sanitizeEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text ?? '').trim().slice(0, 300);
    if (!text) return null;
    const now = Date.now();
    const scope = raw.scope === 'global' ? 'global' : 'chat';
    const chatKey = safeChatKey(raw.chatKey);
    if (scope === 'chat' && !chatKey) return null;
    const kind = EVENT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : DEFAULT_KIND;
    return {
      id: String(raw.id || newId('e')),
      text,
      kind,
      scope,
      chatKey: scope === 'chat' ? chatKey : '',
      participants: (Array.isArray(raw.participants) ? raw.participants : [])
        .map((p) => safeUserId(p))
        .filter(Boolean)
        .slice(0, 20),
      importance: clamp(Number(raw.importance) || 3, 1, 5),
      weight: clamp(raw.weight === undefined ? 1 : raw.weight, 0, 1),
      pinned: raw.pinned === true,
      hits: Math.max(0, Number(raw.hits) || 0),
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now,
      lastTouchedAt: Number(raw.lastTouchedAt) || Number(raw.updatedAt) || Number(raw.createdAt) || now,
      lastMentionAt: Number(raw.lastMentionAt) || Number(raw.createdAt) || now,
      expiresAt: Number(raw.expiresAt) || 0,
      resolved: raw.resolved === true,
      origin: safeChatKey(raw.origin) || chatKey || ''
    };
  }

  // ── 持久化 ──
  #savePerson(userId) {
    const person = this.people.get(String(userId));
    if (!person) return false;
    return writeJson(path.join(this.peopleDir, `${person.userId}.json`), person);
  }

  #saveEvents() {
    return writeJson(this.eventsFile, { version: 1, updatedAt: Date.now(), events: this.events });
  }

  #saveMeta(patch = {}) {
    const prev = readJson(this.metaFile, {}) || {};
    return writeJson(this.metaFile, { ...prev, ...patch });
  }

  meta() {
    this.load();
    return readJson(this.metaFile, {}) || {};
  }

  // ── 可见性闸门 ──
  /**
   * 来源会话 src 的记忆，是否允许出现在目标会话 target。
   * 同一会话永远可见；其余按配置放行。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.surface] 这条是「表层记忆」吗？
   *   表层记忆是刚说过的话（限时暂存），用户明确要求"私聊说的要能立刻在群里复述"，
   *   所以它默认跨群可见（含私聊→群），走 surfacePrivateToGroup；
   *   长期记忆沿用原闸门（默认挡私聊→群，避免机器人在群里揭人老底）。
   */
  visible(srcChatKey, targetChatKey, { surface = false } = {}) {
    const src = String(srcChatKey || '');
    const target = String(targetChatKey || '');
    if (!src || !target) return false;
    if (src === target) return true;
    const cfg = mcfg();
    if (!cfg.crossGroupEnabled) return false;
    if (cfg.crossGroupExclude.includes(src) || cfg.crossGroupExclude.includes(target)) return false;
    const srcPrivate = src.startsWith('private:');
    const targetGroup = target.startsWith('group:');
    if (srcPrivate && targetGroup) {
      // 表层 = 刚说过的话，默认放行；长期 = 沉淀下来的档案，默认拦着。
      if (surface) return cfg.surfacePrivateToGroup;
      return cfg.crossGroupPrivateToGroup;
    }
    return true;
  }

  // ── 人物档案 ──

  /** 建立/更新档案，登记名字与出现过的会话。 */
  touchPerson(userId, { name = '', chatKey = '', at = 0 } = {}) {
    this.load();
    const uid = safeUserId(userId);
    if (!uid) return null;
    const now = Number(at) || Date.now();
    const person = this.people.get(uid) || {
      userId: uid,
      primaryName: '',
      names: {},
      tags: [],
      facts: [],
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
      lastConsolidatedAt: 0,
      pinned: false
    };
    const nm = String(name ?? '').trim().slice(0, 60);
    const ck = safeChatKey(chatKey);
    if (ck && nm) person.names[ck] = nm;
    if (nm) person.primaryName = nm;
    person.lastSeenAt = Math.max(Number(person.lastSeenAt) || 0, now);
    person.updatedAt = now;
    this.people.set(uid, person);
    this.#savePerson(uid);
    return person;
  }

  /**
   * 记一条对某人的长期事实。重复内容会合并（强化而不是堆积）。
   * @returns {object|null} 写入的 fact
   */
  rememberFact(userId, content, { name = '', chatKey = '', at = 0, importance = 3, pinned = false } = {}) {
    if (!mcfg().globalEnabled) return null;
    const uid = safeUserId(userId);
    const text = String(content ?? '').trim().slice(0, 300);
    if (!uid || !text) return null;
    const now = Number(at) || Date.now();
    const person = this.touchPerson(uid, { name, chatKey, at: now });
    if (!person) return null;

    const key = normText(text);
    let fact = person.facts.find((f) => normText(f.content) === key);
    if (fact) {
      // 同一件事再次被提到 = 强化记忆：权重回升、命中数 +1
      fact.weight = clamp(Number(fact.weight || 1) + 0.25, 0, 1);
      fact.hits = (Number(fact.hits) || 0) + 1;
      fact.lastTouchedAt = now;
      fact.updatedAt = now;
      fact.importance = Math.max(Number(fact.importance) || 3, clamp(Number(importance) || 3, 1, 5));
      const ck = safeChatKey(chatKey);
      if (ck && !fact.sources.some((s) => s.chatKey === ck)) fact.sources.push({ chatKey: ck, at: now });
    } else {
      fact = {
        id: newId('f'),
        content: text,
        importance: clamp(Number(importance) || 3, 1, 5),
        weight: 1,
        pinned: pinned === true,
        hits: 0,
        createdAt: now,
        updatedAt: now,
        lastTouchedAt: now,
        sources: safeChatKey(chatKey) ? [{ chatKey: safeChatKey(chatKey), at: now }] : []
      };
      person.facts.push(fact);
    }
    this.#enforceFactCap(person);
    person.updatedAt = now;
    this.#savePerson(uid);
    return fact;
  }

  /** 超过每人上限时，按分数淘汰（pinned 永不淘汰）。 */
  #enforceFactCap(person) {
    const cap = mcfg().maxFactsPerPerson;
    if (person.facts.length <= cap) return;
    const now = Date.now();
    const base = mcfg().decayHalfLifeDays;
    const keep = [...person.facts]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return scoreOf(b, now, base) - scoreOf(a, now, base);
      })
      .slice(0, cap);
    const keepIds = new Set(keep.map((f) => f.id));
    person.facts = person.facts.filter((f) => keepIds.has(f.id));
  }

  getPerson(userId) {
    this.load();
    const p = this.people.get(safeUserId(userId));
    return p ? structuredClone(p) : null;
  }

  listPeople({ limit = 200 } = {}) {
    this.load();
    return [...this.people.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, Math.max(1, Number(limit) || 200))
      .map((p) => structuredClone(p));
  }

  /** 出现在某个会话里的人（UI 与调试用）。 */
  peopleInChat(chatKey, { limit = 200 } = {}) {
    const ck = safeChatKey(chatKey);
    if (!ck) return [];
    return this.listPeople({ limit: 10000 })
      .filter((p) => p.names[ck] || p.facts.some((f) => f.sources.some((s) => s.chatKey === ck)))
      .slice(0, limit);
  }

  forgetFact(userId, { factId = '', content = '' } = {}) {
    this.load();
    const uid = safeUserId(userId);
    const person = this.people.get(uid);
    if (!person) return 0;
    const before = person.facts.length;
    const cid = String(factId || '').trim();
    const key = normText(content);
    person.facts = person.facts.filter((f) => {
      if (cid && f.id === cid) return false;
      if (key && normText(f.content) === key) return false;
      return true;
    });
    const removed = before - person.facts.length;
    if (removed) {
      person.updatedAt = Date.now();
      this.#savePerson(uid);
    }
    return removed;
  }

  forgetPerson(userId) {
    this.load();
    const uid = safeUserId(userId);
    if (!uid || !this.people.has(uid)) return false;
    this.people.delete(uid);
    try { fs.rmSync(path.join(this.peopleDir, `${uid}.json`), { force: true }); } catch { /* ignore */ }
    return true;
  }

  /**
   * 把一个会话对某人的印象「同步」进跨群档案。
   *
   * 关键语义：**每个会话只对自己贡献的那部分负责**。
   *   - 本会话已经不再承认的事实 → 收回本会话的来源标记；
   *     若某条事实因此没有任何来源，说明它本来就只来自这个会话 → 全局也一并删掉。
   *   - 别的会话贡献的事实原样保留（不会被 A 群的整理/删除误伤）。
   * 这样管理端在某个群删印象、或整理时合并精简，都能正确传导到跨群档案，又不污染其他群。
   *
   * @param {string[]} contents 本会话「当前承认的全部印象」——是快照不是增量，
   *        所以调用方不需要区分新增/删除，全局层负责算出差异。
   */
  syncChatFacts(userId, contents, { name = '', chatKey = '', at = 0, importance = 3 } = {}) {
    const uid = safeUserId(userId);
    const ck = safeChatKey(chatKey);
    if (!uid || !ck) return null;
    const now = Number(at) || Date.now();
    const imp = clamp(Number(importance) || 3, 1, 5);
    const person = this.touchPerson(uid, { name, chatKey: ck, at: now });
    if (!person) return null;

    const want = new Map();   // 归一化文本 -> 原文
    for (const raw of Array.isArray(contents) ? contents : []) {
      const text = String(raw ?? '').trim().slice(0, 300);
      if (text && !want.has(normText(text))) want.set(normText(text), text);
    }

    // 1) 收回本会话已经不再承认的事实
    for (const f of [...person.facts]) {
      if (want.has(normText(f.content))) continue;
      const before = f.sources.length;
      f.sources = f.sources.filter((s) => s.chatKey !== ck);
      if (before > 0 && f.sources.length === 0) {
        person.facts = person.facts.filter((x) => x.id !== f.id);
      }
    }

    // 2) 新增 / 强化本会话承认的事实
    for (const [key, text] of want) {
      const fact = person.facts.find((f) => normText(f.content) === key);
      if (fact) {
        /*
         * ⚠️ 只有"这个会话第一次承认这条"才算强化。
         *
         * 以前这里是无条件 weight +0.25、lastTouchedAt = now：而写穿是**整份快照**
         * 调用（memory_append、整理回填、管理端编辑都会走这里），于是每写一次
         * 这个人名下**所有**事实的时间戳都被刷成"现在"、权重一路顶到 1 ——
         * 只要这个群还在聊天，旧印象就永远不会衰减，"遗忘曲线"在跨群层形同虚设。
         * 用户眼里就是"她总拿很久以前的印象说事"。
         *
         * 现在的语义：重复写穿同一批内容 = 无操作；真的新增了一个来源才强化。
         * （另：importance 仍取较高者 —— 那不是"时间"，被抬高是合理的。）
         */
        const isNewSource = !fact.sources.some((s) => s.chatKey === ck);
        if (isNewSource) {
          fact.sources.push({ chatKey: ck, at: now });
          fact.weight = clamp(Number(fact.weight || 1) + 0.25, 0, 1);
          fact.lastTouchedAt = now;
          fact.updatedAt = now;
        }
        fact.importance = Math.max(Number(fact.importance) || 3, imp);
      } else {
        person.facts.push({
          id: newId('f'),
          content: text,
          importance: imp,
          weight: 1,
          pinned: false,
          hits: 0,
          createdAt: now,
          updatedAt: now,
          lastTouchedAt: now,
          sources: [{ chatKey: ck, at: now }]
        });
      }
    }
    this.#enforceFactCap(person);
    person.updatedAt = now;
    this.#savePerson(uid);
    return person;
  }

  /** 汇总某人在所有会话里的已知印象（跨群整理/管理端查看用）。 */
  crossGroupDigest(userId) {
    const person = this.getPerson(userId);
    if (!person) return null;
    return {
      userId: person.userId,
      primaryName: person.primaryName,
      names: person.names,
      facts: person.facts.map((f) => ({
        id: f.id,
        content: f.content,
        importance: f.importance,
        from: [...new Set(f.sources.map((s) => s.chatKey))]
      }))
    };
  }

  /** 整理后整体替换某人的事实（保留命中的元数据，避免整理把权重清零）。 */
  replaceFacts(userId, contents, { name = '', chatKey = '', at = 0, importance = 3 } = {}) {
    const uid = safeUserId(userId);
    if (!uid) return null;
    const now = Number(at) || Date.now();
    const person = this.touchPerson(uid, { name, chatKey, at: now });
    if (!person) return null;
    const oldByKey = new Map(person.facts.map((f) => [normText(f.content), f]));
    const ck = safeChatKey(chatKey);
    const next = [];
    for (const raw of Array.isArray(contents) ? contents : []) {
      const text = String(raw ?? '').trim().slice(0, 300);
      if (!text) continue;
      const old = oldByKey.get(normText(text));
      next.push(old
        ? { ...old, updatedAt: now, lastTouchedAt: now }
        : {
            id: newId('f'),
            content: text,
            importance: clamp(Number(importance) || 3, 1, 5),
            weight: 1,
            pinned: false,
            hits: 0,
            createdAt: now,
            updatedAt: now,
            lastTouchedAt: now,
            sources: ck ? [{ chatKey: ck, at: now }] : []
          });
    }
    person.facts = next;
    this.#enforceFactCap(person);
    person.lastConsolidatedAt = now;
    person.updatedAt = now;
    this.#savePerson(uid);
    return person;
  }

  // ── 表层记忆（暂存区）──
  //
  // 定位：刚说过的话的「短期缓存」，跟长期档案分开存（surface.json）。
  //   * 为什么单独一层：长期档案要"沉淀"，写进去就带着遗忘曲线慢慢淡；
  //     而"私聊刚说的那句"需要的是**立刻、而且是原话**能在另一个群用上。
  //     混在一起会互相污染（长期档案被大量原话灌爆，或者刚说的话因为
  //     闸门配置进不了群）。
  //   * 生命周期：写入 → 存活 surfaceTtlMs（默认 10 分钟）→ 到期自动清理。
  //     期间任何会话都能查到；用户/模型也可以中途 promote 成长期记忆。
  //   * 存储形态：{ userId, name, chatKey, text, at, expiresAt, promotedAt }
  //     按 userId 分组，因为"跨群对齐"的唯一依据就是 QQ 号。

  #loadSurface() {
    this.load();
    try {
      const raw = readJson(this.surfaceFile, null);
      const list = Array.isArray(raw?.items) ? raw.items : [];
      const now = Date.now();
      this.surface = list
        .map((s) => this.#sanitizeSurface(s))
        .filter(Boolean)
        // 载入即清理过期项，省得每次查询都要过滤
        .filter((s) => !s.expiresAt || now < s.expiresAt);
    } catch {
      this.surface = [];
    }
    return this.surface;
  }

  #sanitizeSurface(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const uid = safeUserId(raw.userId);
    const ck = safeChatKey(raw.chatKey);
    const text = String(raw.text ?? '').trim().slice(0, 500);
    if (!uid || !ck || !text) return null;
    return {
      id: String(raw.id || newId('s')),
      userId: uid,
      name: String(raw.name ?? '').trim().slice(0, 60),
      chatKey: ck,
      text,
      at: Number(raw.at) || Date.now(),
      expiresAt: Number(raw.expiresAt) || 0,
      promotedAt: Number(raw.promotedAt) || 0
    };
  }

  #saveSurface() {
    // 落盘前再清一次过期项：不然长期不查的库会一直堆僵尸数据。
    const now = Date.now();
    this.surface = (this.surface || []).filter((s) => !s.expiresAt || now < s.expiresAt);
    return writeJson(this.surfaceFile, { version: 1, updatedAt: now, items: this.surface });
  }

  /**
   * 记一条表层记忆（一句原话）。
   * 同一会话里同一句话短时间内重复出现时合并，避免刷屏时堆一屏重复。
   */
  addSurface({ userId, name = '', chatKey, text, at = 0 } = {}) {
    const cfg = mcfg();
    if (!cfg.surfaceEnabled || !cfg.globalEnabled) return null;
    const uid = safeUserId(userId);
    const ck = safeChatKey(chatKey);
    const body = String(text ?? '').trim();
    if (!uid || !ck || !body) return null;
    if (!this.surface) this.#loadSurface();
    const now = Number(at) || Date.now();
    // 机器人自己的话不算"某人说过的事"，但这里只做形式校验（调用方也会过滤）

    const key = normText(body);
    const dup = this.surface.find((s) => s.userId === uid && s.chatKey === ck && normText(s.text) === key);
    if (dup) {
      // 同一句话重提 = 置顶变新（延长有效期），不堆一条
      dup.at = now;
      dup.expiresAt = now + cfg.surfaceTtlMs;
      dup.name = String(name || dup.name || '').slice(0, 60);
      this.#enforceSurfaceCap(uid);
      this.#saveSurface();
      return dup;
    }

    const item = {
      id: newId('s'),
      userId: uid,
      name: String(name ?? '').trim().slice(0, 60),
      chatKey: ck,
      text: body.slice(0, 500),
      at: now,
      expiresAt: now + cfg.surfaceTtlMs,
      promotedAt: 0
    };
    this.surface.push(item);
    this.#enforceSurfaceCap(uid);
    this.#saveSurface();
    return item;
  }

  /** 每人上限：超出时丢最旧的（表层本来就是"最近说过的话"）。 */
  #enforceSurfaceCap(userId) {
    const cap = mcfg().surfaceMaxPerPerson;
    const mine = this.surface.filter((s) => s.userId === userId);
    if (mine.length <= cap) return;
    const drop = new Set(
      [...mine].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(cap).map((s) => s.id)
    );
    this.surface = this.surface.filter((s) => !drop.has(s.id));
  }

  /**
   * 查表层记忆。
   * @param {object} opts
   * @param {string} [opts.userId]  只看某人
   * @param {string} [opts.chatKey] 目标会话（用于可见性闸门）
   * @param {string} [opts.excludeChatKey] 排除的会话（"别处的"= 不等于当前会话）
   * @param {boolean} [opts.otherChatsOnly] 只要来自别的会话的（跨群复述用）
   */
  listSurface({ userId = '', chatKey = '', excludeChatKey = '', otherChatsOnly = false, limit = 50 } = {}) {
    this.load();
    const cfg = mcfg();
    if (!cfg.surfaceEnabled) return [];
    if (!this.surface) this.#loadSurface();
    const now = Date.now();
    const uid = safeUserId(userId);
    const ck = safeChatKey(chatKey);
    const ex = safeChatKey(excludeChatKey);
    return this.surface
      .filter((s) => {
        if (s.expiresAt && now >= s.expiresAt) return false;
        if (uid && s.userId !== uid) return false;
        // 可见性：这条来自哪个会话、能不能出现在目标会话
        if (ck && s.chatKey !== ck && !this.visible(s.chatKey, ck, { surface: true })) return false;
        if (otherChatsOnly && s.chatKey === ex) return false;
        return true;
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((s) => structuredClone(s));
  }

  /** 按 id 找一条表层记忆（沉淀/删除时用）。 */
  getSurface(id) {
    this.load();
    if (!this.surface) this.#loadSurface();
    const s = this.surface.find((x) => x.id === String(id || ''));
    return s ? structuredClone(s) : null;
  }

  /**
   * 把一条表层记忆「沉淀」成长期记忆 —— 这是"用户手动点击加入长期记忆"的后端。
   * @param {string} id            表层记忆 id
   * @param {object} [opts]
   * @param {string} [opts.kind]   event/topic/promise/joke/grudge/preference
   * @param {number} [opts.importance]
   * @param {'event'|'fact'} [opts.as]  沉淀成"长期事件"（默认）还是"人物事实"
   * @returns {{ok:boolean, kind:string, event?:object, fact?:object}}
   */
  promoteSurface(id, { kind = 'event', importance = 3, as = 'event' } = {}) {
    const item = this.getSurface(id);
    if (!item) return { ok: false, reason: 'not-found' };
    const imp = clamp(Number(importance) || 3, 1, 5);
    if (as === 'fact') {
      const fact = this.rememberFact(item.userId, item.text, {
        name: item.name,
        chatKey: item.chatKey,
        at: Date.now(),
        importance: imp
      });
      if (!fact) return { ok: false, reason: 'write-failed' };
      this.#markSurfacePromoted(id);
      return { ok: true, kind: 'fact', fact: structuredClone(fact) };
    }
    const event = this.noteEvent({
      text: item.text,
      kind: EVENT_KINDS.includes(String(kind)) ? String(kind) : DEFAULT_KIND,
      // 私聊来的按"跟人走"更合理：这个人出现在哪个群都能想起来
      scope: item.chatKey.startsWith('private:') ? 'global' : 'chat',
      chatKey: item.chatKey,
      participants: [item.userId],
      importance: imp
    });
    if (!event) return { ok: false, reason: 'write-failed' };
    this.#markSurfacePromoted(id);
    return { ok: true, kind: 'event', event: structuredClone(event) };
  }

  #markSurfacePromoted(id) {
    if (!this.surface) this.#loadSurface();
    const s = this.surface.find((x) => x.id === String(id || ''));
    if (s) {
      s.promotedAt = Date.now();
      this.#saveSurface();
    }
  }

  removeSurface(id) {
    if (!this.surface) this.#loadSurface();
    const before = this.surface.length;
    this.surface = this.surface.filter((s) => s.id !== String(id || ''));
    if (this.surface.length !== before) {
      this.#saveSurface();
      return true;
    }
    return false;
  }

  /** 清理过期表层记忆（维护循环调用）。 */
  pruneSurface() {
    if (!this.surface) this.#loadSurface();
    const now = Date.now();
    const before = this.surface.length;
    this.surface = this.surface.filter((s) => !s.expiresAt || now < s.expiresAt);
    const removed = before - this.surface.length;
    if (removed) this.#saveSurface();
    return removed;
  }

  /**
   * 生成【刚刚在别处提到】注入段：
   * 只带"来自别的会话、还在有效期内、过了可见性闸门"的原话。
   * 目的是让模型能自然接话（"你刚在私聊说的那个…"），而不是硬背档案。
   */
  surfaceForPrompt(chatKey, { userIds = null, maxChars = 0, now = Date.now(), chatLabeler = null } = {}) {
    if (!this.enabled || !mcfg().surfaceEnabled) return '';
    this.load();
    const cfg = mcfg();
    if (cfg.surfaceMaxInject <= 0) return '';
    const budget = Math.max(200, Number(maxChars) || Math.min(600, cfg.crossGroupMaxChars));
    const ck = safeChatKey(chatKey);
    if (!ck) return '';
    const label = typeof chatLabeler === 'function' ? chatLabeler : chatLabel;
    // 空数组 = 未筛选（否则 [] 会过滤掉所有人，整段静默消失）
    const filter = Array.isArray(userIds) && userIds.length
      ? new Set([...userIds].map((u) => safeUserId(u)).filter(Boolean))
      : null;
    if (!this.surface) this.#loadSurface();

    const pick = this.surface
      .filter((s) => {
        if (s.expiresAt && now >= s.expiresAt) return false;
        if (filter && !filter.has(s.userId)) return false;
        if (s.chatKey === ck) return false;                        // 只要"别处"的
        return this.visible(s.chatKey, ck, { surface: true });
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, cfg.surfaceMaxInject);
    if (!pick.length) return '';

    const nameOf = (s) => s.name || s.userId;
    const lines = ['【刚刚在别处提到】下面几句是不久前在别的会话里说的（可能来自私聊）。如果是本次对话相关的人或事，可以自然接上；不相关就当没看见，别硬提：'];
    for (const s of pick) {
      const mins = Math.max(0, Math.round((now - (s.at || now)) / 60000));
      const ago = mins <= 0 ? '刚刚' : (mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`);
      lines.push(`- ${nameOf(s)}（QQ ${s.userId}）在${label(s.chatKey)} ${ago}说：“${s.text}”`);
    }
    let out = lines.join('\n');
    if (out.length > budget) {
      const kept = [];
      let used = 0;
      for (const line of out.split('\n')) {
        if (used + line.length + 1 > budget) break;
        kept.push(line);
        used += line.length + 1;
      }
      out = kept.join('\n');
    }
    return out;
  }

  // ── 长期事件 ──

  noteEvent({ text, kind = DEFAULT_KIND, scope = 'chat', chatKey = '', participants = [], at = 0, importance = 3, expiresAt = 0, pinned = false } = {}) {
    this.load();
    if (!mcfg().eventsEnabled || !mcfg().globalEnabled) return null;
    const body = String(text ?? '').trim().slice(0, 300);
    if (!body) return null;
    const now = Number(at) || Date.now();
    const sc = scope === 'global' ? 'global' : 'chat';
    const ck = safeChatKey(chatKey);
    if (sc === 'chat' && !ck) return null;
    const kd = EVENT_KINDS.includes(String(kind)) ? String(kind) : DEFAULT_KIND;
    const pids = (Array.isArray(participants) ? participants : [participants])
      .map((p) => safeUserId(p))
      .filter(Boolean)
      .slice(0, 20);

    // 同一会话里语义相同的事件视为"又被提起"：强化 + 更新时间，不再堆一条。
    const key = normText(body);
    const dup = this.events.find((e) => e.scope === sc && e.chatKey === (sc === 'chat' ? ck : '') && normText(e.text) === key);
    if (dup) {
      dup.weight = clamp(Number(dup.weight || 1) + 0.25, 0, 1);
      dup.hits = (Number(dup.hits) || 0) + 1;
      dup.lastMentionAt = now;
      dup.lastTouchedAt = now;
      dup.updatedAt = now;
      dup.importance = Math.max(Number(dup.importance) || 3, clamp(Number(importance) || 3, 1, 5));
      dup.resolved = false;
      for (const p of pids) if (!dup.participants.includes(p)) dup.participants.push(p);
      this.#enforceEventCaps();
      this.#saveEvents();
      return dup;
    }

    const event = {
      id: newId('e'),
      text: body,
      kind: kd,
      scope: sc,
      chatKey: sc === 'chat' ? ck : '',
      origin: ck || '',
      participants: pids,
      importance: clamp(Number(importance) || 3, 1, 5),
      weight: 1,
      pinned: pinned === true,
      hits: 0,
      createdAt: now,
      updatedAt: now,
      lastTouchedAt: now,
      lastMentionAt: now,
      expiresAt: Number(expiresAt) || 0,
      resolved: false
    };
    this.events.push(event);
    // 顺手把参与者登记进人物档案 —— 让"提过某人"本身也成为线索
    for (const p of pids) this.touchPerson(p, { chatKey: ck, at: now });
    this.#enforceEventCaps();
    this.#saveEvents();
    return event;
  }

  #enforceEventCaps() {
    const cfg = mcfg();
    const now = Date.now();
    const base = cfg.decayHalfLifeDays;
    const drop = new Set();
    // 每会话上限（全局事件单独归到 __global__ 桶，用总量上限管）
    const byChat = new Map();
    for (const e of this.events) {
      const k = e.scope === 'chat' ? e.chatKey : '__global__';
      if (!byChat.has(k)) byChat.set(k, []);
      byChat.get(k).push(e);
    }
    for (const [k, list] of byChat) {
      const limit = k === '__global__' ? cfg.maxEventsTotal : cfg.maxEventsPerChat;
      if (list.length <= limit) continue;
      const keep = [...list]
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return scoreOf(b, now, base) - scoreOf(a, now, base);
        })
        .slice(0, limit);
      const keepIds = new Set(keep.map((e) => e.id));
      for (const e of list) if (!keepIds.has(e.id)) drop.add(e.id);
    }
    // 总量上限
    if (this.events.length - drop.size > cfg.maxEventsTotal) {
      const rest = this.events
        .filter((e) => !drop.has(e.id))
        .sort((a, b) => scoreOf(b, now, base) - scoreOf(a, now, base));
      for (const e of rest.slice(cfg.maxEventsTotal)) drop.add(e.id);
    }
    if (drop.size) this.events = this.events.filter((e) => !drop.has(e.id));
  }

  listEvents({ chatKey = '', scope = '', kinds = null, since = 0, until = 0, userId = '', limit = 100, includeExpired = false, targetChatKey = '' } = {}) {
    this.load();
    const cfg = mcfg();
    const now = Date.now();
    const ck = safeChatKey(chatKey);
    const target = safeChatKey(targetChatKey) || ck;
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
    const uid = safeUserId(userId);
    return this.events
      .filter((e) => {
        if (!includeExpired && e.expiresAt && now > e.expiresAt) return false;
        if (scope && e.scope !== scope) return false;
        if (e.scope === 'chat') {
          if (ck && e.chatKey !== ck) return false;
          if (!ck && target && !this.visible(e.chatKey, target)) return false;
        }
        if (kindSet && !kindSet.has(e.kind)) return false;
        if (since && e.createdAt < since) return false;
        if (until && e.createdAt > until) return false;
        if (uid && !e.participants.includes(uid)) return false;
        return true;
      })
      .sort((a, b) => scoreOf(b, now, cfg.decayHalfLifeDays) - scoreOf(a, now, cfg.decayHalfLifeDays))
      .slice(0, Math.max(1, Number(limit) || 100))
      .map((e) => structuredClone(e));
  }

  /** 改一条已有事件（改作用域 / 重要度 / 内容 / 参与者）。UI 与接口都用它。 */
  updateEvent(eventId, patch = {}) {
    this.load();
    const e = this.events.find((x) => x.id === String(eventId || ''));
    if (!e || !patch || typeof patch !== 'object') return null;

    if (patch.text !== undefined) {
      const t = String(patch.text ?? '').trim();
      if (t) e.text = t.slice(0, 300);
    }
    if (patch.kind !== undefined && EVENT_KINDS.includes(String(patch.kind))) e.kind = String(patch.kind);
    if (patch.importance !== undefined) e.importance = clamp(Number(patch.importance) || 3, 1, 5);
    if (patch.pinned !== undefined) e.pinned = patch.pinned === true;
    if (patch.resolved !== undefined) e.resolved = patch.resolved === true;
    if (Array.isArray(patch.participants)) {
      e.participants = patch.participants.map((p) => safeUserId(p)).filter(Boolean).slice(0, 20);
    }
    if (patch.scope !== undefined) {
      const sc = patch.scope === 'global' ? 'global' : 'chat';
      if (sc === 'global') {
        // 跟人走：记下来源会话，之后靠 origin 做可见性判断
        e.origin = e.origin || e.chatKey || safeChatKey(patch.chatKey) || '';
        e.chatKey = '';
        e.scope = 'global';
      } else {
        // 收回本会话：优先用调用方给的 chatKey，其次退回当初的来源
        const back = safeChatKey(patch.chatKey) || e.origin || e.chatKey;
        if (!back) return null;          // 不知道属于哪个会话就不改，避免产生孤儿事件
        e.chatKey = back;
        e.origin = e.origin || back;
        e.scope = 'chat';
      }
    }
    e.updatedAt = Date.now();
    e.lastTouchedAt = e.updatedAt;
    this.#enforceEventCaps();
    this.#saveEvents();
    return e;
  }

  forgetEvent(eventId) {
    this.load();
    const id = String(eventId || '').trim();
    if (!id) return false;
    const before = this.events.length;
    this.events = this.events.filter((e) => e.id !== id);
    if (this.events.length !== before) {
      this.#saveEvents();
      return true;
    }
    return false;
  }

  /** 标记为已了结（"那件事翻篇了"），保留但不主动注入。 */
  resolveEvent(eventId) {
    this.load();
    const e = this.events.find((x) => x.id === String(eventId || ''));
    if (!e) return false;
    e.resolved = true;
    e.updatedAt = Date.now();
    this.#saveEvents();
    return true;
  }

  // ── 统一检索（记忆检索工具的后端）──
  /**
   * 跨群检索记忆。
   * @returns {{people: object[], events: object[], query: string, total: number}}
   */
  search({ query = '', userId = '', chatKey = '', kinds = null, scope = '', days = 0, limit = 12 } = {}) {
    this.load();
    const cfg = mcfg();
    const now = Date.now();
    const base = cfg.decayHalfLifeDays;
    const tokens = tokenize(query);
    const uid = safeUserId(userId);
    const ck = safeChatKey(chatKey);
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(String)) : null;
    const since = days > 0 ? now - days * DAY_MS : 0;
    const max = Math.max(1, Math.min(50, Number(limit) || 12));

    // 人物：命中名字/昵称/事实内容
    const people = [];
    for (const p of this.people.values()) {
      if (uid && p.userId !== uid) continue;
      const names = Object.values(p.names);
      const visibleFacts = p.facts.filter((f) => !ck || !f.sources.length || f.sources.some((s) => this.visible(s.chatKey, ck)));
      if (!visibleFacts.length && !names.length) continue;
      const hay = [p.primaryName, ...names, ...p.tags, ...visibleFacts.map((f) => f.content)].join(' ');
      const m = tokens.length ? matchScore(tokens, hay) : 0;
      if (tokens.length && m <= 0) continue;
      const relevance = Math.max(0, ...visibleFacts.map((f) => scoreOf(f, now, base)));
      const score = tokens.length ? m * 0.7 + relevance * 0.3 : relevance;
      if (score <= 0) continue;
      people.push({
        userId: p.userId,
        name: p.primaryName || names[0] || p.userId,
        names,
        tags: p.tags,
        chatCount: Object.keys(p.names).length,
        score: Number(score.toFixed(4)),
        facts: visibleFacts
          .map((f) => ({
            id: f.id,
            content: f.content,
            importance: f.importance,
            weight: Number(effectiveWeight(f, now, base).toFixed(3)),
            ago: formatAgo(f.lastTouchedAt, now),
            from: f.sources.map((s) => chatLabel(s.chatKey))
          }))
          .sort((a, b) => b.weight * b.importance - a.weight * a.importance)
          .slice(0, 8)
      });
    }
    people.sort((a, b) => b.score - a.score);

    // 事件
    const events = [];
    for (const e of this.events) {
      if (e.resolved) continue;
      if (e.expiresAt && now > e.expiresAt) continue;
      if (kindSet && !kindSet.has(e.kind)) continue;
      if (scope && e.scope !== scope) continue;
      if (since && e.createdAt < since) continue;
      if (uid && !e.participants.includes(uid)) continue;
      // scope 决定的是"自动注入的范围"；检索是 AI 主动去查，允许跨会话，
      // 但必须过同一个可见性闸门 —— 否则私聊内容会绕过 crossGroupPrivateToGroup。
      if (e.scope === 'chat') {
        if (!ck) continue;                                   // 没有目标会话时不猜，避免跨群串味
        if (e.chatKey !== ck && !this.visible(e.chatKey, ck)) continue;
      } else {
        const src = e.origin || '';
        if (ck && src && !this.visible(src, ck)) continue;
      }
      const m = tokens.length ? matchScore(tokens, e.text) : 0;
      if (tokens.length && m <= 0) continue;
      const relevance = scoreOf(e, now, base);
      const score = tokens.length ? m * 0.7 + relevance * 0.3 : relevance;
      events.push({
        id: e.id,
        text: e.text,
        kind: e.kind,
        scope: e.scope,
        chatKey: e.chatKey,
        from: e.scope === 'chat'
          ? chatLabel(e.chatKey)
          : (e.origin ? `跨群（来自 ${chatLabel(e.origin)}）` : '跨群'),
        participants: e.participants,
        importance: e.importance,
        weight: Number(effectiveWeight(e, now, base).toFixed(3)),
        ago: formatAgo(e.lastMentionAt, now),
        resolved: e.resolved,
        score: Number(score.toFixed(4))
      });
    }
    events.sort((a, b) => b.score - a.score);

    return {
      query: String(query || ''),
      people: people.slice(0, max),
      events: events.slice(0, max),
      total: people.length + events.length
    };
  }

  /** 检索命中即强化：被想起来的事更不容易忘（记忆的"复习效应"）。 */
  reinforce({ factIds = [], eventIds = [] } = {}) {
    this.load();
    const now = Date.now();
    let n = 0;
    const fids = new Set((factIds || []).map(String));
    if (fids.size) {
      for (const p of this.people.values()) {
        let dirty = false;
        for (const f of p.facts) {
          if (!fids.has(f.id)) continue;
          f.weight = clamp(Number(f.weight || 1) + 0.15, 0, 1);
          f.hits = (Number(f.hits) || 0) + 1;
          f.lastTouchedAt = now;
          dirty = true;
          n += 1;
        }
        if (dirty) this.#savePerson(p.userId);
      }
    }
    const eids = new Set((eventIds || []).map(String));
    if (eids.size) {
      let dirty = false;
      for (const e of this.events) {
        if (!eids.has(e.id)) continue;
        e.weight = clamp(Number(e.weight || 1) + 0.15, 0, 1);
        e.hits = (Number(e.hits) || 0) + 1;
        e.lastTouchedAt = now;
        dirty = true;
        n += 1;
      }
      if (dirty) this.#saveEvents();
    }
    return n;
  }

  // ── 提示词注入 ──
  /**
   * 生成【跨群档案】+【长期记忆】两段文本。
   * @param {string} chatKey 当前会话
   * @param {object} opts { userIds, maxChars, now, chatLabeler }
   */
  formatForPrompt(chatKey, { userIds = null, maxChars = 0, now = Date.now(), chatLabeler = null, contextText = '' } = {}) {
    if (!this.enabled) return '';
    this.load();
    const cfg = mcfg();
    const ck = safeChatKey(chatKey);
    // ── 私聊加权（2026-09-16）──
    // 群聊注入要"摊"：一屏好几个人，每人 3 条事实、总共 1400 字就该收手。
    // 私聊只有对方一个人，摊无可摊，按同一套预算算就是把这个人的档案压到三行 ——
    // 这是"私聊容易不记事"的另一半原因。私聊单独放宽预算与每人条数。
    // 注意：【跨群档案】只显示"别的会话里学到的"事实，本会话学到的事走【记忆】，
    //       两段合起来才是完整的"我记得你什么"，所以两边的私聊加权要一起改。
    const priv = Boolean(ck) && ck.startsWith('private:') && cfg.privateBoost !== false;
    const budget = Math.max(300, Number(maxChars) || (priv ? cfg.crossGroupMaxChars * 1.7 : cfg.crossGroupMaxChars));
    const factsPerPerson = priv ? cfg.privateFactsPerPersonInject : cfg.factsPerPersonInject;
    const eventsMax = priv ? cfg.privateEventsMaxInject : cfg.eventsMaxInject;
    const base = cfg.decayHalfLifeDays;
    // 空数组按"未筛选"处理（与 null 同义）：调用方拿不到相关人时会传 []，
    // 若按"只注入这些人"解释就会把整段记忆清空。
    const filter = Array.isArray(userIds) && userIds.length
      ? new Set([...userIds].map((u) => safeUserId(u)).filter(Boolean))
      : null;
    const label = typeof chatLabeler === 'function' ? chatLabeler : chatLabel;

    // ── 相关性加权（2026-09-19）──
    // 与本地印象同样的思路：光看"权重 + 重要度"会永远让几条高分老记忆霸占名额，
    // 跟当下话题无关的旧事实把该讲的事挤出去。传入 contextText 时，
    // 命中的条目获得加成（最多 +0.45，足以在两者分数接近时反超），没传则完全按老口径排。
    const ctxTokens = contextText ? tokenize(String(contextText).slice(0, 2000)) : [];
    const relBonus = (text) => (ctxTokens.length ? matchScore(ctxTokens, text) * 0.45 : 0);
    const rankOf = (entry) => scoreOf(entry, now, base) + relBonus(entry?.content || entry?.text || '');

    const sections = [];

    // ── 表层记忆：别的会话里"刚刚说过的话" ──
    // 放在最前，因为它最有时效性 —— 用户要的就是"私聊问完，另一个群立刻能接上"。
    if (cfg.surfaceEnabled && cfg.surfaceMaxInject > 0) {
      // 传归一化后的 filter（而不是原始 userIds）：空数组在 surfaceForPrompt 里
      // 会被当成"只注入这些人"，把整段【刚刚在别处提到】清空。
      const surf = this.surfaceForPrompt(ck, { userIds: filter ? [...filter] : null, now, chatLabeler: label });
      if (surf) sections.push(surf);
    }

    // ── 跨群档案：只看"来自别的会话"的事实，避免和【记忆】重复 ──
    if (cfg.crossGroupEnabled && cfg.peopleMaxInject > 0) {
      const rows = [];
      for (const p of this.people.values()) {
        if (filter && !filter.has(p.userId)) continue;
        const localName = ck ? (p.names[ck] || '') : '';
        const otherFacts = p.facts.filter((f) => {
          const srcs = f.sources.filter((s) => this.visible(s.chatKey, ck));
          if (!srcs.length) return false;
          // 只有在"别的会话"里也学过，才算跨群信息
          return srcs.some((s) => s.chatKey !== ck);
        });
        if (!otherFacts.length) continue;
        const otherChats = new Set();
        for (const f of otherFacts) {
          for (const s of f.sources) {
            if (this.visible(s.chatKey, ck) && s.chatKey !== ck) otherChats.add(s.chatKey);
          }
        }
        // 时效上限（injectMaxAgeDays，默认 0 = 不限）：太老的条目不再自动注入，
        // 但没删 —— 模型想起来了还能用 memory_search 查到。防的是"张口就来旧印象"。
        // ⚠ pinned（钉住的）豁免这条闸门：它的语义就是"永不过期"，
        //    decay() 与 effectiveWeight() 都按同一口径放行，注入这里漏了会自相矛盾
        //    —— 钉住的记忆不被淘汰、却再也不出现在提示词里，等于白钉。
        const inRange = cfg.injectMaxAgeDays > 0
          ? otherFacts.filter((f) => f.pinned === true
            || (now - (memoryStampOf(f) || now)) / DAY_MS <= cfg.injectMaxAgeDays)
          : otherFacts;
        const pick = inRange
          .sort((a, b) => rankOf(b) - rankOf(a))
          .slice(0, factsPerPerson);
        if (!pick.length) continue;   // 全被时效上限滤掉 → 这个人整条不注入
        rows.push({
          userId: p.userId,
          name: p.primaryName || Object.values(p.names)[0] || p.userId,
          localName,
          otherChats: [...otherChats],
          facts: pick,
          score: Math.max(...pick.map((f) => rankOf(f)))
        });
      }
      rows.sort((a, b) => b.score - a.score);
      const picked = rows.slice(0, cfg.peopleMaxInject);
      if (picked.length) {
        // 段首把"这条信息的地位"写死：以前记的，不是现在的确认。
        // 用户报的"她太容易被记忆影响"，一半来自这里 —— 无时间的断言 + 没有地位说明。
        // ⚠ 只在本轮真的会打标记时才提（annotateAge 关掉时还提就是误导）。
        const lines = [cfg.annotateAge
          ? '【跨群档案】同一个 QQ 号在不同群里是同一个人。下面这些人你以前在别的会话接触过，别当成陌生人。这些都是**以前**记下的，不是现在的确认（带 ⚠ 的很可能已经过时）：跟本人当场说的冲突时，一律以当场说的为准。'
          : '【跨群档案】同一个 QQ 号在不同群里是同一个人。下面这些人你以前在别的会话接触过，别当成陌生人。这些都是**以前**记下的，不是现在的确认：跟本人当场说的冲突时，一律以当场说的为准。'];
        for (const r of picked) {
          const alias = r.localName && r.localName !== r.name ? `，本群叫「${r.localName}」` : '';
          const where = r.otherChats.map((k) => label(k)).slice(0, 3).join('、');
          lines.push(`- ${r.name}（QQ ${r.userId}${alias}${where ? `；另见于 ${where}` : ''}）`);
          for (const f of r.facts) {
            const src = f.sources.find((s) => s.chatKey !== ck && this.visible(s.chatKey, ck));
            const from = src ? `记于 ${label(src.chatKey)}` : '';
            const age = cfg.annotateAge
              ? memoryAgeLabel(memoryStampOf(f), now, { staleDays: cfg.staleDays }).text
              : '';
            const meta = [from, age].filter(Boolean).join(' · ');
            lines.push(`  · ${f.content}${meta ? `（${meta}）` : ''}`);
          }
        }
        sections.push(lines.join('\n'));
      }
    }

    // ── 长期记忆：本会话的长期事件（约定/梗/恩怨/长期话题）──
    if (cfg.eventsEnabled && cfg.eventsMaxInject > 0) {
      const pool = this.events.filter((e) => {
        if (e.resolved) return false;
        if (e.expiresAt && now > e.expiresAt) return false;
        // 时效上限（默认 0 = 不限）：太老的事件不再自动注入，避免"翻旧账"。
        // ⚠ pinned 同样豁免 —— 理由见上面【跨群档案】那处（两处必须同一口径）。
        if (cfg.injectMaxAgeDays > 0 && e.pinned !== true
          && (now - (memoryStampOf(e) || now)) / DAY_MS > cfg.injectMaxAgeDays) return false;
        if (e.scope === 'chat') return ck ? e.chatKey === ck : false;
        // 跨群事件：先过可见性闸门 —— 别让私聊里知道的事绕过 crossGroupPrivateToGroup 溜进群
        const src = e.origin || '';
        if (ck && src && !this.visible(src, ck)) return false;
        // 再要求"涉及的人正好在本次对话里"，否则跨群事件会在所有会话里到处乱冒
        if (filter) return e.participants.some((p) => filter.has(p));
        return true;
      });
      const picked = pool
        .sort((a, b) => rankOf(b) - rankOf(a))
        .slice(0, eventsMax);
      if (picked.length) {
        const labels = { event: '事件', topic: '话题', promise: '约定', joke: '梗', grudge: '恩怨', preference: '偏好' };
        const lines = [cfg.annotateAge
          ? '【长期记忆】这个会话里长期有效的事（不是临时闲聊，可以自然引用，别当成刚发生）。带 ⚠ 的说明过了很久、可能早翻篇了，提之前先想想现在还成不成立：'
          : '【长期记忆】这个会话里长期有效的事（不是临时闲聊，可以自然引用，别当成刚发生）：'];
        for (const e of picked) {
          const who = e.participants.length ? `；涉及 ${e.participants.slice(0, 3).join('、')}` : '';
          const tag = labels[e.kind] || '事件';
          const stale = cfg.annotateAge
            && memoryAgeLabel(memoryStampOf(e), now, { staleDays: cfg.staleDays }).stale;
          lines.push(`- [${tag}] ${e.text}（${formatAgo(e.lastMentionAt, now)}${who}${stale ? '；⚠ 很久没提，可能已了结' : ''}）`);
        }
        sections.push(lines.join('\n'));
      }
    }

    if (!sections.length) return '';
    // 预算裁剪：按行截断，保证不把提示词撑爆
    let out = sections.join('\n\n');
    if (out.length > budget) {
      const kept = [];
      let used = 0;
      for (const line of out.split('\n')) {
        if (used + line.length + 1 > budget) break;
        kept.push(line);
        used += line.length + 1;
      }
      out = `${kept.join('\n')}\n（记忆已按重要性截断）`;
    }
    return out;
  }

  // ── 遗忘曲线维护 ──
  /**
   * 淘汰已经淡出阈值的记忆。返回本次清理统计。
   * 判定：非 pinned 且 importance < keepImportance 且 有效权重 < decayMinWeight
   *       且 最后触碰距今 > decayMinAgeDays。
   */
  decay({ now = Date.now(), dryRun = false } = {}) {
    this.load();
    const cfg = mcfg();
    const base = cfg.decayHalfLifeDays;
    const result = { people: 0, facts: 0, events: 0, peopleRemoved: 0, surface: 0, dryRun: !!dryRun };

    // 判定函数抽出来，保证 dryRun（预览）与真跑用的是同一套标准。
    const keepFact = (f) => {
      if (f.pinned) return true;
      if (Number(f.importance) >= cfg.keepImportance) return true;
      const ageDays = (now - (Number(f.lastTouchedAt) || Number(f.updatedAt) || now)) / DAY_MS;
      if (ageDays < cfg.decayMinAgeDays) return true;
      return effectiveWeight(f, now, base) >= cfg.decayMinWeight;
    };
    const keepEvent = (e) => {
      if (e.pinned) return true;
      if (e.expiresAt && now > e.expiresAt) return false;
      if (Number(e.importance) >= cfg.keepImportance) return true;
      const ageDays = (now - (Number(e.lastTouchedAt) || Number(e.updatedAt) || now)) / DAY_MS;
      if (ageDays < cfg.decayMinAgeDays) return true;
      return effectiveWeight(e, now, base) >= cfg.decayMinWeight;
    };

    let projectedPeople = this.people.size;
    let projectedFacts = 0;
    for (const [uid, person] of [...this.people.entries()]) {
      const kept = person.facts.filter(keepFact);
      const removed = person.facts.length - kept.length;
      if (removed > 0) {
        result.facts += removed;
        // dryRun 只统计、绝不改内存态 —— 否则"预览"会真的把记忆改掉。
        if (!dryRun) {
          person.facts = kept;
          person.updatedAt = now;
          this.#savePerson(uid);
        }
      }
      if (kept.length) {
        projectedFacts += kept.length;
        continue;
      }
      // 已经没有事实了：档案本身留不留，看它是否既无称呼又长期没露面
      result.people += 1;
      const staleProfile = !Object.keys(person.names).length
        && (now - (Number(person.lastSeenAt) || now)) / DAY_MS > Math.max(30, cfg.decayMinAgeDays * 4);
      if (staleProfile) {
        result.peopleRemoved += 1;
        projectedPeople -= 1;
        if (!dryRun) this.forgetPerson(uid);
      }
    }

    const keptEvents = this.events.filter(keepEvent);
    result.events = this.events.length - keptEvents.length;
    if (result.events > 0 && !dryRun) {
      this.events = keptEvents;
      this.#enforceEventCaps();
      this.#saveEvents();
    }
    if (!dryRun) this.#saveMeta({ lastDecayAt: now });
    this.lastMaintenanceAt = now;
    // 表层记忆按 TTL 清理（与长期记忆的遗忘曲线是两套逻辑：这里就是简单到期即删）
    if (!this.surface) this.#loadSurface();
    if (!dryRun) {
      result.surface = this.pruneSurface();
    } else {
      result.surface = (this.surface || []).filter((s) => s.expiresAt && now >= s.expiresAt).length;
    }
    result.kept = {
      people: dryRun ? projectedPeople : this.people.size,
      facts: dryRun ? projectedFacts : [...this.people.values()].reduce((n, p) => n + p.facts.length, 0),
      events: dryRun ? keptEvents.length : this.events.length,
      surface: (this.surface || []).length
    };
    return result;
  }

  stats() {
    this.load();
    const cfg = mcfg();
    const now = Date.now();
    const base = cfg.decayHalfLifeDays;
    const meta = this.meta();
    let facts = 0;
    let weakest = 1;
    const chatSet = new Set();
    for (const p of this.people.values()) {
      facts += p.facts.length;
      for (const ck of Object.keys(p.names)) chatSet.add(ck);
      for (const f of p.facts) weakest = Math.min(weakest, effectiveWeight(f, now, base));
    }
    return {
      enabled: this.enabled,
      dir: this.dir,
      people: this.people.size,
      facts,
      events: this.events.length,
      chatEvents: this.events.filter((e) => e.scope === 'chat').length,
      globalEvents: this.events.filter((e) => e.scope === 'global').length,
      chats: chatSet.size,
      surface: (this.surface || []).filter((s) => !s.expiresAt || now < s.expiresAt).length,
      surfaceEnabled: mcfg().surfaceEnabled,
      weakestWeight: Number(weakest.toFixed(3)),
      lastDecayAt: Number(meta.lastDecayAt) || 0,
      lastConsolidateAt: Number(meta.lastConsolidateAt) || 0
    };
  }

  markConsolidated(at = Date.now()) {
    this.load();
    this.#saveMeta({ lastConsolidateAt: Number(at) || Date.now() });
  }
}
