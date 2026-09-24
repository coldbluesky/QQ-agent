// 编码与巩固：像保存文件 + 后台整理。
// 把 data/messages 的增量压成「小时块」，写入长时并更新海马索引。
// 比日块更细：检索能定位到大概哪个小时；原始 messages 永不改写。
import fs from 'node:fs';
import path from 'node:path';
import { LongTermStore, hourChunkId, hourKeyOf, timeOfDayOf } from './longterm.js';
import { Hippocampus, buildHit } from './hippocampus.js';
import { tokenize } from './tokenize.js';
import { ingestSemanticFromHour } from './arch.js';

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

function isWorthKeeping(msg) {
  const text = String(msg.text || '').trim();
  if (!text) return false;
  if (/^\[(图片|表情|贴图|语音|视频)\]$/.test(text)) return false;
  // 空合并转发占位（还没展开/展开失败）没有可检索内容
  if (/^\[合并转发聊天记录\]$/i.test(text) || /^\[转发消息\s*[^\]]*\]$/.test(text)) return false;
  return true;
}

function weightOf(msg) {
  const text = String(msg.text || '');
  let w = 1;
  if (text.length >= 12) w += 1;
  if (msg.self) w += 0.2;
  if (/[?？]|为什么|怎么|计划|约定|明天|记得|别忘|推荐|链接|http/i.test(text)) w += 1;
  // 展开后的合并转发通常信息密度高，略加权
  if (/\[合并转发\s*共/.test(text)) w += 2;
  if (text.length <= 2) w *= 0.4;
  return w;
}

export class Consolidator {
  constructor({ messagesDir, memoryRoot }) {
    this.messagesDir = path.resolve(messagesDir);
    this.longterm = new LongTermStore(memoryRoot);
    this.hippo = new Hippocampus(memoryRoot);
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

  /**
   * 巩固单个会话：按小时建块。
   * force=true 时清掉该会话旧 hour/day 块并全量重建。
   */
  consolidateChat(chatKey, { force = false } = {}) {
    const all = loadMessages(this.messagesDir, chatKey);
    const meta = this.longterm.chatMeta(chatKey);
    const start = force ? 0 : Math.max(0, Number(meta.lastIndexedId) || 0);
    const fresh = force ? all : all.filter((m) => Number(m.id) > start);
    if (!fresh.length && !force) {
      return { chatKey, added: 0, chunks: 0, lastIndexedId: meta.lastIndexedId };
    }

    if (force) {
      // 清掉旧的日块/小时块，避免索引里残留粗粒度
      const prefixDay = `day_${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}_`;
      const prefixHour = `hour_${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}_`;
      for (const id of this.longterm.listChunkIds()) {
        if (id.startsWith(prefixDay) || id.startsWith(prefixHour)) {
          this.hippo.forget(id, { mode: 'unlink' });
          try { fs.unlinkSync(this.longterm.chunkFile(id)); } catch { /* ignore */ }
        }
      }
      meta.dayKeys = {};
    }

    /** @type {Map<string, object[]>} */
    const byHour = new Map();
    for (const m of force ? all : fresh) {
      if (!isWorthKeeping(m)) continue;
      const hk = hourKeyOf(m.ts);
      if (!byHour.has(hk)) byHour.set(hk, []);
      byHour.get(hk).push(m);
    }

    let chunkCount = 0;
    for (const [hourKey, newMsgs] of byHour) {
      let hourMsgs = newMsgs;
      if (!force && hourMsgs.length < 8) {
        // 增量很小：合并进已有小时块，避免碎块
        const existing = this.longterm.readChunk(hourChunkId(chatKey, hourKey));
        if (existing) {
          const merged = new Map();
          for (const s of existing.snippets || []) {
            merged.set(`${s.mid ?? s.localId ?? s.ts}`, s);
          }
          for (const m of newMsgs) {
            merged.set(`${m.mid ?? m.id ?? m.ts}`, {
              ts: Number(m.ts) || 0,
              mid: m.mid ?? null,
              localId: m.id ?? null,
              who: m.self ? '我' : (m.senderName || m.senderId || '?'),
              self: !!m.self,
              text: String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
              w: weightOf(m)
            });
          }
          hourMsgs = [...merged.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
        }
      }

      const chunk = this.#buildHourChunk(chatKey, hourKey, hourMsgs);
      this.longterm.writeChunk(chunk);
      this.hippo.indexChunk(chunk);
      // 语义卡片：本地启发式，失败忽略
      try { ingestSemanticFromHour(chatKey, chunk.snippets); } catch { /* ignore */ }
      meta.dayKeys[String(hourKey).slice(0, 10)] = true;
      chunkCount += 1;
    }

    const lastId = all.length ? Number(all[all.length - 1].id) || start : start;
    meta.lastIndexedId = Math.max(Number(meta.lastIndexedId) || 0, lastId);
    if (all.length) meta.lastTs = Number(all[all.length - 1].ts) || meta.lastTs;
    meta.granularity = 'hour';
    this.longterm.saveState();
    this.hippo.save();

    return {
      chatKey,
      added: force ? all.length : fresh.length,
      chunks: chunkCount,
      lastIndexedId: meta.lastIndexedId
    };
  }

  consolidateAll({ force = false } = {}) {
    this.reconcileIndex();
    const results = [];
    for (const chatKey of this.listChatKeys()) {
      results.push(this.consolidateChat(chatKey, { force }));
    }
    this.hippo.save();
    return results;
  }

  /**
   * 对账：磁盘有块、倒排没有 → 补索引。
   * 历史事故：406 块只索引了 70，搜「尼尔原声」永远搜不到。
   */
  reconcileIndex({ force = false } = {}) {
    let added = 0;
    for (const id of this.longterm.listChunkIds()) {
      if (!force && this.hippo.data.chunks[id]) continue;
      const chunk = this.longterm.readChunk(id);
      if (!chunk) continue;
      this.hippo.indexChunk(chunk);
      added += 1;
    }
    if (added) this.hippo.save();
    return { added, total: Object.keys(this.hippo.data.chunks).length };
  }

  #buildHourChunk(chatKey, hourKey, msgsIn) {
    const msgs = msgsIn.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    const lines = [];
    for (const m of msgs) {
      const who = m.self ? '我' : (m.senderName || m.senderId || '?');
      const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      if (!text) continue;
      lines.push({
        ts: Number(m.ts) || 0,
        mid: m.mid ?? null,
        localId: m.id ?? null,
        who,
        self: !!m.self,
        text,
        w: weightOf(m)
      });
    }

    const dayKey = String(hourKey).slice(0, 10);
    const title = `${chatKey} @ ${hourKey}:00`;
    const top = [...lines].sort((a, b) => b.w - a.w).slice(0, 6);
    const summary = top.map((l) => `${l.who}: ${l.text}`).join(' | ').slice(0, 320);

    const freq = new Map();
    for (const l of lines) {
      for (const t of tokenize(l.text)) {
        if (t.length < 2 && !/[a-z0-9]/.test(t)) continue;
        freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
    const keywords = [...freq.entries()]
      .filter(([t, n]) => n >= 2 && t.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([t]) => t);

    // 小时块最多留 80 条碎片，控制索引体积
    return {
      id: hourChunkId(chatKey, hourKey),
      kind: 'hour',
      chatKey,
      dayKey,
      hourKey,
      timeOfDay: timeOfDayOf(hourKey),
      when: lines.length ? lines[lines.length - 1].ts : Date.now(),
      title,
      summary,
      keywords,
      snippets: lines.slice(-80),
      msgCount: lines.length,
      consolidatedAt: Date.now()
    };
  }

  search(query, { chatKey = null, limit = 8, maxSnippets = 5, dayFrom = null, dayTo = null, preferDay = null, preferTod = null } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    // 索引明显落后于磁盘时先对账（防「块在库里但搜不到」）
    try {
      const diskN = this.longterm.listChunkIds().length;
      const idxN = Object.keys(this.hippo.data.chunks).length;
      if (diskN > idxN + 20) this.reconcileIndex();
    } catch { /* ignore */ }
    // 「昨天/上次」→ 偏好前一日
    if (!preferDay && /(昨天|昨晚|昨日|前一天)/.test(q)) {
      const d = new Date(Date.now() - 86400000);
      preferDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    } else if (!preferDay && /(前天)/.test(q)) {
      const d = new Date(Date.now() - 2 * 86400000);
      preferDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    // 「中午/早上/晚上」→ 时段偏好
    if (!preferTod) {
      if (/(中午|午饭|午餐|晌午)/.test(q)) preferTod = '午';
      else if (/(早上|早晨|早饭|早餐)/.test(q)) preferTod = '早';
      else if (/(下午)/.test(q)) preferTod = '下午';
      else if (/(晚上|晚饭|晚餐|夜里|夜里)/.test(q)) preferTod = '晚';
      else if (/(半夜|凌晨|深夜|夜宵|宵夜)/.test(q)) preferTod = '夜';
    }
    const searchOpts = { chatKey, limit: Math.max(limit, 1) * 2, dayFrom, dayTo, preferDay, preferTod };
    let cands = this.hippo.searchCandidates(q, searchOpts);
    if (cands.length < Math.min(3, limit)) {
      const loose = q
        .replace(/[，,。.！!？?、\s：:；;]+/g, ' ')
        .split(/\s+/)
        .flatMap((w) => {
          if (w.length <= 2) return [w];
          const parts = [];
          for (let i = 0; i < w.length; i += 2) parts.push(w.slice(i, i + 3));
          return parts;
        })
        .filter((w) => w.length >= 2)
        .slice(0, 8)
        .join(' ');
      if (loose && loose !== q) {
        const more = this.hippo.searchCandidates(loose, searchOpts);
        const seen = new Set(cands.map((c) => c.chunkId));
        for (const c of more) {
          if (seen.has(c.chunkId)) continue;
          cands.push({ ...c, score: c.score * 0.7 });
        }
        cands.sort((a, b) => b.score - a.score);
      }
    }
    const hits = [];
    for (const c of cands) {
      const chunk = this.longterm.readChunk(c.chunkId);
      if (!chunk) continue;
      hits.push(buildHit(chunk, c.score, { query: q, maxSnippets }));
      if (hits.length >= limit) break;
    }
    return hits;
  }

  stats() {
    return {
      chats: this.listChatKeys().length,
      ...this.hippo.stats(),
      granularity: 'hour',
      memoryRoot: this.longterm.root
    };
  }
}
