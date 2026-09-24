// 移植层：把「我方已有的状态化能力」以最小侵入的方式接到目标的编排流程上。
//
// 为什么要有这个文件
// ────────────────────────────────────────────────────────────────────────
// 目标项目（qq-agent v0.3.0）的 orchestrator.js 已经有一套完整的提示词装配
// 与运行期钩子骨架：buildSystemPrompt 的 extraSections、buildUserPrompt 的
// 各段落、以及 runAgent 的 ctx。我方那 20 个模块（情绪/情爱/风格/棋局/姐妹/
// 临时设定…）都自带 promptBlock 函数，但各自的读取时机、配置开关、降级规则
// 都不一致。
//
// 直接在 orchestrator.js 里写十几段 try/catch 会让那个文件彻底不可读，也会
// 让「哪个块在什么条件下注入」这件事散落各处。所以统一收在这一层：
//   · 编排器只调 buildPortedSections() / buildPortedContextLines()
//   · 每个子系统的失败互相隔离（一个坏掉不影响其它块，也不影响发言）
//
// 取舍原则（与本批移植总原则一致：「保留目标原有实现，只搬我方独有无对应的」）
//   · 只在目标缺少对应能力时注入；目标已有的段落一律不动。
//   · 所有注入都是**追加**，不修改、不删除目标原有内容。
//   · 全部开关默认关闭的子系统不产生任何输出 → 行为与没有本模块时一致。

import {
  readEmotion, applyRuleNudge, emotionPromptBlock, emotionCfg
} from './emotion.js';
import {
  readIntimacy, noteIntimacyTurn, intimacyCfg, intimacyPromptBlock
} from './intimacy.js';
import { readChess, chessPromptBlock, chessInviteBlock, chessCfg } from './chess.js';
import { effectiveTempSettings, tempSettingsPromptBlock, tempSettingsCfg } from './temp-settings.js';
import {
  readSisters, readSpeech, sisterPromptBlock, sisterRelationRules,
  sisterCfg, registerSelf, appendSpeech, readSisterNotes, sisterNotesBlock
} from './sister.js';
import { readActivity, formatActivityBlock, appendActivity } from './bus.js';
import { isMuted } from './mute.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';

const log = (m) => { try { logger.log(`[ported] ${m}`); } catch { /* logger 挂了就算了 */ } };

// ── 小工具 ───────────────────────────────────────────────────────────────

function isOn(v, dflt = true) {
  if (v === undefined || v === null) return dflt;
  return v !== false;
}

// 只取群号数字部分（emotion/intimacy/chess 的 chatKey 语义与我方一致，直接用）
function safe(fn, fallback, label) {
  try { return fn(); } catch (error) {
    log(`${label} 失败（已忽略）: ${error?.message ?? error}`);
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 系统提示词片段（追加到 buildSystemPrompt 的 extraSections）
// ═══════════════════════════════════════════════════════════════════════
//
// 返回 [{ id, title, priority, content }]。
// priority 采用目标 prompt.js 的口径：数值大 = 靠前。
// 目标核心规则段（安全/工具协议）不经此处，无需担心被顶掉。
// 参考值：主人规则 72；这里全部取 60 以下，保证排在主人规则之后。

export function buildPortedSections({ chatKey, kind = 'group', chatId = '', triggerText = '' } = {}) {
  const cfg = getConfig();
  const sections = [];
  const isGroup = kind === 'group';

  // ── 1. 情绪（emotion）──
  // 规则触发 + 当前情绪状态。目标没有情绪系统，纯新增。
  if (isOn(cfg.emotion?.enabled, false)) {
    const s = safe(() => {
      const ec = emotionCfg(cfg.emotion);
      // 先跑规则兜底（@我/被骂/深夜…），再读状态 —— 顺序与我方一致
      safe(() => applyRuleNudge(chatKey, {
        text: triggerText, kind, selfLastMessageAt: 0, cfg: ec
      }), null, 'emotion.nudge');
      const st = readEmotion(chatKey, { cfg: ec });
      return st ? emotionPromptBlock(st, ec) : '';
    }, '', 'emotion');
    if (s && String(s).trim()) {
      sections.push({ id: 'ported-emotion', title: '', priority: 58, content: String(s).trim() });
    }
  }

  // ── 2. 情爱等级（intimacy）──
  // 只在等级真的达到会改变语气的档位时注入；0 档不产生内容。
  if (isOn(cfg.intimacy?.enabled, false)) {
    const s = safe(() => {
      const ic = intimacyCfg(cfg.intimacy);
      const st = readIntimacy(chatKey, { cfg: ic });
      return st ? intimacyPromptBlock(st, ic) : '';
    }, '', 'intimacy');
    if (s && String(s).trim()) {
      sections.push({ id: 'ported-intimacy', title: '', priority: 56, content: String(s).trim() });
    }
  }

  // ── 3. 棋局（chess）──
  // 有进行中的对局才注入局面；没有对局时仅在群聊里给一句"可以约棋"的引导。
  if (isOn(cfg.chess?.enabled, false)) {
    const s = safe(() => {
      const cc = chessCfg(cfg.chess);
      const st = readChess(chatKey, { cfg: cc });
      if (st && st.status === 'playing') return chessPromptBlock(st, cc);
      return isGroup ? chessInviteBlock() : '';
    }, '', 'chess');
    if (s && String(s).trim()) {
      sections.push({ id: 'ported-chess', title: '', priority: 54, content: String(s).trim() });
    }
  }

  // ── 4. 临时设定（tempSettings）──
  // 群级短时生效的指令（"这小时只聊 X"）。广播设定所有实例共享。
  if (isGroup) {
    const s = safe(() => {
      const tc = tempSettingsCfg(cfg.tempSettings);
      const payload = effectiveTempSettings({ groupId: chatId, cfg: tc });
      return payload ? tempSettingsPromptBlock(payload, tc) : '';
    }, '', 'tempSettings');
    if (s && String(s).trim()) {
      sections.push({ id: 'ported-temp-settings', title: '', priority: 60, content: String(s).trim() });
    }
  }

  // ── 5. 姐妹关系 + 她们刚说的话（sister）──
  // 目标没有多实例协同。姐妹注册表为空时不产生任何内容 —— 单实例用户零影响。
  if (isOn(cfg.sister?.enabled, false)) {
    const s = safe(() => {
      const sc = sisterCfg(cfg.sister);
      const sisters = readSisters({});
      if (!Array.isArray(sisters) || sisters.length === 0) return '';
      const speech = readSpeech({ chat: chatKey, limit: 6 });
      const notes = readSisterNotes({ limit: 8 });
      const blocks = [
        sisterRelationRules(sisters, cfg.persona?.botName || ''),
        sisterPromptBlock({ sisterSpeech: speech, sisters, chatKey }),
        sisterNotesBlock(notes, sisters)
      ].filter((x) => x && String(x).trim());
      return blocks.join('\n\n');
    }, '', 'sister');
    if (s && String(s).trim()) {
      sections.push({ id: 'ported-sister', title: '', priority: 52, content: String(s).trim() });
    }
  }

  return sections;
}

// ═══════════════════════════════════════════════════════════════════════
// 用户提示词片段（追加到 buildUserPrompt 产出的文本之后）
// ═══════════════════════════════════════════════════════════════════════
//
// bus.js 的"同机其它实例在干嘛"——放在用户提示里是因为它**每轮都会变**，
// 放进系统提示会把前缀缓存打断（目标 prompt.js 顶部对此有明确警告）。
// 追加在 buildUserPrompt 结果末尾即可，缓存前缀不受影响。

export function buildPortedContextLines({ chatKey, kind = 'group', chatId = '' } = {}) {
  const cfg = getConfig();
  const lines = [];

  // ── 兄弟实例活动（bus）──
  if (isOn(cfg.bus?.enabled, false)) {
    const block = safe(() => {
      const entries = readActivity({ limit: 40, excludeTag: '' });
      return formatActivityBlock(entries);
    }, '', 'bus');
    if (block && String(block).trim()) lines.push(String(block).trim());
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════
// 运行期钩子
// ═══════════════════════════════════════════════════════════════════════

/**
 * 会话开始前：注册实例身份、补记规则触发。
 * 编排器在 runAgent 开头调一次；任何失败都不影响本次发言。
 */
export function beforeRun({ chatKey, kind = 'group', chatId = '', triggerText = '' } = {}) {
  // 只有启用姐妹/总线体系时才登记实例身份 —— 单实例场景下这个文件没有任何读者，
  // 却会在程序根留下一个 bus/ 目录，容易让用户困惑（本版未启用多实例）。
  const cfg = getConfig();
  if (isOn(cfg.sister?.enabled, false) || isOn(cfg.bus?.enabled, false)) {
    safe(() => registerSelf({ kind, chatId, chatKey }), null, 'sister.registerSelf');
  }
  return { ok: true };
}

/**
 * 本轮用户消息产生的后续效应（在触发消息文本已知后调用）。
 * 目前只有情爱等级推进 —— 它需要看"这一轮的对话内容"。
 */
export function noteUserTurns({
  chatKey, kind = 'group', text = '', timestamps = [], personaName = ''
} = {}) {
  const cfg = getConfig();
  if (!isOn(cfg.intimacy?.enabled, false)) return;

  safe(() => {
    const ic = intimacyCfg(cfg.intimacy);
    noteIntimacyTurn(chatKey, {
      text: String(text || ''),
      timestamps: Array.isArray(timestamps) ? timestamps : [],
      personaName: personaName || '',
      cfg: ic
    });
  }, null, 'intimacy.noteTurn');
}

/**
 * 发言之后：把本条发言写进跨实例活动日志，姐妹实例才看得见"她刚说了什么"。
 * 单实例场景下这个日志没有人读，但写入成本极低（一行 JSONL）。
 */
export function afterSend({ chatKey, kind = 'group', chatId = '', text = '' } = {}) {
  const cfg = getConfig();
  if (!isOn(cfg.bus?.enabled, false) && !isOn(cfg.sister?.enabled, false)) return;

  safe(() => {
    appendActivity({
      chat: chatKey, kind, chatId, text: String(text || '').slice(0, 400), at: Date.now()
    });
  }, null, 'bus.append');
  safe(() => {
    appendSpeech({ chat: chatKey, text: String(text || '').slice(0, 400), at: Date.now() });
  }, null, 'sister.appendSpeech');
}

/**
 * 群禁言状态（mute.js）：目标的 orchestrator 自己有 #checkSelfMuted，
 * 这里只提供"本地手动禁言"这一路（管理员在群里发指令禁言机器人）。
 * 返回 true = 应当视作被禁言、不发言。
 */
export function isLocallyMuted(chatId) {
  if (!chatId) return false;
  return safe(() => isMuted(chatId), false, 'mute.isMuted') === true;
}

// 供 /api/status 与排障面板使用：一行看清移植层各子系统是否启用。
export function portedHooksStatus() {
  const cfg = getConfig();
  return {
    emotion: isOn(cfg.emotion?.enabled, false),
    intimacy: isOn(cfg.intimacy?.enabled, false),
    chess: isOn(cfg.chess?.enabled, false),
    tempSettings: isOn(cfg.tempSettings?.enabled, false),
    sister: isOn(cfg.sister?.enabled, false),
    bus: isOn(cfg.bus?.enabled, false),
    mute: true
  };
}
