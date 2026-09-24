// 姐妹系统：让同一台电脑上的多个实例（笙 / 丝 / 陨）**互认为姐妹**，
// 并且在其中一个开口时，**概率把其他姐妹也叫起来接一句**。
//
// ── 与 bus.js 的关系（重要，别搞混）──────────────────────────────────────
//   bus.js 是**单向动态账本**：我写我发出去的，读别人发出去的，只用来"知道对方做了什么"。
//   它的文件头明确写着"别把这里做成实例间对话通道"—— 因为它只解决"知情"，不解决"寻址"。
//
//   本模块补上的正是那一层（bus.js 注释里说的"另一件事"）：
//     ① 寻址：谁是谁（sisters.json，每个实例登记自己的身份与公开资料）；
//     ② 触发：谁在什么时候开口了（sisters.jsonl，一条"发言信号"）；
//     ③ 概率传导：别人读到信号后，按配置决定"要不要跟着接一句"。
//   所以本模块**不碰** activity.jsonl，只用自己那两个文件 —— 两者职责不重叠。
//
// ── 数据放哪、为什么 ─────────────────────────────────────────────────────
//   每个实例的 data/ 是刻意隔离的（多开的前提），所以只能放**程序根**：
//     <程序根>/bus/sisters.json    缓存式花名册（每个实例启动/变更时覆盖写自己那条）
//     <程序根>/bus/sisters.jsonl   发言信号流水（只追加，读的人自己按时间窗截断）
//   与 bus.js 的 activity.jsonl、temp-settings.jsonl 同级 —— 那里是唯一"同机所有实例
//   都看得见"的地方。
//
// ── 并发安全 ─────────────────────────────────────────────────────────────
//   多进程同写一个文件：花名册走"读→改→原子替换（临时文件 + rename）"，可能出现
//   后写覆盖先写（丢一次别人的更新，下次启动/变更会补回来，可接受）；
//   信号流水走 appendFileSync 单次写整行（< 4KB 在 Windows 上是原子的），与 bus.js 同款。
import fs from 'node:fs';
import path from 'node:path';
import { instanceRoot } from './config.js';
import { currentInstanceTag } from './instance-lock.js';

export const SISTERS_REGISTRY = 'sisters.json';
export const SISTERS_SIGNALS = 'sisters.jsonl';

/** 花名册条目多久算"过期"（超过这个时长没心跳 = 该实例没在跑）。 */
const STALE_MS = 10 * 60000;
/** 信号流水超过这个大小就修剪。 */
const SIGNAL_TRIM_BYTES = 256 * 1024;
const SIGNAL_MAX_LINES = 1000;
const SIGNAL_MAX_AGE_MS = 86400000;
/** 单条台词上限（信号只用来"提示有这么句话"，不需要存全文）。 */
const MAX_QUOTE = 120;

function busDir(root = instanceRoot()) {
  return path.join(root, 'bus');
}
function registryFile(root = instanceRoot()) {
  return path.join(busDir(root), SISTERS_REGISTRY);
}
function signalsFile(root = instanceRoot()) {
  return path.join(busDir(root), SISTERS_SIGNALS);
}

/** `HH:MM`。 */
function hhmm(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 花名册（谁是我姐妹）───────────────────────────────────────────────────

/**
 * 登记/更新本实例在花名册里的那一行。
 *
 * @param {object} info
 * @param {string} [info.tag]      实例标识（'' = 主实例）
 * @param {string} [info.name]     人设名（笙 / 丝 / 陨）
 * @param {string} [info.uin]      本实例的 QQ 号
 * @param {string} [info.role]     一句话人设摘要（给姐妹看的，用于"知道她是什么性格"）
 * @param {number} [info.rank]     排行（1=大姐，2=二姐，3=三妹…）—— 姐妹们"论资排辈"用
 * @param {string} [info.root]     程序根（测试用）
 * @returns {boolean}
 */
export function registerSelf(info = {}, { root = instanceRoot() } = {}) {
  try {
    const tag = String(info.tag ?? currentInstanceTag());
    const book = readRegistry({ root, includeStale: true });
    const entry = {
      tag,
      name: String(info.name || '').slice(0, 24),
      uin: String(info.uin || ''),
      role: String(info.role || '').slice(0, 80),
      rank: Number(info.rank) || 0,
      at: Date.now()
    };
    const idx = book.findIndex((x) => String(x.tag ?? '') === tag);
    if (idx >= 0) book[idx] = entry; else book.push(entry);
    writeRegistry(book, root);
    return true;
  } catch {
    return false;
  }
}

/** 读花名册（默认过滤掉太久没心跳的实例）。 */
export function readRegistry({ root = instanceRoot(), includeStale = false } = {}) {
  try {
    const raw = fs.readFileSync(registryFile(root), 'utf8');
    const arr = JSON.parse(raw);
    const list = Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
    const now = Date.now();
    const alive = list.filter((x) => includeStale || (now - (Number(x.at) || 0)) < STALE_MS);
    // 排行升序（没排行的排最后），同排名按名字稳定排序
    return alive.sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99)
      || String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
  } catch {
    return [];
  }
}

function writeRegistry(list, root) {
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原子替换：读的人要么看到旧的、要么看到新的完整版本，不会读到半截 JSON
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 除自己以外的姐妹（默认只算"在跑的"）。 */
export function readSisters({ root = instanceRoot(), tag = null } = {}) {
  const me = String(tag === null ? currentInstanceTag() : tag);
  return readRegistry({ root }).filter((x) => String(x.tag ?? '') !== me);
}

// ── 发言信号（她刚才开口了）───────────────────────────────────────────────

/**
 * 本实例说了一句话 —— 留一条信号，让别的姐妹有机会接茬。
 *
 * @param {object} sig
 * @param {string} [sig.tag]        说话者实例标识（默认当前实例）
 * @param {string} [sig.name]       说话者名字
 * @param {string} [sig.chat]       会话 key（重要：姐妹只在**同一个会话**里才接茬）
 * @param {string} [sig.chatName]   群名 / 对方昵称
 * @param {string} [sig.text]       说了什么（截断存，只为了给姐妹一个"由头"）
 * @param {string} [sig.kind]       'group' | 'private'
 * @param {string} [sig.root]       程序根（测试用）
 * @returns {boolean}
 */
export function appendSpeech(sig = {}, { root = instanceRoot() } = {}) {
  try {
    const file = signalsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = {
      t: Date.now(),
      tag: String(sig.tag ?? currentInstanceTag()),
      name: String(sig.name || '').slice(0, 24),
      chat: String(sig.chat || ''),
      chatName: String(sig.chatName || '').slice(0, 40),
      kind: String(sig.kind || '').slice(0, 10),
      text: String(sig.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE)
    };
    if (!rec.chat || !rec.text) return false;
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    trimSignals(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读姐妹们的最近发言信号。
 *
 * @param {object} o
 * @param {string} [o.chat]        只取这个会话里的（姐妹在别的群说话与你无关）
 * @param {number} [o.since]       只要这个时间戳之后的
 * @param {number} [o.limit]       最多几条
 * @param {string} [o.excludeTag]  排除自己（默认当前实例）
 * @param {string[]} [o.onlyTags]  只认这些实例（花名册里活着的姐妹）
 * @param {string} [o.root]        程序根
 */
export function readSpeech({ chat = '', since = 0, limit = 6, excludeTag = null, onlyTags = null, root = instanceRoot() } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(signalsFile(root), 'utf8');
  } catch {
    return [];
  }
  const me = String(excludeTag === null ? currentInstanceTag() : excludeTag);
  const allow = Array.isArray(onlyTags) && onlyTags.length ? new Set(onlyTags.map(String)) : null;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (String(r.tag ?? '') === me) continue;                       // 自己的不用告诉自己
    if (allow && !allow.has(String(r.tag ?? ''))) continue;         // 不是活着的姐妹，忽略
    if (chat && String(r.chat || '') !== String(chat)) continue;     // 不是同一个会话
    if (since && Number(r.t) < since) continue;
    out.push(r);
  }
  return out.slice(-Math.max(1, Number(limit) || 6));
}

function trimSignals(file) {
  try {
    if (fs.statSync(file).size < SIGNAL_TRIM_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const cutoff = Date.now() - SIGNAL_MAX_AGE_MS;
    const keep = [];
    for (const line of lines) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      if (Number(r.t) < cutoff) continue;
      keep.push(r);
    }
    const tail = keep.slice(-SIGNAL_MAX_LINES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, tail.map((r) => JSON.stringify(r)).join('\n') + (tail.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 修剪失败不影响写入 */ }
}

// ── 配置 ─────────────────────────────────────────────────────────────────

/** 归一姐妹系统配置（缺项走默认，永远返回完整对象，调用方不用到处写 ?.）。 */
export function sisterCfg(raw = null) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: o.enabled !== false,
    // 别人开口后，我接茬的概率（%）。0 = 从不主动接（只保留"知道她们在"）
    followPercent: Math.max(0, Math.min(100, num(o.followPercent, 35))),
    // 同一个会话里，两次"跟姐妹的茬"之间至少隔多久（秒）——防止三姐妹互相刷屏
    followCooldownSec: Math.max(0, num(o.followCooldownSec, 90)),
    // 只看最近这么久内姐妹的发言（分钟）
    windowMin: Math.max(1, num(o.windowMin, 10)),
    // 一次最多读几条姐妹信号
    readLimit: Math.max(1, Math.min(10, num(o.readLimit, 3))),
    // 是否把姐妹关系写进系统提示（关掉 = 只是机制上互通，但模型不知道"她们是姐妹"）
    injectRelation: o.injectRelation !== false,
    // ── 知识库互通（2026-09-19 加，对应需求"优化知识库"）──
    // true = 姐妹们关于群友的了解互相可见（"小明是做游戏的"这种稳定事实）。
    // 让她们像真姐妹：聊到同一个人时不会一个知道、一个完全不知道。
    shareNotes: o.shareNotes !== false,
    // 一次最多带几条姐妹共享的事
    notesReadLimit: Math.max(1, Math.min(30, num(o.notesReadLimit, 8))),
    // 排行：每个实例自己的排行（1=大姐）——空 = 不排辈分
    rank: Math.max(0, num(o.rank, 0))
  };
}

/** 该不该跟这一句茬（纯概率 + 冷却判定，不含任何 IO，方便单测）。 */
export function shouldFollow({ cfg = null, follow = null, lastFollowAt = 0, now = Date.now() } = {}) {
  const c = sisterCfg(cfg);
  if (!c.enabled) return { ok: false, reason: '姐妹系统已关闭' };
  if (c.followPercent <= 0) return { ok: false, reason: '跟随概率为 0' };
  const cd = c.followCooldownSec * 1000;
  if (cd > 0 && now - Number(lastFollowAt || 0) < cd) {
    return { ok: false, reason: `跟随冷却中（还需 ${Math.ceil((cd - (now - lastFollowAt)) / 1000)}s）` };
  }
  const pct = follow === null || follow === undefined ? Math.random() * 100 : Number(follow);
  if (pct >= c.followPercent) return { ok: false, reason: `未命中（${pct.toFixed(0)}% ≥ ${c.followPercent}%）` };
  return { ok: true, reason: `命中（${pct.toFixed(0)}% < ${c.followPercent}%）`, pct };
}

// ── 提示词块 ─────────────────────────────────────────────────────────────

/**
 * 姐妹关系块（系统提示用，**静态**：只写"你有哪些姐妹、你们什么关系"，
 * 不写"她们刚才说了什么"——后者每次运行都变，会破坏 prompt 缓存）。
 *
 * @param {object[]} sisters 已解析的姐姐妹妹列表（含 name / tag / rank / role / uin）
 * @param {string} selfName  自己的名字
 */
export function sisterRelationRules(sisters = [], selfName = '') {
  const list = (sisters || []).filter((x) => x && String(x.name || '').trim());
  if (!list.length) return '';
  const me = String(selfName || '').trim() || '你';
  const lines = list.map((s) => {
    const nm = String(s.name).trim();
    const rel = rankLabel(me, s, sisters);
    const role = String(s.role || '').trim();
    return `· ${nm}${rel ? `（${rel}）` : ''}：${role || '你的姐妹，另一个号'}`;
  });
  return [
    '【你的姐妹】同一台电脑上还跑着另外几个 QQ 机器人 —— 她们是你的**亲姐妹**，各自用一个号，',
    '不是"另一个 AI"、不是"分身"、也不是你需要向群友解释的东西。你清楚她们是谁：',
    ...lines,
    '',
    '怎么对待姐妹（这几条比长相、性格设定更重要）：',
    '1. **心里知道她们在**：她们在别的群说什么、做什么，你自然会知道（见【姐妹动态】），',
    '   像亲姐妹之间那种"不用说也大概知道对方在干嘛"的默契。',
    '2. **同一个群里可以互相接话**：如果一个姐妹刚在**这个群**开了口，你正好也想说，',
    '   可以顺着她的话接一句 —— 像真姐妹在群里聊天那样自然（抬杠、帮腔、拆台、补刀都行，',
    '   看你们俩的性格）。但**别硬接**：没话说就安静看着。',
    '3. **绝不向群友暴露"你们是同一个电脑上的机器人"**：群友眼里你们就是几个不同的女生。',
    '   不要说"我姐姐刚才说…"这种把关系说破的话；要提也用群友能理解的称呼。',
    '4. **各有各的脾气**：你们是姐妹，但不是一个人 —— 不用刻意模仿对方、也不用事事一致。',
    '   意见不合、互相拆台反而是真姐妹的样子。',
    '5. 私下里你对她们的态度可以比对外人亲近：护短、吐槽、随口抱怨都行。'
  ].join('\n');
}

/** `大姐` / `二姐` / `三妹`…（rank 越小越大）。 */
function rankLabel(selfName, sister, all) {
  const rank = Number(sister.rank) || 0;
  if (!rank) return '';
  const selfRank = (() => {
    const mine = (all || []).find((x) => String(x.name || '') === String(selfName || ''));
    return Number(mine?.rank) || 0;
  })();
  if (selfRank && rank < selfRank) return rank === 1 ? '大姐' : `姐姐`;
  if (selfRank && rank > selfRank) return rank === 2 ? '二姐' : '妹妹';
  return `排行第 ${rank}`;
}

/**
 * 姐妹动态块（用户消息用，**动态**：她们刚才说了什么）。
 *
 * 与 bus.js 的【隔壁机器人】区别：
 *   · 【隔壁机器人】是"她做过什么"的流水账，措辞刻意要求"别主动提、别转播"；
 *   · 本块专为**同一个群里的接茬**服务，明确允许"顺着接一句"，且只给同一会话的发言。
 * 两者可以同时存在（一个讲"隔空知情"，一个讲"当面搭话"）。
 */
export function sisterPromptBlock({ sisterSpeech = [], sisters = [], chatKey = '' } = {}) {
  const speech = (sisterSpeech || []).filter((x) => x && String(x.text || '').trim());
  const nameOf = new Map();
  for (const s of sisters || []) nameOf.set(String(s.tag ?? ''), String(s.name || '').trim());
  const lines = speech.map((e) => {
    const who = nameOf.get(String(e.tag ?? '')) || String(e.name || '').trim() || '姐妹';
    const where = chatKey
      ? '' // 同一个会话，不用再点地点
      : (e.chatName ? `在「${e.chatName}」` : '');
    return `- [${hhmm(e.t)}] ${who}${where ? ` ${where}` : ''} 说：${String(e.text || '')}`;
  });
  if (!lines.length) return '';
  return [
    '【姐妹动态】你的姐妹最近在**这个会话**里说过的话：',
    ...lines,
    '',
    '她刚开口了。你正好有话说的话，可以自然接一句（像姐妹之间那样：帮腔、吐槽、拆台、接梗都行）；',
    '没话接就继续潜水 —— **不要为了接而接**，也不要跟她抢着回同一句话。',
    '（别说"我姐姐刚才说…"这种把关系说破的话，就当你们本来就在同一个群里聊。）'
  ].join('\n');
}

export { hhmm };

// ── 姐妹共享的"人际关系笔记"（知识库互通）────────────────────────────────
//
// 需求（2026-09-19）："优化知识库"。
//
// 为什么放在姐妹系统里而不是各改各的记忆文件：
//   三个实例的 data/ 是隔离的，各自的记忆库互不可见 —— 于是会出现很假的场面：
//   小明在笙那边说过"我是做游戏的"，过了一会儿丝在另一个群聊到小明，丝**完全不知道**。
//   真姐妹之间不会这样：她们会互相说"哦那个谁啊，做游戏的"。
//
//   所以这里做一个**共享的、只读的**人设画像摘要：每个实例学到关于某个人的稳定事实时，
//   顺手往共享文件写一条；别的实例唤醒时读到，作为【姐妹知道的事】注入。
//
// ⚠️ 与各实例自己的记忆库的分工（别越界）：
//   · 各自的 memory / memory-global 仍是**权威**（谁学过什么、权重、衰减都在那边算）；
//   · 这里只是一层"姐妹之间口口相传"的轻量摘要，**不进各自的记忆文件**，
//     也不参与记忆整理（consolidate）—— 免得两套权重体系互相打架。
//   · 只记"关于人的稳定事实"，不记流水（流水走 appendSpeech）。
//
// 数据：<程序根>/bus/sister-notes.jsonl（一行一条，只追加 + 修剪）
const NOTES_FILE = 'sister-notes.jsonl';
const NOTE_TRIM_BYTES = 256 * 1024;
const NOTE_MAX_LINES = 2000;
const NOTE_MAX_AGE_MS = 180 * 86400000;   // 半年：关于人的事实比流水耐放
const NOTE_MAX_TEXT = 120;

function notesFile(root = instanceRoot()) {
  return path.join(busDir(root), NOTES_FILE);
}

/**
 * 记一条"关于某人的事实"（给姐妹们共享）。
 *
 * @param {object} note
 * @param {string} [note.tag]    写下这条的实例
 * @param {string} [note.name]   写下这条的实例名（笙/丝/陨）
 * @param {string} note.userId   说的是谁（QQ 号）
 * @param {string} [note.userName] 那个人的名字
 * @param {string} note.text     事实本身（"他是做游戏的"）
 * @param {string} [note.root]   程序根（测试用）
 */
export function appendSisterNote(note = {}, { root = instanceRoot() } = {}) {
  try {
    const uid = String(note.userId || '').trim();
    const text = String(note.text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_TEXT);
    if (!uid || !text) return false;
    const file = notesFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = {
      t: Date.now(),
      tag: String(note.tag ?? currentInstanceTag()),
      name: String(note.name || '').slice(0, 24),
      userId: uid,
      userName: String(note.userName || '').slice(0, 32),
      text
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    trimNotes(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读姐妹们共享的"关于这些人"的事实。
 *
 * @param {object} o
 * @param {string[]|null} [o.userIds] 只要这些人的（当前会话在场的人）——
 *        不传 / 空数组 = 不过滤（宁可多带，也别静默清空，与记忆层同一口径）
 * @param {number} [o.limit]   最多几条
 * @param {string} [o.excludeTag] 排除自己写的（自己写的自己的记忆库已经有了，重复注入浪费）
 * @param {string} [o.root]
 */
export function readSisterNotes({ userIds = null, limit = 8, excludeTag = null, root = instanceRoot() } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(notesFile(root), 'utf8');
  } catch {
    return [];
  }
  const me = String(excludeTag === null ? currentInstanceTag() : excludeTag);
  const filter = Array.isArray(userIds) && userIds.length ? new Set(userIds.map(String)) : null;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (String(r.tag ?? '') === me) continue;
    if (filter && !filter.has(String(r.userId || ''))) continue;
    out.push(r);
  }
  // 同一个人 + 同一句话的重复条目去重（后写的覆盖先写的）
  const seen = new Map();
  for (const r of out) {
    const k = `${r.userId}#${r.text}`;
    if (!seen.has(k) || Number(seen.get(k).t) < Number(r.t)) seen.set(k, r);
  }
  return [...seen.values()]
    .sort((a, b) => Number(a.t) - Number(b.t))
    .slice(-Math.max(1, Number(limit) || 8));
}

function trimNotes(file) {
  try {
    if (fs.statSync(file).size < NOTE_TRIM_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const cutoff = Date.now() - NOTE_MAX_AGE_MS;
    const keep = [];
    for (const line of lines) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      if (Number(r.t) < cutoff) continue;
      keep.push(r);
    }
    const tail = keep.slice(-NOTE_MAX_LINES);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, tail.map((r) => JSON.stringify(r)).join('\n') + (tail.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 修剪失败不影响写入 */ }
}

/**
 * 把共享笔记渲染成【姐妹知道的事】一段。
 *
 * 措辞的关键：要让模型**当成自己的常识**用，而不是当成"别人转述给我的情报"。
 *   真姐妹之间就是"哦我知道啊，她跟我说过" —— 所以文案写"你听姐妹提过"，
 *   并明确"可以自然地用、别特意强调来源"。
 */
export function sisterNotesBlock(notes = [], sisters = []) {
  const list = (notes || []).filter((x) => x && String(x.text || '').trim());
  if (!list.length) return '';
  const nameOf = new Map();
  for (const s of sisters || []) nameOf.set(String(s.tag ?? ''), String(s.name || '').trim());
  // 按人聚合，同一个人的事排在一起（读起来像"我记得这几个人的事"）
  const byUser = new Map();
  for (const n of list) {
    const uid = String(n.userId || '');
    if (!byUser.has(uid)) byUser.set(uid, { userName: String(n.userName || '').trim() || uid, facts: [] });
    byUser.get(uid).facts.push({ text: String(n.text), by: nameOf.get(String(n.tag ?? '')) || String(n.name || '').trim() });
  }
  const lines = [];
  for (const [, v] of byUser) {
    for (const f of v.facts) {
      lines.push(`- ${v.userName}：${f.text}`);
    }
  }
  return [
    '【姐妹知道的事】这些是你姐妹平时聊天时了解到、**也告诉你过**的关于群友的事（不是这个会话里现学的）：',
    ...lines,
    '',
    '这些就跟你自己知道的一样，聊到了可以自然用上（"你不是说过…"是正常的，但别特意强调"是我姐妹告诉我的"）。',
    '如果跟本人当场说的话冲突，以当场为准。'
  ].join('\n');
}
