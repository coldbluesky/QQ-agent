// 文字冒险 · 单次长跑（LLM 型 / skills/）。
//
// ── 与海龟汤的关键差异：状态是"会演进的"──────────────────────────────────
// 海龟汤是固定答案 + 主持人判断，状态只有一份汤底；文字冒险是**持续演进的状态机**
// ——场景、数值、道具、旗标、剧情摘要全都在变。本项目是无状态会话（每条消息新开
// 一次会话、LLM 零历史），这些变化不落盘，下一轮就全没了。
//
// 所以本技能的核心是一张**有界存档卡**，分三层：
//   热层（每轮注入）：当前场景 / 数值 / 道具 / 旗标            —— 固定大小
//   温层（每轮注入）：剧情摘要 recap，硬上限、溢出从最旧处截断  —— 固定大小
//   冷层（落盘不注入）：事件日志 log，靠 adventure__recall 按需检索 —— 可无限长
// 于是玩到第 30 段，每轮注入量还是那几百字，不随游戏时长膨胀 —— 与本项目
// 「每次处理 token 恒定」是同一套哲学。宁可截断也不要全量注入。
//
// ── 为什么要有一个"发消息"的工具（narrate）────────────────────────────────
// 编排层写得很清楚（src/orchestrator.js 的注释）：模型回复的**正文不会发到群里**
// ——"文本只是思考，按设计不发 QQ"，发言必须走工具（send_message 之类）。
// 叙述是文字冒险的全部产出，如果指望模型"记得再调一次 send_message"，漏一次就是
// 整局哑火、而且它自己还不知道。所以 narrate 把「发叙述」和「写回存档」压进**一次
// 调用**：结构上不可能只做一半。这也是照抄 skills/image-generate 的发送范式。
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 发言一律走 ctx.sender（限频/去重/存档）；发不出去时把文本交还给模型让它自己
//     用 send_message 发，绝不静默丢消息。
//   · 不注册定时器：技能没有"主动发消息"的入口，所以没有"超时/自动推进"这类设计，
//     整局完全由群友的消息驱动。
//   · 存档卡每一轮都会注入系统提示，所以**不需要** status 工具 —— 模型本来就知道
//     当前场景和背包。工具越少，每轮请求的 function 列表越省 token。

import fs from 'node:fs';
import path from 'node:path';
import * as configModule from '../../src/config.js';
import { writeJsonAtomic } from '../../src/util.js';
import { currentMemoryKey } from '../../src/persona-store.js';

/** api.config 的本地引用（必须在 setup 里取）。 */
let cfg = () => ({});
let log = () => {};

/** 出厂默认值（与 skill.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = { narrateChars: 220, choices: 3, recapMax: 400, allowCustomTheme: true };

/** 事件日志上限：条数 + 单条长度。冷层可以长，但不能无限。 */
const LOG_MAX = 300;
const LOG_TEXT_MAX = 300;
/** 结局存档保留条数。 */
const FINISHED_MAX = 20;

/**
 * 内置题材。
 *
 * 每个题材给四样东西：
 *   pitch   —— 菜单上给群友看的一句话卖点
 *   world   —— 每轮注入的世界观约束（模型靠它保持前后一致，别写太长）
 *   scenes  —— 候选开场场景，开局时随机挑一个，让第一段有具体的落脚点
 *   stats   —— 初始数值。键名是中文，模型写回时必须沿用同名键
 *
 * 题材刻意轻重搭配：聊斋/废土/赛博压得住气氛，深夜食堂/校园日常适合想轻松玩一局。
 */
export const THEMES = [
  {
    id: 'liaozhai', name: '聊斋·捉鬼',
    pitch: '阴阳眼、民俗禁忌、深夜的叩门声',
    world: '清末的南方小镇，鬼神与人心纠缠。你天生有一双阴眼，看得见常人看不见的东西。规矩要守：夜里不回头、不接生人递来的东西、子时莫应门。',
    scenes: ['雨夜借宿的破庙', '镇口贴着黄符的老宅', '打更人失踪的那条巷子'],
    stats: { 阳气: 10, 心念: 10 }
  },
  {
    id: 'xiuxian', name: '修仙',
    pitch: '拜师、炼丹、闯秘境，从杂役弟子熬起',
    world: '灵气稀薄的下界，宗门林立。你是刚入门的杂役弟子，丹田里那点微末灵光来路不明。修行如逆水行舟，一步慢，步步慢。',
    scenes: ['杂役院清晨的钟声里', '后山禁地边缘的药田', '外门大比前夜的擂台边'],
    stats: { 修为: 0, 灵石: 3 }
  },
  {
    id: 'jianghu', name: '武侠江湖',
    pitch: '一桩旧案、半截烧焦的信、雨夜的客栈',
    world: '朝廷势弱、门派割据的乱世。你身负一桩旧案，身上只有半截烧焦的信和一把不好用的刀。',
    scenes: ['雨夜的悦来客栈', '渡口最后一条船', '镖局门口挂着的白灯笼'],
    stats: { 内力: 10, 声望: 0 }
  },
  {
    id: 'wasteland', name: '末世废土',
    pitch: '拾荒、据点、辐射区边缘的补给点',
    world: '大灾变三十年后。空气有毒，水比命贵，人们在地下管道和废墟之间活着。信任是最贵的东西。',
    scenes: ['废弃地铁站的篝火旁', '辐射区边缘的补给点', '一栋还没塌完的写字楼'],
    stats: { 体力: 10, 物资: 2 }
  },
  {
    id: 'cyberpunk', name: '赛博朋克',
    pitch: '义体、黑客、抹掉你一半身份的巨型企业',
    world: '义体与霓虹覆盖的巨型都市，大公司比政府还大。你的身份记录被人为抹掉了一半，没人知道为什么。',
    scenes: ['雨夜的下城区天台', '一间没有招牌的义体诊所', '数据港的排队通道'],
    stats: { 信用点: 500, 义体负荷: 0 }
  },
  {
    id: 'star', name: '星际漂流',
    pitch: '飞船失事、异星求生、有限的氧气',
    world: '你的运输船在跃迁中出了故障，坠在一颗没有名字的行星上。通讯全断，补给有限，这颗星球不是无人的。',
    scenes: ['冒着烟迫降的驾驶舱', '异星苔原上的巨大裂缝', '半埋在沙里的废弃探测站'],
    stats: { 氧气: 10, 燃料: 5 }
  },
  {
    id: 'shop', name: '深夜食堂',
    pitch: '凌晨开门的小店，来的客人都带着故事',
    world: '一间凌晨才开门的小店，只做几道菜。来的人都带着自己的事，你负责听，也负责做。不用打打杀杀，用心经营就行。',
    scenes: ['凌晨一点，第一个客人推门进来', '雨夜，只有一把伞的人坐到了角落', '打烊前的最后一位客人'],
    stats: { 口碑: 0, 库存: 5 }
  },
  {
    id: 'campus', name: '校园日常',
    pitch: '社团、天台的风、没说完的那些话',
    world: '普通高中，一个普通的夏天。社团、考试、走廊里递出去的纸条，以及一些还没说出口的话。',
    scenes: ['放学后空无一人的社团活动室', '天台上的风', '文化祭前一夜的教室'],
    stats: { 好感: 0, 精力: 10 }
  }
];

// ── 配置 ──────────────────────────────────────────────────────────────────

function clampInt(value, lo, hi, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** 当前设置（出厂默认 ← 用户在设置页改过的值），并做钳制。 */
export function readSettings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  out.narrateChars = clampInt(out.narrateChars, 80, 600, DEFAULTS.narrateChars);
  out.choices = clampInt(out.choices, 2, 5, DEFAULTS.choices);
  out.recapMax = clampInt(out.recapMax, 200, 1000, DEFAULTS.recapMax);
  out.allowCustomTheme = out.allowCustomTheme !== false;
  return out;
}

// ── 落盘 ─────────────────────────────────────────────────────────────────
//
// 与棋局（chess.json）、海龟汤同目录：都挂在当前人设的 _global 下，换人设就换一整套
// 游戏存档，符合"每个角色有自己的群记忆"的整体设计。
//
// ⚠️ DATA_DIR 延迟读取：测试与便携模式会重定向数据目录，模块加载时定死会取到旧路径。

function stateFile(dir = '') {
  const base = dir || path.join(configModule.DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'adventure.json');
}

export function adventureFilePath(dir = '') {
  return stateFile(dir);
}

function readStore(dir = '') {
  const file = stateFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
      return { version: 1, chats: raw.chats };
    }
  } catch { /* 首次运行 / 文件损坏：当空库，不抛 */ }
  return { version: 1, chats: {} };
}

function writeStore(store, dir = '') {
  const file = stateFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: 1, chats: store.chats || {} });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

/** 把一条落盘记录补齐成完整会话状态（缺字段一律补默认，不抛）。 */
export function normalizeChat(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const a = s.active;
  const active = (a && typeof a === 'object' && a.themeName)
    ? {
        themeId: String(a.themeId || ''),
        themeName: String(a.themeName),
        world: String(a.world || ''),
        role: String(a.role || ''),
        scene: String(a.scene || ''),
        stats: (a.stats && typeof a.stats === 'object' && !Array.isArray(a.stats)) ? { ...a.stats } : {},
        flags: Array.isArray(a.flags) ? a.flags.map(String).slice(0, 30) : [],
        items: Array.isArray(a.items) ? a.items.map(String).slice(0, 30) : [],
        recap: String(a.recap || ''),
        saves: Number(a.saves) || 0,
        startedAt: Number(a.startedAt) || 0,
        updatedAt: Number(a.updatedAt) || 0
      }
    : null;
  const log = Array.isArray(s.log)
    ? s.log.map((e, i) => ({ n: Number(e?.n) || i + 1, text: String(e?.text || '').slice(0, LOG_TEXT_MAX) }))
        .filter((e) => e.text)
    : [];
  const finished = Array.isArray(s.finished)
    ? s.finished.map((f) => ({
        themeName: String(f?.themeName || ''),
        outcome: String(f?.outcome || ''),
        saves: Number(f?.saves) || 0,
        at: Number(f?.at) || 0
      }))
    : [];
  return { active, log, finished };
}

/** 取某个会话的状态（不存在就建一个空壳）。 */
function chatState(store, chatKey) {
  const key = String(chatKey || '');
  const s = normalizeChat(store.chats[key]);
  store.chats[key] = s;
  return s;
}

// ── 题材 ─────────────────────────────────────────────────────────────────

/** 按 id / 全名 / 包含关系匹配内置题材；匹配不到返回 null。 */
export function resolveTheme(input) {
  const q = String(input ?? '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  return THEMES.find((t) => t.id === lower)
    || THEMES.find((t) => t.name === q)
    || THEMES.find((t) => t.name.includes(q) || q.includes(t.name))
    || THEMES.find((t) => t.pitch.includes(q))
    || null;
}

/** 给群友看的题材菜单（纯文本，模型直接转发即可）。 */
export function themeMenu() {
  return [
    '🎲 文字冒险 · 选个题材',
    ...THEMES.map((t, i) => `${i + 1}. ${t.name} —— ${t.pitch}`),
    '',
    '回复编号或题材名，我就开局。'
  ].join('\n');
}

/** 挑一个开场场景（rng 可注入，测试要的是确定结果）。 */
export function pickScene(theme, rng = Math.random) {
  const list = Array.isArray(theme?.scenes) ? theme.scenes.filter(Boolean) : [];
  if (!list.length) return '';
  const idx = Math.floor(Number(rng()) * list.length) % list.length;
  return list[Math.max(0, idx)];
}

/** 数值对象 → 一行可读文本。 */
export function fmtStats(stats) {
  const entries = Object.entries(stats || {}).filter(([, v]) => v !== undefined && v !== null);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join('、') : '（无）';
}

// ── 提示词注入（这个技能的心脏）───────────────────────────────────────────

/**
 * 动态提示词片段：有进行中的冒险时，把整张存档卡 + 叙述铁律每轮重新注入。
 *
 * 这是模型"还记得自己在带什么局"的唯一来源（无状态会话，历史不保留）。
 * ⚠️ 必须**同步** —— manager.getPromptSections 不会 await。
 */
export function promptSections(context = {}) {
  const chatKey = String(context?.chatKey || '');
  if (!chatKey) return [];
  const store = readStore();
  const st = normalizeChat(store.chats?.[chatKey]);
  if (!st.active) return [];

  const a = st.active;
  const s = readSettings();
  const lines = [
    '【进行中的文字冒险 · 你是叙述者】',
    `题材：${a.themeName}`,
    a.world ? `世界观：${a.world}` : '',
    `玩家角色：${a.role || '（还没定，可在叙述里自然带出或问一句）'}`,
    `当前场景：${a.scene || '（尚未确定）'}`,
    `数值：${fmtStats(a.stats)}`,
    `线索/状态：${a.flags.length ? a.flags.join('、') : '无'}`,
    `随身：${a.items.length ? a.items.join('、') : '空'}`,
    `剧情摘要：${a.recap || '（刚开局）'}`,
    '',
    '叙述铁律：',
    `· 第二人称「你」，每段叙述 ${s.narrateChars} 字以内，别写长。`,
    `· 结尾给 ${s.choices} 个左右的具体行动选项，同时允许群友自由输入别的行动。`,
    '· 绝不替玩家做决定，也不要替玩家宣告他的选择。',
    '· 一次只推进一个场景；玩家没有行动就别往下推进剧情。',
    `· 剧情摘要上限 ${s.recapMax} 字，太长会被从最旧处截断。`,
    '· 需要回忆更早的剧情 / 某件道具的来历，用 adventure__recall 查事件日志，别硬编。',
    '· 群里有人只是闲聊、没在推进剧情时，别硬把话题拉回冒险，也别调用工具。'
  ].filter(Boolean);
  return [{ id: 'adventure-active', title: '文字冒险', priority: 57, content: lines.join('\n') }];
}

// ── 发送 ─────────────────────────────────────────────────────────────────

/**
 * 把一段文本发到当前会话。
 *
 * 走 ctx.sender 是唯一正确的出口（限频 / 去重 / 留档都在那条管道里）。
 * 发送失败不抛，返回 { ok:false, error }，由调用方退化成"交还给模型让它自己发"。
 */
async function sendToChat(ctx, text) {
  if (typeof ctx?.sender?.sendTextBatch !== 'function') {
    return { ok: false, error: '当前会话不支持主动发送' };
  }
  try {
    const r = await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
    const sent = Array.isArray(r?.sent) ? r.sent : [];
    try {
      ctx.session?.sent?.push?.(...sent.map((x) => ({ type: 'text', text: x.text, at: x.at })));
      if (ctx?.session?.id) ctx.emit?.('session-update', ctx.session.id);
    } catch { /* 记账失败不影响已发出的消息 */ }
    if (sent.length) return { ok: true };
    const failed = Array.isArray(r?.failed) ? r.failed : [];
    return { ok: false, error: failed.map((f) => f.error).join('；') || '发送管道没有回执' };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// ── 存档卡的读写 ─────────────────────────────────────────────────────────

/** 往事件日志追加一条（带序号，供 recall 引用）。 */
function pushLog(state, text) {
  const t = String(text || '').trim().slice(0, LOG_TEXT_MAX);
  if (!t) return;
  const n = state.log.length ? state.log[state.log.length - 1].n + 1 : 1;
  state.log.push({ n, text: t });
  while (state.log.length > LOG_MAX) state.log.shift();
}

/**
 * 应用一次剧情摘要更新。
 *
 * 支持两种写法，按可靠性取舍：
 *   · recap —— 整体重写（模型自己压缩，质量最好，但要求高）
 *   · beat  —— 追加一段（模型最擅长，日常用这个；零改写负担）
 * 溢出时从**最旧**处截断（旧剧情不是丢了，是归进了事件日志），并把截掉的部分
 * 也塞进日志，这样 adventure__recall 还翻得回来。
 */
export function applyRecap(active, { recap, beat } = {}, maxChars = DEFAULTS.recapMax) {
  let text = '';
  if (typeof recap === 'string' && recap.trim()) text = recap.trim();
  else if (typeof beat === 'string' && beat.trim()) {
    text = active.recap ? `${active.recap} ${beat.trim()}` : beat.trim();
  } else return { changed: false, dropped: '' };

  let dropped = '';
  if (text.length > maxChars) {
    dropped = text.slice(0, text.length - maxChars);
    text = text.slice(text.length - maxChars);
  }
  active.recap = text;
  return { changed: true, dropped };
}

/** 把数组字段按增量合并（去重、保序、上限 30）。 */
function mergeList(list, add = [], remove = []) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const x of (Array.isArray(remove) ? remove : [])) {
    const i = out.indexOf(String(x));
    if (i >= 0) out.splice(i, 1);
  }
  for (const x of (Array.isArray(add) ? add : [])) {
    const v = String(x).trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(-30);
}

/** 数值增量合并：只覆盖传进来的键，其余保持不动。 */
function mergeStats(stats, patch) {
  const out = { ...(stats || {}) };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[String(k)] = n;
    }
  }
  return out;
}

/**
 * 把一次调用里的存档字段写进 active。
 * narrate 与 save 共用这一段，保证两条路写出来的存档完全一致。
 */
export function applySaveFields(active, args = {}, settings = readSettings()) {
  if (typeof args.scene === 'string' && args.scene.trim()) active.scene = args.scene.trim().slice(0, 120);
  if (typeof args.role === 'string' && args.role.trim()) active.role = args.role.trim().slice(0, 60);
  if (args.stats !== undefined) active.stats = mergeStats(active.stats, args.stats);
  active.items = mergeList(active.items, args.addItems, args.removeItems);
  active.flags = mergeList(active.flags, args.addFlags, args.removeFlags);
  const r = applyRecap(active, args, settings.recapMax);
  active.updatedAt = Date.now();
  // ⚠️ 数"段"由调用方负责（只有真的发了一段叙述才算一段），这里不碰 saves
  return r;
}

/** 存档卡 → 给模型看的文本（工具返回值里用它，和注入的版本保持同一口径）。 */
function cardText(a) {
  return [
    `题材：${a.themeName}`,
    `当前场景：${a.scene || '（未定）'}`,
    `数值：${fmtStats(a.stats)}`,
    `线索/状态：${a.flags.length ? a.flags.join('、') : '无'}`,
    `随身：${a.items.length ? a.items.join('、') : '空'}`,
    `剧情摘要：${a.recap || '（空）'}`,
    `本局已存档 ${a.saves} 段`
  ].join('\n');
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 技能入口。
 *
 * ⚠️ 必须叫 setup（或旧的 register），且在里面直接注册工具 —— 别拆成
 * "setup 只存配置 + register 去注册"，那样 register 永远不会被调用。
 */
export function setup(a) {
  cfg = a.config;
  log = a.log || (() => {});
  registerTools(a);
}

function registerTools(a) {
  const s0 = readSettings();

  a.registerTool({
    id: 'start',
    name: '开始一场文字冒险',
    description: '开一场文字冒险（互动小说）。群友想玩冒险 / 跑团 / 文字游戏时调用。题材由群友选：不传 theme 时会返回题材菜单（把它发到群里让大家挑），拿到结果后再带上 theme 调一次就正式开局。同一会话同时只能有一局。',
    category: 'utility',
    icon: '🎲',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: '题材，填题材名或编号对应的名字（例如「聊斋·捉鬼」「修仙」）。留空则只返回题材菜单、暂不开局。' },
        role: { type: 'string', description: '（可选）玩家角色名或一句话设定，例如「阿七，一个瘸腿的货郎」。留空就让玩家在开场里自然带出。' }
      },
      required: []
    },
    async execute(ctx, args) {
      const s = readSettings();
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return { content: '拿不到当前会话，没法建立存档，先不开局。', isError: true };

      const store = readStore();
      const state = chatState(store, chatKey);
      if (state.active) {
        return {
          content: `本群已经有一局在进行中（题材：${state.active.themeName}，当前场景：${state.active.scene || '未定'}）。要换一局请先调用 adventure__end 收档。`,
          isError: true
        };
      }

      const asked = String(args?.theme ?? '').trim();
      if (!asked) {
        // 只出菜单，不动存档 —— 群友还要挑
        return { content: `${themeMenu()}\n\n把上面这段（可以自己润色）发到群里让群友挑，然后用挑中的题材再调一次 adventure__start。` };
      }

      let theme = resolveTheme(asked);
      if (!theme) {
        if (!s.allowCustomTheme) {
          return { content: `「${asked}」不在内置题材里（设置里关掉了「允许自编题材」）。\n${themeMenu()}\n\n请群友从上面挑一个。`, isError: true };
        }
        // 自编题材：世界观交给模型自己维持，数值留空
        theme = {
          id: `custom-${Date.now()}`,
          name: asked.slice(0, 20),
          pitch: asked,
          world: `自定义题材「${asked}」。世界观由你自己设定，但必须前后一致：接下来的每一段都要跟这个设定对得上，不能中途改规则。`,
          scenes: [],
          stats: {}
        };
      }

      const scene = pickScene(theme) || '故事的开头';
      const role = String(args?.role ?? '').trim().slice(0, 60);
      const now = Date.now();
      state.active = {
        themeId: theme.id,
        themeName: theme.name,
        world: theme.world,
        role,
        scene,
        stats: { ...(theme.stats || {}) },
        flags: [],
        items: [],
        recap: '',
        saves: 0,
        startedAt: now,
        updatedAt: now
      };
      pushLog(state, `开局：${theme.name}${role ? `（角色：${role}）` : ''}`);
      const written = writeStore(store);
      if (!written.ok) {
        return { content: `存档写不进去（${written.error}），这局不开了。`, isError: true };
      }
      log(`开局：${chatKey} · ${theme.name}`);

      return {
        content: [
          `『${theme.name}』已开局。存档卡：`,
          cardText(state.active),
          '',
          theme.world,
          '',
          `现在你来写开场（用 adventure__narrate 发出去，它同时会把这一段的进展写回存档）：`,
          `· 第二人称，${s.narrateChars} 字以内，交代「你」为什么在这里、眼前是什么。`,
          `· 结尾给 ${s.choices} 个左右的具体行动选项，并说明群友也可以自己输入别的行动。`,
          '· 不要替玩家做选择，也不要问「你要怎么做」以外的元问题。'
        ].join('\n')
      };
    }
  });

  a.registerTool({
    id: 'narrate',
    name: '叙述并推进',
    description: '文字冒险的主循环工具：把这一段的叙述发到群里，并把剧情进展写回存档（场景、摘要、数值、道具、旗标）。每次轮到玩家行动、你写完叙述后都用它。只传状态字段、不传 text 时，就只写存档、不在群里发言。',
    category: 'utility',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发到群里的叙述正文（第二人称，别超过设定字数）。留空 = 只写存档、不发言。' },
        scene: { type: 'string', description: '当前场景的一句话（地点 + 时间/氛围），覆盖旧值。场景切换时必填。' },
        recap: { type: 'string', description: '（可选）整体重写的剧情摘要——只在旧摘要太乱太长时用它压一次。日常请用 beat。' },
        beat: { type: 'string', description: '（可选）这一段发生的剧情，会追加到摘要末尾。日常用这个，不需要重写旧内容。' },
        stats: { type: 'object', description: '数值变化，只传变化的键，键名必须与存档卡里一致，例如 {"阳气": 8}。' },
        addItems: { type: 'array', items: { type: 'string' }, description: '（可选）本轮获得的东西。' },
        removeItems: { type: 'array', items: { type: 'string' }, description: '（可选）本轮失去或用掉的东西。' },
        addFlags: { type: 'array', items: { type: 'string' }, description: '（可选）本轮新增的关键线索/状态，例如「欠道士一条命」。' },
        removeFlags: { type: 'array', items: { type: 'string' }, description: '（可选）不再成立的线索/状态。' },
        event: { type: 'string', description: '（可选）本轮值得长期记住的一件事，会进事件日志，以后可用 adventure__recall 检索。' },
        role: { type: 'string', description: '（可选）确定玩家角色名/设定后填一次。' }
      },
      required: []
    },
    async execute(ctx, args) {
      const s = readSettings();
      const chatKey = String(ctx?.chatKey || '');
      const store = readStore();
      if (!store.chats[chatKey]?.active) {
        return { content: '现在没有进行中的文字冒险。想开一局的话调用 adventure__start（不带 theme 会先给你题材菜单）。', isError: true };
      }
      const state = chatState(store, chatKey);
      const active = state.active;
      const text = typeof args?.text === 'string' ? args.text.trim() : '';

      const r = applySaveFields(active, args, s);
      if (args?.event) pushLog(state, args.event);
      if (r.dropped) pushLog(state, `（早期摘要归档）${r.dropped}`);
      // 只有真的发出一段叙述才算推进了一"段"；纯存档（没有 text）不计数
      if (text) active.saves += 1;

      const written = writeStore(store);
      if (!written.ok) {
        // 存档写不进去 = 下一轮模型就忘了这一段；宁可报错让它重试，也别假装成功
        return { content: `存档写不进去（${written.error}），这一段没能记下来。请稍后再试一次。`, isError: true };
      }

      if (!text) return { content: `已更新存档（未发言）。\n${cardText(active)}` };

      const delivered = await sendToChat(ctx, text);
      log(`叙述：${chatKey} · 第 ${active.saves} 段${delivered.ok ? '' : `（发送失败：${delivered.error}）`}`);
      const head = delivered.ok
        ? '已发到群里。'
        : `没能自动发出去（${delivered.error}），请你立刻用 send_message 把下面这段原样发到群里：\n${text}\n`;
      return { content: `${head}\n当前存档：\n${cardText(active)}` };
    }
  });

  a.registerTool({
    id: 'recall',
    name: '翻冒险事件日志',
    description: '检索本局文字冒险的事件日志（早于当前摘要的旧剧情、道具来历、NPC 关系等）。群友问「之前那个人是谁」「这钥匙哪来的」这类需要回忆旧内容的问题时调用它，不要凭印象硬编。',
    category: 'utility',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，例如某个 NPC 名字、道具名、地点。留空则返回最近几条。' },
        limit: { type: 'number', description: '最多返回几条（1~30，默认 8）。' }
      },
      required: []
    },
    async execute(ctx, args) {
      const chatKey = String(ctx?.chatKey || '');
      const store = readStore();
      const state = normalizeChat(store.chats?.[chatKey]);
      if (!state.log.length) {
        return { content: '本群还没有文字冒险的日志记录。想开一局的话调用 adventure__start。' };
      }
      const limit = clampInt(args?.limit, 1, 30, 8);
      const q = String(args?.query ?? '').trim().toLowerCase();
      const pool = q ? state.log.filter((e) => e.text.toLowerCase().includes(q)) : state.log;
      if (!pool.length) {
        return { content: `事件日志里没有和「${args?.query}」相关的内容（本局共 ${state.log.length} 条）。` };
      }
      const picked = pool.slice(-limit);
      return {
        content: [
          `事件日志${q ? `（匹配「${args?.query}」）` : '（最近）'}：`,
          ...picked.map((e) => `[${e.n}] ${e.text}`),
          pool.length > picked.length ? `（共 ${pool.length} 条匹配，只显示最近 ${picked.length} 条）` : ''
        ].filter(Boolean).join('\n')
      };
    }
  });

  a.registerTool({
    id: 'end',
    name: '结束这场冒险',
    description: '收档：结束当前文字冒险，并把结局记进本群档案（题材、结局一句话、存档段数）。群友通关、团灭、或明确说不玩了的时候调用它。收档后可以立刻开新的一局。',
    category: 'utility',
    icon: '🏁',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: '一句话结局，例如「你烧了那封信，从此再没人认得出你」。' }
      },
      required: ['outcome']
    },
    async execute(ctx, args) {
      const chatKey = String(ctx?.chatKey || '');
      const store = readStore();
      if (!store.chats[chatKey]?.active) {
        return { content: '现在没有进行中的文字冒险，不用收档。', isError: true };
      }
      const state = chatState(store, chatKey);
      const active = state.active;
      const outcome = String(args?.outcome ?? '').trim();
      if (!outcome) return { content: '要收档的话，得给一句话结局（outcome）。', isError: true };

      state.finished.push({
        themeName: active.themeName,
        outcome: outcome.slice(0, 200),
        saves: active.saves,
        at: Date.now()
      });
      while (state.finished.length > FINISHED_MAX) state.finished.shift();
      pushLog(state, `结局：${outcome}`);
      state.active = null;
      const written = writeStore(store);
      log(`收档：${chatKey} · ${active.themeName} · ${active.saves} 段`);

      const history = state.finished.slice(-5).reverse()
        .map((f) => `· 「${f.themeName}」${f.outcome}（${f.saves} 段）`).join('\n');
      return {
        content: [
          `本局已收档：『${active.themeName}』，共 ${active.saves} 段。`,
          written.ok ? '' : `（⚠️ 写盘失败，可能仍显示进行中：${written.error}）`,
          '',
          '本群近期结局：',
          history || '（无）',
          '',
          '结局的叙述请你自己用 send_message 发给群友；想再开一局就直接调 adventure__start。'
        ].filter(Boolean).join('\n')
      };
    }
  });

  log(`文字冒险已就绪（题材 ${THEMES.length} 个，每段 ${s0.narrateChars} 字上限）`);
}

export function available() { return { ok: true }; }

export const internals = {
  THEMES, DEFAULTS, LOG_MAX, FINISHED_MAX,
  readSettings, resolveTheme, themeMenu, pickScene, fmtStats,
  promptSections, applyRecap, applySaveFields, mergeList, mergeStats, cardText,
  stateFile, readStore, writeStore, normalizeChat, chatState, pushLog
};
