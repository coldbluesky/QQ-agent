// 海龟汤（LLM 型 / skills/）。
//
// ── 为什么是"落盘 + 提示词注入"，而不是"一问一答"────────────────────────────
// 本项目是**无状态会话**：每条新消息都新开一个会话，LLM 层面零历史（见 README
// 「事件驱动 + 无状态会话」）。所以主持人（模型）在下一轮**不会记得汤底**——
// 上一轮工具返回的答案，下一轮就没了。
//
// 对策与棋局（src/chess.js）完全一致，只是换了数据：
//   · 开局时把「汤面 + 汤底」按 chatKey 落盘，隔离到每个群；
//   · 每次组装系统提示时用 promptSections() 把这一局的汤面、汤底重新注入 ——
//     模型于是"每一轮都记得答案"，能稳定地判断群友的提问；
//   · 回答提问**不走工具**（每题一次工具调用，成本和延迟都不划算），由模型
//     直接说话；只有「开局 / 公布汤底 / 查进度」三个动作才进 function 列表。
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 发言一律走 ctx.sender（限频/去重/存档）；发不出去时退化成把文本交还给
//     模型让它自己发，绝不静默丢消息。
//   · 不注册定时器：本项目的技能没有"主动发消息"的入口（api 上不给 sender），
//     所以不存在"超时判负 / 自动催问"这类设计——题面只在开局那一刻发出，之后
//     完全由群友的消息驱动。
//   · 汤底是秘密：它只进**系统提示**（模型私有上下文），永不进群里。promptSections
//     里对模型写死了"不许说出口"的铁律 —— 这是本技能唯一的防泄底手段，别删。

import fs from 'node:fs';
import path from 'node:path';
import * as configModule from '../../src/config.js';
import { writeJsonAtomic } from '../../src/util.js';
import { currentMemoryKey } from '../../src/persona-store.js';

/** api.config 的本地引用（必须在 setup 里取）。 */
let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 出厂默认值（与 skill.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = { allowCustomPuzzle: true, strictYesNo: true };

/**
 * 内置题库。
 *
 * 每道题都是「汤面（悬念本身）+ 汤底（真相）」的一对，汤面必须**信息不全**才能
 * 玩得起来 —— 所以汤面里刻意不解释前因后果。汤底要求是"一个能让所有细节同时
 * 成立的干净真相"，模糊的答案会让主持人自己都答不好是/不是。
 *
 * 为什么内置而不是全交给模型现编：题面质量是本游戏体验的全部，模型现编的题
 * 常常"没有唯一解"或"汤底和汤面对不上"，一问就露馅。内置题库保底，现编作为补充。
 */
export const PUZZLES = [
  {
    id: 'sea-turtle-soup',
    soup: '一个男人喝了一口海龟汤，随后结束了自己的生命。',
    answer: '他和同伴曾在海上遇难漂流，饿到快死时，同伴端来一碗热汤，说是「海龟汤」，救了他一命。获救后他第一次喝到真正的海龟汤，发现味道完全不同——他终于明白，当年那碗汤是同伴用自己的肉熬的，同伴因此死了。他是为此自尽的。'
  },
  {
    id: 'balloon-match',
    soup: '荒无人烟的沙漠里，一个人面朝下趴着死去，旁边散落着半根火柴。',
    answer: '他和几个人乘热气球穿越沙漠，热气球超重即将坠毁，把身上所有负重都扔了仍然不够。于是大家抽签决定谁跳下去——抽签用的是火柴，抽到最短那一截（也就是这半根）的人跳。'
  },
  {
    id: 'funeral-stranger',
    soup: '一个男人在母亲的葬礼上遇见一位素不相识的女子，一见倾心。几天后，他杀死了自己的姐姐。',
    answer: '他以为只要再办一场葬礼，就能再见到那位女子一面。'
  },
  {
    id: 'elevator-short-man',
    soup: '他住在十楼。每天下楼都能一路坐到一楼，回家时却只坐到七楼，剩下的走楼梯；可下雨天，他能一路坐到家门口。',
    answer: '他个子很矮，电梯里的按钮够不到十楼，最多只够得到七楼，剩下的只好走上去。下雨天他带着雨伞，用伞尖去按按钮，就能直接坐到十楼。'
  },
  {
    id: 'river-waterweed',
    soup: '男人跳河寻死被救起，众人问他在水下看到了什么，他说「只抓到一把水草」。警察听完，立刻派人下河打捞，捞起了一具女尸。',
    answer: '他抓到的并不是水草，而是他女友的长发——女友比他更早一步溺在了这条河里，先他而去。'
  },
  {
    id: 'bar-hiccup',
    soup: '一个人走进酒吧，只点了一杯白水。酒保看了他一眼，突然掏出一把枪指着他。他愣了几秒，笑着说「谢谢」，转身走了。',
    answer: '他打嗝打个不停，正想找办法止住。酒保一眼看穿，于是用「吓一跳」这一招——突然拔枪把他生生吓好了。白水他一口没喝上。'
  },
  {
    id: 'desert-rock-paper-scissors',
    soup: '沙漠里躺着两具尸体，两个人都还握着拳，像到死都在玩石头剪刀布。',
    answer: '他们被困沙漠、水粮耗尽，约定用猜拳决定谁先死——输的人自愿放弃，让对方吃掉自己活下去。结果两人都出了「剪刀」：谁都不肯赢，谁都不忍心活下去。于是两个人都留在了这里。'
  },
  {
    id: 'lighthouse-dark',
    soup: '他睡前随手关掉了一盏灯，第二天读到报纸后，就再也没能原谅自己。',
    answer: '他是灯塔的看守员。那晚他下班前没把塔上的灯点亮（或误把要一直亮着的灯关掉了）。漆黑的海上，一艘船失去指引触礁沉没，船员全部遇难。他读到新闻才明白自己做了什么。'
  },
  {
    id: 'candle-daylight',
    soup: '他吹灭了蜡烛，屋子里反而更亮了。',
    answer: '那天晚上停电，屋里只能点蜡烛。就在他吹灭蜡烛的一瞬间，电来了——顶灯全亮，屋子当然比蜡烛时亮得多。'
  },
  {
    id: 'ice-block',
    soup: '一个人吊死在大厅正中央，脚下只有一滩水；房间里没有能垫脚的东西，也没有第二个出入口。',
    answer: '他站在一块巨大的冰块上把自己吊了起来。冰块融化后只剩那滩水，现场于是看起来像一个不可能完成的密室。'
  },
  {
    id: 'train-tunnel-blind',
    soup: '一个盲人独自坐火车，列车驶入隧道后没多久，他就结束了自己的生命。',
    answer: '他不是天生看不见——他刚做完复明手术，医生嘱咐他拆线前先别睁眼，还说「只要还看得见，手术就算成功」。隧道里一片漆黑，他睁眼什么都看不见，以为手术失败、自己还是个瞎子，绝望之下自尽了。'
  },
  {
    id: 'snow-footprints',
    soup: '他出差几天后回家，发现雪地里只有一串脚印，从大门一直走到屋门口就断了。他没进门，先打了电话报警。',
    answer: '这几天他不在家，屋里不该有人。脚印是走向屋门的，却没有一串走出来的——说明有人进去了，而且还没出来。'
  },
  {
    id: 'extra-candle',
    soup: '停电的夜里，他在家里逐间点起蜡烛。走到第三间房时，他抓起外套就冲出去报了警。',
    answer: '他只在两间房里点过蜡烛。推开第三间房门时，里面已经有一根烛火亮着了——屋里只有他一个人，那根蜡烛不是他点的。'
  },
  {
    id: 'voicemail-third-listen',
    soup: '他把妻子生前的语音留言翻来覆去地听，听到第三遍时，他报了警。',
    answer: '妻子是被人害死的。他听了三遍才听清：留言的背景里除了妻子的话，还有另一个人的声音和一声关门声。也就是说，妻子录下这段话的时候，凶手就在她身边。'
  },
  {
    id: 'birthday-cake-stranger',
    soup: '她生日那天，一个蛋糕被送到了家里。她没告诉过任何人今天是她的生日，也没告诉过任何人现在的地址。她打开盒子，立刻报了警。',
    answer: '她几个月前才搬来这座城市，就是为了躲开一个人。能准确找到这个地址、还知道她生日的，只有那个人。'
  },
  {
    id: 'watering-the-flowers',
    soup: '她每天早上都给阳台的花浇水。这天她照常浇完水，低头往楼下看了一眼，然后报了警。',
    answer: '老楼阳台渗水，浇花的水会顺着往楼下滴。今天她看见水正滴在一个躺在地上一动不动的人身上，那人一点反应都没有——楼下有人倒在那里。'
  },
  {
    id: 'two-movie-tickets',
    soup: '他买了两张电影票，一个人看完了整场，散场时却哭得站不起来。',
    answer: '这是他和妻子的约定：她说等这部片子上映就一起看。片子真的上映了，她已经不在了。他买两张票，是替两个人来看的。'
  },
  {
    id: 'call-dead-wife',
    soup: '他给去世半年的妻子手机打了个电话，居然有人接了。他立刻报了警。',
    answer: '他一直没舍得给妻子的号码销户，每月照旧交着话费。妻子的手机是和她一起失踪的，那个号码早该没人用了——能接起这个电话的，只有拿走她手机的人。'
  },
  {
    id: 'triplets-same-day',
    soup: '一位母亲有三个儿子，三个儿子在同一天离世，警察却没有立案。',
    answer: '三个儿子是三胞胎。他们在同一天出生，也在同一天夭折——那是一场没能救回来的早产，属于医疗事件，不是刑案。'
  },
  {
    id: 'bungee-cliff',
    soup: '他纵身从悬崖上跳了下去，围观的人却一起鼓起掌来。',
    answer: '他系着安全绳——这是一次蹦极，或者一场极限表演。观众是在为他的这一跳喝彩。'
  },
  {
    id: 'fake-blood-room',
    soup: '房间里满地是血，警察冲进去之后却发现没有一个人受伤。',
    answer: '那是剧组正在拍戏。地上的「血」是道具糖浆（影视用的假血），屋子里的人全是演员。'
  },
  {
    id: 'neighbor-light',
    soup: '他每晚都能看到对面楼那位独居老人准时在十点关灯。今晚十一点了，老人家的灯还亮着。他拨了报警电话。',
    answer: '他和老人早就约好：只要每晚十点按时关灯，就说明老人平安。灯一直亮着，意味着老人出了事——一个人住的他，没人会发现得更早。'
  },
  {
    id: 'second-toothbrush',
    soup: '她一个人住。这天早上刷牙时，她发现杯子里多了一把牙刷。',
    answer: '她的洗漱杯里本来只有她自己的那一把。多出来的那把意味着：有人进过她家，而且没打算马上走。'
  },
  {
    id: 'sleeping-passenger',
    soup: '他在火车上睡着了，醒来时发现整节车厢空无一人。',
    answer: '车已经到终点站了，乘客早就下光了——他睡过了站，这节车厢是被暂时闲置的。'
  },
  {
    id: 'returned-letter',
    soup: '他给去世的父亲寄了一封信，几天后竟然收到了回信。他拆开一看，反而更难受了。',
    answer: '他收到的其实是自己寄出的那封信——因为收件地址那端已经没人签收，邮局原封退回。信封上那个「无法投递」的戳，就是他父亲确实不在了的证明。'
  },
  {
    id: 'suitcase-extra-package',
    soup: '他在机场打开自己的行李箱，发现里面多了一个不属于他的包裹，随即报了警。',
    answer: '有人趁他不注意，把东西塞进了他的箱子——包着的是违禁品。他差一点就成了被人利用的「运输工具」，所以必须在登机前报警。'
  },
  {
    id: 'laugh-at-funeral',
    soup: '葬礼上所有人都在哭，只有一个人在笑，却没有人责怪他。',
    answer: '死者生前在遗嘱里写明了：自己的葬礼上不许哭，请在场的人替他笑一次，就当送他出门。'
  },
  {
    id: 'piano-upstairs',
    soup: '楼上每晚十点都会准时传来钢琴声。这天十点整，琴声又响了起来，他却连夜搬走了。',
    answer: '楼上的住户上个月就已经搬走了，那间房一直空着——房里根本没有人，琴声不该存在。'
  },
  {
    id: 'anonymous-package-phone',
    soup: '他收到一个没有寄件人的包裹，里面是一部手机。他开机看了一眼，立刻报了警。',
    answer: '手机相册里全是他自己家里的照片——从他家的角度拍的，有些甚至就是当天早上拍的。有人在盯着他。'
  },
  {
    id: 'last-one-out-of-classroom',
    soup: '他是最后一个离开教室的人。关灯锁门之后，他在走廊尽头又听到了教室里翻书的声音。',
    answer: '他锁门时，教室里还躲着一个人——那个人一直没走，也没敢出声。'
  }
];

// ── 配置 ──────────────────────────────────────────────────────────────────

/** 当前设置（出厂默认 ← 用户在设置页改过的值）。 */
export function readSettings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  // 布尔项一律按「不是 false 就是 true」归一：设置页存下来的可能是字符串/undefined
  out.allowCustomPuzzle = out.allowCustomPuzzle !== false;
  out.strictYesNo = out.strictYesNo !== false;
  return out;
}

// ── 落盘 ─────────────────────────────────────────────────────────────────
//
// 路径刻意与棋局（chess.json）同目录：都挂在当前人设的 _global 下，
// 换人设就换一整套游戏存档，符合"每个角色有自己的群记忆"的整体设计。
//
// ⚠️ DATA_DIR 用**延迟读取**（每次现取）而不是模块加载时定死：测试与便携模式会
// 重定向数据目录，顶层取会把旧路径固定下来（同 src/sticker-manager.js 的告诫）。

function stateFile(dir = '') {
  const base = dir || path.join(configModule.DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'turtle-soup.json');
}

export function turtleSoupFilePath(dir = '') {
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

/** 把一条落盘记录补齐成完整的会话状态（缺字段一律补默认，不抛）。 */
function normalizeChat(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const byUser = (s.byUser && typeof s.byUser === 'object' && !Array.isArray(s.byUser)) ? s.byUser : {};
  const active = (s.active && typeof s.active === 'object' && s.active.soup && s.active.answer)
    ? {
        id: String(s.active.id || ''),
        soup: String(s.active.soup),
        answer: String(s.active.answer),
        startedAt: Number(s.active.startedAt) || 0
      }
    : null;
  return {
    used: Array.isArray(s.used) ? s.used.map(String) : [],
    active,
    started: Number(s.started) || 0,
    solved: Number(s.solved) || 0,
    byUser: { ...byUser }
  };
}

/** 取某个会话的状态（不存在就建一个空壳）。 */
function chatState(store, chatKey) {
  const key = String(chatKey || '');
  const s = normalizeChat(store.chats[key]);
  store.chats[key] = s;
  return s;
}

// ── 出题 ─────────────────────────────────────────────────────────────────

/**
 * 抽一道本群还没用过的题；题库抽完一轮就重置重来。
 *
 * rng 可注入：测试要的是"抽到哪一道"确定，而不是结果随运行变。
 */
export function pickPuzzle(state, { puzzles = PUZZLES, rng = Math.random } = {}) {
  const pool = puzzles.filter((p) => p && p.id && p.soup && p.answer);
  if (!pool.length) return null;
  const used = Array.isArray(state?.used) ? state.used : [];
  let candidates = pool.filter((p) => !used.includes(p.id));
  if (!candidates.length) {
    // 抽完一轮：清空已用记录，重新开始（否则题目会永久枯竭）
    if (state) state.used = [];
    candidates = pool;
  }
  const idx = Math.floor(Number(rng()) * candidates.length) % candidates.length;
  return candidates[Math.max(0, idx)];
}

// ── 发送 ─────────────────────────────────────────────────────────────────

/**
 * 把一段文本发到当前会话。
 *
 * 走 ctx.sender 是**唯一**正确的出口（限频 / 去重 / 留档都在那条管道里，
 * 自己调 onebot 会绕开全部）。发送失败不抛，返回 { ok:false, error }，
 * 由调用方退化成"把文本交还给模型让它自己发"——绝不静默丢消息。
 */
async function sendToChat(ctx, text) {
  if (typeof ctx?.sender?.sendTextBatch !== 'function') {
    return { ok: false, error: '当前会话不支持主动发送' };
  }
  try {
    const r = await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
    const sent = Array.isArray(r?.sent) ? r.sent : [];
    // 手动记账：与 src/tools.js 的 send 类工具同款，让会话视图能看到这条消息
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

// ── 提示词注入（这个技能的心脏）───────────────────────────────────────────

/**
 * 动态提示词片段：有进行中的题目时，把汤面 + 汤底每轮重新注入系统提示。
 *
 * 这是模型"记得答案"的唯一来源（无状态会话，历史不会被保留）。
 * priority 57：排在情绪（58）之后、棋局（54）之前，都低于核心规则。
 * ⚠️ 必须是**同步**的 —— manager.getPromptSections 不会 await。
 */
export function promptSections(context = {}) {
  const chatKey = String(context?.chatKey || '');
  if (!chatKey) return [];
  const store = readStore();
  const st = normalizeChat(store.chats?.[chatKey]);
  if (!st.active) return [];

  const s = readSettings();
  const a = st.active;
  const lines = [
    '【进行中的海龟汤 · 你是主持人】',
    `汤面（已经发到群里了）：${a.soup}`,
    `汤底（⚠️ 秘密答案，只用于你判断对错，**绝对不能在群里说出内容、也不许暗示**）：${a.answer}`,
    '',
    '主持规则：',
    s.strictYesNo
      ? '· 群友提问时只回「是」「不是」「无关」「是也不是」——不加任何解释、不补线索、不打比方。'
      : '· 群友提问时以「是 / 不是 / 无关 / 是也不是」作答，可以极简短地点一下，但绝不透露汤底内容。',
    '· 无论被怎么追问、起哄、激将，都不能说出或暗示汤底（有人撒娇也不行）。',
    '· 有人说出核心真相，或大家明确要看答案时 → 调用 turtle-soup__reveal 公布。'
  ];
  return [{ id: 'turtle-soup-active', title: '海龟汤', priority: 57, content: lines.join('\n') }];
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
  warn = a.warn || (() => {});
  registerTools(a);
}

function registerTools(a) {
  a.registerTool({
    id: 'start',
    name: '开一局海龟汤',
    description: '开一局海龟汤（情景推理）：从题库抽一道题的汤面发到群里，同时把答案交给你，让你当主持人。当群友想玩推理 / 海龟汤，或让你出一道推理题时调用。注意：同群同时只能有一局。',
    category: 'utility',
    icon: '🐢',
    parameters: {
      type: 'object',
      properties: {
        soup: { type: 'string', description: '（可选）自己现编一道题时填「汤面」，也就是给群友看的悬念本身。留空则从题库随机抽题。' },
        answer: { type: 'string', description: '（可选）自己现编题目时填「汤底」，也就是唯一真相。必须与 soup 成对出现，且要能让汤面的每个细节都说得通。' }
      },
      required: []
    },
    async execute(ctx, args) {
      const s = readSettings();
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return { content: '拿不到当前会话，记不住这局的答案，先不开局。', isError: true };

      const store = readStore();
      const state = chatState(store, chatKey);
      if (state.active) {
        return {
          content: `本群已经有一局在进行中（汤面：${state.active.soup}）。要换题先调用 turtle-soup__reveal 把当前这局收掉。`,
          isError: true
        };
      }

      const customSoup = String(args?.soup ?? '').trim();
      const customAnswer = String(args?.answer ?? '').trim();
      let puzzle;
      if (customSoup || customAnswer) {
        if (!s.allowCustomPuzzle) {
          return { content: '设置里关掉了「允许自编题目」：请不要传 soup/answer，直接让我从题库抽题开局。', isError: true };
        }
        if (!customSoup || !customAnswer) {
          return { content: '自编题要同时给 soup（汤面）和 answer（汤底），缺一个都没法开局。', isError: true };
        }
        puzzle = { id: `custom-${Date.now()}`, soup: customSoup, answer: customAnswer };
      } else {
        puzzle = pickPuzzle(state);
        if (!puzzle) return { content: '题库是空的，出不了题。', isError: true };
        if (!state.used.includes(puzzle.id)) state.used.push(puzzle.id);
      }

      state.active = { id: puzzle.id, soup: puzzle.soup, answer: puzzle.answer, startedAt: Date.now() };
      state.started += 1;
      const written = writeStore(store);
      if (!written.ok) {
        // 答不进磁盘 = 下一轮模型就忘了汤底，这局一定玩崩 —— 宁可开局失败
        return { content: `记不住这局的答案（写盘失败：${written.error}），这局不开了。`, isError: true };
      }

      const text = `🐢 海龟汤 · 第 ${state.started} 碗\n汤面：${puzzle.soup}\n\n来猜吧——用能被「是 / 不是」回答的问题问我。`;
      const delivered = await sendToChat(ctx, text);
      log(`开局：${chatKey} · ${puzzle.id}${delivered.ok ? '' : `（发送失败：${delivered.error}）`}`);

      const secret = `汤底（⚠️ 秘密答案，只用来判断群友的提问，**绝对不能在群里说出内容**）：${puzzle.answer}`;
      if (delivered.ok) {
        return {
          content: `汤面已经发到群里了，你别再重复念一遍。\n${secret}\n现在开始当主持人：只回「是 / 不是 / 无关 / 是也不是」，不要解释。`
        };
      }
      return {
        content: `汤面没能自动发出去（${delivered.error}），请你把下面这段原样发到群里：\n${text}\n\n${secret}`
      };
    }
  });

  a.registerTool({
    id: 'reveal',
    name: '公布汤底',
    description: '公布当前这局海龟汤的汤底并结束本局。有人说出核心真相、或大家明确要看答案 / 想放弃了，就调用它。公布后可以接着开新一局。',
    category: 'utility',
    icon: '🥣',
    parameters: {
      type: 'object',
      properties: {
        solved: { type: 'boolean', description: '是否有人猜中了真相：猜中填 true；大家没猜出来、直接要看答案或放弃了，填 false。' },
        player: { type: 'string', description: '猜中者的群昵称（solved 为 true 时尽量填上，用来记分；确实不知道就留空）。' }
      },
      required: ['solved']
    },
    async execute(ctx, args) {
      const chatKey = String(ctx?.chatKey || '');
      const store = readStore();
      // ⚠️ 必须用 chatState（就地取，写回同一对象引用）：
      //    normalizeChat 返回的是**副本**，改副本再 writeStore 等于什么都没改，
      //    本局会永远"进行中"。（这个坑真踩过一次。）
      if (!store.chats[chatKey]) return { content: '现在没有进行中的海龟汤。想玩的话调用 turtle-soup__start 开一局。', isError: true };
      const state = chatState(store, chatKey);
      if (!state.active) {
        return { content: '现在没有进行中的海龟汤。想玩的话调用 turtle-soup__start 开一局。', isError: true };
      }

      const a = state.active;
      const solved = args?.solved === true;
      const player = String(args?.player ?? '').trim().slice(0, 40);
      if (solved) {
        state.solved += 1;
        const who = player || '某位群友';
        state.byUser[who] = (Number(state.byUser[who]) || 0) + 1;
      }

      const lines = ['🐢 公布汤底', `汤面：${a.soup}`, `汤底：${a.answer}`];
      lines.push(solved ? `—— 恭喜 ${player || '这位群友'} 猜中！` : '—— 这碗没人喝到见底，下回再来。');
      const text = lines.join('\n');

      state.active = null;
      const written = writeStore(store);
      const delivered = await sendToChat(ctx, text);
      log(`公布：${chatKey} · ${a.id}${solved ? '（猜中）' : ''}${delivered.ok ? '' : `（发送失败：${delivered.error}）`}`);

      const notes = [];
      notes.push(delivered.ok
        ? '汤底已经发到群里了，你不要再重复抄一遍。'
        : `汤底没能自动发出去（${delivered.error}），请你把下面这段原样发到群里：\n${text}`);
      notes.push(`本群战绩：开局 ${state.started} 局 / 猜中 ${state.solved} 局。`);
      if (!written.ok) notes.push(`（⚠️ 清理本局状态时写盘失败，可能仍显示进行中：${written.error}）`);
      notes.push('如果群里还想玩，可以直接再开一局。');
      return { content: notes.join('\n') };
    }
  });

  a.registerTool({
    id: 'status',
    name: '海龟汤进度',
    description: '查本群海龟汤的当前题目与战绩（开局几局、猜中几局、谁猜中最多）。有人问「这题什么情况 / 玩到哪了 / 谁最厉害」时用它。注意：它不会公布答案——要看答案请用 turtle-soup__reveal。',
    category: 'utility',
    icon: '📜',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      const chatKey = String(ctx?.chatKey || '');
      const store = readStore();
      if (!store.chats?.[chatKey]) return { content: '本群还没玩过海龟汤。想玩的话调用 turtle-soup__start 开一局。' };

      const state = normalizeChat(store.chats[chatKey]);
      const top = Object.entries(state.byUser)
        .filter(([, c]) => Number(c) > 0)
        .sort((x, y) => Number(y[1]) - Number(x[1]))
        .slice(0, 5);
      const lines = [`海龟汤战绩：开局 ${state.started} 局 / 猜中 ${state.solved} 局。`];
      if (top.length) lines.push(`猜中榜：${top.map(([name, count]) => `${name}×${count}`).join('、')}`);
      if (state.active) {
        lines.push(`进行中：汤面「${state.active.soup}」（答案还没公布——要公布请调用 turtle-soup__reveal）`);
      } else {
        lines.push('当前没有进行中的题目。');
      }
      return { content: lines.join('\n') };
    }
  });

  log('海龟汤已就绪（题库 ' + PUZZLES.length + ' 碗）');
}

export function available() { return { ok: true }; }

export const internals = {
  PUZZLES, DEFAULTS, readSettings, pickPuzzle, promptSections,
  stateFile, readStore, writeStore, normalizeChat, chatState
};
