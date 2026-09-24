// 分层会话记忆（确定性型 / plugins/）
//
// ── 为什么要做成插件，而不是注册工具 ─────────────────────────────────────
// 这套东西的价值不在"模型能搜"，而在**每轮都会发生的确定性动作**：
//   · 后台按节奏把新消息压成日块索引（模型不知道、也不需要知道）
//   · 每轮往提示词里注入极短的记忆片段（待办 / 跨轮 / 语义卡 / 跨群）
// 这两件事模型想忽略也忽略不掉 —— 正是 plugins/（确定性型）的定义。
// 模型主动检索（memory_search / memory_archive）是**另一型**，放在
// skills/memory-recall/：那里注册工具、由模型决定何时调用，通过这里暴露的
// memory.search / memory.archive 能力取用实现。
//
// 这样两型各归其位：关掉本插件 → 检索工具自动显示「依赖未就绪」；
// 只留本插件 → 记忆照常巩固与注入，只是模型不能主动翻旧账。
//
// ── 与核心的关系（零侵入）────────────────────────────────────────────────
// 全部通过 hooks 挂载，**没有改一行核心代码**：
//   before-context       收集本轮触发内容（钩子载荷里没有，先存下来）
//   before-llm-messages  注入记忆片段（钩子允许原地改 messages）
//   after-response       写跨轮状态 + 记成本
// activate / deactivate  起停后台巩固定时器
//
// 上游是 07-conversation-memory 魔改包，原版要求在 app.js / orchestrator.js /
// prompt.js / tools.js / config.js 里各插一段接线；这里用 hooks 等价替代，
// 于是它从"改本体"变成了"放进去就生效"。

import path from 'node:path';
import { DATA_DIR } from './lib/env.js';
import { createConversationMemory } from './lib/memory.js';
import { buildArchitectureInject, saveCrossTurn, archStats } from './lib/arch.js';
import { reportRunCost, costGuardStats } from './lib/cost-guard.js';

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = {
  enabled: true,
  injectArchitecture: true,
  consolidateIntervalMin: 10,
  pendingTodos: true,
  crossTurnWorking: true,
  semanticCards: true,
  crossChatAwareness: true,
  semanticTopN: 2,
  costGuard: true,
  dayPromptMax: 800000,
  chatPromptMax: 200000
};

let api = null;
let mem = null;
let timer = null;
let consolidating = false;

/**
 * 本轮触发内容暂存。
 *
 * before-context 的载荷里有 triggerEntries，但 before-llm-messages 没有 ——
 * 而"语义卡按触发文本匹配""绑人的待办只在对方出现时注入"都需要它。
 * 所以在前者收集、后者消费，用完即删（不用 Map 长期持有会话引用）。
 */
const pendingTrigger = new Map();

/** 当前设置（插件默认值 ← 用户在设置页改过的值）。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * 把插件设置映射成下游模块期望的配置形状（`cfg.api.*`）。
 * 那些模块是从旧版搬过来的，读的是 `cfg.api.architecture.xxx`；
 * 与其改 6 个文件的取值方式（容易漏），不如在这里做一层薄适配。
 */
function legacyCfg() {
  const s = settings();
  return {
    api: {
      conversationMemory: { enabled: s.enabled !== false },
      architecture: {
        pendingTodos: s.pendingTodos !== false,
        crossTurnWorking: s.crossTurnWorking !== false,
        semanticCards: s.semanticCards !== false,
        crossChatAwareness: s.crossChatAwareness !== false,
        semanticTopN: Number(s.semanticTopN) || 2
      },
      costGuard: {
        enabled: s.costGuard !== false,
        dayPromptMax: Number(s.dayPromptMax) || 800000,
        chatPromptMax: Number(s.chatPromptMax) || 200000
      }
    }
  };
}

/** 单例：巩固器与检索器必须共用同一份索引，否则搜到的和刚写的对不上。 */
function instance() {
  if (!mem) {
    mem = createConversationMemory({
      messagesDir: path.join(DATA_DIR, 'messages'),
      memoryRoot: path.join(DATA_DIR, 'memory-v2')
    });
  }
  return mem;
}

/**
 * 跑一次增量巩固。
 *
 * 重入保护：定时器与钩子都可能触发，两个巩固同时写索引会互相覆盖。
 * 失败只打日志 —— 记忆是增强功能，坏了也绝不能让主流程陪葬。
 */
function consolidate(why) {
  if (consolidating) return;
  if (settings().enabled === false) return;
  consolidating = true;
  try {
    const results = instance().consolidate({ force: false }) || [];
    const added = results.reduce((sum, r) => sum + (Number(r?.added) || 0), 0);
    if (added > 0) {
      api.log(`巩固（${why}）：+${added} 条，索引 ${JSON.stringify(instance().consolidator.stats())}`);
    }
  } catch (error) {
    api.warn('巩固失败：', error?.message ?? error);
  } finally {
    consolidating = false;
  }
}

/** 把片段并进 system 消息（原地改，钩子约定允许）。 */
function appendToSystem(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') {
    sys.content += text;
    return;
  }
  if (sys && Array.isArray(sys.content)) {
    sys.content.push({ type: 'text', text });
    return;
  }
  messages.unshift({ role: 'system', content: String(text).trim() });
}

export function setup(a) {
  api = a;
}

/** 生效：起后台巩固。首跑延迟 8 秒，别和启动抢 IO。 */
export function activate() {
  if (settings().enabled === false) return;
  const everyMin = Math.max(1, Number(settings().consolidateIntervalMin) || 10);
  timer = setInterval(() => consolidate('tick'), everyMin * 60000);
  timer.unref?.();
  const boot = setTimeout(() => consolidate('boot'), 8000);
  boot.unref?.();
  api.log(`会话记忆已启用：间隔 ${everyMin} 分钟，数据根 ${DATA_DIR}`);
}

/** 关闭：停掉定时器。已生成的索引留在磁盘上，重新启用即复用。 */
export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 能力：给 skills/memory-recall/ 的检索工具用。
 * 返回统一形状 `{ ok, ... }`，不抛错 —— 调用方是模型工具，抛错只会变成一句难懂的话。
 */
export const providers = {
  'memory.search': (args = {}) => {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, hits: [], error: '缺少检索关键词' };
    try {
      const hits = instance().search(query, {
        chatKey: args?.chatKey || null,
        limit: Math.min(12, Math.max(1, Number(args?.limit) || 5)),
        maxSnippets: 5
      });
      return { ok: true, hits };
    } catch (error) {
      return { ok: false, hits: [], error: String(error?.message ?? error) };
    }
  },

  'memory.archive': (args = {}) => {
    try {
      const archive = instance().archive;
      const chatKey = args?.chatKey || null;
      const mode = String(args?.mode || 'list');
      if (mode === 'list') return { ok: true, chatKey, days: archive.listDays(chatKey, { limit: 30 }) };
      if (mode === 'count') {
        return {
          ok: true,
          ...archive.count({
            chatKey,
            query: args?.query,
            day: args?.day || null,
            dayFrom: args?.dayFrom || null,
            dayTo: args?.dayTo || null,
            maxSamples: 8
          })
        };
      }
      return {
        ok: true,
        ...archive.load({
          chatKey,
          day: args?.day,
          dayFrom: args?.dayFrom,
          dayTo: args?.dayTo,
          offset: args?.offset,
          limit: args?.limit,
          query: args?.query
        })
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  'memory.status': () => {
    try {
      return { ok: true, index: instance().consolidator.stats(), arch: archStats(), cost: costGuardStats() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

export const hooks = {
  /** 收集本轮触发内容，供注入时的"语义卡匹配 / 绑人待办"使用。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      const people = new Set();
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
        const uid = String(e?.senderId ?? '').trim();
        if (uid) people.add(uid);
      }
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), {
        triggerText: texts.join('\n').slice(0, 800),
        personIds: [...people]
      });
    } catch { /* 收集失败只是少点上下文，不影响这轮 */ }
  },

  /**
   * 注入记忆片段。
   *
   * ⚠️ 这里**不**跑巩固：钩子有 5 秒超时，而巩固要读文件、写索引，超时会被
   * 整个跳过还可能留下半截状态。巩固交给 activate() 的定时器。
   */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false || s.injectArchitecture === false) return;

    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingTrigger.get(key) || {};
    pendingTrigger.delete(key);          // 用完即删，别攒着会话引用

    let text = '';
    try {
      text = buildArchitectureInject(legacyCfg(), {
        chatKey: ctx.chatKey,
        kind: ctx.kind,
        triggerText: info.triggerText || '',
        personIds: info.personIds || []
      });
    } catch (error) {
      api.warn('架构注入失败：', error?.message ?? error);
    }
    if (text) appendToSystem(ctx.messages, text);
  },

  /** 运行结束：写跨轮状态 + 记成本（都是本地小文件操作，快）。 */
  async 'after-response'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;

    try {
      const content = ctx.response?.message?.content;
      saveCrossTurn(legacyCfg(), ctx.chatKey, {
        sent: Array.isArray(ctx.session?.sent) ? ctx.session.sent : [],
        draft: typeof content === 'string' ? content : ''
      });
    } catch { /* 跨轮状态写不进去不影响对话 */ }

    if (s.costGuard !== false) {
      try {
        const u = ctx.session?.usage || {};
        reportRunCost(ctx.chatKey, {
          promptTokens: Number(u.promptTokens ?? u.prompt_tokens ?? 0) || 0,
          cachedTokens: Number(u.cachedTokens ?? u.cached_tokens ?? 0) || 0
        }, legacyCfg());
      } catch { /* 统计失败无所谓 */ }
    }
  }
};
