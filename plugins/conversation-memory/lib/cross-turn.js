// 跨轮工作记忆：上一轮想到哪了、草稿、未完成意图。
// 每个 chat 一份短档案；TTL 内下一轮可引用，像人「刚聊完还记得」。
import fs from 'node:fs';
import path from 'node:path';

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

function safeName(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

export class CrossTurnWorking {
  constructor(root, { ttlMin = 90, maxChars = 280 } = {}) {
    this.root = path.resolve(root);
    this.ttlMs = Math.max(5, Number(ttlMin) || 90) * 60000;
    this.maxChars = Math.min(800, Math.max(80, Number(maxChars) || 280));
    ensure(this.root);
  }

  #file(chatKey) {
    return path.join(this.root, `${safeName(chatKey)}.json`);
  }

  load(chatKey) {
    const raw = readJson(this.#file(chatKey), null);
    if (!raw) return null;
    if (Date.now() - (raw.at || 0) > this.ttlMs) return null;
    return raw;
  }

  /** 运行结束时写入：本想说什么、搜到什么、是否没说完。 */
  saveAfterRun(chatKey, {
    outcome = '',
    draft = '',
    sent = [],
    lastQuery = '',
    unfinished = false,
    note = ''
  } = {}) {
    const sentText = (Array.isArray(sent) ? sent : [])
      .filter((s) => s?.type === 'text')
      .map((s) => String(s.text || '').slice(0, 60))
      .slice(0, 3);
    const payload = {
      at: Date.now(),
      outcome: String(outcome || '').slice(0, 40),
      draft: String(draft || '').slice(0, this.maxChars),
      sent: sentText,
      lastQuery: String(lastQuery || '').slice(0, 80),
      unfinished: !!unfinished,
      note: String(note || '').slice(0, 120)
    };
    // 完全没信息就不存
    if (!payload.draft && !payload.sent.length && !payload.lastQuery && !payload.unfinished) {
      try { fs.unlinkSync(this.#file(chatKey)); } catch { /* ignore */ }
      return null;
    }
    atomicWrite(this.#file(chatKey), payload);
    return payload;
  }

  clear(chatKey) {
    try { fs.unlinkSync(this.#file(chatKey)); } catch { /* ignore */ }
  }

  /** 渲染成极短一段给提示词。 */
  render(chatKey, { botName = '' } = {}) {
    const w = this.load(chatKey);
    if (!w) return '';
    const bits = [];
    if (w.sent?.length) bits.push(`刚发过「${String(w.sent[0] || '').slice(0, 24)}」`);
    if (w.draft) bits.push(`想了「${String(w.draft).slice(0, 40)}」`);
    if (w.lastQuery) bits.push(`查过${w.lastQuery}`);
    if (w.unfinished) bits.push('没说完');
    if (!bits.length) return '';
    return `【跨轮】${bits.join('；')}。（接着聊，别复读）`;
  }
}
