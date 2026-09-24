// 语义卡片：比「群友印象」更像人的长期常识/事件记忆。
// 本地从小时块/消息启发式抽取，不调模型；注入时按关键词匹配，短文本。
import fs from 'node:fs';
import path from 'node:path';
import { hourKeyOf } from './longterm.js';

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fb) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fb;
  }
}

function atomicWrite(file, data) {
  ensure(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// 更严：避免把闲聊感叹句刷成垃圾卡
const PLAN_RE = /(明天|后天|下周|周末|约好|说好|定了|要去|要来|一起吃|聚餐|考试|比赛|生日|开黑|上线|发布会)/i;
const FACT_RE = /(记住这点|记得我|我是.{0,6}(学生|打工|程序员)|我喜欢.{0,12}|别骂我|雷点是|口头禅)/i;

export class SemanticCardStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'cards.json');
    ensure(this.root);
    const raw = readJson(this.file, { version: 1, cards: [] });
    this.cards = Array.isArray(raw.cards) ? raw.cards : [];
  }

  save() {
    if (this.cards.length > 400) {
      this.cards.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      this.cards = this.cards.slice(0, 400);
    }
    atomicWrite(this.file, { version: 1, cards: this.cards });
  }

  #key(type, chatKey, title) {
    return `${type}|${chatKey}|${String(title).toLowerCase().slice(0, 60)}`;
  }

  upsert({ type, chatKey, title, detail, tags = [], source = 'local', ts = Date.now() }) {
    const t = String(title || '').trim().slice(0, 80);
    if (!t || !chatKey) return null;
    const k = this.#key(type, chatKey, t);
    const existing = this.cards.find((c) => c.key === k);
    if (existing) {
      existing.hits = (existing.hits || 1) + 1;
      existing.lastTs = Math.max(existing.lastTs || 0, ts);
      if (detail) existing.detail = String(detail).slice(0, 200);
      if (tags?.length) existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 8);
      this.save();
      return existing;
    }
    const card = {
      key: k,
      type: type === 'plan' ? 'plan' : (type === 'fact' ? 'fact' : 'topic'),
      chatKey,
      title: t,
      detail: String(detail || '').slice(0, 200),
      tags: (tags || []).map(String).slice(0, 8),
      hits: 1,
      lastTs: ts,
      source
    };
    this.cards.unshift(card);
    this.save();
    return card;
  }

  /** 从该小时的消息行里抽卡片（本地启发式）。 */
  ingestHour(chatKey, snippets = []) {
    if (!Array.isArray(snippets) || !snippets.length) return 0;
    let n = 0;
    for (const s of snippets) {
      const text = String(s?.text || '').trim();
      if (text.length < 10 || text.length > 140) continue;
      if (/[\[【].{0,4}(引用|图片|表情)/.test(text)) continue;
      if ((text.match(/[?？！!]/g) || []).length >= 2) continue; // 感叹/连环问不进卡
      const who = s.self ? '我' : String(s.who || '');
      const type = PLAN_RE.test(text) ? 'plan' : (FACT_RE.test(text) ? 'fact' : null);
      if (!type) continue;
      const title = text.replace(/\s+/g, ' ').slice(0, 40);
      this.upsert({
        type,
        chatKey,
        title,
        detail: `${who}: ${text.slice(0, 100)}`,
        tags: type === 'plan' ? ['计划'] : ['事实'],
        ts: Number(s.ts) || Date.now()
      });
      n += 1;
    }
    return n;
  }

  /** 清掉明显垃圾卡（过短/感叹/图片/语气）。 */
  purgeJunk() {
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => {
      const t = String(c.title || '');
      if (t.length < 12) return false;
      if (/\[图片|【图片|\[表情/.test(t)) return false;
      if (/^(哈哈|草|乐|典|6+|嗯|哦|啊哈|诶嘿)/.test(t)) return false;
      if (/我在的|慢慢聊|旁边看着/.test(t)) return false;
      if ((t.match(/[?？！!]/g) || []).length >= 2) return false;
      // 要么有明确计划词，要么有事实锚点
      if (!PLAN_RE.test(t) && !FACT_RE.test(t) && !/\d{3,}/.test(t)) return false;
      return true;
    });
    if (this.cards.length !== before) this.save();
    return before - this.cards.length;
  }

  /** 按触发文本匹配相关卡片（最多 max 条，短渲染）。 */
  match(query, { chatKey = null, limit = 4, now = Date.now() } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const c of this.cards) {
      if (chatKey && c.chatKey !== chatKey) continue;
      const hay = `${c.title} ${c.detail} ${(c.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      // 关键词粗匹配
      const words = q.match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || [];
      for (const w of words) if (hay.includes(w)) score += 3;
      if (hay.includes(q.slice(0, 12))) score += 4;
      // 新鲜度 + 命中次数
      const ageH = Math.max(1, (now - (c.lastTs || 0)) / 3600000);
      score += Math.min(3, (c.hits || 1) / 2) / Math.log2(ageH + 1);
      if (score > 1.2) scored.push({ score, card: c });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit)).map(({ card, score }) => ({
      type: card.type,
      title: card.title,
      detail: card.detail,
      when: new Date(card.lastTs || now).toISOString().slice(0, 16).replace('T', ' '),
      score: Math.round(score * 10) / 10,
      chatKey: card.chatKey
    }));
  }

  stats() {
    const byType = {};
    for (const c of this.cards) byType[c.type] = (byType[c.type] || 0) + 1;
    return { cards: this.cards.length, byType };
  }
}
