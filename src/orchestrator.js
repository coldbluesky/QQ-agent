// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { getToolAvailability } from './tool-registry.js';
import { skillManager } from './skills/manager.js';
import {
  buildPortedSections, buildPortedContextLines,
  beforeRun as portedBeforeRun, isLocallyMuted
} from './agent-hooks.js';
// ── 群内指令接线 ──
// admin：管理员在群里喊「禁言/解除」→ 就地执行，不进模型（否则模型会把
// 「禁言」当聊天接下茬）。temp-settings：群里发「临时设定：… 持续 N 分钟」→ 解析入库 + 回执。
import { parseAdminCommand, isAdmin, adminEnabled } from './admin.js';
import { muteGroup, unmuteGroup } from './mute.js';
import { parseTempCommand, setTempSetting, tempSettingsCfg } from './temp-settings.js';
// ── 回复安全网（reply-rescue.js）──
// 把"写在正文里、但没通过工具发出去"的成稿抢救成一条 send_message 调用。
// 判定逻辑本身是纯逻辑（可被测试直接驱动）；这里只负责注入依赖。
import { rescueUnsentReply } from './reply-rescue.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { voiceReady } from './tts.js';
import { loadSongLibrary, songsStatus } from './songs.js';
import {
  loadSummary, saveSummary, clearSummary,
  pickMessagesToFold, resolveKeepRaw, buildFoldPrompt, cleanSummaryText
} from './summary.js';

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, tts = null, emit = null, reminders = null, videoReader = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.tts = tts;                    // 语音合成器；null = 未启用语音
    this.reminders = reminders;        // 提醒（闹钟）存储；null = 不启用
    this.videoReader = videoReader;    // 视频读取服务；null = 不启用
    this.reminderTimer = null;
    this.reminderFiring = new Set();
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.folding = new Set();          // 正在折叠前情摘要的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
  }

  /**
   * 重新拉取工具定义（Skill/插件加载或热重载之后调用）。
   * 内置工具不会重复注册（buildToolDefs 内部幂等），技能工具则会随之出现/消失。
   */
  refreshToolDefs() {
    this.toolDefs = buildToolDefs();
    return this.toolDefs.length;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey) {
    const cfg = getConfig();
    const entries = this.store.peekUnread(chatKey, 200) || [];
    const r = resolveContextTier({
      triggerEntries: entries,
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey)   // 按会话取档位：统一开关关闭时各群可以有独立滑条
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, shouldRespond: false, reason: '无未读' };
    return r;
  }

  scheduleWake(chatKey, delay = null) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      const predicted = this.#predictTier(chatKey);
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  /**
   * 运行收尾时检查是否还有未读：有就稍后再开一次会话（drain）。
   *
   * 这是"运行期间来的消息不会丢"的关键一环：onIncoming 在运行中会直接返回、
   * 把责任交给这里（见 onIncoming 的注释）。所以它必须**无条件执行**，
   * 因此被放进 #runAgent 的 finally，并且内部自己兜住异常 ——
   * 收尾清理绝不能因为"调度 drain 失败"而中断。
   */
  #scheduleDrainIfUnread(chatKey) {
    try {
      if (this.aborted || this.paused) return;
      if (this.store.unreadCount(chatKey) <= 0) return;
      const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
      this.scheduleWake(chatKey, drainDelay);
    } catch (error) {
      console.error(`[orchestrator] ${chatKey} drain 调度失败:`, error?.message ?? error);
    }
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /**
   * 群内指令：在**进模型之前**拦截并就地执行。
   *
   * 两类：
   *   A. 管理员指令（admin.js）：「禁言」→ 本群静默 + 本轮不再运行；
   *      「解除」→ 恢复，批里剩下的普通消息照常运行。
   *   B. 临时设定指令（temp-settings.js）：「临时设定：… 持续 N 分钟」→ 入库 +
   *      回执（走统一发送管道），指令消息从触发批剔除。
   *
   * @returns {Promise<boolean>} true = 本轮已被指令完全消费，调用方直接 return
   */
  /** 取某个能力的第一个提供者函数（Skill 未启用时返回 null）。 */
  #capFirst(name, context = {}) {
    try {
      return skillManager.getCapabilityProviders(name, context)[0]?.fn || null;
    } catch {
      return null;
    }
  }

  /** 给"正文裁判"用的模型参数：沿用当前聊天的主模型，不另开一份配置。 */
  #judgeApi() {
    const api = getConfig().api || {};
    // 密钥解析：模型走 providers 目录时顶层 api.apiKey 常为空 —— 直接取会 401。
    let apiKey = api.apiKey;
    if (!apiKey && api.provider) {
      const p = currentProviders().find((x) => x.id === api.provider);
      apiKey = p?.apiKey || '';
    }
    return { baseUrl: api.baseUrl, apiKey, model: api.model, provider: api.provider };
  }

  /** 触发批的文本（裁判要知道"这轮收到了什么"，才能判断正文是对它的回复）。 */
  #triggerText(triggerEntries) {
    return (triggerEntries || [])
      .map((e) => String(e?.text || '')).filter(Boolean).join('\n').slice(0, 400);
  }

  async #handleChatCommands(chatKey, entries, { waitingSessionId = null } = {}) {
    const groupId = String(chatKey).split(':')[1] || '';
    if (!groupId || !Array.isArray(entries) || !entries.length) return false;
    const cfgNow = getConfig();

    // ── A. 管理员指令 ──
    if (adminEnabled()) {
      const cmdOf = (e) => {
        const cmd = parseAdminCommand(e?.text);
        return cmd && isAdmin(groupId, e?.senderId) ? cmd.cmd : null;
      };
      // 「禁言」优先判定：即使同批混着「解除」，也以"最新意图是闭嘴"处理
      if (entries.some((e) => cmdOf(e) === 'mute')) {
        const who = entries.find((e) => cmdOf(e) === 'mute');
        const r = muteGroup(groupId, { by: 'admin', reason: '群内指令', admin: true });
        console.log(`[admin] 群 ${groupId} 管理员 ${who?.senderName || who?.senderId || '?'} 指令禁言 → ${r.ok ? '已生效' : `失败：${r.error}`}`);
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '管理员指令禁言');
        this.emit('chat-update', chatKey);
        return true;
      }
      if (entries.some((e) => cmdOf(e) === 'unmute')) {
        const who = entries.find((e) => cmdOf(e) === 'unmute');
        const r = unmuteGroup(groupId);
        console.log(`[admin] 群 ${groupId} 管理员 ${who?.senderName || who?.senderId || '?'} 指令解除禁言 → wasMuted=${r.wasMuted}`);
        // 解除后批里剩下的普通消息照常运行（解除指令本身不进模型）
        const rest = entries.filter((e) => cmdOf(e) !== 'unmute');
        entries.splice(0, entries.length, ...rest);
        if (!rest.length) {
          if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '管理员指令解除禁言');
          this.emit('chat-update', chatKey);
          return true;
        }
      }
    }

    // ── B. 临时设定指令 ──
    const tCfg = tempSettingsCfg(cfgNow.tempSettings);
    if (tCfg.enabled && tCfg.allowCommand) {
      // 从后往前剔（splice 安全），同一批多条指令逐条处理、逐条回执
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const parsed = parseTempCommand(e?.text);
        if (!parsed) continue;
        // 权限：默认仅管理员（本群或 '*' 全局）；信任私群可 commandAllowEveryone
        if (!tCfg.commandAllowEveryone && !isAdmin(groupId, e?.senderId)) continue;
        const r = setTempSetting(groupId, {
          text: parsed.text, ttlMin: parsed.ttlMin, by: 'command',
          note: `群内指令 by ${e?.senderName || e?.senderId || '?'}`
        });
        let reply;
        if (r?.ok === false) {
          reply = `临时设定没有生效：${r.error}`;
        } else {
          const leftMin = Math.max(1, Math.round((Number(r.item?.expiresAt) - Date.now()) / 60000));
          const durText = leftMin >= 1440
            ? `${Math.round((leftMin / 1440) * 10) / 10} 天`
            : leftMin >= 60
              ? `${Math.round((leftMin / 60) * 10) / 10} 小时`
              : `${leftMin} 分钟`;
          reply = `收到，本群临时设定已生效（约 ${durText}）：${r.item?.summary || parsed.text}`;
        }
        try {
          await this.sender.sendTextBatch(chatKey, [reply]);
        } catch (error) {
          console.warn(`[temp-settings] 指令回执发送失败: ${error?.message ?? error}`);
        }
        entries.splice(i, 1);   // 指令消息不进模型
      }
    }
    return false;
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) {
      // 这次唤醒被合并，交给正在跑的那次运行收尾时的 drain（见 #scheduleDrainIfUnread）。
      // 主动开话题本来就是"能跳就跳"，不算异常不记日志；其它来源记一条，
      // 便于排查"消息进来了却没反应"（正常情况不该频繁出现）。
      if (!proactive) {
        console.warn(`[orchestrator] ${chatKey} 正在运行，本次唤醒被合并（未读将由收尾 drain 接管）`);
      }
      return;
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        if (s && s.status === 'waiting') {
          this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要不要取走未读 ──
    //
    // 关键顺序：判定必须发生在 drainUnread() 之前。
    // drainUnread 会把未读取走并全部置为已读（作为触发批），
    // 如果先取走再判定，未命中时就拿不到"该标记已读"的对象了。
    //
    // 未命中时：标记已读、不创建会话、不调模型 —— 这才是省 token 的关键
    // （消息内容仍留在存档里，日后被艾特时会作为"已读历史"带进提示词）。
    // 群禁言（本地硬闸门）：禁言期间完全不触发 —— 连档位判定都不做。
    if (!proactive) {
      const [muteKind, muteId] = String(chatKey).split(':');
      if (muteKind === 'group' && isLocallyMuted(muteId)) {
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        return;
      }
    }

    const cfgNow = getConfig();
    let pendingEntries = [];
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本）
      pendingEntries = this.store.peekUnread(chatKey, 200) || [];
      if (pendingEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      const tierResult0 = this.#predictTier(chatKey);

      if (tierResult0.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markAllRead(chatKey);
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult0.tier}），已标记已读、不响应`);
        }
        return;
      }
    }

    // 触发批：当前所有未读（含之前积压的）—— 到这说明确定要响应了
    let triggerEntries = proactive ? [] : this.store.drainUnread(chatKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
    }
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }

    // ── 群内指令：命中则就地处理，指令消息不进模型 ──
    if (!proactive && await this.#handleChatCommands(chatKey, triggerEntries, { waitingSessionId })) {
      return;
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    // 两个修复（此前"已读历史偶尔拼接不进提示词"的根源）：
    //   1. 主动机会没有触发批：resolveContextTier 对空触发批在 1~3 档下判
    //      "未触发"（count=0）→【过去状态】一条不带，模型在失忆状态下被要求
    //      主动开话题。proactive 显式按 4 档带 allCount 条已读。
    //   2. 随机档实跑复用预判钉住的骰子（此处的 triggerEntries 与预判同源）。
    const tierResult = proactive
      ? { tier: 4, count: Math.max(0, Number(storeConfigForChat(chatKey).allCount) || 80), reason: '主动机会（带历史）', shouldRespond: true }
      : resolveContextTier({
        triggerEntries,
        selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
        botName: cfgNow.persona?.botName || '',
        selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
        cfg: storeConfigForChat(chatKey)   // 与 #predictTier 同一来源，保证预判/实跑一致
      });

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit: tierResult.count, tierInfo: tierResult });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
      // ⚠️ drain 必须在 finally 里，不能放到 try/finally 之后。
      // 原先它在外面，一旦这段里抛出任何异常（finish / emit / resetSessionForRetry
      // 都可能抛），drain 会被整段跳过 —— 未读消息留在存档里、却再没有任何人安排唤醒，
      // 只能等用户"再发一条"才把它带出来。这正是"消息进来了却没反应、重新提醒才行"
      // 的成因之一（onIncoming 在运行中会把唤醒交给 drain，drain 一丢就没人管了）。
      this.#scheduleDrainIfUnread(chatKey);
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
    // 前情摘要折叠：把"这次没看到原文的旧消息"并进摘要。
    // 传入本次读取窗口 tierResult.count —— 保留数不能超过它，否则会留下
    // "既没进摘要、也没被原文带进提示词"的盲区（见 summary.js 的 resolveKeepRaw）。
    this.#maybeFoldSummary(chatKey, tierResult.count);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 曲库快照（提示词 + 工具用）。纯本地清单，读一次即可，不需要网络。
    const songEntries = loadSongLibrary();

    // 工具/技能共享的运行期上下文
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const skillContext = {
      chatKey, kind, chatId, chatName,
      model: cfg.api.model,
      provider: cfg.api.provider,
      visionEnabled,
      searchEnabled,
      proactive,
      sessionId: session.id
    };

    // Skill 生命周期：提示词组装之前先跑 before-context。
    // 注意 hook 只能**追加/加工上下文**；安全规则、工具协议等核心提示词由 prompt.js 独占
    // （Skill 无法覆盖，manifest priority 上限 99）。
    try {
      await skillManager.runHook('before-context', {
        ...skillContext,
        triggerEntries,
        store: this.store,
        memory: this.memory
      });
    } catch (error) {
      skillManager.recordError('before-context', error);
    }

    // 移植层（agent-hooks）：把"我方已有"的状态化能力接到编排流程上。
    // 每一块都依赖各自的开关，关掉就与没有这些模块时完全一致。
    const triggerTextForHooks = triggerEntries
      .map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
    try {
      portedBeforeRun({ chatKey, kind, chatId, triggerText: triggerTextForHooks });
    } catch (error) {
      console.warn('[agent-hooks] beforeRun 失败:', error?.message ?? error);
    }
    const portedSections = (() => {
      try { return buildPortedSections({ chatKey, kind, chatId, triggerText: triggerTextForHooks }); }
      catch { return []; }
    })();

    // 组装提示词（无 LLM 历史）
    const systemPrompt = buildSystemPrompt({ skillContext, extraSections: portedSections });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      songEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      // 前情摘要（跨会话的对话记忆）：开关关掉就当它不存在，提示词里也不会出现这一段。
      // ⚠️ 必须传进 buildUserPrompt 的这个对象 —— 提示词用的是这里的字段，
      // 不是下面给工具用的 ctx。加错地方的表现是"折叠明明成功、提示词里却没有摘要"。
      summaryText: cfg.summary?.enabled === false ? '' : loadSummary(chatKey).text
    });

    // 移植层动态块（bus 活动等）放在用户提示末尾 —— 变化频率高的内容靠后，保护前缀缓存
    const portedLines = (() => {
      try { return buildPortedContextLines({ chatKey, kind, chatId }); }
      catch { return []; }
    })();
    const userPromptFull = portedLines.length ? `${userPrompt}\n\n${portedLines.join('\n\n')}` : userPrompt;

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPromptFull;
    session.promptChars = systemPrompt.length + userPromptFull.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPromptFull}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPromptFull }
    ];
    // 让 Skill 加工即将发给模型的消息（如补充知识库片段）。
    // hook 拿到的是同一个数组引用，允许原地修改，返回值忽略。
    try {
      await skillManager.runHook('before-llm-messages', { ...skillContext, messages });
    } catch (error) {
      skillManager.recordError('before-llm-messages', error);
    }

    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // 工具集按配置过滤（visionEnabled / searchEnabled 已在上面为 skillContext 算好）：
    // 无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具。
    // 语音：开关打开、真的注入了合成器、且配置完整（选好模型/凭证）才给工具。
    // 少了任一条件都不注册 —— 否则模型每次调用都撞一个必然失败的报错，白烧 token。
    const voiceEnabled = cfg.voice?.enabled === true && Boolean(this.tts) && voiceReady().ok;
    // 曲库：开关 + 有歌 + 装了 ffmpeg 三者齐备才注册 sing / list_songs。
    // 缺 ffmpeg 是最容易踩的（它是个系统依赖），这里判掉能让模型完全不知道有唱歌这回事。
    const songState = songsStatus(songEntries);
    // 被排除的工具与原因（UI 排障可见：为什么这个工具没给模型）
    const excludedTools = [];
    const toolDefs = this.toolDefs.filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      if (!voiceEnabled && d.name === 'send_voice') return false;
      if (!songState.ok && (d.name === 'sing' || d.name === 'list_songs')) return false;
      // Skill 层（统一口径）：所属技能是否生效 / 能力依赖 / 分类开关 / 单工具开关 / tool.guard
      const av = getToolAvailability(d.id ?? d.name, {
        skills: skillManager,
        toolsCfg: cfg.tools || {},
        visionEnabled,
        searchEnabled,
        runtimeContext: { chatKey, kind, chatId, sessionId: session.id }
      });
      if (!av.enabled) { excludedTools.push({ id: d.id ?? d.name, code: av.code, reason: av.reason }); return false; }
      return true;
    });
    session.excludedTools = excludedTools;
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      tts: voiceEnabled ? this.tts : null,
      songs: songState.ok ? songEntries : [],
      reminders: this.reminders,
      videoReader: this.videoReader,
      session,
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      // ── 剩余轮次提醒：防止"工具轮次耗尽导致想说的话发不出去"──
      // 进入最后 3 轮且还一条消息都没发时，往对话里注入一条系统提醒，
      // 明确告诉模型"轮次快用完了，现在就该用 send_message 把话说出来"。
      // 没有这个提醒时，模型常把轮次花在搜索/看图上，循环一断消息就丢了。
      // 已发出过消息则不打扰（模型可能只是收尾查询，别催它重复发言）。
      const roundsLeft = maxRounds - round;
      if (roundsLeft <= 3 && roundsLeft > 0 && session.sent.length === 0
          && messages[messages.length - 1]?.role !== 'system') {
        messages.push({
          role: 'user',
          content: `【系统提醒】工具调用轮次只剩 ${roundsLeft} 轮。如果你打算回应本次消息，请立刻调用 send_message 把要说的话发出去，不要再调用其它工具 —— 轮次耗尽后你将没有机会发言，群友会收不到任何内容。`
        });
      }
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools, skillContext });
      // 拿到响应后让 Skill 加工（提取 reasoning / 记录降级等）
      try {
        await skillManager.runHook('after-response', { ...skillContext, response, session });
      } catch (error) {
        skillManager.recordError('after-response', error);
      }
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;

      // ⚠️ 发回上游的这条 assistant 消息必须"干净"：
      //   1. tool_calls 要规整。这些内容会成为下一轮请求的一部分，而模型/中转网关返回
      //      什么是我们控制不了的 —— 实测遇到过 type="functionfunction"，原样回传后
      //      下一轮直接被上游拒：
      //        The parameter `messages.tool_calls.type` ... invalid value: `functionfunction`
      //   2. 不带 raw。那是我们自己的留档字段（存 usage 给用量页统计），
      //      严格的上游会因为消息里冒出未知字段而 400。
      // 留档仍用原始返回，两个用途就此分开。
      const cleanToolCalls = normalizeToolCalls(msg.tool_calls);
      const apiAssistantEntry = {
        role: 'assistant',
        content: finalContent,
        ...(cleanToolCalls ? { tool_calls: cleanToolCalls } : {})
      };
      messages.push(apiAssistantEntry);
      session.messages.push(structuredClone({
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      }));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有原生工具调用。两种可能：
        //   · 模型真的说完了（文本只是思考，按设计不发 QQ）→ 正常结束
        //   · 模型不遵守工具协议，把要说的话写在了正文里 → 群友什么都收不到
        // 给回复安全网一次机会抢救后者（插件未启用时立刻返回空，行为完全不变）。
        let rescued = [];
        try {
          rescued = await rescueUnsentReply({
            text: rawContent,
            trigger: this.#triggerText(triggerEntries),
            sent: session.sent || [],
            api: this.#judgeApi(),
            cap: (name) => this.#capFirst(name, skillContext),
            log: (message) => skillManager.recordError('reply-safety', message)
          });
        } catch (error) {
          skillManager.recordError('reply-safety', error);
        }
        if (!rescued.length) break;

        toolCalls = rescued;
        // 把 assistant 条目改成 tool_calls 形态：不这么做的话，下面 push 进去的
        // tool 消息就没有对应的 tool_call，下一轮请求会被判为非法消息序列。
        const lastRescue = messages[messages.length - 1];
        if (lastRescue?.role === 'assistant') {
          lastRescue.content = null;
          lastRescue.tool_calls = toolCalls;
        }
        const liveRescue = this.sessions.current.get(session.id);
        const uiRescue = liveRescue?.messages?.[liveRescue.messages.length - 1];
        if (uiRescue?.role === 'assistant') {
          uiRescue.content = null;
          uiRescue.tool_calls = structuredClone(toolCalls);
          uiRescue.inlineParsed = true;
          uiRescue.rescued = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        // ── 工具执行前后钩子 ──
        // before-tool 可以**否决**一次调用（返回 { block:true, reason }）——
        // 用于"Skill 运行期发现不该执行"的场景（如知识库索引未就绪）。
        // 注意：否决只是拒绝这一次调用，不会绕过发送队列/限频/存档。
        let blocked = null;
        try {
          const hookResults = await skillManager.runHook('before-tool', {
            ...skillContext, toolName: name, argsRaw, session
          });
          blocked = hookResults.map((r) => r.value).find((v) => v && v.block) || null;
        } catch (error) {
          skillManager.recordError('before-tool', error);
        }
        const result = blocked
          ? { content: `错误：${blocked.reason || '该工具调用被 Skill 拒绝'}`, isError: true }
          : await executeTool(toolDefs, ctx, name, argsRaw);
        try {
          await skillManager.runHook('after-tool', {
            ...skillContext, toolName: name, argsRaw, result, session
          });
        } catch (error) {
          skillManager.recordError('after-tool', error);
        }
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let media = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          // image_url 与 video_url 都要收：视频抽帧走前者，全模态原生读视频走后者。
          // 以前只 filter image_url，video_url 会被静默丢掉（模型只拿到「已发送视频输入」的说明文字）。
          media = result.content.filter((p) => p.type === 'image_url' || p.type === 'video_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (media.length) {
          const imgCount = media.filter((p) => p.type === 'image_url').length;
          const vidCount = media.filter((p) => p.type === 'video_url').length;
          const what = [
            imgCount ? `${imgCount} 张图片` : '',
            vidCount ? `${vidCount} 段视频` : ''
          ].filter(Boolean).join(' + ');
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${what}，请直接"看"了回应]` },
              ...media
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: media.length, images: imgCount, videos: vidCount } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 提醒（闹钟/计时）调度 ─────────────────────────────────────────────

  /** 启动提醒调度循环：每 20 秒检查一次到点的提醒并触发。 */
  startReminderLoop() {
    this.stopReminderLoop();
    if (!this.reminders) return;
    const tick = async () => {
      if (this.aborted) return;
      try {
        const dueList = this.reminders.due(Date.now());
        for (const r of dueList) {
          if (this.reminderFiring.has(r.id)) continue;
          this.reminderFiring.add(r.id);
          try {
            // 发送成功后才标记 fired；失败保留未触发状态，下一轮重试。
            // （反过来"先标记再发"会让 OneBot 断线/进程崩溃时的提醒永久丢失）
            await this.#fireReminder(r);
            this.reminders.markFired(r.id);
          } catch (error) {
            console.error('[reminder] 触发失败，将在下一轮重试:', error?.message ?? error);
          } finally {
            this.reminderFiring.delete(r.id);
          }
        }
        if (dueList.length) this.reminders.prune();
      } catch (error) {
        console.error('[reminder] 调度出错:', error?.message ?? error);
      }
      this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 20000);
    };
    this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 5000);   // 启动 5s 后第一次检查
  }

  stopReminderLoop() {
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = null; }
  }

  /** 触发一条提醒：往对应群/私聊发一条提醒消息（走正常发送管道，留档）。 */
  async #fireReminder(r) {
    const [kind, id] = String(r.chatKey || '').split(':');
    if (!kind || !id) return;
    const text = `⏰ 提醒：${r.text}`;
    // 走统一发送管道（SendQueue）：与机器人发言共享限频 / 去重 / 超长切分 / CQ 转义，
    // 并自带留档（appendSelf）。失败必须向上抛，让调度循环保留未触发状态以便重试。
    await this.sender.sendTextBatch(r.chatKey, [text]).then((result) => {
      if (result?.sent?.some((s) => s?.deduped)) {
        console.warn(`[reminder] 提醒文本与刚发送的内容完全相同，被去重跳过（${r.chatKey}）`);
      }
    });
    this.emit('chat-update', r.chatKey);
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 6;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      const overThreshold = st.counts.memberImpression > minImpressions;
      // 「发现活跃群友」模式下，条数门槛不再是必要条件 —— 由下方的冷却时间单独限流。
      // 只看条数的话，新群/冷群永远凑不到阈值，而整理模式又只合并删减、不新增，
      // 于是第一条印象永远建不出来（实测有群聊了 200+ 条却零印象）。
      const discovering = cfg.memory?.discoverActiveMembers !== false;
      if (!overThreshold && !anyMemberOverloaded && !discovering) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  // ── 前情摘要折叠 ──
  //
  // 与记忆整理的区别：这里**没有时间冷却** —— 摘要的价值就是新鲜，而 minFold 这道门已经
  // 天然限流了调用频率：只有本次又有 minFold 条以上消息滑出读取窗口，才会真的调模型。
  // 群不活跃时滑不出消息，就一次都不会调。
  #maybeFoldSummary(chatKey, contextLimit = 0) {
    try {
      const cfg = getConfig();
      if (cfg.summary?.enabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不折叠
      if (this.folding.has(chatKey)) return;              // 同一会话同时只折一次
      this.folding.add(chatKey);
      this.foldSummaryForChat(chatKey, { contextLimit })
        .catch((error) => console.error(`[summary] 折叠 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.folding.delete(chatKey));
    } catch { /* 摘要折叠是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 折叠前情摘要 —— 唯一入口（自动触发与手动按钮都走这里）。
   *
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {boolean} [opts.force]        忽略 minFold 门槛（手动触发时用）
   * @param {number}  [opts.contextLimit] 本次读取窗口条数（决定保留多少条原文不进摘要）
   * @returns {Promise<{ok, folded, note, ...}>} folded=0 表示这次没折（很常见，不是错误）
   */
  async foldSummaryForChat(chatKey, { force = false, contextLimit = 0 } = {}) {
    const cfg = getConfig();
    const maxChars = Math.max(200, Number(cfg.summary?.maxChars) || 1200);
    const maxInputMsgs = Math.max(1, Number(cfg.summary?.maxInputMsgs) || 200);
    const keepRaw = resolveKeepRaw(cfg.summary?.keepRaw, contextLimit);
    const minFold = Math.max(1, Number(cfg.summary?.minFold) || 5);

    const state = loadSummary(chatKey);
    // 只取"保留区 + 单批上限"这么多条：窗口最前面那一段必然都已滑出保留区，
    // 读更早的没有意义（它们要么已折叠过、要么留给下一轮）。
    const list = this.store.recent(chatKey, { limit: keepRaw + maxInputMsgs });
    const toFold = pickMessagesToFold(list, {
      keepRaw,
      throughId: state.throughId,
      maxInputMsgs
    });

    if (!toFold.length) {
      return { ok: true, folded: 0, note: '没有新的旧消息需要折叠' };
    }
    if (!force && toFold.length < minFold) {
      return {
        ok: true,
        folded: 0,
        pending: toFold.length,
        note: `只有 ${toFold.length} 条滑出读取窗口（不足 ${minFold} 条），这次不折叠`
      };
    }
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法折叠前情摘要');

    const { system, user } = buildFoldPrompt({ prevText: state.text, messages: toFold, maxChars });
    const res = await this.#summaryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    const text = cleanSummaryText(res?.message?.content, maxChars);
    // 空结果一律放弃，保留原摘要 —— 宁可摘要旧一点，也不能被清空
    if (!text) throw new Error('模型返回了空的摘要，已保留原摘要');

    const lastId = Number(toFold[toFold.length - 1]?.id) || state.throughId;
    const saved = saveSummary(chatKey, {
      text,
      throughId: lastId,
      folds: state.folds + 1,
      folded: state.folded + toFold.length
    });
    console.log(`[summary] ${chatKey} 折叠 ${toFold.length} 条进前情摘要（累计 ${saved.folded} 条 / ${saved.text.length} 字）`);
    return {
      ok: true,
      folded: toFold.length,
      chars: saved.text.length,
      folds: saved.folds,
      totalFolded: saved.folded,
      note: `已把 ${toFold.length} 条旧消息折叠进摘要（现 ${saved.text.length} 字）`
    };
  }

  /** 清空某会话的前情摘要（手动）。 */
  resetSummary(chatKey) {
    return clearSummary(chatKey);
  }

  /**
   * 摘要折叠专用模型调用。
   * useChatModel=true 时跟随聊天模型；false 时用 cfg.summary.provider/model 指向的目录模型。
   * 与 #memoryChat 分开：摘要是独立开关，模型也应当能单独指定。
   */
  async #summaryChat(messages) {
    const cfg = getConfig();
    const s = cfg.summary || {};
    if (s.useChatModel !== false) {
      // ⚠️ 这里【不能】传只带 timeoutMs 的 overrides：chatCompletion 里
      // `const api = overrides || effectiveApi()` 是**整体替换**而非合并，
      // 只给 timeoutMs 会让 baseUrl/apiKey/model 全变成 undefined，请求发不出去
      // （表现为"折叠接口返回 202 但摘要永远是空的"）。跟随聊天模型就什么都不传。
      return chatCompletion({ messages, temperature: 0.2 });
    }
    const providers = currentProviders();
    const p = providers.find((x) => x.id === s.provider);
    if (!p?.baseURL || !p?.apiKey || !s.model) {
      throw new Error('摘要折叠专用模型未配置：请在设置 → 记忆 → 前情摘要里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      // 专用模型必须给全 baseUrl/apiKey/model（overrides 是整体替换，缺一个都发不出去）
      overrides: {
        baseUrl: p.baseURL,
        apiKey: p.apiKey,
        model: s.model,
        timeoutMs: Math.max(10000, Number(s.timeoutMs) || 180000)
      }
    });
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      // 即使没人可整理也要记一次时间：自动整理是"每次运行后"都会进来问一遍的，
      // 不记的话冷却永不生效 —— 每来一条消息就重扫 2000 条聊天记录，白烧 CPU
      // （而结果每次都一样）。手动指定群友（only）不占用冷却。
      if (!only) this.#markConsolidated(chatKey, []);
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

/**
 * 把模型返回的 tool_calls 规整成上游一定接受的形式。
 *
 * 存在的理由：我们把这些 tool_calls 原样塞进 messages 发给下一轮，而模型/中转网关
 * 返回什么不由我们决定。实测碰到过 `type: "functionfunction"`，照抄回去后上游直接
 * 400；也见过缺 id、arguments 是对象而非字符串、甚至整个 function 段缺失的情况。
 * 与其把畸形数据透传给上游（报错信息还很难定位），不如在回传前统一收敛。
 *
 * 返回 undefined 表示"没有可用的工具调用"，调用方应省略整个 tool_calls 字段
 * （比留一个 null/空数组更安全，部分上游对 null 也会报参数错）。
 */
export function normalizeToolCalls(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const call = list[i];
    if (!call || typeof call !== 'object') continue;
    const fn = call.function && typeof call.function === 'object' ? call.function : {};
    const name = String(fn.name ?? '').trim();
    // 没有函数名的条目上游必然不认，直接丢弃（保留只会连累整次请求被拒）
    if (!name) continue;
    const rawArgs = fn.arguments;
    const args = rawArgs === undefined || rawArgs === null
      ? '{}'
      : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs));
    out.push({
      id: String(call.id ?? `call_${i}`),
      type: 'function',                    // 规范里只允许这一个值
      function: { name, arguments: args }
    });
  }
  return out.length ? out : undefined;
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
