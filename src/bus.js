// 跨实例动态账本：让同一台电脑上的多个机器人互相"知道对方刚才做了什么"。
//
// 需求（2026-09-15）："我希望这两个实例消息可以互通（如主实例知道实例 b 刚才做了什么）"。
//
// ── 放在哪、为什么 ──────────────────────────────────────────────────────
//   每个实例的 data/ 是**刻意隔离**的（那是双开的前提），所以共享只能放在
//   **程序根** —— 唯一一份"所有实例都看得见"的地方（主实例的 data/、
//   第二个实例的 data-2/ 都在它下面，但彼此隔离）。
//   文件：`<程序根>/bus/activity.jsonl`，一行一条 JSON，只追加、不重写。
//
// ── 写什么 ──────────────────────────────────────────────────────────────
//   只写"这个实例发出去的东西"（文本 / 图片 / 表情包 / 拍一拍）+ 关键事件（上线 / 掉线）。
//   收到的消息**不写** —— 量是外发的几十倍，全记进去等于每次唤醒白烧几百 token，
//   而需求问的是"它刚才做了什么"，答案恰好就在外发那一边。
//   （粒度是用户 2026-09-15 明确选的："只记外发 + 关键事件"。）
//
// ── 并发安全（两个实例是两个进程，会同时往同一个文件追加）────────────────
//   ① 追加模式 + **一次 write 写完一整行**（含换行）：单次 write 小于 4KB 时在
//      Windows 上是原子的，不会出现两个进程的半行交错。
//   ② 行级解析容错：任何解析失败的行直接跳过 —— 半行、断电截断、手改坏一行，
//      都只损失那一行，不会让整个账本失效。
//   ③ 修剪（trim）走"临时文件 + rename"原子替换，且只在超过阈值时才触发，
//      尽量避开同时写的窗口；修剪失败不影响写入。
//
// ── 读什么 ──────────────────────────────────────────────────────────────
//   读**别人的**（excludeTag），按时间窗 + 条数截断，返回时间正序的最近 N 条。
//   主实例的 tag 是空串（''），这也是一个合法的"要排除的值"。
//
// ⚠️ 别把这里做成"实例间对话通道"。它只是个单向的**动态账本**：写自己的、读别人的。
//   真要做 A→B 传话，得再加一层寻址与幂等，那是另一件事，别顺手塞进这个文件。
import fs from 'node:fs';
import path from 'node:path';
import { instanceRoot } from './config.js';

export const BUS_DIRNAME = 'bus';
export const BUS_FILENAME = 'activity.jsonl';

/** 账本超过这个大小就修剪一次（保留最近 MAX_LINES 行 / MAX_AGE 内）。 */
const TRIM_AT_BYTES = 512 * 1024;
const MAX_LINES = 2000;
/** 修剪后保留的最长历史：双开场景没人会去翻三天前的动态。 */
const MAX_AGE_MS = 3 * 86400000;
/** 单条 text 上限（防止某条超长消息把账本撑爆 / 提示词被一条占满）。 */
const MAX_TEXT = 200;

export function busDir(root = instanceRoot()) {
  return path.join(root, BUS_DIRNAME);
}

export function busFile(root = instanceRoot()) {
  return path.join(busDir(root), BUS_FILENAME);
}

/** `HH:MM`（本地时区）。不复用 util 里那个是为了让本模块能被单独测试、无额外依赖。 */
function hhmm(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 记一条动态。**永不抛错**（账本是锦上添花，不能因为它写不动而影响收发）。
 *
 * @param {object} entry
 * @param {number} [entry.t]        时间戳，默认现在
 * @param {string} [entry.tag]      实例标识（'' = 主实例）
 * @param {string} [entry.name]     实例显示名
 * @param {string} [entry.uin]      这个实例自己的 QQ 号
 * @param {string} [entry.type]     'say' | 'image' | 'sticker' | 'poke' | 'event'
 * @param {string} [entry.chat]     会话 key（'group:123' / 'private:456'）
 * @param {string} [entry.chatName] 群名 / 对方昵称（可为空）
 * @param {string} [entry.to]       私聊对方 QQ
 * @param {string} [entry.text]     内容（事件类填"上线了"这类短句）
 * @param {string} [entry.root]     程序根（测试用）
 * @returns {boolean} 是否真的写进去了
 */
export function appendActivity(entry, { root = instanceRoot() } = {}) {
  try {
    const file = busFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = {
      t: Number(entry?.t) || Date.now(),
      tag: String(entry?.tag ?? ''),
      name: String(entry?.name || '').slice(0, 24),
      uin: String(entry?.uin || ''),
      type: String(entry?.type || 'say').slice(0, 12),
      chat: String(entry?.chat || ''),
      chatName: String(entry?.chatName || '').slice(0, 40),
      to: String(entry?.to || ''),
      text: String(entry?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    };
    // 非事件类必须有内容，否则记了也没意义（空消息会被渲染成"说了："）
    if (!rec.text && rec.type !== 'event') return false;
    // ⚠️ 一次写完一整行（含换行）—— 见文件头"并发安全 ①"
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    maybeTrim(file);
    return true;
  } catch {
    return false;
  }
}

/** 账本太大时原子修剪：保留最近 MAX_LINES 行且不早于 MAX_AGE_MS 的条目。 */
function maybeTrim(file) {
  try {
    if (fs.statSync(file).size < TRIM_AT_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const cutoff = Date.now() - MAX_AGE_MS;
    const keep = [];
    for (const line of lines) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }   // 坏行直接丢
      if (!r || typeof r !== 'object') continue;
      if (Number(r.t) < cutoff) continue;
      keep.push(r);
    }
    const tail = keep.slice(-MAX_LINES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, tail.map((r) => JSON.stringify(r)).join('\n') + (tail.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);   // 原子替换：读的人要么看到旧的、要么看到新的
  } catch { /* 修剪失败不影响写入，下次超大再试 */ }
}

/**
 * 读最近动态。
 *
 * @param {object} o
 * @param {number} [o.since]       只要这个时间戳之后的
 * @param {number} [o.limit]       最多返回几条（取**最近**的 N 条，返回时间正序）
 * @param {string} [o.excludeTag]  排除某个实例（自己的动态不用告诉自己）
 * @param {string} [o.root]        程序根（测试用）
 * @returns {object[]}
 */
export function readActivity({ root = instanceRoot(), since = 0, limit = 40, excludeTag = '' } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(busFile(root), 'utf8');
  } catch {
    return [];    // 还没有账本文件 = 还没有别的实例写过东西
  }
  const want = String(excludeTag ?? '');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }      // 坏行跳过，见文件头 ②
    if (!r || typeof r !== 'object') continue;
    if (String(r.tag ?? '') === want) continue;            // 自己的不用告诉自己
    if (since && Number(r.t) < since) continue;
    out.push(r);
  }
  const n = Math.max(1, Number(limit) || 40);
  return out.slice(-n);
}

/** `group:123` / `private:456` → "在群「XX」" / "私聊 XX"（拿不到群名就用号）。 */
function whereOf(e) {
  const chat = String(e.chat || '');
  if (!chat) return '';
  const [kind, id] = chat.split(':');
  const label = String(e.chatName || '').trim();
  if (kind === 'group') return `在群「${label || id}」`;
  if (kind === 'private') return `私聊 ${label || id}`;
  return `在 ${chat}`;
}

/** 动作词：说 / 发 / 拍了拍。 */
function verbOf(e) {
  if (e.type === 'event') return '';
  if (e.type === 'poke') return '';
  if (e.type === 'image' || e.type === 'sticker') return '发了 ';
  return '说：';
}

/**
 * 把若干条动态渲染成提示词里的一段（空数组 → 空串，调用方直接判空即可）。
 *
 * 措辞有三条硬要求，别"润色"掉：
 *   ① 必须点明这些事发生在**另一个号那边**，不在当前会话 —— 否则模型会把它
 *      当成这个群里刚发生的话，出现"你刚才不是说了…"这种错位。
 *   ② 必须允许它"自然地知道"，否则模型会假装看不见，互通就白做了。
 *   ③ 必须禁止主动提及 / 向群友介绍"另一个机器人"，否则它会到处转播，
 *      在群里暴露"有两个号"这件事。
 */
export function formatActivityBlock(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = list.map((e) => {
    const who = String(e.name || '').trim() || (String(e.tag || '') ? `实例 ${String(e.tag).toUpperCase()}` : '主实例');
    const uin = String(e.uin || '').trim();
    const where = whereOf(e);
    const tail = e.type === 'event'
      ? String(e.text || '')
      : `${verbOf(e)}${String(e.text || '')}`;
    return `- [${hhmm(e.t)}] ${who}${uin ? `(${uin})` : ''}${where ? ` ${where}` : ''} ${tail}`.trimEnd();
  });
  return [
    '【隔壁机器人】同一台电脑上还跑着另一个 QQ 机器人（另一个号，不是这个会话里的人）。'
      + '下面是**它那边**最近说过、做过的事 —— 都发生在别的群里或私聊里，不在当前会话，也不是你说的：',
    ...lines,
    '你可以像"同一个人管着两个号"那样心里有数（当前话题正好相关时，可以自然地用上）。'
      + '但**不要**主动提它、不要复述或转播它的发言，也不要向群友透露"还有一个机器人"这件事。'
  ].join('\n');
}
