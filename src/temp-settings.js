// 临时设定：只在**某一个群**、**某一段时间**内有效的临时交代。
//
// 用户原始需求（2026-09-18）：
//   "有时候想临时设定一些事，但是写到人设表里面以后她会记得。我希望有一个临时设定，
//    它只在单单某一个群使用，并且只在一段时间内有用，过了之后这段临时记忆只剩概述，
//    不会影响其他群的聊天。"
//
// 所以这个模块要同时满足四条：
//   ① 只作用于**单个群**：按群号存、按群号取，私聊和其他群一个字都读不到；
//   ② 只在**有效期**内生效：到期自动失效，不用人工清理；
//   ③ 过期后这段记忆**只剩一句概述**（不再照原样执行，但也不是凭空消失）；
//   ④ 绝不外泄：既不进 persona/customRules（那是跨群全局的），也不进跨群长期记忆。
//
// 和已有模块的关系（别搞混）：
//   · `config.customRules` 是**永久、全局**的附加规则 —— 临时设定存在的意义就是它；
//   · `mute.js` 是**硬闸门**（命中的群连提示词都不拼）—— 临时设定正好相反，是往里加内容；
//   · `emotion.js` / `intimacy.js` 是"她自己的状态"（她变的），临时设定是"管理员交办的"
//     （外界定的），只是碰巧都用"跟人设走的 _global 文件"这一套存法。
//
// 存储：`data/memory/<人设>/_global/temp-settings.json`（跟人设走 —— 换人设就该换一套临时设定）
// 结构：`{ version: 1, groups: { [群号]: { items: [ {id,text,summary,note,at,expiresAt,by} ] } } }`
//
// 三条关键设计（都是想清楚才定的）：
//   1. **过期是懒判定的**（同 emotion.js 的衰减）：只存 `expiresAt`，读的时候和 now 比。
//      不跑定时器、不后台改文件 —— 进程重启 / 关机几天都不会算错。
//   2. **概述是规则生成的**（不调 LLM）：`makeTempSummary()` 剪一句话留档。
//      为什么不用模型总结：过期可能发生在任何一次运行的中间，为一个"收尾"再买一次
//      LLM 调用既贵又可能失败；而且这段概述**不再驱动行为**，剪得粗糙没关系。
//      "剪得不够好"的代价由"正文原样留在文件里、控制台可见"兜住。
//   3. **正文与概述分开注入**：未过期 → 注入正文（照做）；已过期 → 只注入概述，
//      且措辞必须写明"这件事已经过去、只作背景，不要主动提、不要照着演"。
//      ⚠️ 反过来（过期后仍注入正文）会让她永远照着演 —— 那就等于写进人设表了，
//         正好是用户要躲开的那个毛病。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig, instanceRoot } from './config.js';
import { currentMemoryKey } from './persona-store.js';
// 跨实例广播落在 `<程序根>/bus/` —— 复用实例互通那一套目录约定（bus.js 的 busDir），
// 别自己再发明一个"所有实例都看得见"的位置。
import { busDir } from './bus.js';
// 落盘走 writeJsonAtomic（util.js）：tmp + rename，失败会清掉 tmp 并抛出 ——
// 别把 data/ 堆成一地 .tmp（这个坑踩过好几次）。
import { writeJsonAtomic, formatShortTime } from './util.js';

// 正文长度上限的兜底（配置里 maxChars 会盖住它）。临时设定是"交办事项"，
// 不是写小作文；放开了会直接挤占【记忆】【过去状态】的预算。
const HARD_MAX_TEXT = 4000;
const MAX_NOTE = 120;
// 一次给模型看的"已结束概述"最多几条 —— 攒多了会变成一坨"她记得的旧账"
const MAX_BRIEFS_IN_PROMPT = 3;

export const TEMP_MIN_TTL_MIN = 1;
export const TEMP_MAX_TTL_MIN = 60 * 24 * 365; // 最长一年（再长就该写人设表了）

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 取整 + 钳到区间。
 * ⚠️ fallback 必须**显式传**（不能拿 lo 当兜底）：配置里写了个坏值（"abc"）时，
 *    回落到的应该是"默认值"（如 defaultTtlMin 720），而不是"下限"（1 分钟）——
 *    否则一个手滑的错别字会把临时设定悄悄变成 60 秒就过期。
 */
function clampRound(v, fallback, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(num(v, fallback))));
}

/**
 * 配置归一化（同 emotion.js 的 emotionCfg：`??` 挡不住 NaN，`||` 会吃掉有意义的 0）。
 * @param {object|null} rawIn 传了就用它（prompt.js 会把 liveCfg.tempSettings 传进来，
 *                            避免"提示词读一份配置、接口读另一份"），不传就读全局配置。
 *                            传进来的是归一化过的对象也安全（字段是幂等的）。
 */
// ── 群内指令解析（orchestrator 拦截调用）────────────────────────────────
//
// 用户原始需求（2026-09-20）："临时设定不想每次都开控制台，想在群里直接说一句"。
// 形态：`临时设定：这小时只聊游戏，持续 60 分钟`（"持续…"可省略 → 用默认有效期）。
//
// 判定原则与 admin.parseAdminCommand 一致：**整句就是在下指令** ——
// 开头必须是「临时设定/临时交代/临时约定」+ 分隔符，不是则当普通聊天放行。
// （不宽容称呼前缀：设定内容本身就是自由文本，前缀宽容会把
//  "我记得之前那个临时设定说…" 误判成指令。）

/** 指令词头：必须出现在句首。 */
const TEMP_CMD_HEAD = /^(?:临时设定|临时交代|临时约定)\s*[：:]\s*([\s\S]+)$/;
/** 时长尾巴：`持续 30 分钟` / `有效期 2 小时` / `持续1天`。 */
const TEMP_CMD_DUR = /(?:持续|有效期?|时限|有效)\s*(\d+)\s*(分钟|小时|天)\s*$/;

/**
 * 解析一条群消息是不是临时设定指令。
 * @returns {{ text: string, ttlMin: number|null } | null} null = 不是指令
 *   （ttlMin 为 null 表示没写时长，setTempSetting 会用 defaultTtlMin）
 */
export function parseTempCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 1200) return null;   // 超长基本是复制粘贴的聊天记录，不是指令
  const head = TEMP_CMD_HEAD.exec(raw);
  if (!head) return null;
  let body = head[1].trim();
  if (!body) return null;
  let ttlMin = null;
  const dur = TEMP_CMD_DUR.exec(body);
  if (dur) {
    const n = Number(dur[1]);
    if (Number.isFinite(n) && n > 0) {
      ttlMin = dur[2] === '小时' ? n * 60 : dur[2] === '天' ? n * 24 * 60 : n;
      body = body.slice(0, dur.index).trim();
    }
  }
  // 去掉指令内容末尾可能残留的句号（"只聊游戏。"→"只聊游戏"），语气词保留
  body = body.replace(/[。．.]+\s*$/, '').trim();
  if (!body) return null;
  return { text: body, ttlMin: Number.isFinite(ttlMin) ? ttlMin : null };
}

export function tempSettingsCfg(rawIn = null) {
  const raw = (rawIn && typeof rawIn === 'object') ? rawIn : (getConfig().tempSettings || {});
  return {
    enabled: raw.enabled !== false,
    // 不填 ttlMin 时用这个默认有效期（分钟）。默认 12 小时：够覆盖"今天下午"这类交办，
    // 又短到不会变成事实上的永久设定。
    defaultTtlMin: clampRound(raw.defaultTtlMin, 720, TEMP_MIN_TTL_MIN, TEMP_MAX_TTL_MIN),
    // 同一个群最多同时挂几条（超出丢最旧的）—— 防止临时设定变成第二个 customRules
    maxPerGroup: clampRound(raw.maxPerGroup, 5, 1, 50),
    // 最多给多少个群挂着（防止映射无限长大）
    maxGroups: clampRound(raw.maxGroups, 100, 1, 5000),
    // 过期后是否还把"概述"当背景注入 —— 默认开，就是用户说的"只剩概述"。
    // 关掉 = 过期即彻底静音（正文也不删，只是不再出现）。
    keepBrief: raw.keepBrief !== false,
    // 概述长度（字）
    briefMaxChars: clampRound(raw.briefMaxChars, 60, 10, 200),
    // 过期记录保留多久（天）：超过就真的删掉。0 = 过期即删（连概述都不留）
    keepDays: clampRound(raw.keepDays, 30, 0, 3650),
    // 单条正文长度上限
    maxChars: clampRound(raw.maxChars, 1000, 20, HARD_MAX_TEXT),
    // 「开场反应只做一次」的时限（分钟）。背景见 config.js 与 tempSettingsPromptBlock 里
    // 那段事故说明（2026-09-19：三个号反复复读"主人你怎么变成这样了？"）。
    // 0 = 关掉时限提示（回归开关）。
    reactWindowMin: clampRound(raw.reactWindowMin, 30, 0, 1440),
    // ── 跨实例广播 ──
    // true = 读（并在控制台可写）"同一台电脑上所有实例共用"的那一份临时设定。
    // 为什么需要它（用户 2026-09-19）："我希望这个可以一次性给所有实例设定" ——
    // 三个号（笙/丝/陨）各开一个控制台手抄一遍太蠢，而且抄漏一个就"只有两个号照做"。
    // 关掉后：只认本实例自己的那一份（每实例可以各自设，互不影响）。
    crossInstance: raw.crossInstance !== false,
    // ── 群内指令（orchestrator 拦截「临时设定：…」）──
    // 开关 + 权限：默认只有管理员（config.admin.admins，含 '*' 全局）能在群里发指令，
    // 防止任意群友给机器人塞临时人设。allowCommand 打开且管理员未配置时指令无效
    // （isAdmin 恒 false，消息按普通聊天放行）—— 不会报错，只是不生效。
    allowCommand: raw.allowCommand !== false,
    // true = 任何群成员都能发临时设定指令（信任度高的私群才开）
    commandAllowEveryone: raw.commandAllowEveryone === true
  };
}

/** 群号归一化：只认纯数字（临时设定只在群里生效，私聊没有群号可用）。 */
export function normalizeGroupId(id) {
  const s = String(id ?? '').trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

// ── 文件读写 ─────────────────────────────────────────────────────────────

function storeFile(dir = '') {
  const base = dir || path.join(DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'temp-settings.json');
}

/** 临时设定文件路径（控制台要显示"存在哪"，备份/排查时也用得上）。 */
export function tempSettingsFilePath(dir = '') {
  return storeFile(dir);
}

function readStore(dir = '') {
  const file = storeFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.groups && typeof raw.groups === 'object') {
      return { version: 1, groups: raw.groups };
    }
  } catch { /* 首次运行/文件损坏：当空库处理，不抛 */ }
  return { version: 1, groups: {} };
}

function writeStore(store, dir = '') {
  const file = storeFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: 1, groups: store.groups || {} });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

function nextId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── 概述 ─────────────────────────────────────────────────────────────────

/**
 * 把正文剪成一句"概述"（规则，零 LLM）。
 *
 * 判据刻意简单：优先在句子边界（。！？；）切，切不出来就硬切 + 省略号。
 * 剪掉的尾巴不再有语义 —— 没关系，这段概述**不驱动行为**，只是让她"不至于完全没印象"。
 */
export function makeTempSummary(text, maxChars = 60) {
  const limit = Math.max(10, Math.round(num(maxChars, 60)));
  // 压平换行/多余空白：交办常常是几条 bullet，压成一行才好当"概述"读
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= limit) return flat;
  const head = flat.slice(0, limit);
  const m = head.match(/^[\s\S]*[。！？；!?;]/);
  // 只有切出来的句子"够长"才认它，否则会为了一句"嗯。"把整段概述缩成两个字
  if (m && m[0].trim().length >= Math.min(12, Math.floor(limit / 2))) return m[0].trim();
  return `${head.replace(/[，,、：:\s]+$/, '')}…`;
}

/** 剩余时长的人话（分钟 → "3 小时"/"2 天"）。 */
export function leftText(leftMin) {
  const n = Math.max(0, Math.round(Number(leftMin) || 0));
  if (n >= 1440) return `${Math.round(n / 1440)} 天`;
  if (n >= 60) return `${Math.round(n / 60)} 小时`;
  return `${n} 分钟`;
}

// ── 增删查 ───────────────────────────────────────────────────────────────

/**
 * 加一条临时设定。
 * @param {string} groupId 群号（只有群聊能用）
 * @param {object} p
 * @param {string} p.text       正文 —— 要她照做的事（**按原文注入**，说到写到）
 * @param {number} [p.ttlMin]   有效期（分钟）；不填用 cfg.defaultTtlMin
 * @param {number|string} [p.expiresAt] 直接给到期时间（毫秒时间戳或可解析的时间字符串），优先于 ttlMin
 * @param {string} [p.summary]  手写概述（不填则到期时用 makeTempSummary 剪正文）
 * @param {string} [p.note]     备注（给控制台看，不进提示词）
 * @param {string} [p.by]       manual | model | admin
 */
export function setTempSetting(groupId, { text, ttlMin, expiresAt, summary, note, by = 'manual' } = {},
  { now = Date.now(), cfg = null, dir = '' } = {}) {
  const c = tempSettingsCfg(cfg);
  if (!c.enabled) return { ok: false, error: '临时设定功能已关闭（配置 tempSettings.enabled = false）' };
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字（临时设定只在群聊里生效）' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容不能为空' };
  if (body.length > c.maxChars) return { ok: false, error: `内容太长（${body.length} 字），最多 ${c.maxChars} 字` };

  // 到期时间：显式 expiresAt 优先，否则按 ttlMin（再否则默认值）
  let exp = 0;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    exp = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));
    if (!Number.isFinite(exp)) return { ok: false, error: 'expiresAt 不是合法时间（毫秒时间戳或 2026-09-20T03:00）' };
  } else {
    const raw = Number(ttlMin);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : c.defaultTtlMin;
    exp = now + Math.round(Math.min(TEMP_MAX_TTL_MIN, Math.max(TEMP_MIN_TTL_MIN, minutes)) * 60000);
  }
  if (exp <= now) return { ok: false, error: '到期时间必须晚于现在（设了等于没设）' };

  const item = {
    id: nextId(),
    text: body,
    summary: String(summary ?? '').trim().slice(0, c.briefMaxChars) || makeTempSummary(body, c.briefMaxChars),
    note: String(note ?? '').trim().slice(0, MAX_NOTE),
    at: now,
    expiresAt: exp,
    by: String(by || 'manual')
  };

  const store = readStore(dir);
  const prev = store.groups[gid];
  const items = [item, ...(Array.isArray(prev?.items) ? prev.items : [])].slice(0, c.maxPerGroup);
  store.groups[gid] = { items };
  // 群数量上限：超出丢最久没碰过的群（按该群最新一条的 at 比）
  const gids = Object.keys(store.groups);
  if (gids.length > c.maxGroups) {
    const newestAt = (g) => (store.groups[g]?.items || []).reduce((mx, x) => Math.max(mx, Number(x?.at) || 0), 0);
    gids.sort((a, b) => newestAt(b) - newestAt(a)).slice(c.maxGroups).forEach((g) => { delete store.groups[g]; });
  }
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: `临时设定没写进磁盘：${w.error}` };
  return { ok: true, groupId: gid, item, dropped: (prev?.items?.length || 0) + 1 - items.length, file: w.file };
}

/**
 * 把一条原始记录塑形成"带算好的 active/expired/leftMin/…"的视图对象。
 *
 * ⚠️ 本地与广播两条来源**必须共用这一个函数**：判定口径（到期那一刻即算过期、
 *    leftMin/expiredMin 的取整方式、summary 的兜底剪法）只要有一处不一致，
 *    就会出现"控制台显示还有 1 分钟、提示词那边已经当过期了"这种鬼账。
 *
 * @param {'local'|'broadcast'} source 记下来源 —— 控制台要标「所有实例」，删除也要按它分流
 */
function shapeItem(it, gid, now, c, source) {
  const exp = Number(it?.expiresAt) || 0;
  const active = exp > now;
  const at = Number(it?.at) || 0;
  return {
    id: String(it?.id || ''),
    groupId: gid,
    source,
    text: String(it?.text || ''),
    summary: String(it?.summary || '') || makeTempSummary(it?.text, c.briefMaxChars),
    note: String(it?.note || ''),
    at,
    expiresAt: exp,
    by: String(it?.by || 'manual'),
    // 广播记录才知道"是谁广播的"（本地记录这两项是空串）
    tag: String(it?.tag ?? ''),
    name: String(it?.name || ''),
    active,
    expired: !active,
    ageMin: Math.max(0, Math.round((now - (at || now)) / 60000)),
    leftMin: active ? Math.max(0, Math.round((exp - now) / 60000)) : 0,
    expiredMin: active ? 0 : Math.max(0, Math.round((now - exp) / 60000))
  };
}

/**
 * 列出**本实例**的记录（默认全部群；给了 groupId 就只列那个群）。
 * 返回的每条都带好算完的 active/expired/leftMin/ageMin —— 判定只在这里做一次。
 * ⚠️ 这里**不含跨实例广播**那一份 —— 要合并视图用 effectiveTempSettings()。
 *    （不在这里偷偷合并：本函数是纯本地存储的读口，单元测试全靠它的隔离性。）
 */
export function listTempSettings({ now = Date.now(), cfg = null, dir = '', groupId = '' } = {}) {
  const c = tempSettingsCfg(cfg);
  const want = groupId ? normalizeGroupId(groupId) : '';
  const store = readStore(dir);
  const out = [];
  for (const [gid, g] of Object.entries(store.groups)) {
    if (want && gid !== want) continue;
    for (const it of (Array.isArray(g?.items) ? g.items : [])) out.push(shapeItem(it, gid, now, c, 'local'));
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 某个群现在**生效中**的临时设定（按到期时间近的排前面）。 */
export function activeTempSettings(groupId, opts = {}) {
  return listTempSettings({ ...opts, groupId }).filter((x) => x.active).sort((a, b) => a.expiresAt - b.expiresAt);
}

/**
 * 某个群**已结束**的临时设定概述（供"留个印象"用）。
 * 按**结束时间**倒序取前几条（不是按创建时间）—— 攒了几十条之后，该优先记起来的是
 * "刚结束的那件事"，不是"很久以前立过、也早就过期了的那条"。
 */
export function briefTempSettings(groupId, opts = {}) {
  const c = tempSettingsCfg(opts.cfg);
  if (!c.keepBrief) return [];
  return listTempSettings({ ...opts, groupId })
    .filter((x) => x.expired)
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .slice(0, MAX_BRIEFS_IN_PROMPT)
    .map((x) => ({ id: x.id, summary: x.summary, expiresAt: x.expiresAt, expiredMin: x.expiredMin }));
}

/** 删掉一条（返回是否真删掉了）。 */
export function removeTempSetting(groupId, id, { dir = '' } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: '缺少 id' };
  const store = readStore(dir);
  const g = store.groups[gid];
  if (!g || !Array.isArray(g.items)) return { ok: true, removed: false };
  const before = g.items.length;
  g.items = g.items.filter((x) => String(x?.id) !== key);
  const removed = g.items.length !== before;
  if (!g.items.length) delete store.groups[gid];
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed, file: w.file };
}

/** 清掉某个群的全部临时设定。 */
export function clearTempSettings(groupId, { dir = '' } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const store = readStore(dir);
  const existed = Object.prototype.hasOwnProperty.call(store.groups, gid);
  const n = existed ? (store.groups[gid]?.items?.length || 0) : 0;
  delete store.groups[gid];
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed: n, existed, file: w.file };
}

// ── 跨实例广播（同一台电脑上的所有实例共用一份）────────────────────────────
//
// 需求（2026-09-19）："我希望这个可以一次性给所有实例设定"。
//
// 背景：临时设定原本落在 `data/memory/<人设>/_global/temp-settings.json`，而每个实例的
// data/ 是**刻意隔离**的（主实例 `data/`、实例 2 `data-2/`、实例 3 `data-3/`）——
// 那是多开的前提。所以"一次给所有实例"必须换一个所有实例都看得见的地方。
//
// 选型：**程序根的 `bus/` 目录**（`<程序根>/bus/temp-settings.jsonl`），与 bus.js 的动态账本同级。
// 为什么不 HTTP 扇出到 3210/3221/3231：
//   ① 要预先知道每个实例的端口，端口一改就失效；
//   ② 某个实例当时没开着 → 这条设定就**静默丢了**，而"以为都设上了"最难查；
//   ③ 还要处理令牌/鉴权。
// 共享文件没这三个问题：谁在场谁生效，当时没开机的实例下次起来照样读得到。
//
// 并发（两个实例是两个进程，会同时往同一个文件追加）—— 完全照搬 bus.js 的三条：
//   ① **追加 + 一次 write 写完一整行**（单次 <4KB 在 Windows 上是原子的，不会半行交错）；
//   ② 行级解析容错：坏行直接跳过，只损失那一行；
//   ③ 压缩（compact）走"临时文件 + rename"原子替换，失败不影响写入。
//
// 为什么是**追加式事件流**而不是"读-改-写一个 JSON"：
//   `set` / `del` / `clear` 三种操作都只追加一行，读的时候按顺序折叠（fold）出当前状态。
//   读-改-写在两个实例同时点保存时会丢掉其中一个的设定（典型丢失更新）。
//
// ⚠️ 广播是**跟人不跟人设**的：它对"这台电脑上的所有号"生效，不管那个号当前挂的是哪张人设卡。
//    这正是用户要的（笙/丝/陨 一起生效）。想要"只给某一个号"就用本实例的那一份（不加 broadcast）。

const BROADCAST_FILENAME = 'temp-settings.jsonl';
/** 超过这个大小就折叠压缩一次（保留折叠后的 set 行）。 */
const BROADCAST_TRIM_BYTES = 256 * 1024;

/**
 * 广播目录的根。
 * 默认 = 程序根（`instanceRoot()`，与 bus.js 的"所有实例都看得见的地方"同一个）。
 * `QQ_AGENT_BUS_ROOT` 是给测试用的逃生口：端到端测试驱动的是真编排器，没法从外面传 root，
 * 只能靠环境变量把它指到临时目录（否则会往真实 bus/ 里写东西）。
 */
export function broadcastRoot() {
  return String(process.env.QQ_AGENT_BUS_ROOT || '').trim() || instanceRoot();
}

/** 广播文件路径（控制台要显示"存在哪"）。 */
export function broadcastFile(root = broadcastRoot()) {
  return path.join(busDir(root), BROADCAST_FILENAME);
}

/** 把若干行事件折叠成"当前有哪些广播临时设定"（Map<id, item>）。 */
function foldBroadcast(lines) {
  const map = new Map();
  for (const line of lines) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }   // 坏行跳过，见上面 ②
    if (!r || typeof r !== 'object') continue;
    const op = String(r.op || 'set');
    if (op === 'del') {
      map.delete(String(r.id || ''));
      continue;
    }
    if (op === 'clear') {
      const gid = normalizeGroupId(r.groupId);
      if (!gid) continue;
      for (const [id, it] of map) if (it.groupId === gid) map.delete(id);
      continue;
    }
    // op === 'set'
    const id = String(r.id || '');
    const gid = normalizeGroupId(r.groupId);
    const text = String(r.text || '').trim();
    // 缺 id / 群号不合法 / 空正文 → 这条事件没有意义，跳过（同 bus 的"空话不记"）
    if (!id || !gid || !text) continue;
    map.set(id, {
      id,
      groupId: gid,
      text,
      summary: String(r.summary || '').trim(),
      note: String(r.note || '').slice(0, MAX_NOTE),
      at: Number(r.at) || Number(r.t) || 0,
      expiresAt: Number(r.expiresAt) || 0,
      by: String(r.by || 'broadcast'),
      tag: String(r.tag ?? ''),
      name: String(r.name || '').slice(0, 24)
    });
  }
  return map;
}

/** 读全部广播记录（折叠后）。读不动 = 没有广播，不抛。 */
export function readBroadcast(root = broadcastRoot()) {
  let raw = '';
  try {
    raw = fs.readFileSync(broadcastFile(root), 'utf8');
  } catch {
    return new Map();   // 还没有广播文件 = 没人广播过
  }
  return foldBroadcast(raw.split('\n'));
}

/** 追加一条广播事件（原子性靠"一次 write 一整行"，见上面 ①）。 */
function appendBroadcast(op, root) {
  try {
    const file = broadcastFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(op)}\n`, 'utf8');
    maybeCompactBroadcast(file);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 文件太大时折叠压缩：把"事件流"重写成"每个存活条目一行 set"。 */
function maybeCompactBroadcast(file) {
  try {
    const before = fs.statSync(file);
    if (before.size < BROADCAST_TRIM_BYTES) return;
    const live = [...foldBroadcast(fs.readFileSync(file, 'utf8').split('\n')).values()];
    const body = live.map((it) => JSON.stringify({ op: 'set', t: Date.now(), ...it })).join('\n');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body + (live.length ? '\n' : ''), 'utf8');
    // ⚠️ 并发守卫：压缩是"读 → 算 → 整体重写"，而这中间**别的实例可能刚追加了一行**
    //    （每个实例是独立进程，共用这一个文件）。无脑 rename 会把那一行静默吃掉 ——
    //    典型的丢失更新，而且是"设定没了但没人报错"这种最难查的形态。
    //    所以 rename 之前重新 stat 一次：大小变了 = 有人写过 → 放弃本轮（下次文件只会更大，
    //    一定会再触发），并把 tmp 清掉别留垃圾。窗口从"整个读算过程"缩到"两次 stat 之间"。
    if (fs.statSync(file).size !== before.size) {
      try { fs.unlinkSync(tmp); } catch { /* 清不掉也无害 */ }
      return;
    }
    fs.renameSync(tmp, file);   // 原子替换：读的人要么看到旧的、要么看到新的
  } catch { /* 压缩失败不影响写入，下次超大再试 */ }
}

/**
 * 广播一条临时设定（**这台电脑上的所有实例都会照做**）。
 * 校验口径与 setTempSetting 完全一致 —— 两边不一致就会出现"本地能设、广播设不上"。
 * @param {string} tag  广播者的实例标识（'' = 主实例），控制台用来显示"来自实例 B"
 */
export function setBroadcastTempSetting(groupId, { text, ttlMin, expiresAt, summary, note, by = 'broadcast', tag = '', name = '' } = {},
  { now = Date.now(), cfg = null, root = broadcastRoot() } = {}) {
  const c = tempSettingsCfg(cfg);
  if (!c.enabled) return { ok: false, error: '临时设定功能已关闭（配置 tempSettings.enabled = false）' };
  if (!c.crossInstance) return { ok: false, error: '跨实例广播已关闭（配置 tempSettings.crossInstance = false）' };
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字（临时设定只在群聊里生效）' };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容不能为空' };
  if (body.length > c.maxChars) return { ok: false, error: `内容太长（${body.length} 字），最多 ${c.maxChars} 字` };

  let exp = 0;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    exp = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));
    if (!Number.isFinite(exp)) return { ok: false, error: 'expiresAt 不是合法时间（毫秒时间戳或 2026-09-20T03:00）' };
  } else {
    const raw = Number(ttlMin);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : c.defaultTtlMin;
    exp = now + Math.round(Math.min(TEMP_MAX_TTL_MIN, Math.max(TEMP_MIN_TTL_MIN, minutes)) * 60000);
  }
  if (exp <= now) return { ok: false, error: '到期时间必须晚于现在（设了等于没设）' };

  const item = {
    id: nextId(),
    groupId: gid,
    text: body,
    summary: String(summary ?? '').trim().slice(0, c.briefMaxChars) || makeTempSummary(body, c.briefMaxChars),
    note: String(note ?? '').trim().slice(0, MAX_NOTE),
    at: now,
    expiresAt: exp,
    by: String(by || 'broadcast')
  };
  const w = appendBroadcast({ op: 'set', t: now, ...item, tag: String(tag ?? ''), name: String(name || '').slice(0, 24) }, root);
  if (!w.ok) return { ok: false, error: `广播没写进磁盘：${w.error}` };
  return { ok: true, groupId: gid, item, file: w.file };
}

/** 列出**广播**那一份（形状与 listTempSettings 一致，多一个 source='broadcast'）。 */
export function listBroadcastTempSettings({ now = Date.now(), cfg = null, groupId = '', root = broadcastRoot() } = {}) {
  const c = tempSettingsCfg(cfg);
  const want = groupId ? normalizeGroupId(groupId) : '';
  const out = [];
  for (const it of readBroadcast(root).values()) {
    if (want && it.groupId !== want) continue;
    out.push(shapeItem(it, it.groupId, now, c, 'broadcast'));
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 删掉一条广播（写一条 del 墓碑，不动别人已写的历史）。 */
export function removeBroadcastTempSetting(groupId, id, { root = broadcastRoot() } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: '缺少 id' };
  const hit = readBroadcast(root).get(key);
  if (!hit || hit.groupId !== gid) return { ok: true, removed: false };
  const w = appendBroadcast({ op: 'del', t: Date.now(), id: key }, root);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed: true, file: w.file };
}

/** 清掉某个群的全部广播（写一条 clear 事件）。 */
export function clearBroadcastTempSettings(groupId, { root = broadcastRoot() } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const before = [...readBroadcast(root).values()].filter((x) => x.groupId === gid).length;
  if (!before) return { ok: true, removed: 0, existed: false };
  const w = appendBroadcast({ op: 'clear', t: Date.now(), groupId: gid }, root);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed: before, existed: true, file: w.file };
}

/**
 * **本实例 + 广播** 的合并视图 —— 提示词、控制台都该用这个，而不是 listTempSettings。
 *
 * 去重规则：按 id 去重、广播优先。正常情况下两边 id 不会撞（各自生成），
 * 但万一有人手抄了一份进本地（真的会有人这么干），让"广播那份"胜出 —— 它更"外"、
 * 也更可能是最新的口径，避免同一个 id 在列表里出现两行。
 *
 * @returns {{active: object[], brief: object[], items: object[]}}
 */
export function effectiveTempSettings({ groupId = '', now = Date.now(), cfg = null, dir = '', root = broadcastRoot() } = {}) {
  const c = tempSettingsCfg(cfg);
  const local = listTempSettings({ now, cfg: c, dir, groupId });
  // 关掉 crossInstance 时**一个字都不读**（不是"读了不显示"）—— 关就是关。
  const bc = c.crossInstance ? listBroadcastTempSettings({ now, cfg: c, groupId, root }) : [];
  const seen = new Set(bc.map((x) => x.id));
  const items = [...bc, ...local.filter((x) => !seen.has(x.id))].sort((a, b) => b.at - a.at);
  const active = items.filter((x) => x.active).sort((a, b) => a.expiresAt - b.expiresAt);
  const brief = (c.keepBrief ? items.filter((x) => x.expired) : [])
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .slice(0, MAX_BRIEFS_IN_PROMPT)
    .map((x) => ({ id: x.id, summary: x.summary, expiresAt: x.expiresAt, expiredMin: x.expiredMin, source: x.source }));
  return { active, brief, items };
}

/** 删除一条 —— 按来源分流（广播的删广播、本地的删本地）。控制台只认 id，不关心来源。 */
export function removeTempSettingAny(groupId, id, { dir = '', root = broadcastRoot() } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const key = String(id || '').trim();
  if (!key) return { ok: false, error: '缺少 id' };
  const hit = [...readBroadcast(root).values()].find((x) => x.id === key && x.groupId === gid);
  if (hit) return { ...removeBroadcastTempSetting(gid, key, { root }), source: 'broadcast' };
  return { ...removeTempSetting(gid, key, { dir }), source: 'local' };
}

/** 清掉某个群的全部 —— **两边都清**（否则"清空了"过一会儿广播那份又冒出来）。 */
export function clearTempSettingsAny(groupId, { dir = '', root = broadcastRoot() } = {}) {
  const gid = normalizeGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const a = clearTempSettings(gid, { dir });
  const b = clearBroadcastTempSettings(gid, { root });
  if (!a.ok) return a;
  if (!b.ok) return b;
  return {
    ok: true,
    removed: (a.removed || 0) + (b.removed || 0),
    existed: !!(a.existed || b.existed),
    local: a.removed || 0,
    broadcast: b.removed || 0
  };
}

/**
 * 广播那一份的维护清理：把"过期超过 keepDays 天"的条目用 clear 之外的方式去掉。
 * 实现就是**折叠压缩**（见 maybeCompactBroadcast）—— 压缩时只保留存活条目，
 * 过期的自然被丢掉；但过期不久、还该留概述的条目要保住，否则"只剩概述"就没了。
 */
export function pruneBroadcastTempSettings(now = Date.now(), cfg = null, { root = broadcastRoot() } = {}) {
  const c = tempSettingsCfg(cfg);
  const file = broadcastFile(root);
  // 先记下读之前的大小，rename 之前再比一次 —— 见 maybeCompactBroadcast 里的并发守卫说明。
  let sizeBefore = -1;
  try { sizeBefore = fs.statSync(file).size; } catch { return 0; }   // 没文件 = 没东西可清
  const live = [...readBroadcast(root).values()];
  const keep = live.filter((it) => {
    const exp = Number(it.expiresAt) || 0;
    if (exp > now) return true;
    if (c.keepDays <= 0) return false;
    return now - exp <= c.keepDays * 86400000;
  });
  if (keep.length === live.length) return 0;
  try {
    const body = keep.map((it) => JSON.stringify({ op: 'set', t: Date.now(), ...it })).join('\n');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body + (keep.length ? '\n' : ''), 'utf8');
    // 有人在这中间追加过（别的实例刚设了一条）→ 放弃本轮，别把那条吃掉
    if (fs.statSync(file).size !== sizeBefore) {
      try { fs.unlinkSync(tmp); } catch { /* 清不掉也无害 */ }
      return 0;
    }
    fs.renameSync(tmp, file);
  } catch {
    return 0;   // 写不动就当没清（下次再试），绝不抛
  }
  return live.length - keep.length;
}

/**
 * 维护清理（挂在 orchestrator 的长期记忆维护循环里，顺手跑）。
 * 只做一件事：把**过期超过 keepDays 天**的记录真的删掉。
 * （群数量上限在 setTempSetting 里顺手裁了，不放到这里。）
 * ⚠️ 不能"过期即删"（除非 keepDays=0）：用户要的正是"过期后只剩概述"，
 *    删早了概述也跟着没了。
 */
export function pruneTempSettings(now = Date.now(), cfg = null, { dir = '' } = {}) {
  const c = tempSettingsCfg(cfg);
  const store = readStore(dir);
  let removed = 0;
  for (const [gid, g] of Object.entries(store.groups)) {
    const items = (Array.isArray(g?.items) ? g.items : []).filter((it) => {
      const exp = Number(it?.expiresAt) || 0;
      if (exp > now) return true;                       // 生效中：留着
      if (c.keepDays <= 0) { removed += 1; return false; } // 配成 0 = 过期即删
      if (now - exp > c.keepDays * 86400000) { removed += 1; return false; }
      return true;
    });
    if (items.length) store.groups[gid] = { items };
    else delete store.groups[gid];
  }
  if (removed) writeStore(store, dir);
  return removed;
}

// ── 提示词 ───────────────────────────────────────────────────────────────

/**
 * 用户消息里的动态块：**未过期注入正文，已过期只注入概述**。
 *
 * 为什么走用户消息而不是系统提示：
 *   ① 它随过期时刻变化（"有效期至 09-20 03:00" 变成 "已经结束的临时设定"），
 *      塞进系统提示会让 prompt 缓存次次失效；
 *   ② 系统提示是"她是谁"，临时设定是"这一阵子额外交代的事" —— 语义上就该在用户消息里。
 *
 * @param {{active?: object[], brief?: object[]}|null} payload orchestrator 算好的快照
 * @returns {string} '' 表示不注入（开关关掉 / 没有内容）
 */
export function tempSettingsPromptBlock(payload, rawCfg = null) {
  const c = tempSettingsCfg(rawCfg);
  if (!c.enabled) return '';
  // ⚠️ 先滤掉空条目再判"要不要出块"：正文/概述为空的记录（数据被手改过、或 summary 被清空）
  //    渲染出来就是一个空的 "- "，模型会当成一条残缺指令。
  const active = (Array.isArray(payload?.active) ? payload.active : [])
    .filter((it) => String(it?.text ?? '').trim());
  const brief = (c.keepBrief && Array.isArray(payload?.brief) ? payload.brief : [])
    .filter((it) => String(it?.summary ?? '').trim());
  if (!active.length && !brief.length) return '';

  const lines = [];
  if (active.length) {
    // ⚠️ 三件事都要说死，少一件就出一种事故：
    //    ① 只说"这是你的设定" → 模型会当成永久人设的一部分；
    //    ② 只说"只在这个群" → 可能被理解成"可以不当真"；
    //    ③ 只说"就按它做" → 块一挪到尾部就会被读成"这一次的任务"，做完就忘。
    //    所以范围（只这个群）+ 期限（到点失效）+ **持续性**（不是一次性任务）三样都得有。
    lines.push('【本群临时设定 · 此刻正在生效】');
    lines.push('下面几条是管理员交办的补充设定：**只在这个群**、**只在这一段时间内**成立。'
      + '它不是一次性的任务，是这段时间里一直有效的前提 —— 就按它说、按它做；'
      + '它和【过去状态】【记忆】【跨群档案】里的说法对不上时，一律以本段为准：');
    for (const it of active) {
      // 到期信息写**绝对时间**（09-20 03:00）而不是"还有 X 小时"：模型算不了时间差，
      // 但"到点失效"这个事实必须让她知道（否则她会当成永久人设）。
      const left = Number(it.leftMin) > 0 ? `，约 ${leftText(it.leftMin)}后失效` : '';
      const until = it.expiresAt ? `（有效期至 ${formatShortTime(it.expiresAt)}${left}）` : '';
      // 「开场反应只做一次」：生效够久就补一句。只在她**确实来得及反应过**的时候加 ——
      // 刚设上的那一次不能被劝住（那正是管理员设它的目的）。
      const settled = c.reactWindowMin > 0 && Number(it.ageMin) >= c.reactWindowMin;
      const aged = settled ? `（已生效 ${leftText(it.ageMin)}：如果这条说的是"刚发生的变化"，当时的反应已经做过了）` : '';
      lines.push(`- ${String(it.text || '').trim()}${until}${aged}`);
    }
    // ⚠️ 2026-09-19 真实事故（用户原话："ai总会忘记刚刚发生了什么，然后反复出现'主人你怎么变成这样了？'"）。
    //    真凶不是记忆系统，就是**这一块自己**：管理员写的是"主人突然变成了…你们要先表现得震惊，
    //    然后再适应"，而块头只声明了"持续性"（"是这段时间里一直有效的前提 —— 就按它说、按它做"），
    //    没说"开场反应只做一次"；块又压在注意力最高的尾部 → 模型把"先表现得震惊"当成
    //    **每次运行都要做**的动作，每隔几分钟唤醒一次就重新震惊一次；这条设定还是跨实例广播的，
    //    于是三个号一起复读同一句话，看起来就像"她完全不记得刚刚发生过什么"。
    //    解法：把两类条目分开讲，并把判断依据**点名**指到她自己说过的话上 ——
    //    证据（她几分钟前那句"你怎么变成这样了"）本来就在【过去状态】里，但模型不会主动拿它
    //    去反驳一条写着"一律以本段为准"的指令，必须由我们替它把这条线连上。
    //    位置放在条目**之后**：要压过上面那句"再震惊一次"的祈使句（块内也是越靠后越重）。
    lines.push('读这些条目时分清两类：**这段时间一直成立的前提**（称呼、关系、规矩）照它做；'
      + '而"某件事刚发生时该怎么反应"（震惊、追问、打量、调侃、安慰）只在**它刚发生的那一次**做 —— '
      + '之后就看【过去状态】里**你自己**已经说过的话接着往下聊，同一件事已经表过态就换个说法。');
    // ⚠️ 收尾句**不要**再堆一串"不要…、不要…、也不要…"：本项目反复验证过
    //    "否定的措辞会被打折扣执行"，而块尾又是权重最高的位置 —— 把一长串禁令摆在那儿，
    //    模型会优先执行禁令（R18 那次"别播报"被她执行成"干脆不提落点"，同一个坑）。
    //    范围用一句话带过就够，把权重留给上面"就按它做"。
    lines.push('【范围】只作用于这个群（别的群、私聊都不适用，也别对外提"被交代过"这件事）；'
      + '到点它自己失效，不用记进长期记忆。');
  }
  if (brief.length) {
    lines.push('【本群背景 · 已经结束的临时设定】');
    for (const it of brief) lines.push(`- ${String(it.summary || '').trim()}`);
    lines.push('这些已经过去了，只留个印象，**不要再照着做**：除非有人主动提起，否则不要提它。');
  }
  return lines.join('\n');
}
