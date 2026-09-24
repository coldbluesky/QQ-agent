// 短时跨会话感知：处理 A 时，浓缩其它群/私聊最近在聊什么。
// 目标：像人「余光知道隔壁在吵什么」——话题词 + 谁在说 + 尾句，而不是碎原文。
import fs from 'node:fs';
import path from 'node:path';

function loadMessages(messagesDir, chatKey) {
  try {
    const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
    let t = fs.readFileSync(path.join(messagesDir, `${safe}.json`), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}

const STOP = new Set(['这个', '那个', '就是', '还是', '但是', '因为', '所以', '什么', '怎么', '可以', '没有', '我们', '你们', '他们', '自己', '一下', '不是', '如果', '现在', '时候', '一个', '没有', '不会', '知道', '可以', '然后', '但是', '就是', '这个', '那个', '什么', '怎么']);

function topicsOf(texts, limit = 6) {
  const freq = new Map();
  for (const t of texts) {
    for (const w of String(t).toLowerCase().match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || []) {
      if (w.length < 2 || STOP.has(w)) continue;
      if (/^\d+$/.test(w) && w.length < 4) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * @returns {string}
 */
export function buildCrossChatAwareness(messagesDir, currentChatKey, {
  minutes = 12,
  maxChats = 2,
  maxChars = 180,
  excludeSelf = true
} = {}) {
  const cutoff = Date.now() - Math.max(1, Number(minutes) || 12) * 60000;
  let files = [];
  try {
    files = fs.readdirSync(messagesDir).filter((f) => /^(group|private)_\d+\.json$/.test(f));
  } catch {
    return '';
  }

  /** @type {{chatKey:string,n:number,topics:string[],people:string[],tail:string,priority:number}[]} */
  const rows = [];
  for (const f of files) {
    const m = /^(group|private)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const chatKey = `${m[1]}:${m[2]}`;
    if (chatKey === currentChatKey) continue;
    const recent = loadMessages(messagesDir, chatKey).filter((x) => Number(x.ts || 0) >= cutoff);
    if (recent.length < 4) continue;

    const usable = recent.filter((x) => {
      const t = String(x.text || '').trim();
      if (!t) return false;
      if (/^\[(图片|表情|贴图|语音|视频)\]$/.test(t)) return false;
      if (excludeSelf && x.self) return false;
      return t.length >= 4 && t.length < 200;
    });
    if (!usable.length) continue;

    const texts = usable.map((x) => String(x.text || ''));
    const people = [...new Set(usable.slice(-30).map((x) => (x.self ? '我' : x.senderName || x.senderId)))]
      .filter(Boolean).slice(0, 4);
    const topics = topicsOf(texts, 6);
    const tail = String(texts[texts.length - 1] || '').replace(/\s+/g, ' ').slice(0, 36);
    const label = m[1] === 'group' ? `群${m[2]}` : `私聊${m[2]}`;
    // 话题越密、消息越多越优先展示
    rows.push({
      chatKey,
      n: recent.length,
      topics,
      people,
      tail,
      priority: topics.length * 3 + Math.min(20, recent.length) / 5
    });
    // label 暂存
    rows[rows.length - 1].label = label;
  }

  rows.sort((a, b) => b.priority - a.priority);
  const parts = [];
  let used = 0;
  for (const r of rows.slice(0, Math.max(1, maxChats))) {
    const bits = [];
    if (r.topics.length) bits.push(`话题:${r.topics.slice(0, 5).join('/')}`);
    if (r.people.length) bits.push(`在聊:${r.people.join(',')}`);
    if (r.tail) bits.push(`尾句:"${r.tail}"`);
    const line = `${r.label}${r.n}条 ${bits.join(' · ')}`;
    if (used + line.length > maxChars && parts.length) break;
    parts.push(line);
    used += line.length;
  }
  if (!parts.length) return '';
  return `【旁听·${minutes}分钟其它会话】\n${parts.join('\n')}\n（环境感知；别插话除非被点名。别人问起别的情况时可用 memory_search 跨库查。）`;
}
