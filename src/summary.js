// 前情摘要：跨会话的对话记忆。
//
// ── 为什么需要它 ──
// 本项目每次运行都是全新会话，模型对历史的全部认知就是【过去状态】里的最近 N 条原文
// （N 由上下文档位决定，8~80 不等）。群一活跃，这点窗口几分钟就被刷过去，窗口外的对话
// 等于没发生过 —— 这就是"聊完就忘、显得呆"的根源。
//
// ── 做法 ──
// 每次运行结束后，把"这次没看到原文的旧消息"折叠进一份持久化摘要，下次唤醒时连同最近
// 原文一起注入。两个关键性质：
//   1. 摘要正文有固定字数上限（summary.maxChars）→ 注入成本有界，不随聊天量膨胀，
//      保住了项目"单次成本恒定"的设计；
//   2. 折叠在运行结束后异步做，不占回复时间，失败也只记日志、不影响聊天主流程。
//
// ── 存储 ──
// data/summary/<group_x|private_x>.json
//   {
//     text:       摘要正文
//     throughId:  已折叠到的本地消息 id（含）。下次只折叠 id 比它大的，
//                 所以重复调用是幂等的，同一条消息不会被折叠两次。
//     updatedAt / folds / folded：展示与统计用
//   }
//
// 刻意不放进 data/memory/：那边 memory.js 会把会话目录下的每个 .json 都当成员文件读，
// 多一个 _summary.json 会被解析成一条"无名群友"的脏数据。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const SUMMARY_DIR = path.join(DATA_DIR, 'summary');

function chatFile(chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(SUMMARY_DIR, `${safe}.json`);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

const EMPTY = { text: '', throughId: 0, updatedAt: 0, folds: 0, folded: 0 };

/** 读取某会话的前情摘要（不存在时返回空结构）。 */
export function loadSummary(chatKey) {
  const raw = readJson(chatFile(chatKey), null);
  if (!raw) return { ...EMPTY };
  return {
    text: String(raw.text ?? ''),
    throughId: Number(raw.throughId) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    folds: Number(raw.folds) || 0,
    folded: Number(raw.folded) || 0
  };
}

/** 写入摘要；patch 里没给的字段保持原值。 */
export function saveSummary(chatKey, patch = {}) {
  const cur = loadSummary(chatKey);
  const next = {
    chatKey: String(chatKey),
    text: patch.text === undefined ? cur.text : String(patch.text ?? ''),
    throughId: patch.throughId === undefined ? cur.throughId : (Number(patch.throughId) || 0),
    updatedAt: Date.now(),
    folds: patch.folds === undefined ? cur.folds : (Number(patch.folds) || 0),
    folded: patch.folded === undefined ? cur.folded : (Number(patch.folded) || 0)
  };
  writeJson(chatFile(chatKey), next);
  return {
    text: next.text,
    throughId: next.throughId,
    updatedAt: next.updatedAt,
    folds: next.folds,
    folded: next.folded
  };
}

/**
 * 清空摘要。
 * 折叠游标（throughId）一并归零：等价于"把这段前情彻底忘掉"，
 * 之后积累的旧消息会被重新折叠成一份新摘要，而不是永远卡在空摘要上。
 */
export function clearSummary(chatKey) {
  try { fs.rmSync(chatFile(chatKey), { force: true }); } catch { /* ignore */ }
  return { ...EMPTY };
}

/**
 * 选出这次要折叠进摘要的消息（纯函数，便于单测）。
 *
 * @param {Array}  messages     存档消息（旧 → 新），每条需要有数字 id
 * @param {number} keepRaw      最近多少条保留原文、不进摘要
 * @param {number} throughId    已折叠到的消息 id（含）
 * @param {number} maxInputMsgs 单次最多取多少条
 * @returns {Array} 要折叠的消息（旧 → 新）
 *
 * 取的是**最旧的**那一批，而不是最新的：这样按时间顺序逐批折叠、不会跳段。
 * 若取最新那批，被跳过的那段 id 会永远小于新的 throughId，以后再也折不到 ——
 * 那部分内容就永久丢了。
 */
export function pickMessagesToFold(messages, { keepRaw = 60, throughId = 0, maxInputMsgs = 200 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(0, Number(keepRaw) || 0);
  const cutoff = list.length - keep;          // 这个下标之前的都已"滑出窗口"
  if (cutoff <= 0) return [];
  const through = Number(throughId) || 0;
  const aged = list.slice(0, cutoff).filter((m) => Number(m?.id) > through);
  if (!aged.length) return [];
  const max = Math.max(1, Number(maxInputMsgs) || 200);
  return aged.slice(0, max);
}

/**
 * 清洗模型返回的摘要正文。
 *
 * 即便提示词里明确说了"不要代码块"，模型仍经常裹一层 ``` 或加个"摘要："前缀 ——
 * 这层壳会被原样注入到下次的提示词里，看着很脏。这里统一剥掉。
 * 返回空串表示这次结果不可用（调用方应保留原摘要，而不是把摘要清空）。
 */
export function cleanSummaryText(raw, maxChars = 1200) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 整体被代码块包住时剥掉围栏（含 ```json 这类语言标记）
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  // 常见的前缀噪声
  s = s.replace(/^\s*(?:【?更新后的摘要】?|摘要)\s*[:：]\s*/, '');
  s = s.trim();
  const limit = Math.max(1, Number(maxChars) || 1200);
  return s.slice(0, limit);
}

/**
 * 计算"保留多少条原文不进摘要"。
 *
 * 关键：不能超过本次实际读给模型的窗口（contextLimit），否则会出现
 * "既没进摘要、也没被原文带进提示词"的盲区 —— 比如档位只读 20 条原文，
 * 而 keepRaw=60，那第 21~60 条对模型来说就是彻底不存在的。
 * contextLimit 未知（0/null）时退回 keepRaw。
 */
export function resolveKeepRaw(keepRaw, contextLimit) {
  const k = Math.max(0, Number(keepRaw) || 0);
  const limit = Math.max(0, Number(contextLimit) || 0);
  return limit > 0 ? Math.min(k, limit) : k;
}

/**
 * 组装"把新记录合并进已有摘要"的提示词（纯函数）。
 *
 * 明确要求输出**完整摘要**而不是增量补丁：补丁式输出在多轮折叠后会互相矛盾、
 * 越叠越乱，而完整重写每次都能重新收敛。
 */
export function buildFoldPrompt({ prevText = '', messages = [], maxChars = 1200 } = {}) {
  const lines = messages
    .map((m) => {
      const who = m?.self ? '我（机器人）' : (String(m?.senderName || '').trim() || String(m?.senderId || '') || '某人');
      const body = String(m?.text || '').replace(/\s+/g, ' ').trim();
      return body ? `${who}：${body}` : '';
    })
    .filter(Boolean);

  return {
    system: [
      '你是聊天机器人的长期记忆模块，负责维护一段群聊/私聊的"前情摘要"。',
      '用户给你一份【已有摘要】和一段【新的聊天记录】，你要把新记录合并进摘要，',
      '输出**更新后的完整摘要** —— 不是增量补丁，也不是聊天记录的复述。',
      '',
      '保留：聊过的话题与结论、做出的决定或约定、正在进行的玩笑或梗、值得记住的事实',
      '（谁是谁、喜好、雷点），以及"话说到哪了"。',
      '丢掉：寒暄、重复、纯表情、没有信息量的水话。',
      '',
      '硬性要求：',
      `1. 全文不超过 ${maxChars} 字；超出时优先保留近期内容与长期有用的事实。`,
      '2. 只依据给定材料，严禁编造、严禁脑补没发生过的事。',
      '3. 一次性的、无关紧要的细节不要写。',
      '4. 直接输出摘要正文：不要 Markdown 标题、不要代码块、不要任何解释或前缀。'
    ].join('\n'),
    user: [
      '【已有摘要】',
      String(prevText || '').trim() || '（暂无，这是第一次生成）',
      '',
      '【新的聊天记录（从旧到新，需要合并进摘要）】',
      lines.length ? lines.join('\n') : '（空）',
      '',
      `【输出】把上面这段记录合并进已有摘要，输出更新后的完整摘要（不超过 ${maxChars} 字）。`
    ].join('\n')
  };
}
