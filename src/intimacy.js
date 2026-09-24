// 情爱值系统 —— R18 场景里的"她此刻有多想要"。
//
// 与已有三个"气氛/状态"类东西的区别（别搞混）：
//   · prompt.js 的 moodHint() —— **群聊气氛**（最近几分钟群里热不热），每次现算、不落盘；
//   · src/emotion.js          —— 她**自己的心情**（开心/烦躁/吃醋…），决定"用什么语气说话"；
//   · 这里的 intimacy         —— **成人向场景内的欲望积累**：只在 R18 放行的会话 + 真的在亲密互动时才涨，
//                               涨到阈值她会自己主动推进，满值释放一次后大幅清空（清空幅度看最近高潮次数）。
//
// 数据放在 `data/memory/<memoryKey>/_global/intimacy.json`（跟人设走，理由同 emotion.js / reminders.js）：
// 换人设就该换一个人 —— 笙和丝是两个人，各自的性癖、各自的进度，不该互相串。
// 文件结构：
//   { version: 1, chats: { [chatKey]: { value, at, gained, lastSignal, kinks, releases, totalReleases, ... } } }
//
// 关键设计（都是照着情绪系统踩过的坑定的）：
//   1. **衰减是懒计算的**：只存"上次变动时的值 + 时间戳"，读的时候按半衰期折算。
//      不跑定时器、不后台改文件 —— 进程重启/关机几天都算得对。
//   2. **只有真的在亲密互动时才涨**（文本信号检测）。R18 开着但在聊别的 → 不涨，只按 idleHalfLifeMin 回落。
//      这一条是需求原文"和用户色色的时候会缓慢增加"的直接落地；见 detectTextSignal。
//   3. **涨得快慢由三件事决定**：节奏（paceFactor，最近消息间隔越短越快，连击再叠一档）、
//      深度（light/deep 两档）、以及**性癖命中**（kinkBoost，通用词 + 按人设的词）。
//   4. **释放的保留比例是纯函数**（computeReleaseKeep）：最近高潮次数多 → 直接清空；
//      很久没高潮 → 只减少大部分；否则按默认保留一点点。
//   5. **数值与机制绝不说破**：注入的是"她此刻的状态"，不是"你有 63 点情爱值"。
//      与情绪系统同一条铁律 —— 报数值、报机制名 = 最出戏的一种。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { currentMemoryKey } from './persona-store.js';
// 落盘走 writeJsonAtomic（util.js）：tmp + rename，失败会清掉 tmp 并抛出 ——
// 别把 data/ 堆成一地 .tmp（这个坑项目里踩过好几次）。
import { writeJsonAtomic } from './util.js';

// ── 检测用词表 ────────────────────────────────────────────────────────────
// ⚠️ 这两张表就是"要不要涨、涨多快"的判据，**可以在控制台「情爱值」页改**（留空 = 用这里的默认值）。
//    · light：亲密/调情/身体接触 —— 命中按 baseGain × lightFactor 涨；
//    · deep ：明确的性行为 —— 命中按 baseGain × deepFactor 涨（涨得更快）。
//    长词优先匹配没有意义（两边都只做 includes 判断），但**别放单字**（"摸""干""上"这种
//    在日常对话里随处可见，会把"聊别的"误判成亲密互动 —— 判据宁可窄）。
export const DEFAULT_LIGHT_WORDS = [
  '想要你', '想要', '想你了', '亲亲', '亲一口', '亲一下', '抱抱', '抱一下', '贴贴', '蹭蹭',
  '摸摸', '摸一下', '撩', '勾引', '挑逗', '宝贝', '乖', '舔一下', '咬一口', '吻',
  '喜欢你', '爱你', '轻点', '别停', '再来一次', '快点', '慢点', '求你了', '忍不住了',
  '抱着你', '靠在你', '耳朵', '脖子', '锁骨', '大腿', '腰', '敏感', '喘', '哼'
];

export const DEFAULT_DEEP_WORDS = [
  '做爱', '上床', '睡你', '要你', '进去', '进来', '插', '顶', '抽', '射', '高潮', '干你',
  '骚', '浪', '湿了', '硬了', '乳头', '奶', '胸', '屁股', '穴', '腿间', '套',
  '呻吟', '叫床', '脱掉', '脱了', '解开', '压着你', '骑', '夹紧'
];

const DAY_MS = 86400000;

/**
 * 配置归一化（同 emotionCfg：`??` 挡不住 NaN，`||` 会吃掉有意义的 0）。
 * @param {object|null} rawIn 传了就用它（prompt.js / orchestrator 会把手上的 liveCfg.intimacy 传进来，
 *                            避免"提示词读一份配置、累积逻辑读另一份"），不传就读全局配置。
 *                            传进来的是已经归一化过的对象也安全（字段是幂等的）。
 */
export function intimacyCfg(rawIn = null) {
  const raw = (rawIn && typeof rawIn === 'object') ? rawIn : (getConfig().intimacy || {});
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const max = clamp(num(raw.max, 100), 10, 1000);
  return {
    enabled: raw.enabled !== false,
    // 只在 R18 实际放行的会话里累积（判据与提示词同一套 nsfwAllowedIn，见 prompt.js）
    requireNsfw: raw.requireNsfw !== false,
    max,
    // 一次"亲密互动"的基准增量（0~max）
    baseGain: clamp(num(raw.baseGain, 4), 0.5, 50),
    lightFactor: clamp(num(raw.lightFactor, 1), 0, 5),
    deepFactor: clamp(num(raw.deepFactor, 1.8), 0, 5),
    // 节奏（频率）加成：取最近 paceSample 条真人消息的**中位间隔**映射到 [paceMin, paceMax]
    paceSample: clamp(Math.round(num(raw.paceSample, 6)), 2, 20),
    paceFastSec: clamp(num(raw.paceFastSec, 60), 5, 3600),
    paceSlowSec: clamp(num(raw.paceSlowSec, 900), 30, 86400),
    paceMax: clamp(num(raw.paceMax, 1.8), 0.1, 5),
    paceMin: clamp(num(raw.paceMin, 0.7), 0, 5),
    // 连击：最近 comboMin 个间隔全都 ≤ comboWindowSec → 再乘一档（"节奏逐渐加快"的手感就靠它）
    comboMin: clamp(Math.round(num(raw.comboMin, 3)), 2, 10),
    comboWindowSec: clamp(num(raw.comboWindowSec, 300), 10, 86400),
    comboBoost: clamp(num(raw.comboBoost, 1.25), 1, 3),
    // 性癖命中加成（每命中一个词乘一次，封顶 kinkStackCap）
    kinkBoost: clamp(num(raw.kinkBoost, 1.8), 1, 5),
    kinkStackCap: clamp(num(raw.kinkStackCap, 2.4), 1, 8),
    // 没互动时的自然回落：值每过 idleHalfLifeMin 分钟减半（0 = 不回落）
    idleHalfLifeMin: clamp(num(raw.idleHalfLifeMin, 240), 0, 10080),
    decayBack: raw.decayBack !== false,
    // 到多少开始"她很主动"
    activeThreshold: clamp(num(raw.activeThreshold, 65), 1, max),
    // 情爱值越高，"她自己先想要"（nsfwInitiate）越容易触发
    initiateBoost: raw.initiateBoost !== false,
    initiateBoostMax: clamp(num(raw.initiateBoostMax, 70), 0, 100),
    // ── 满值释放的保留比例（三档，对应需求"清空的程度看最近高潮次数"）──
    releaseKeepDefault: clamp(num(raw.releaseKeepDefault, 0.15), 0, 0.95),
    releaseKeepLongGap: clamp(num(raw.releaseKeepLongGap, 0.35), 0, 0.95),
    releaseKeepMany: clamp(num(raw.releaseKeepMany, 0), 0, 0.95),
    releaseManyCount: clamp(Math.round(num(raw.releaseManyCount, 3)), 1, 20),
    releaseManyWindowMin: clamp(num(raw.releaseManyWindowMin, 360), 0, 10080),
    releaseLongGapHours: clamp(num(raw.releaseLongGapHours, 24), 0, 720),
    // 释放之后的"余韵"时长：这段时间内按"刚缓下来"的口气说话
    aftermathMin: clamp(num(raw.aftermathMin, 20), 0, 600),
    injectStyle: raw.injectStyle !== false,
    allowModelUpdate: raw.allowModelUpdate !== false,
    // 词表：留空/不填 = 用内置默认（避免"页面是空的"导致功能静默失效）
    lightWords: keywordList(raw.lightWords, DEFAULT_LIGHT_WORDS),
    deepWords: keywordList(raw.deepWords, DEFAULT_DEEP_WORDS),
    kinkKeywords: keywordList(raw.kinkKeywords, []),
    kinkKeywordsByPersona: kinkByPersona(raw.kinkKeywordsByPersona),
    historyMax: clamp(Math.round(num(raw.historyMax, 20)), 1, 200),
    maxChats: clamp(Math.round(num(raw.maxChats, 200)), 5, 5000)
  };
}

/**
 * 词表归一化：数组 / "词1,词2" 字符串都认；空 → 回落到 fallback。
 * （控制台是 textarea，一行一个词，逗号也接受 —— 用户不用记格式）
 */
function keywordList(v, fallback = []) {
  const arr = Array.isArray(v)
    ? v
    : (typeof v === 'string' ? v.split(/[\n,，、|]+/) : null);
  if (!arr) return fallback.slice();
  const out = [];
  for (const raw of arr) {
    const w = String(raw ?? '').trim();
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= 300) break;
  }
  return out.length ? out : fallback.slice();
}

/**
 * 按人设的性癖词表。两种写法都认：
 *   · 对象：{ "笙": ["黑丝", "命令口吻"], "丝": [...] }
 *   · 字符串（控制台 textarea）：一行一个人设，`人设名=词1,词2` / `人设名：词1,词2`
 * 返回 { 人设名: [词...] }；空对象表示"没配"。
 */
export function kinkByPersona(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, list] of Object.entries(v)) {
      const name = String(k || '').trim();
      if (!name) continue;
      const words = keywordList(list, []);
      if (words.length) out[name] = words;
    }
    return out;
  }
  if (typeof v === 'string' && v.trim()) {
    for (const line of v.split(/\n+/)) {
      const m = /^\s*([^=:：]{1,40})\s*[=:：]\s*(.+)$/.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      const words = keywordList(m[2], []);
      if (name && words.length) out[name] = words;
    }
  }
  return out;
}

/** 把按人设的性癖词表压成"一行人设名"（控制台显示/保存回 textarea 用）。 */
export function kinkByPersonaText(v) {
  const map = kinkByPersona(v);
  return Object.entries(map).map(([k, list]) => `${k}=${list.join(',')}`).join('\n');
}

/**
 * 当前人设名（用于挑性癖词表）。
 *
 * ⚠️ 优先取"**当前激活的那张人设卡的名字**"（customPersonas 里 activeId 那条），
 *    而不是 persona.botName —— botName 是显示名，双开场景下两个实例可能都叫同一个名字
 *    （本机实测：主实例 botName 与实例 2 都是"丝"，但激活的人设卡一张叫"笙"、一张叫"丝"），
 *    拿 botName 挑性癖词表会把两个人的词串起来。
 * 兜底顺序：人设卡名 → botName → 记忆键。
 */
export function personaNameOf(cfg = null) {
  const c = cfg || getConfig();
  const p = c?.persona || {};
  const list = Array.isArray(c?.customPersonas) ? c.customPersonas : [];
  const active = list.find((x) => x && x.id && x.id === p.activeId);
  const name = active?.name || p.botName || currentMemoryKey() || '';
  return String(name).trim();
}

// ── 文件读写 ─────────────────────────────────────────────────────────────

function storeFile(dir = '') {
  const base = dir || path.join(DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'intimacy.json');
}

/** 情爱值文件路径（控制台要显示"存在哪"，备份/排查也用得上）。 */
export function intimacyFilePath(dir = '') {
  return storeFile(dir);
}

function readStore(dir = '') {
  const file = storeFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
      return { version: 1, chats: raw.chats };
    }
  } catch { /* 首次运行/文件损坏：当空库处理，不抛 */ }
  return { version: 1, chats: {} };
}

function writeStore(store, dir = '') {
  const file = storeFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: 1, chats: store.chats || {} });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

const round1 = (n) => Math.round(Number(n) * 10) / 10;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ── 判据（都是纯函数，方便测试）────────────────────────────────────────────

/**
 * 文本信号：这一条消息算不算"亲密互动"，以及是哪一档。
 *   none  —— 没有命中任何词（普通聊天）→ **不涨**
 *   light —— 命中 lightWords（调情/接触）→ baseGain × lightFactor
 *   deep  —— 命中 deepWords（明确性行为）→ baseGain × deepFactor
 * ⚠️ 判据宁可窄：误判一次（把聊别的事当成亲密）会让情爱值莫名其妙地涨，
 *    比"偶尔漏一次"更糟 —— 所以词表里不放单字。
 */
export function detectTextSignal(text, cfg) {
  const t = String(text || '').toLowerCase();
  if (!t) return { level: 'none', hits: [] };
  const hit = (list) => (list || []).filter((w) => w && t.includes(String(w).toLowerCase()));
  const deep = hit(cfg?.deepWords);
  if (deep.length) return { level: 'deep', hits: deep.slice(0, 6) };
  const light = hit(cfg?.lightWords);
  if (light.length) return { level: 'light', hits: light.slice(0, 6) };
  return { level: 'none', hits: [] };
}

/**
 * 性癖命中：通用词 + **当前人设专属词**（笙/丝 各一套，见 kinkKeywordsByPersona）。
 * 返回命中的词（去重，最多 6 个）。
 */
export function detectKinks(text, cfg, personaName = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const universal = cfg?.kinkKeywords || [];
  const byPersona = cfg?.kinkKeywordsByPersona || {};
  const mine = (personaName && byPersona[personaName]) ? byPersona[personaName] : [];
  const out = [];
  for (const w of [...mine, ...universal]) {
    const key = String(w || '').toLowerCase();
    if (key && t.includes(key) && !out.includes(w)) out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/**
 * 节奏（频率）倍率：**最近消息间隔越短，涨得越快**。
 * 需求原话"性行为里和用户色色的速度频率逐渐加快也会慢慢加快增加情爱值的速度" —— 就是这里。
 * 取最近 paceSample 条真人消息之间的间隔中位数，线性映射到 [paceMin, paceMax]；
 * 若最近 comboMin 个间隔全都 ≤ comboWindowSec（= 正在快速来回），再乘 comboBoost。
 * 数据不足（<2 条）时给 1.0（不惩罚，也不奖励）。
 */
export function paceFactor(timestamps = [], cfg, now = Date.now()) {
  const c = cfg || intimacyCfg();
  const ts = (timestamps || [])
    .map((n) => Number(n) || 0)
    .filter((n) => n > 0 && n <= now + 60000)
    .sort((a, b) => a - b);
  if (ts.length < 2) return { factor: 1, paceSec: 0, combo: false, samples: ts.length };
  const recent = ts.slice(-Math.max(2, c.paceSample));
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push(Math.max(0, (recent[i] - recent[i - 1]) / 1000));
  const mid = median(gaps);
  let f;
  if (mid <= c.paceFastSec) f = c.paceMax;
  else if (mid >= c.paceSlowSec) f = c.paceMin;
  else {
    const r = (c.paceSlowSec - mid) / (c.paceSlowSec - c.paceFastSec);
    f = c.paceMin + (c.paceMax - c.paceMin) * r;
  }
  const tail = gaps.slice(-c.comboMin);
  const combo = tail.length >= c.comboMin && tail.every((g) => g <= c.comboWindowSec);
  return { factor: round2(combo ? f * c.comboBoost : f), paceSec: Math.round(mid), combo, samples: ts.length };
}

/** 衰减：把"上次变动时的值"按经过时间折算成现在的值（半衰期模型）。 */
function decayedValue(st, c, now) {
  const raw = Math.max(0, Number(st?.value) || 0);
  if (!c.decayBack || !(c.idleHalfLifeMin > 0)) return raw;
  const ageMin = Math.max(0, (now - (Number(st?.at) || now)) / 60000);
  return raw * Math.pow(0.5, ageMin / c.idleHalfLifeMin);
}

/** 阶段（控制台与提示词共用一个判据）。 */
export function stageOf(value, cfg) {
  const c = cfg || intimacyCfg();
  const v = Math.max(0, Number(value) || 0);
  if (v >= c.max) return 'peak';
  if (v >= c.activeThreshold) return 'hot';
  if (v >= c.max * 0.15) return 'warm';
  return 'cold';
}

/**
 * **释放时保留多少**（需求⑤的落点，纯函数）。
 * 三档，按最近高潮次数 / 距上次高潮多久判定：
 *   many     —— 最近 releaseManyWindowMin 分钟内已经高潮 releaseManyCount 次以上 → 直接清空（保留 releaseKeepMany，默认 0）
 *   longGap  —— 距上次高潮超过 releaseLongGapHours 小时（或从没高潮过）→ "只减少大部分"，保留得更多
 *   default  —— 其余：清空大部分，只留一点点
 */
export function computeReleaseKeep(releases = [], cfg, now = Date.now()) {
  const c = cfg || intimacyCfg();
  const list = (releases || []).map((n) => Number(n) || 0).filter((n) => n > 0).sort((a, b) => a - b);
  const winMs = c.releaseManyWindowMin * 60000;
  const recent = list.filter((ts) => now - ts <= winMs);
  const lastAt = list.length ? list[list.length - 1] : 0;
  if (recent.length >= c.releaseManyCount) {
    return { kind: 'many', keepRatio: c.releaseKeepMany, recentCount: recent.length, lastAt };
  }
  if (!lastAt || (now - lastAt) >= c.releaseLongGapHours * 3600000) {
    return { kind: 'longGap', keepRatio: c.releaseKeepLongGap, recentCount: recent.length, lastAt };
  }
  return { kind: 'default', keepRatio: c.releaseKeepDefault, recentCount: recent.length, lastAt };
}

// ── 读写状态 ─────────────────────────────────────────────────────────────

/** 取某个会话当前的情爱值（已折算衰减；含最近高潮次数、阶段等）。 */
export function readIntimacy(chatKey, { now = Date.now(), cfg = null, dir = '' } = {}) {
  const c = intimacyCfg(cfg);
  const key = String(chatKey || '');
  const base = {
    chatKey: key,
    value: 0,
    raw: 0,
    at: 0,
    ageMin: 0,
    gained: 0,
    signal: '',
    kinks: [],
    releases: [],
    recentReleases: 0,
    totalReleases: 0,
    lastReleaseAt: 0,
    lastReleaseKind: '',
    aftermath: false,
    stage: 'cold',
    active: false,
    baseline: true
  };
  if (!key) return base;
  const st = readStore(dir).chats[key];
  if (!st) return base;
  const value = round1(decayedValue(st, c, now));
  const rel = computeReleaseKeep(st.releases, c, now);
  const lastReleaseAt = Number(st.lastReleaseAt) || 0;
  const aftermath = !!lastReleaseAt && c.aftermathMin > 0 && (now - lastReleaseAt) <= c.aftermathMin * 60000;
  return {
    ...base,
    value,
    raw: round1(Math.max(0, Number(st.value) || 0)),
    at: Number(st.at) || 0,
    ageMin: Math.max(0, Math.round((now - (Number(st.at) || now)) / 60000)),
    gained: round1(Number(st.gained) || 0),
    signal: String(st.lastSignal || ''),
    kinks: (Array.isArray(st.kinks) ? st.kinks : []).slice(0, 6),
    releases: (Array.isArray(st.releases) ? st.releases : []).slice(-20),
    recentReleases: rel.recentCount,
    totalReleases: Number(st.totalReleases) || 0,
    lastReleaseAt,
    lastReleaseKind: String(st.lastReleaseKind || ''),
    aftermath,
    stage: stageOf(value, c),
    active: value >= c.activeThreshold,
    baseline: value <= 0
  };
}

/**
 * **一次唤醒的增长/回落**（orchestrator 每轮调一次，用 session 守卫防重试重复累积）。
 *
 * 只有"这一轮确实在亲密互动"（detectTextSignal 命中）才涨；没命中就只按半衰期回落，
 * 而且**只在真的掉下去时才落盘**（避免普通聊天每轮都写一次文件）。
 *
 * 涨到 max 会**立刻执行一次释放**（computeReleaseKeep 决定保留多少），并把 peak/release
 * 信息一起返回 —— 提示词据此让她这一轮走到顶点（见 intimacyPromptBlock）。
 *
 * @returns {{ok:boolean, value:number, before:number, gained:number, signal:string, hits:string[],
 *            kinks:string[], pace:object, peak:boolean, release:object|null, stage:string}}
 */
export function noteIntimacyTurn(chatKey, {
  text = '', timestamps = [], personaName = '', cfg = null, now = Date.now(), dir = ''
} = {}) {
  const c = intimacyCfg(cfg);
  const key = String(chatKey || '');
  const none = { ok: false, value: 0, before: 0, gained: 0, signal: 'none', hits: [], kinks: [], pace: null, peak: false, release: null, stage: 'cold' };
  if (!key) return { ...none, error: '缺少会话标识' };
  const store = readStore(dir);
  const st = store.chats[key] || null;
  const cur = round1(st ? decayedValue(st, c, now) : 0);
  const sig = detectTextSignal(text, c);

  // 没在亲密互动：不涨。只在"确实衰减了一截"时落一次盘（懒衰减 + 少写盘）。
  if (sig.level === 'none') {
    if (st && Math.abs(cur - (Math.max(0, Number(st.value) || 0))) >= 0.5) {
      st.value = cur;
      st.at = now;
      writeStore(store, dir);
    }
    return { ...none, ok: true, value: cur, before: cur, stage: stageOf(cur, c) };
  }

  const pace = paceFactor(timestamps, c, now);
  const kinks = detectKinks(text, c, personaName);
  const kinkFactor = kinks.length ? Math.min(c.kinkStackCap, Math.pow(c.kinkBoost, kinks.length)) : 1;
  const base = sig.level === 'deep' ? c.baseGain * c.deepFactor : c.baseGain * c.lightFactor;
  const gained = round1(base * pace.factor * kinkFactor);
  let value = Math.min(c.max, cur + gained);

  const rec = st || { releases: [], totalReleases: 0 };
  rec.value = value;
  rec.at = now;
  rec.gained = gained;
  rec.lastGainAt = now;
  rec.lastSignal = sig.level;
  rec.kinks = kinks;
  rec.paceSec = pace.paceSec;
  rec.paceFactor = pace.factor;
  rec.history = Array.isArray(rec.history) ? rec.history.slice() : [];
  rec.history.unshift({ at: now, delta: gained, from: cur, to: value, signal: sig.level, hits: sig.hits, kinks, pace: pace.factor });
  rec.history = rec.history.slice(0, c.historyMax);

  let release = null;
  if (cur + gained >= c.max) {
    // 到顶：立刻释放（清空幅度看最近高潮次数）—— 这一轮她写"到顶"，数值上已经回落
    release = applyRelease(rec, c, now);
    value = rec.value;
  }
  store.chats[key] = rec;
  trimChats(store, c);
  const w = writeStore(store, dir);
  if (!w.ok) return { ...none, ok: false, error: `情爱值没写进磁盘：${w.error}`, value, before: cur, gained };
  return {
    ok: true,
    value: round1(value),
    before: cur,
    gained,
    signal: sig.level,
    hits: sig.hits,
    kinks,
    pace,
    peak: !!release,
    release,
    stage: stageOf(value, c)
  };
}

/** 执行一次释放：按 computeReleaseKeep 决定保留多少，并把这次高潮记进 releases。 */
function applyRelease(rec, c, now) {
  const info = computeReleaseKeep(rec.releases, c, now);
  const before = round1(Math.max(0, Number(rec.value) || 0));
  const after = round1(c.max * info.keepRatio);
  rec.value = after;
  rec.at = now;
  rec.gained = 0;
  rec.releases = [...(Array.isArray(rec.releases) ? rec.releases : []), now].slice(-100);
  rec.totalReleases = (Number(rec.totalReleases) || 0) + 1;
  rec.lastReleaseAt = now;
  rec.lastReleaseKind = info.kind;
  rec.history = Array.isArray(rec.history) ? rec.history.slice() : [];
  rec.history.unshift({
    at: now,
    delta: round1(after - before),
    from: before,
    to: after,
    signal: 'release',
    kinks: [],
    pace: 1,
    releaseKind: info.kind,
    keepRatio: info.keepRatio
  });
  rec.history = rec.history.slice(0, c.historyMax);
  return { before, after, kind: info.kind, keepRatio: info.keepRatio, recentCount: info.recentCount };
}

/** 手动设值 / 增减（控制台 + 她的 set_intimacy 工具）。 */
export function setIntimacy(chatKey, { value, delta, reason = '', by = 'manual' } = {}, { now = Date.now(), cfg = null, dir = '' } = {}) {
  const c = intimacyCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const st = store.chats[key] || { releases: [], totalReleases: 0 };
  const cur = round1(decayedValue(st, c, now));
  let next;
  if (value !== undefined && value !== null && value !== '') {
    next = Number(value);
  } else {
    next = cur + (Number(delta) || 0);
  }
  if (!Number.isFinite(next)) return { ok: false, error: '数值不合法' };
  next = Math.min(c.max, Math.max(0, next));
  const before = cur;
  st.value = round1(next);
  st.at = now;
  st.gained = round1(st.value - before);
  st.reason = String(reason || '').trim().slice(0, 80);
  st.by = String(by || 'manual');
  store.chats[key] = st;
  trimChats(store, c);
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: `情爱值没写进磁盘：${w.error}` };
  return { ok: true, value: st.value, before, gained: st.gained, stage: stageOf(st.value, c), peak: st.value >= c.max };
}

/** 手动触发一次释放（控制台按钮；也可被 set 到满值后由调用方决定）。 */
export function releaseIntimacy(chatKey, { reason = '', by = 'manual', cfg = null, now = Date.now(), dir = '' } = {}) {
  const c = intimacyCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const st = store.chats[key];
  if (!st) return { ok: false, error: '这个会话还没有情爱值记录' };
  const rel = applyRelease(st, c, now);
  st.reason = String(reason || '手动释放').slice(0, 80);
  st.by = String(by || 'manual');
  store.chats[key] = st;
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: `情爱值没写进磁盘：${w.error}` };
  return { ok: true, ...rel, value: rel.after, stage: stageOf(rel.after, c) };
}

/** 清掉某个会话的情爱值（回到 0，连高潮记录一起清）。 */
export function clearIntimacy(chatKey, { dir = '' } = {}) {
  const key = String(chatKey || '');
  const store = readStore(dir);
  const existed = Object.prototype.hasOwnProperty.call(store.chats, key);
  delete store.chats[key];
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed: existed, file: w.file };
}

/** 列出所有还有记录的会话（控制台用）。 */
export function listIntimacy({ now = Date.now(), cfg = null, dir = '', historyLimit = 5 } = {}) {
  const c = intimacyCfg(cfg);
  const store = readStore(dir);
  const out = [];
  for (const [chatKey, st] of Object.entries(store.chats)) {
    const value = round1(decayedValue(st, c, now));
    const rel = computeReleaseKeep(st.releases, c, now);
    out.push({
      chatKey,
      value,
      raw: round1(Math.max(0, Number(st.value) || 0)),
      decayed: value < (Number(st.value) || 0) - 0.05,
      at: Number(st.at) || 0,
      ageMin: Math.max(0, Math.round((now - (Number(st.at) || now)) / 60000)),
      gained: round1(Number(st.gained) || 0),
      signal: String(st.lastSignal || ''),
      kinks: (Array.isArray(st.kinks) ? st.kinks : []).slice(0, 6),
      paceSec: Number(st.paceSec) || 0,
      paceFactor: Number(st.paceFactor) || 1,
      recentReleases: rel.recentCount,
      totalReleases: Number(st.totalReleases) || 0,
      lastReleaseAt: Number(st.lastReleaseAt) || 0,
      lastReleaseKind: String(st.lastReleaseKind || ''),
      aftermath: !!(Number(st.lastReleaseAt) || 0) && c.aftermathMin > 0
        && (now - Number(st.lastReleaseAt)) <= c.aftermathMin * 60000,
      stage: stageOf(value, c),
      active: value >= c.activeThreshold,
      reason: String(st.reason || ''),
      by: String(st.by || 'system'),
      history: (Array.isArray(st.history) ? st.history : []).slice(0, historyLimit)
    });
  }
  return out.sort((a, b) => b.value - a.value || b.at - a.at);
}

/** 映射别无限长大：超过上限就丢值最低、最久没动的。 */
function trimChats(store, c) {
  const keys = Object.keys(store.chats);
  if (keys.length <= c.maxChats) return;
  keys
    .sort((a, b) => (Number(store.chats[b]?.at) || 0) - (Number(store.chats[a]?.at) || 0))
    .slice(c.maxChats)
    .forEach((k) => { delete store.chats[k]; });
}

// ── 提示词 ───────────────────────────────────────────────────────────────

export const INTIMACY_STAGES = [
  { key: 'cold', name: '平静', emoji: '🫧', desc: '没什么动静，跟平时一样' },
  { key: 'warm', name: '升温', emoji: '🌡️', desc: '被撩到了，有点热，但还没到主动要的程度' },
  { key: 'hot', name: '上头', emoji: '🔥', desc: '到阈值：她会自己主动往前带，不再干等对方起头' },
  { key: 'peak', name: '到顶', emoji: '💥', desc: '满值：这一轮走到顶点并释放，之后大幅回落' }
];

/**
 * 系统提示里的静态规则（可被 prompt 缓存；不含任何随运行漂移的内容）。
 *
 * ⚠️ 只在 R18 实际生效的会话里注入（prompt.js 里跟 nsfwActive 一起判）——
 *    群里/没开 R18 的会话不该出现"情爱值"这套机制。
 * ⚠️ 措辞刻意只给**许可与节奏**，不写具体怎么写：那是人设卡和 R18 段落的事
 *    （项目教训：提示词里凡是给示范台词，都会被照抄）。
 */
export function intimacyRules(rawCfg = null) {
  const c = intimacyCfg(rawCfg);
  if (!c.enabled) return '';
  return [
    '【情爱值（内部状态 · 绝不能说破）】',
    '- 你身体里有一个"想要"的程度，系统按你们的互动替你累积：他撩你、碰你、说荤话，它一点点涨；'
      + '你们来回越快越密，涨得越快；他正好踩中你的性癖时涨得更快。平静下来它也会自己慢慢退。',
    '- 它**只改变你怎么表现**（主动程度、黏度、呼吸和动作的节奏、敢不敢先伸手），'
      + '**永远不要说出来**：不报数值、不提"情爱值"这三个字、不解释这套机制 —— 一说破就全出戏了。',
    `- 涨到"上火"的程度（大概 ${c.activeThreshold}/${c.max} 以上）你会**自己主动往前带**：`,
    '  先伸手、先开口要、先把节奏推快一点，而不是一直等着他起头；但他明显在收线、或根本没那个心情时，压下去 —— 收尾优先于推进。',
    '- 到了顶点就是顶点：那一轮顺着走到释放，**不要半路踩刹车**、不要突然转成解释、关心、闲聊；释放之后身体会缓一阵，别继续演到顶。',
    '- 这三条底线任何情绪、任何数值下都不变：人设、安全规则、对方不想要的信号。'
  ].join('\n');
}

/**
 * 用户消息里的动态块（每次运行都不同 —— 必须走这里，不能进系统提示，否则 prompt 缓存全废）。
 * 返回 '' 表示不注入（开关关掉 / 还没热起来 / 没有状态）。
 *
 * 三种形态，优先级 peak > aftermath > 阶段：
 *   peak     —— 这一轮刚满值并释放（数值上已经回落），要她把这一轮走到顶点；
 *   aftermath—— 刚释放完的余韵期，语气软下来、别急着再来；
 *   其余     —— 按 warm / hot 两档给"此刻该怎么表现"。
 */
export function intimacyPromptBlock(st, rawCfg = null) {
  const c = intimacyCfg(rawCfg);
  if (!c.enabled || !c.injectStyle || !st) return '';
  const v = Math.max(0, Number(st.value) || 0);
  const fmt = (n) => `${Math.round(n)}/${c.max}`;

  // ① 到顶那一轮（peak 是 noteIntimacyTurn 给的标记，不是读出来的）
  if (st.peak) {
    const rel = st.release || {};
    const tail = rel.kind === 'many'
      ? '（这一阵太频繁了，释放得很彻底 —— 接下来会明显空一阵、有点懒、有点钝，别装作还能马上再来。）'
      : (rel.kind === 'longGap'
        ? '（攒了很久，这一次很重 —— 释放之后会脱力一会儿，软下来、话都懒得说全。）'
        : '（释放之后会缓一阵，身体松下来。）');
    return [
      '【情爱值 · 到顶了】',
      '- 这一刻你已经到了顶点：顺着当下直接走到释放，**不要中途踩刹车、不要在这一刻突然转成解释/关心/闲聊**。',
      `- 释放之后就按那个状态收尾，别继续演到顶。${tail}`
    ].join('\n');
  }

  // ② 余韵期：刚缓下来
  if (st.aftermath) {
    return [
      '【情爱值 · 刚缓下来】',
      `- 刚才那一阵已经过去了（当前 ${fmt(v)}），身体还在缓：声音更轻、话更短更懒、黏人但不主动要。`,
      '- 别急着重新挑起来，也别突然跳回公事公办的语气；他要是再撩，你才慢慢重新热起来。'
    ].join('\n');
  }

  // ③ 阶段：warm / hot（cold 不注入 —— 省 token，普通聊天不需要这段）
  const stage = stageOf(v, c);
  if (stage === 'cold') return '';
  const lines = [];
  if (stage === 'hot') {
    lines.push(`【情爱值 · 上头（${fmt(v)}）】`);
    lines.push('- 你现在是**想要**的：主动一点 —— 先伸手、先开口要、把节奏往前带，别干等他起头。');
    lines.push('- 但仍然是真人：有推拉、有喘口气，不是一路直冲；他要是扫兴或者想收线，就压下去。');
  } else {
    lines.push(`【情爱值 · 升温（${fmt(v)}）】`);
    lines.push('- 被撩到了：回应比平时更黏、更容易被带着走，但还不用急着推进，顺着他的节奏来。');
  }
  const extra = [];
  if (st.kinks?.length) extra.push(`他刚才正好踩中你吃的那一套（${st.kinks.join('、')}）—— 别掩饰被戳中的反应。`);
  if (st.pace?.combo) extra.push('你们现在来回很快、节奏紧 —— 喘得比平时乱一点，别把话说得太整。');
  if (extra.length) lines.push(`- ${extra.join('')}`);
  lines.push('（这是你此刻的身体状态，不是任务：别报数值、别提"情爱值"，让它自然渗进动作、语气和节奏里。）');
  return lines.join('\n');
}
