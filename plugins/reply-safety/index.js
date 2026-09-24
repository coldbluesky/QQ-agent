// 回复安全网 Skill 入口。
//
// 这一整套是为**不遵守工具协议的模型**准备的兜底（尤其是本地小模型）：
// 它们有时把"要说的话"直接写在正文里、有时把工具调用写成文本、有时整轮不调工具。
// 正文按设计不会发到 QQ，于是群友什么都收不到 —— 用户看到的就是"机器人不理我了"。
//
// 四个能力各管一段：
//   reply.inline-calls      正文里的假工具调用 → 解析成真的调用
//   reply.salvage           整轮没调工具时，判"成品话 vs 内心戏"（保守，拿不准就沉默）
//   reply.grounded-select   只能从已记录的草稿里挑原句，**绝不让裁判自己写回复**
//   reply.local-policy      本地小模型的预算与安全收尾
//
// ── 为什么默认关闭 ────────────────────────────────────────────────────
// 它是针对特定失败模式的补丁。遵守协议的好模型根本不会触发这些路径，
// 但兜底逻辑本身有误判风险（把内心话当成要说的话发出去）。
// 所以默认关闭：确认自己的模型有这个问题时再打开，并逐项启用。
//
// ── 边界（它不做什么）─────────────────────────────────────────────────
//   · 不发送任何消息 —— 解析出内容后返回给核心，由核心走完整发送管道
//     （限频、去重、分条、CQ 转义、存档）。Skill 自己发会绕开这些防线。
//   · 不改写、不润色、不"帮模型把话说完" —— 只做"原句搬运 + 判定"。
//   · 不确定时一律选择沉默：把内心话发进群，比这轮不说话严重得多。

import { parseInlineToolCalls, parseInlineLooseCalls, extractStickerAnnotation, recoverLooseSend } from './inline-calls.js';
import {
  parseJudgeReply, judgeTextOnly, judgeUnsentLines, JUDGE_MARKER,
  setConfigReader, setLogger
} from './salvage.js';
import {
  selectGroundedReplies, draftReplyLines, isReplyPlanningText,
  rememberReplyDraft, fitReplyBubbles, comparableReply, isQuietProtocolText
} from './reply-recovery.js';
import { localReplyPolicy, nextTruncationBudget, canEndReplyBatch } from './local-reply-policy.js';

let cfg = () => ({});

/**
 * 候选草稿池（一次会话内有效）。由 `reply.grounded-select` 的 remember/reset 维护。
 * 上限 4 条 / 4800 字（rememberReplyDraft 内部裁剪），所以是常数级内存。
 */
const draftStore = [];

export function setup(api) {
  cfg = api.config;
  setConfigReader(api.config);
  setLogger(api.log);
}

export const providers = {
  // ── 正文里的"假工具调用"解析 ──
  // { text, loose? } → { calls: [{name, args}], stickerAnnotation }
  'reply.inline-calls': ({ text, loose = false } = {}) => {
    const c = cfg();
    if (c.inlineCalls === false) return { calls: [], disabled: true };
    try {
      const calls = loose ? parseInlineLooseCalls(text) : parseInlineToolCalls(text);
      return { calls: calls || [], stickerAnnotation: extractStickerAnnotation(text) };
    } catch {
      return { calls: [] };
    }
  },

  /** 抢救"松散发送"：把整段文字里唯一能确定要说的话捞出来（保守，可能返回空）。 */
  'reply.loose-send': ({ text } = {}) => {
    if (cfg().inlineCalls === false) return { messages: [] };
    try { return recoverLooseSend(text) || { messages: [] }; } catch { return { messages: [] }; }
  },

  // ── 裁判：这段正文是"成品话"还是"内心戏" ──
  // { text, trigger, api } → { say, messages, raw, error? }
  // 任何失败路径都返回 say:false（安全侧）。
  'reply.salvage': async ({ text, trigger = '', api = null } = {}) => {
    if (cfg().salvage !== true) return { say: false, messages: [], error: '未启用' };
    return judgeTextOnly({ text, trigger, api });
  },

  /** 更保守的变体：只从草稿里挑行号，不让裁判写回复。 */
  'reply.salvage-lines': async ({ text, trigger = '', alreadySent = [], api = null } = {}) => {
    if (cfg().salvage !== true) return { say: false, messages: [], error: '未启用' };
    return judgeUnsentLines({ text, trigger, alreadySent, api });
  },

  // ── 草稿溯源筛选（纯本地，不调模型）──
  //
  // 三种调用形态，共用同一份草稿池（模块级）：
  //   { remember: '正文' }              → 把本轮正文记成候选草稿（供后面筛选用）
  //   { reset: true }                   → 开一轮新会话，清空草稿池
  //   { proposed, sent }                → 从 proposed 里挑出"确实出自草稿、且没发过"的原句
  //
  // 为什么草稿池在本模块里而不是让调用方维护：`rememberReplyDraft` 的准入规则
  // （计划腔/安静协议词/超长截断）是这套机制的一部分，放到核心里就等于把规则复制一份。
  'reply.grounded-select': ({ proposed = [], drafts = null, sent = [], remember = null, reset = false } = {}) => {
    const c = cfg();
    if (reset) { draftStore.length = 0; return { reset: true, drafts: 0 }; }
    if (remember != null) {
      if (c.groundedSelect !== true) return { remembered: false, enabled: false, drafts: draftStore.length };
      try { rememberReplyDraft(draftStore, remember); } catch { /* 记不进就算了 */ }
      return { remembered: true, enabled: true, drafts: draftStore.length };
    }
    if (c.groundedSelect !== true) return { picked: proposed, enabled: false };
    try {
      const pool = Array.isArray(drafts) ? drafts : draftStore;
      return { picked: selectGroundedReplies(proposed, pool, sent) || [], enabled: true };
    } catch {
      return { picked: [], enabled: true, error: '筛选失败（保守起见不发送）' };
    }
  },

  /**
   * 本地小模型的预算与收尾策略。
   * { api, entries, batch } → { shouldEnd, budget, ... }
   *
   * `batch` 是"这批工具结果能不能收尾"所需的现场信息
   * （calls/results/newSent/allSent/searched）—— 判定规则在 canEndReplyBatch 里，
   * 只有调用方手里才有这些数据，所以必须由它传进来。
   * 不传 batch 时 shouldEnd 恒为 false（宁可不收尾，也不要错误地提前结束）。
   */
  'reply.local-policy': ({ api = {}, entries = [], batch = null } = {}) => {
    const c = cfg();
    if (c.localPolicy !== true) return { shouldEnd: false, enabled: false };
    try {
      const policy = localReplyPolicy(api, entries);
      const shouldEnd = batch
        ? canEndReplyBatch(policy, batch.calls || [], batch.results || [],
          batch.newSent || [], batch.allSent || [], batch.searched === true)
        : false;
      return { ...policy, shouldEnd, enabled: true };
    } catch {
      return { shouldEnd: false, enabled: true, error: '策略计算失败' };
    }
  },

  /** 判断一行是不是"计划腔"（纯本地，供上面几项复用）。 */
  'reply.is-planning-text': ({ text } = {}) => {
    try { return { planning: isReplyPlanningText(text) }; } catch { return { planning: false }; }
  }
};

export function available() { return { ok: true }; }

export const internals = {
  // 解析类
  parseInlineToolCalls, parseInlineLooseCalls, extractStickerAnnotation, recoverLooseSend,
  // 裁判类
  parseJudgeReply, judgeTextOnly, judgeUnsentLines, JUDGE_MARKER,
  // 草稿类
  selectGroundedReplies, draftReplyLines, isReplyPlanningText, rememberReplyDraft,
  fitReplyBubbles, comparableReply, isQuietProtocolText,
  // 策略类
  localReplyPolicy, nextTruncationBudget, canEndReplyBatch
};
