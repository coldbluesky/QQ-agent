// 回忆 · 主动检索（LLM 型 / skills/）。
//
// ── 为什么是 skills/（而且必须和 plugins/conversation-memory 成对出现）─────
// 记忆功能天然是两半：
//   plugins/conversation-memory/   确定性型 —— 后台巩固索引 + 每轮注入片段。
//                                  模型想忽略也忽略不掉，这半边保证"不该忘的不会被忘"。
//   skills/memory-recall/（本模块） LLM 型 —— 检索工具。
//                                  "要不要翻旧账"是**语义判断**，只有模型看得到
//                                  当前对话在聊什么，核心代码排不了程。
//
// 本模块**不自己存任何记忆**：它只把模型意图翻译成对 memory.* 能力的调用。
// 实现由 conversation-memory 通过 providers 提供。因此：
//   · 关掉 conversation-memory → 本技能三个工具立刻变「依赖未就绪」
//     （requires 是**硬依赖**，由 SkillManager 判定，不是本模块自己检查的）
//   · 也可以换一份实现（比如换成云记忆后端），只换提供者，本模块一行不用改
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 不碰磁盘、不建索引：那些都是确定性型的活
//   · 不抛错：调用方是模型，抛错只会变成一句难懂的话。所有失败都转成
//     可读文本（`{ content, isError }`），让模型能自己决定怎么向用户交代
//   · 命中为空时返回**明确文案**而不是空字符串 —— 模型拿到空内容容易开始编

let cfg = () => ({});
let api = null;
let cap = () => undefined;

const DEFAULTS = { defaultLimit: 5, maxLimit: 12, maxSnippetChars: 300 };

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
  };
  // maxLimit 必须 ≥ defaultLimit，否则"默认值"会超过上限 —— 用户把 default 设成 10、
  // max 设成 3 时会出现自相矛盾的配置，这里把上限顶上去而不是让默认值失效。
  out.defaultLimit = clamp(out.defaultLimit, 1, 50, 5);
  out.maxLimit = Math.max(out.defaultLimit, clamp(out.maxLimit, 1, 50, 12));
  out.maxSnippetChars = clamp(out.maxSnippetChars, 60, 2000, 300);
  return out;
}

/**
 * 调一个能力。任何异常都收成 {ok:false, error}。
 *
 * 为什么不用 try/catch 包住调用点：提供者可能来自第三方技能，它抛什么形状的
 * 错误都不知道。统一在这里收口，调用点就只需要判 ok。
 */
function callCapability(name, args) {
  try {
    const r = cap(name, args);
    if (r === undefined) return { ok: false, error: `能力 ${name} 没有可用的提供者` };
    return r;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 把一条命中截断到可读长度（超长处加省略号，让模型知道被截了）。 */
export function trimSnippet(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 把 memory.search 的返回渲染成给模型看的文本。
 * 抽成纯函数：这里的排版规则（命中为空要说清"没有"）是最容易回归的部分，
 * 必须能脱离真提供者单测。
 */
export function renderSearch(result, { query, maxSnippetChars = 300 } = {}) {
  if (!result || result.ok === false) {
    return { content: `检索失败：${result?.error || '未知错误'}`, isError: true };
  }
  const hits = Array.isArray(result.hits) ? result.hits : [];
  if (!hits.length) {
    // ⚠️ 必须是"没有命中"这样的明确表述。返回空串时模型会当成"我没看到限制"
    // 然后开始凭印象编 —— 这正是记忆功能最该避免的失败模式。
    return { content: `没有命中关于「${query}」的记忆。可以换个说法再搜，或者直接说记不清了。` };
  }
  const lines = hits.map((h, i) => {
    const when = h?.dayKey || h?.date || h?.ts || '';
    const where = h?.chatKey ? `（${h.chatKey}）` : '';
    const body = trimSnippet(h?.text ?? h?.snippet ?? h?.content ?? '', maxSnippetChars);
    return `${i + 1}. ${when ? `[${when}]` : ''}${where} ${body}`.trim();
  });
  return { content: `关于「${query}」找到 ${hits.length} 条：\n${lines.join('\n')}` };
}

/**
 * 技能入口。
 *
 * ⚠️ 名字必须叫 `setup`（或旧的 `register`）。加载器的判定是：
 *     const setupFn = typeof mod.setup === 'function' ? mod.setup
 *       : (typeof mod.register === 'function' ? mod.register : null);
 * —— **`setup` 优先**。所以这里直接叫 setup 并**顺手注册工具**，
 * 不要再拆出一个只存配置的同名函数 + register（那样 register 永远不会被调用，
 * 技能显示"加载成功"但工具列表是空的）。
 */
export function setup(a) {
  cfg = a.config;
  api = a;
  // 软依赖取用：能力没注册时返回 undefined，由 callCapability 转成可读错误。
  // 注意 requires 里的硬依赖已经保证"能力提供者存在且生效"才会进到这里，
  // 所以正常情况下 cap 一定能取到东西 —— 这条兜底是给"提供者中途被卸载"用的。
  cap = typeof a.capability === 'function' ? a.capability : (() => undefined);

  registerTools();
}

function registerTools() {

  // ── 工具 1：搜索 ──
  api.registerTool({
    id: 'memory_search',
    name: '回忆一下',
    description: '按关键词搜索过去的聊天记忆（很久以前聊过的事、某人说过的话、约定）。上下文里没有的旧事优先用它，不要直接说"不记得"。',
    category: 'memory',
    icon: '🔎',
    requires: ['memory.search'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词或短语（如"火锅"、"投影仪灯泡"）' },
        limit: { type: 'integer', description: '最多返回几条，默认取设置里的条数' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      const s = settings();
      const query = String(args?.query ?? '').trim();
      if (!query) {
        return { content: '要搜什么？给个关键词（比如"火锅"）。', isError: true };
      }
      const limit = Math.min(s.maxLimit, Math.max(1, Number(args?.limit) || s.defaultLimit));
      const result = callCapability('memory.search', {
        query,
        limit,
        chatKey: ctx?.chatKey || null
      });
      return renderSearch(result, { query, maxSnippetChars: s.maxSnippetChars });
    }
  });

  // ── 工具 2：按时间调阅归档 ──
  api.registerTool({
    id: 'memory_archive',
    name: '翻聊天归档',
    description: '按时间翻过去的聊天归档：mode=list 看有哪些天有记录；mode=day 取某天的内容；mode=count 统计某关键词出现过多少次。适合"上周三群里聊了什么"这类问题。',
    category: 'memory',
    icon: '🗂️',
    requires: ['memory.archive'],
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['list', 'day', 'count'],
          description: 'list=列出有记录的日子（默认）；day=取某天内容（配 day）；count=统计出现次数（配 query）'
        },
        day: { type: 'string', description: '日期，格式 YYYY-MM-DD（mode=day 时用）' },
        dayFrom: { type: 'string', description: '起始日期 YYYY-MM-DD（可选，用于范围查询）' },
        dayTo: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
        query: { type: 'string', description: '关键词（mode=count 时用，可配合日期范围）' },
        limit: { type: 'integer', description: '最多返回几条（可选）' },
        offset: { type: 'integer', description: '跳过前几条（可选，用于翻页）' }
      }
    },
    async execute(ctx, args) {
      const mode = String(args?.mode || 'list');
      const result = callCapability('memory.archive', {
        mode,
        day: args?.day || null,
        dayFrom: args?.dayFrom || null,
        dayTo: args?.dayTo || null,
        query: args?.query || null,
        limit: args?.limit,
        offset: args?.offset,
        chatKey: ctx?.chatKey || null
      });
      if (!result || result.ok === false) {
        return { content: `翻归档失败：${result?.error || '未知错误'}`, isError: true };
      }
      // 归档返回的是结构化 JSON（days / entries / count …），原样序列化给模型 ——
      // 这里不做二次排版：模型读 JSON 比读我们猜的那套文案更准，也不容易丢字段。
      try {
        return { content: JSON.stringify(result) };
      } catch {
        return { content: String(result), isError: true };
      }
    }
  });

  // ── 工具 3：查看索引状态 ──
  api.registerTool({
    id: 'memory_status',
    name: '记忆状态',
    description: '查看记忆索引的状况：收录了多少天、多少条，以及本轮成本统计。搜不到东西时先看这个确认索引是不是还没建起来。',
    category: 'memory',
    icon: '📊',
    requires: ['memory.status'],
    parameters: { type: 'object', properties: {} },
    async execute() {
      const result = callCapability('memory.status', {});
      if (!result || result.ok === false) {
        return { content: `取记忆状态失败：${result?.error || '未知错误'}`, isError: true };
      }
      try {
        return { content: JSON.stringify(result) };
      } catch {
        return { content: String(result), isError: true };
      }
    }
  });
}

export function available() { return { ok: true }; }

export const internals = { trimSnippet, renderSearch, settings };
