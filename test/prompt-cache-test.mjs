// 提示词前缀缓存回归测试。
//
// 为什么需要它：这一组优化（段序 / 分钟粒度 / 历史窗口锚定 / 紧凑格式）改错了
// **不会报错、不会崩**，只是每次请求多付钱 —— 正是最需要测试兜住的那类改动。
// 所以这里断言的是"字节性质"：哪些段排在哪些段之后、两次渲染是否逐字节一致、
// 窗口是不是只在尾部追加。
//
// ⚠️ 数据目录重定向到临时目录：store/memory 都会落盘，绝不能碰用户真实的 data/。
// 因此所有读 DATA_DIR 的模块都必须**动态 import**（静态 import 会在本文件正文
// 执行之前就求值，环境变量就设晚了）。
//
// ⚠️ 每个测试块用**独立的会话号**：ChatStore 会从磁盘加载已有会话，
// 复用同一个 chatKey 会让上一块的 20 条历史叠到这一块上，id 预期全部错位。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-prompt-cache-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildSystemPrompt, buildUserPrompt, buildPastState } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.participation = 'medium';
cfg.sticker.enabled = true;
cfg.song.enabled = false;
setRuntimeConfig(cfg);

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}

let chatSeq = 900000;
/** 每个测试块一个全新会话号，避免磁盘上的旧历史叠进来。 */
function freshChat() {
  chatSeq += 1;
  return `group:${chatSeq}`;
}

/** 造 n 条历史（1 分钟一条，方便断言相对时间戳），全部置为已读。 */
function seed(store, chatKey, n) {
  const base = Date.now() - 3600_000;
  for (let i = 1; i <= n; i++) {
    store.appendIncoming(chatKey, {
      mid: 1000 + i,
      ts: base + i * 60000,
      senderId: i % 3 === 0 ? 'u2' : 'u1',
      senderName: i % 3 === 0 ? '阿伟' : '小明',
      text: `历史${i}`
    });
  }
  store.drainUnread(chatKey);
}

/** 追加若干条新消息并返回未读批（模拟真实唤醒）。 */
function push(store, chatKey, texts) {
  const base = Date.now();
  texts.forEach((t, i) => {
    store.appendIncoming(chatKey, {
      mid: 5000 + i, ts: base + i * 1000, senderId: 'u9', senderName: '新来的', text: t
    });
  });
  return store.drainUnread(chatKey);
}

function baseCtx(store, chatKey, memory, triggerEntries, extra = {}) {
  return {
    chatKey, kind: 'group', chatId: chatKey.split(':')[1], chatName: '测试群',
    triggerEntries, store, memory,
    selfNickname: '测试机',
    selfLastMessageAt: Date.now() - 120000,
    lastMessageAt: Date.now() - 1000,
    recentCount: 12,
    runSeq: 1,
    moreUnreadDuringRun: false,
    proactive: false,
    contextLimit: 10,
    ...extra
  };
}

// ── 1. 段序：易变段必须排在低频段之后（段序 = 前缀缓存的全部收益）──
{
  const chat = freshChat();
  const store = new ChatStore(0);
  seed(store, chat, 20);
  const memory = new MemoryStore();
  memory.append(chat, 'memberImpression', '喜欢猫', { userId: 'u1', target: '小明' });
  const triggers = push(store, chat, ['在吗', '看看这个']);
  const prompt = buildUserPrompt(baseCtx(store, chat, memory, triggers));

  const at = (s) => prompt.indexOf(s);
  ok(at('【引导说明】') >= 0 && at('【过去状态】') > at('【引导说明】'), '【引导说明】（静态）排在【过去状态】之前');
  ok(at('【记忆】') >= 0 && at('【记忆】') < at('【过去状态】'), '【记忆】（低频）排在【过去状态】之前');
  ok(at('【过去状态】') < at('【当前时间】'), '【当前时间】（每轮都变）排在【过去状态】之后');
  ok(at('【当前时间】') < at('【此刻状态】') && at('【此刻状态】') < at('【本次唤醒】'), '易变三段在队尾，顺序为 当前时间 → 此刻状态 → 本次唤醒');
  ok(triggers.every((m) => prompt.includes(m.text)), '触发批出现在【本次唤醒】里');
}

// ── 2. 【当前时间】粒度 = 分钟（同一分钟内多次渲染必须逐字节一致）──
{
  const chat = freshChat();
  const store = new ChatStore(0);
  seed(store, chat, 20);
  const memory = new MemoryStore();
  const stampOf = (t) => (/【当前时间】([^\n]+)/.exec(t) || [])[1] || '';
  // 跨分钟边界会让"两次一致"偶然失败；重试几次即可（正常情况一次就过）
  let stampA = '';
  let stampB = '';
  for (let i = 0; i < 3; i++) {
    stampA = stampOf(buildUserPrompt(baseCtx(store, chat, memory, [])));
    stampB = stampOf(buildUserPrompt(baseCtx(store, chat, memory, [])));
    if (stampA === stampB) break;
  }
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00（周.）$/.test(stampA), `【当前时间】取整到分钟（实际 ${stampA}）`);
  ok(stampA === stampB, '同一分钟内两次渲染的【当前时间】完全一致（多轮工具调用可整段命中）');
}

// ── 3. 触发批不进历史；上一轮的唤醒批在下一轮落到历史**尾部** ──
{
  const chat = freshChat();
  const store = new ChatStore(0);
  seed(store, chat, 20);
  const round1 = push(store, chat, ['第一轮未读A', '第一轮未读B']);
  const past1 = buildPastState(store, chat, { excludeIds: round1.map((m) => m.id), limit: 10, anchorChunk: 8 });
  ok(!past1.text.includes('第一轮未读A'), '触发批不出现在【过去状态】里（避免与新消息重复）');
  const round2 = push(store, chat, ['第二轮未读C']);
  const past2 = buildPastState(store, chat, { excludeIds: round2.map((m) => m.id), limit: 10, anchorChunk: 8 });
  ok(past2.text.includes('第一轮未读A') && past2.text.includes('第一轮未读B'), '上一轮的唤醒批在下一轮成为历史');
  ok(past2.text.startsWith(past1.text), '新消息只是**尾部追加**，上一轮历史是本轮的前缀');
}

// ── 4. 窗口锚定：块内追加 → 前缀延伸；跨块 → 断一次；长度锁在 [maxLimit, maxLimit+chunk-1] ──
{
  const chat = freshChat();
  const store = new ChatStore(0);
  seed(store, chat, 20);
  const LIMIT = 10;
  const CHUNK = 8;
  // newest=20 → anchor=floor((20-10)/8)*8=8 → 窗口 (8,20] = 12 条
  const p1 = buildPastState(store, chat, { limit: LIMIT, anchorChunk: CHUNK });
  ok(p1.count === 12 && p1.anchored === true, `锚定后窗口 = 12 条（实际 ${p1.count}，anchored=${p1.anchored}）`);
  push(store, chat, ['新1', '新2', '新3']);   // newest=23 → anchor 仍是 8 → 窗口 15 条
  const p2 = buildPastState(store, chat, { limit: LIMIT, anchorChunk: CHUNK });
  ok(p2.count === 15, `块内追加：窗口长到 15 条（实际 ${p2.count}）`);
  ok(p2.text.startsWith(p1.text), '块内追加 → 上一轮历史块整体成为公共前缀（缓存延伸到历史末尾）');
  push(store, chat, ['新4', '新5', '新6', '新7', '新8', '新9']);   // newest=29 → anchor 跳到 16 → 跨块
  const p3 = buildPastState(store, chat, { limit: LIMIT, anchorChunk: CHUNK });
  ok(p3.count === 13 && p3.anchored === true, `跨块后窗口 = 13 条（实际 ${p3.count}）`);
  ok(!p3.text.startsWith(p2.text), '跨块那一次前缀会断（块大小与"每轮新增条数"的取舍，周期性发生）');
  for (const [name, p] of [['p1', p1], ['p2', p2], ['p3', p3]]) {
    ok(p.count >= LIMIT && p.count <= LIMIT + CHUNK - 1, `${name} 长度锁在 [10, 17]：实际 ${p.count}`);
  }

  // ── 5. 退化：id 被删出大空洞时，必须**精确回到旧行为**并显式标记 ──
  const holeIds = store.recent(chat, { limit: 200 }).filter((m) => m.id >= 17 && m.id <= 25).map((m) => m.id);
  store.removeByLocalIds(chat, holeIds);
  const p4 = buildPastState(store, chat, { limit: LIMIT, anchorChunk: CHUNK });
  ok(p4.anchored === false, 'id 空洞过大时 anchored=false（不再假装优化还生效）');
  ok(p4.count === LIMIT, `退化时精确回到"最近 maxLimit 条"（实际 ${p4.count}）`);
}

// ── 6. 紧凑格式：首行绝对时间 / 其余相对；QQ 号只在首次出现，可开关改为每行都带 ──
{
  const chat = freshChat();
  const store = new ChatStore(0);
  seed(store, chat, 20);
  const past = buildPastState(store, chat, { limit: 10, anchorChunk: 8 });
  const lines = past.text.split('\n');
  ok(/^\[\d{2}-\d{2} \d{2}:\d{2}\] /.test(lines[0]), `首行给绝对时间：${lines[0].slice(0, 22)}`);
  ok(/^\[\+\d+m\] /.test(lines[1]), `第二行起给相对上一条的分钟差：${lines[1].slice(0, 22)}`);
  ok(lines.slice(1).every((l) => /^\[\+(?:\d+m|\d+h|0)\] /.test(l)), '相对时间戳覆盖到每一行（不再逐行写绝对时间）');
  const u1Segments = lines.filter((l) => l.includes('小明'));
  ok(u1Segments.length > 1, `样本里同一人出现多次（${u1Segments.length} 行）`);
  ok((past.text.match(/\(QQ:u1\)/g) || []).length === 1, '默认同一发言人只在首次出现带 QQ 号（省字节）');
  ok(u1Segments[0].includes('(QQ:u1)') && u1Segments.slice(1).every((l) => l.includes('小明：')),
    '首次出现带号码、后续只有名字（号码仍是身份锚点）');

  // 关掉省略：每行都带号码 —— 身份判定更硬，代价是每行多约 10 字符
  cfg.store.historyShortSpeaker = false;
  setRuntimeConfig(cfg);
  const fullPast = buildPastState(store, chat, { limit: 10, anchorChunk: 8 });
  ok((fullPast.text.match(/\(QQ:u1\)/g) || []).length === u1Segments.length, '关掉省略后每行都带号码');
  ok(fullPast.text.length > past.text.length, `省字节开关确实在省字节：${past.text.length} < ${fullPast.text.length}`);
  cfg.store.historyShortSpeaker = true;
  setRuntimeConfig(cfg);
}

// ── 7. 系统提示字节稳定（配置不变时必须逐字节一致，否则整请求缓存失效）──
{
  const a = buildSystemPrompt();
  const b = buildSystemPrompt();
  ok(a.length > 0 && a === b, '配置不变时两次 buildSystemPrompt 字节一致');
}

// ── 8. Skill 可用性不许抖动：可用性一变就会增删提示词段 + 工具，系统提示字节跟着跳 ──
// 复现的是 video-frames 曾经的 60 秒循环：探测失败 → 60s 后置回 null → 乐观放行(可用)
// → 再探测失败…… 系统提示在 4531/4598 两个字节版本间跳，服务商侧整段缓存归零。
{
  const vf = await import('../plugins/video-frames/index.js');
  vf.setup({ config: () => ({ count: 4 }), log: () => {} });
  vf.internals.__setFfmpegKnown('');
  vf.internals.__setFfmpegKnown('', Date.now() - 120000);   // 进入"失败结果超 60s 的重探窗口"
  const r = vf.available();
  ok(r.ok === false && r.reason === vf.internals.FFMPEG_MISSING_REASON,
    `重探窗口里必须保持"不可用"（不许乐观放行）：ok=${r.ok}`);
  ok(vf.available().reason === r.reason, '重复判定返回同一条 reason（状态文本也逐字节稳定）');
  vf.internals.__resetFfmpegCache();
}

// ── 9. 提示词片段不许重复声明（plugin.json 静态 + index.js 动态曾各来一份）──
{
  const { ROOT } = await import('../src/config.js');
  const readManifest = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, `plugins/${id}/plugin.json`), 'utf8'));
  // 这四个插件都曾"两份说法、不同 id"，而 SkillManager 只按 id 去重 → 两份都进提示词
  for (const id of ['speaker-identity', 'video-frames', 'thinking-adapters', 'owner-identity']) {
    const sections = readManifest(id).prompt?.sections || [];
    ok(sections.length === 0, `${id}/plugin.json 不再声明静态片段（避免与动态片段重复占 token）`);
  }

  const si = await import('../plugins/speaker-identity/index.js');
  si.setup({ config: () => ({ includeInHistory: true }), log: () => {} });
  ok(si.promptSections().length === 1, '发言人身份：开着"历史带 QQ 号"时规则只有一份');
  const fmt = si.providers['message.speaker-format'];
  ok(fmt({ message: { senderId: '10001', senderName: '小明' } }) === '小明(QQ:10001)', '能力输出 名字(QQ:xxx)，与核心的兜底形态一致');
  si.setup({ config: () => ({ includeInHistory: false }), log: () => {} });
  ok(si.promptSections().length === 0, '关掉"历史带 QQ 号"时该规则一并消失（不能指向不存在的 QQ 号）');
  ok(fmt({ message: { senderId: '10001', senderName: '小明' } }) === '小明', '关掉后历史行不再带 QQ 号');

  const vf = await import('../plugins/video-frames/index.js');
  vf.setup({ config: () => ({ count: 4 }), log: () => {} });
  const vfSec = vf.promptSections();
  ok(vfSec.length === 1 && vfSec[0].content.includes('看起来') && vfSec[0].content.includes('4 张截图'),
    '视频理解：帧数与措辞建议合成一份，内容不减');

  const ta = await import('../plugins/thinking-adapters/index.js');
  ta.setup({ config: () => ({ mode: 'auto' }), log: () => {} });
  const taSec = ta.promptSections();
  ok(taSec.length === 1 && taSec[0].content.includes('当前思考模式') && taSec[0].content.includes('不要把打算'),
    '思考输出：模式状态与"别把分析写进消息"合成一份');

  const oi = await import('../plugins/owner-identity/index.js');
  oi.setup({ config: () => ({ ids: ['10001'] }), log: () => {} });
  const oiSec = oi.promptSections();
  ok(oiSec.length === 1 && oiSec[0].content.includes('10001') && oiSec[0].content.includes('只看 QQ 号'),
    '主人识别：动态片段已覆盖静态片段的内容（含号码名单）');
}

// ── 10. 端到端：连续两轮（同一会话，中间来了新消息）的公共前缀必须大幅延伸 ──
// 这是"锚定到底有没有在起作用"的唯一直接证据：服务商只认从头逐字节一致的那一段。
// 关掉锚定（historyAnchorChunk < 0）跑同一场景作对照 —— 两组数字的差距就是收益。
{
  const lcp = (a, b) => {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i += 1;
    return i;
  };

  /** 跑连续两轮，返回两轮的公共前缀占较短者的比例。 */
  function twoRounds() {
    const chat = freshChat();
    const store = new ChatStore(0);
    seed(store, chat, 80);
    const memory = new MemoryStore();
    const p1 = buildUserPrompt(baseCtx(store, chat, memory, push(store, chat, ['这句是上一条']), { contextLimit: 80 }));
    const p2 = buildUserPrompt(baseCtx(store, chat, memory, push(store, chat, ['新消息1', '新消息2', '新消息3']), { contextLimit: 80 }));
    return { p1, p2, ratio: lcp(p1, p2) / Math.min(p1.length, p2.length) };
  }

  const on = twoRounds();
  cfg.store.historyAnchorChunk = -1;      // 关掉锚定：退回原来的滑动窗口
  setRuntimeConfig(cfg);
  const off = twoRounds();
  cfg.store.historyAnchorChunk = 0;
  setRuntimeConfig(cfg);

  ok(on.ratio >= 0.8, `开着锚定：两轮公共前缀占较短的 ${(on.ratio * 100).toFixed(1)}%（要求 ≥80%）`);
  ok(on.ratio > off.ratio + 0.1, `锚定确实是收益来源：${(off.ratio * 100).toFixed(1)}% → ${(on.ratio * 100).toFixed(1)}%`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✓ 提示词前缀缓存回归全部通过（${passed} 项断言）`);
