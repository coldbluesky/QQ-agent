// 成本护栏：本地统计，超标时砍掉可选注入，不调模型。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';

const FILE = path.join(DATA_DIR, 'cost-guard.json');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function read() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return { day: today(), chats: {}, totalPrompt: 0 };
  }
}

function write(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* ignore */ }
}

/**
 * 记一次运行的 prompt 用量。
 * @returns {{ reduced: boolean, reason: string, dayPrompt: number }}
 */
export function reportRunCost(chatKey, { promptTokens = 0, cachedTokens = 0 } = {}, cfg = {}) {
  const guard = cfg?.api?.costGuard || {};
  if (guard.enabled === false) return { reduced: false, reason: 'off', dayPrompt: 0 };

  const dayMax = Math.max(0, Number(guard.dayPromptMax) ?? 800000); // 0=不限
  const chatMax = Math.max(0, Number(guard.chatPromptMax) ?? 200000);

  let data = read();
  if (data.day !== today()) {
    data = { day: today(), chats: {}, totalPrompt: 0 };
  }
  const p = Math.max(0, Number(promptTokens) || 0);
  data.totalPrompt = (Number(data.totalPrompt) || 0) + p;
  if (!data.chats[chatKey]) data.chats[chatKey] = 0;
  data.chats[chatKey] = Number(data.chats[chatKey]) + p;
  write(data);

  let reduced = false;
  let reason = '';
  if (dayMax > 0 && data.totalPrompt >= dayMax) {
    reduced = true;
    reason = `day>${dayMax}`;
  } else if (chatMax > 0 && data.chats[chatKey] >= chatMax) {
    reduced = true;
    reason = `chat>${chatMax}`;
  }
  return { reduced, reason, dayPrompt: data.totalPrompt, chatPrompt: data.chats[chatKey] };
}

/** 本会话/今日是否该砍可选注入（在组 prompt 前问一次）。 */
export function shouldReduceOptionalInjects(cfg) {
  const guard = cfg?.api?.costGuard || {};
  if (guard.enabled === false) return { reduce: false, reason: 'off' };
  const dayMax = Math.max(0, Number(guard.dayPromptMax) ?? 800000);
  const data = read();
  if (data.day !== today()) return { reduce: false, reason: 'new-day' };
  if (dayMax > 0 && Number(data.totalPrompt) >= dayMax * 0.85) {
    return { reduce: true, reason: 'near-day-cap' };
  }
  return { reduce: false, reason: '' };
}

export function costGuardStats() {
  const data = read();
  return {
    day: data.day,
    totalPrompt: Number(data.totalPrompt) || 0,
    chats: Object.keys(data.chats || {}).length
  };
}
