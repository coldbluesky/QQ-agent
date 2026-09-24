// 长时记忆：像硬盘 / 云盘。
// 不是原始录像：按「日摘要 + 事件块 + 要点卡」压缩分块存放。
// 原始全文仍在 data/messages（真相源）；长时只存可检索的碎片与索引指针。
import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

/**
 * @param {string} root 数据根目录，例如 data/memory-v2
 */
export class LongTermStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.chunksDir = path.join(this.root, 'chunks');
    this.stateFile = path.join(this.root, 'state.json');
    ensureDir(this.chunksDir);
    this.state = readJson(this.stateFile, {
      version: 1,
      // chatKey -> { lastIndexedId, lastTs, dayKeys: { 'YYYY-MM-DD': true } }
      chats: {}
    });
  }

  saveState() {
    atomicWrite(this.stateFile, this.state);
  }

  chunkFile(id) {
    return path.join(this.chunksDir, `${id}.json`);
  }

  writeChunk(chunk) {
    atomicWrite(this.chunkFile(chunk.id), chunk);
    return chunk;
  }

  readChunk(id) {
    return readJson(this.chunkFile(id), null);
  }

  listChunkIds() {
    try {
      return fs.readdirSync(this.chunksDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  /** 会话巩固游标 */
  chatMeta(chatKey) {
    const k = String(chatKey);
    if (!this.state.chats[k]) {
      this.state.chats[k] = { lastIndexedId: 0, lastTs: 0, dayKeys: {} };
    }
    return this.state.chats[k];
  }

}

/** 「日」块 id：day_group_1098345913_2026-09-10 */
export function dayChunkId(chatKey, dayKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return `day_${safe}_${dayKey}`;
}

/** 「小时」块 id：hour_group_1098345913_2026-09-10_14 */
export function hourChunkId(chatKey, hourKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return `hour_${safe}_${String(hourKey).replace(/[^0-9-]/g, '')}`;
}

/** 「事件」块 id（预留）。 */
export function episodeChunkId(chatKey, dayKey, n) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return `ep_${safe}_${dayKey}_${n}`;
}

/** 毫秒 → 当天 YYYY-MM-DD（本地时区）。 */
export function dayKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 毫秒 → 小时段 YYYY-MM-DD HH（本地时区，0~23）。 */
export function hourKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  return `${dayKeyOf(ts)} ${hh}`;
}

/** 小时 → 时段标签：早 / 午 / 下午 / 晚 / 夜。 */
export function timeOfDayOf(tsOrHourKey) {
  let hour;
  if (typeof tsOrHourKey === 'string' && /\d{2}$/.test(tsOrHourKey)) {
    hour = Number(tsOrHourKey.slice(-2));
  } else {
    hour = new Date(Number(tsOrHourKey) || Date.now()).getHours();
  }
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return '';
  if (hour >= 5 && hour < 11) return '早';
  if (hour >= 11 && hour < 14) return '午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚';
  return '夜';
}

export function formatWhen(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
