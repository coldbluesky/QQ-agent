// 海马体：索引 + 「这个记忆在哪、怎么调出来」。
// 不是播放录像：检索返回碎片 + 指针；模型按碎片重建（回忆会变形，这是特性）。
// 遗忘：降低 score / 从倒排摘掉指针，不删长时块文件（原始 messages 更不删）。
import fs from 'node:fs';
import path from 'node:path';
import { tokenize, queryTokens, normText } from './tokenize.js';
import { formatWhen } from './longterm.js';

function readJson(file, fallback) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 倒排结构：
 * {
 *   version: 1,
 *   postings: { token: [ { chunkId, tf } ] },
 *   chunks: { chunkId: { chatKey, dayKey, when, title, snippet, length, score } }
 * }
 */
export class Hippocampus {
  constructor(root) {
    this.root = path.resolve(root);
    this.indexFile = path.join(this.root, 'index.json');
    this.data = readJson(this.indexFile, {
      version: 1,
      postings: {},
      chunks: {}
    });
    if (!this.data.postings) this.data.postings = {};
    if (!this.data.chunks) this.data.chunks = {};
  }

  save() {
    atomicWrite(this.indexFile, this.data);
  }

  /** 索引/更新一个长时块。 */
  indexChunk(chunk) {
    const id = chunk.id;
    // 先从倒排去掉旧 postings
    this.#unindex(id);

    const body = [
      chunk.title || '',
      chunk.summary || '',
      (chunk.snippets || []).map((s) => s.text).join('\n'),
      (chunk.keywords || []).join(' ')
    ].join('\n');

    const tokens = tokenize(body);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

    for (const [t, n] of tf) {
      if (!this.data.postings[t]) this.data.postings[t] = [];
      this.data.postings[t].push({ chunkId: id, tf: n });
    }

    const first = chunk.snippets?.[0]?.ts || chunk.when || 0;
    this.data.chunks[id] = {
      chatKey: chunk.chatKey,
      dayKey: chunk.dayKey,
      hourKey: chunk.hourKey || '',
      timeOfDay: chunk.timeOfDay || '',
      kind: chunk.kind || 'hour',
      when: chunk.when || first,
      title: chunk.title || '',
      snippet: (chunk.summary || chunk.snippets?.[0]?.text || '').slice(0, 160),
      length: body.length,
      score: Number(chunk.score) || 1
    };
    return true;
  }

  #unindex(chunkId) {
    const old = this.data.chunks[chunkId];
    if (!old) {
      // 仍扫 postings 防脏数据
    }
    for (const t of Object.keys(this.data.postings)) {
      const list = this.data.postings[t];
      const next = list.filter((p) => p.chunkId !== chunkId);
      if (next.length === 0) delete this.data.postings[t];
      else if (next.length !== list.length) this.data.postings[t] = next;
    }
  }

  /**
   * 关键词检索 → 候选块。
   * 粗匹配 + 可选时间偏好（「昨天/上次」别去抢今天的问答碎片）。
   */
  searchCandidates(query, { chatKey = null, limit = 12, dayFrom = null, dayTo = null, preferDay = null, preferDayBoost = 1.8, preferTod = null } = {}) {
    const weights = queryTokens(query);
    if (!weights.size) return [];
    // 说了「昨天」就把范围锁到那天及更早，别让今天的问答碎片抢排名
    if (preferDay && !dayTo) dayTo = preferDay;

    /** @type {Map<string, number>} */
    const scores = new Map();
    const seenTok = new Set();

    const applyToken = (tok, w) => {
      if (!tok || seenTok.has(tok + '|' + w)) return;
      seenTok.add(tok + '|' + w);
      const list = this.data.postings[tok] || [];
      for (const p of list) {
        const meta = this.data.chunks[p.chunkId];
        if (!meta) continue;
        if (chatKey && meta.chatKey !== chatKey) continue;
        if (dayFrom && String(meta.dayKey) < String(dayFrom)) continue;
        if (dayTo && String(meta.dayKey) > String(dayTo)) continue;
        const add = w * (1 + Math.log(1 + p.tf)) * (meta.score || 1);
        scores.set(p.chunkId, (scores.get(p.chunkId) || 0) + add);
      }
    };

    for (const [tok, w] of weights) {
      applyToken(tok, w);
      if (tok.length >= 2 && tok.length <= 6 && !(this.data.postings[tok]?.length)) {
        let scanned = 0;
        for (const key of Object.keys(this.data.postings)) {
          if (scanned > 8000) break;
          scanned += 1;
          if (key.length < 2) continue;
          if (key.includes(tok) || tok.includes(key)) {
            applyToken(key, w * 0.55);
          }
        }
      }
    }

    const now = Date.now();
    const ranked = [...scores.entries()]
      .map(([chunkId, score]) => {
        const meta = this.data.chunks[chunkId];
        const ageDays = Math.max(0, (now - (meta?.when || now)) / 86400000);
        const recency = 1 / (1 + ageDays / 60);
        let s = score * (0.85 + 0.15 * recency);
        if (preferDay && meta?.dayKey && String(meta.dayKey) === String(preferDay)) {
          s *= preferDayBoost;
        }
        // 时段：午/早/晚 与 chunk.timeOfDay 对齐则加权
        if (preferTod && meta?.timeOfDay) {
          if (meta.timeOfDay === preferTod) s *= 1.6;
          // 午 vs 下午 沾边也算弱命中
          else if (preferTod === '午' && meta.timeOfDay === '下午') s *= 1.15;
          else if (preferTod === '晚' && meta.timeOfDay === '夜') s *= 1.15;
        }
        return { chunkId, score: s };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
    return ranked;
  }

  /** 读块并切成给模型的碎片（重建素材，不是原文全文回放）。 */
  materialize(chunkId, { maxSnippets = 6 } = {}) {
    const meta = this.data.chunks[chunkId];
    if (!meta) return null;
    // 由调用方传入 longTerm.readChunk —— 避免循环依赖，这里只声明需要的数据
    return { chunkId, meta };
  }

  /**
   * 遗忘：降低块权重或从索引摘除指针（文件仍在）。
   * mode: 'soft' 降权 | 'unlink' 从倒排移除
   */
  forget(chunkId, { mode = 'soft', factor = 0.3 } = {}) {
    const meta = this.data.chunks[chunkId];
    if (!meta) return false;
    if (mode === 'unlink') {
      this.#unindex(chunkId);
      delete this.data.chunks[chunkId];
      this.save();
      return { mode, chunkId };
    }
    meta.score = Math.max(0.05, (meta.score || 1) * factor);
    this.save();
    return { mode, chunkId, score: meta.score };
  }

  stats() {
    return {
      chunks: Object.keys(this.data.chunks).length,
      tokens: Object.keys(this.data.postings).length
    };
  }
}

/** 把块 + 命中分拼成检索结果碎片。 */
export function buildHit(chunk, score, { query = '', maxSnippets = 5 } = {}) {
  const q = normText(query);
  let snippets = chunk.snippets || [];
  if (q) {
    const qtok = new Set(tokenize(q));
    // 「像在问问题」的句子降权，别把刚问的那句当答案
    const isQuestiony = (text) => /(吗|么|呢|什么|啥|谁|哪|几|多少|来着|是不是|还记得|推荐了|吃了)/.test(String(text || ''));
    snippets = [...snippets].sort((a, b) => {
      const sa = (tokenize(a.text || '').filter((t) => qtok.has(t)).length) + (a.self ? 0.2 : 0) - (isQuestiony(a.text) ? 0.8 : 0);
      const sb = (tokenize(b.text || '').filter((t) => qtok.has(t)).length) + (b.self ? 0.2 : 0) - (isQuestiony(b.text) ? 0.8 : 0);
      return sb - sa;
    });
  }
  const picked = snippets.slice(0, maxSnippets).map((s) => ({
    when: formatWhen(s.ts).slice(5, 16),
    ts: s.ts,
    who: s.who,
    self: !!s.self,
    text: String(s.text || '').slice(0, 120)
  }));
  return {
    chunkId: chunk.id,
    chatKey: chunk.chatKey,
    dayKey: chunk.dayKey,
    hourKey: chunk.hourKey || '',
    kind: chunk.kind,
    title: chunk.title,
    score: Math.round(score * 100) / 100,
    summary: String(chunk.summary || '').slice(0, 80),
    snippets: picked
  };
}
