// 归档：像「打开某一天的完整聊天记录」，而不是只给搜索碎片。
// 真相源仍是 data/messages；归档按天/时段切片，支持 offset 分页。
import fs from 'node:fs';
import path from 'node:path';
import { dayKeyOf, hourKeyOf, formatWhen } from './longterm.js';

function messagesFile(messagesDir, chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(messagesDir, `${safe}.json`);
}

function loadMessages(messagesDir, chatKey) {
  try {
    let t = fs.readFileSync(messagesFile(messagesDir, chatKey), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}

/**
 * 近 N 小时本地摘要：扫原始存档，压成很短的话题线索（不调模型）。
 * 用于可选注入提示词；默认关。
 */
export function buildRecent24hDigest(messagesDir, chatKey, {
  hours = 24,
  maxChars = 240,
  maxItems = 8
} = {}) {
  const cutoff = Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000;
  const msgs = loadMessages(messagesDir, chatKey)
    .filter((m) => Number(m.ts || 0) >= cutoff)
    .filter((m) => {
      const t = String(m.text || '').trim();
      if (!t) return false;
      if (/^\[(图片|表情|贴图|语音|视频)\]$/.test(t)) return false;
      return t.length >= 4;
    });
  if (!msgs.length) return '';

  const freq = new Map();
  for (const m of msgs) {
    const text = String(m.text || '').toLowerCase();
    for (const ch of text.match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || []) {
      if (ch.length < 2) continue;
      if (/^(这个|那个|就是|还是|但是|因为|所以|什么|怎么|可以|没有|我们|你们|他们|自己|一下|不是|如果|现在|时候)$/.test(ch)) continue;
      freq.set(ch, (freq.get(ch) || 0) + 1);
    }
  }
  const topics = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w, n]) => `${w}×${n}`);

  // 几条信息量较大的短句（偏长、非纯语气）
  const samples = msgs
    .map((m) => {
      const t = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      const who = m.self ? '我' : (m.senderName || m.senderId || '?');
      return { t, who, score: t.length + (/[?？]/.test(t) ? 2 : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((s) => `${s.who}: ${s.t}`);

  const parts = [];
  if (topics.length) parts.push(`话题词: ${topics.join(' ')}`);
  if (samples.length) parts.push(samples.join(' | '));
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

function fmtLine(m) {
  const who = m.self ? '我' : (m.senderName || m.senderId || '?');
  const text = String(m.text || '').replace(/\s+/g, ' ').trim();
  const media = Array.isArray(m.media) && m.media.length ? `[媒体x${m.media.length}]` : '';
  return {
    ts: Number(m.ts) || 0,
    when: formatWhen(m.ts),
    mid: m.mid ?? null,
    localId: m.id ?? null,
    who,
    self: !!m.self,
    text: (text + (media && !text.includes(media) ? ` ${media}` : '')).slice(0, 300)
  };
}

/**
 * 会话归档读取器。
 * @param {{ messagesDir: string, memoryRoot?: string }} paths
 */
export class ArchiveReader {
  constructor({ messagesDir }) {
    this.messagesDir = path.resolve(messagesDir);
  }

  listChatKeys() {
    try {
      return fs.readdirSync(this.messagesDir)
        .filter((f) => /^(group|private)_\d+\.json$/.test(f))
        .map((f) => {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          return `${m[1]}:${m[2]}`;
        });
    } catch {
      return [];
    }
  }

  /** 该会话有哪些天（从原始 messages 扫，比索引全）。 */
  listDays(chatKey, { limit = 40 } = {}) {
    const all = loadMessages(this.messagesDir, chatKey);
    /** @type {Map<string, {dayKey:string, count:number, firstTs:number, lastTs:number}>} */
    const days = new Map();
    for (const m of all) {
      const dk = dayKeyOf(m.ts);
      const cur = days.get(dk) || { dayKey: dk, count: 0, firstTs: m.ts, lastTs: m.ts };
      cur.count += 1;
      if (m.ts < cur.firstTs) cur.firstTs = m.ts;
      if (m.ts > cur.lastTs) cur.lastTs = m.ts;
      days.set(dk, cur);
    }
    return [...days.values()]
      .sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1))
      .slice(0, Math.max(1, limit));
  }

  /** 某天有哪些小时段（细粒度列表）。 */
  listHours(chatKey, day, { limit = 24 } = {}) {
    const all = loadMessages(this.messagesDir, chatKey)
      .filter((m) => dayKeyOf(m.ts) === day);
    /** @type {Map<string, number>} */
    const hours = new Map();
    for (const m of all) {
      const hk = hourKeyOf(m.ts);
      hours.set(hk, (hours.get(hk) || 0) + 1);
    }
    return [...hours.entries()]
      .map(([hourKey, count]) => ({ hourKey, count }))
      .sort((a, b) => (a.hourKey < b.hourKey ? -1 : 1))
      .slice(0, Math.max(1, limit));
  }

  /**
   * 按天/时段拉一段更完整的对话（原始存档切片）。
   * @param {{
   *   chatKey: string,
   *   day?: string,          // YYYY-MM-DD
   *   hour?: string,         // YYYY-MM-DD HH（可选，更细）
   *   dayFrom?: string,
   *   dayTo?: string,
   *   offset?: number,       // 从旧到新的偏移（先返回更早的）
   *   limit?: number,        // 本页条数，默认 40，最大 80
   *   query?: string,        // 可选：只保留含关键词的行（粗过滤）
   *   direction?: 'asc'|'desc'
   * }} opts
   */
  load(opts = {}) {
    const chatKey = String(opts.chatKey || '');
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    const limit = Math.min(80, Math.max(1, Number(opts.limit) || 40));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const direction = opts.direction === 'desc' ? 'desc' : 'asc';
    const day = opts.day ? String(opts.day) : null;
    const hour = opts.hour ? String(opts.hour).slice(0, 13) : null; // YYYY-MM-DD HH
    const dayFrom = opts.dayFrom ? String(opts.dayFrom) : null;
    const dayTo = opts.dayTo ? String(opts.dayTo) : null;
    const q = String(opts.query || '').trim().toLowerCase();

    let msgs = loadMessages(this.messagesDir, chatKey);
    if (hour) {
      msgs = msgs.filter((m) => hourKeyOf(m.ts) === hour);
    } else if (day) {
      msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    } else if (dayFrom || dayTo) {
      msgs = msgs.filter((m) => {
        const dk = dayKeyOf(m.ts);
        if (dayFrom && dk < dayFrom) return false;
        if (dayTo && dk > dayTo) return false;
        return true;
      });
    }

    if (q) {
      msgs = msgs.filter((m) => String(m.text || '').toLowerCase().includes(q));
    }

    msgs = msgs.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    const total = msgs.length;
    if (direction === 'desc') {
      // desc：从最新往回翻。offset 从末尾算。
      const end = Math.max(0, total - offset);
      const start = Math.max(0, end - limit);
      const page = msgs.slice(start, end).reverse().map(fmtLine);
      return {
        ok: true,
        chatKey,
        day: hour || day || (dayFrom || dayTo ? `${dayFrom || '*'}~${dayTo || '*'}` : null),
        total,
        offset,
        limit,
        direction,
        returned: page.length,
        // 下一页：再往更早翻
        nextOffset: end,
        hasMore: start > 0,
        note: total === 0
          ? '这一天/这段时间没有存档。'
          : '这是原始存档切片，不是碎片摘要；引用时可用 mid。翻更早用 nextOffset。',
        lines: page
      };
    }

    const page = msgs.slice(offset, offset + limit).map(fmtLine);
    return {
      ok: true,
      chatKey,
      day: day || (dayFrom || dayTo ? `${dayFrom || '*'}~${dayTo || '*'}` : null),
      total,
      offset,
      limit,
      direction,
      returned: page.length,
      nextOffset: offset + page.length,
      hasMore: offset + page.length < total,
      note: total === 0
        ? '这一天/这段时间没有存档。'
        : '原始存档切片；要接着往后翻用 nextOffset。',
      lines: page
    };
  }

  /** 一键：某天完整一天（默认按时间正序）。 */
  loadDay(chatKey, day, { offset = 0, limit = 40, query = '' } = {}) {
    return this.load({ chatKey, day, offset, limit, query, direction: 'asc' });
  }

  /**
   * 围绕命中点拉前后文（自动上下文）。
   * @param {{chatKey:string, hour?:string, day?:string, anchor?:string, before?:number, after?:number, maxChars?:number}} opts
   * anchor: 命中片段原文，用来定位插入点；没有则取该小时中间。
   */
  loadContextAround({ chatKey, hour, day, anchor = '', before = 8, after = 8, maxChars = 1200 } = {}) {
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    let msgs = loadMessages(this.messagesDir, chatKey);
    if (hour) msgs = msgs.filter((m) => hourKeyOf(m.ts) === hour);
    else if (day) msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    msgs = msgs.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!msgs.length) return { ok: true, lines: [], note: '该时段无原始存档' };

    let idx = Math.floor(msgs.length / 2);
    const a = String(anchor || '').trim();
    if (a) {
      // 找最像的那条（长度交集粗匹配）
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < msgs.length; i += 1) {
        const t = String(msgs[i].text || '');
        if (!t) continue;
        let sc = 0;
        if (t.includes(a) || a.includes(t.slice(0, 20))) sc = 100;
        else {
          // 共同 2 字片数量
          const as = a.match(/[一-鿿]{2}|[a-z0-9]{3,}/g) || [];
          for (const w of as) if (w.length >= 2 && t.includes(w)) sc += 2;
        }
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best >= 0 && bestScore >= 2) idx = best;
    }

    const start = Math.max(0, idx - Math.max(1, Number(before) || 8));
    const end = Math.min(msgs.length, idx + 1 + Math.max(1, Number(after) || 8));
    let chars = 0;
    const lines = [];
    for (let i = start; i < end; i += 1) {
      const f = fmtLine(msgs[i]);
      const line = `${f.when.slice(5)} ${f.self ? '我' : f.who}: ${f.text}`;
      if (chars + line.length > maxChars) break;
      chars += line.length;
      const mark = i === idx ? ' ◄命中' : '';
      lines.push(line + mark);
    }
    return {
      ok: true,
      chatKey,
      hour: hour || dayKeyOf(msgs[idx]?.ts),
      totalInSlice: msgs.length,
      anchorIndex: idx,
      lines,
      note: '这是命中点附近的原始对话（不是碎片），可据此回答。'
    };
  }

  /**
   * 全库/时段「某词出现了多少次」——按消息条数计（一条消息里出现多次算 1 条）。
   * 本地扫原始存档，不调模型。
   */
  count({
    chatKey,
    query,
    day = null,
    dayFrom = null,
    dayTo = null,
    caseSensitive = false,
    maxSamples = 8
  } = {}) {
    const q0 = String(query || '').trim();
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    if (!q0) return { ok: false, error: 'query 不能为空' };

    const needle = caseSensitive ? q0 : q0.toLowerCase();
    let msgs = loadMessages(this.messagesDir, chatKey);
    if (day) {
      msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    } else if (dayFrom || dayTo) {
      msgs = msgs.filter((m) => {
        const dk = dayKeyOf(m.ts);
        if (dayFrom && dk < dayFrom) return false;
        if (dayTo && dk > dayTo) return false;
        return true;
      });
    }

    /** @type {Map<string, number>} */
    const byDay = new Map();
    /** @type {Map<string, number>} */
    const byWho = new Map();
    const samples = [];
    let hitMsgs = 0;
    let hitOccurrences = 0;

    for (const m of msgs) {
      const text = String(m.text || '');
      const hay = caseSensitive ? text : text.toLowerCase();
      if (!hay.includes(needle)) continue;
      hitMsgs += 1;
      // 同一条消息内出现次数（简单 split 计）
      const n = hay.split(needle).length - 1;
      hitOccurrences += Math.max(1, n);

      const dk = dayKeyOf(m.ts);
      byDay.set(dk, (byDay.get(dk) || 0) + 1);
      const who = m.self ? '我' : (m.senderName || m.senderId || '?');
      byWho.set(who, (byWho.get(who) || 0) + 1);

      if (samples.length < Math.max(1, maxSamples)) {
        const line = fmtLine(m);
        samples.push({
          when: line.when,
          who: line.who,
          self: line.self,
          text: line.text,
          mid: line.mid,
          dayKey: dk
        });
      }
    }

    const topDays = [...byDay.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dayKey, n]) => ({ dayKey, messages: n }));
    const topWho = [...byWho.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([who, n]) => ({ who, messages: n }));

    return {
      ok: true,
      chatKey,
      query: q0,
      scope: day ? { day } : (dayFrom || dayTo ? { dayFrom, dayTo } : { all: true }),
      note: '按「消息条数」计：一条里出现多次仍算 1 条；occurrences 是条内出现总次数。',
      messages: hitMsgs,
      occurrences: hitOccurrences,
      daysTouched: byDay.size,
      byDay: topDays,
      byWho: topWho,
      samples
    };
  }
}
