// Prompt caching 自动适配
//
// 为什么需要它（用户原始需求：省 token）：
//   系统提示 + 工具定义是大段稳定文本，每次运行几乎不变。LLM 服务商的
//   "prompt cache"（前缀缓存）正是为这个场景设计的：把稳定的部分标成
//   "cache"，首次写入收正常价，命中后只收 1/10 ~ 1/4 的价。
//   不打标也能自动命中，但**主动打标**可以：
//     · 控制缓存边界（避免模型误缓存易变段，命中后还是过期重建）
//     · 让不支持的端点更容易被发现（走 400 → 去掉重试的兜底）
//     · 让支持自动前缀缓存的网关（如 OpenAI/DeepSeek/Anthropic 兼容层）也
//       能正确识别"这一段是不变的"，命中更稳定
//
// 各家写法（参考 Anthropic / OpenAI / DeepSeek 公开文档）：
//   · OpenAI 兼容（含 DeepSeek、Qwen、绝大多数中转站）：
//     消息上加 `cache_control: { type: 'ephemeral' }`
//     工具上加同样字段（OpenAI 新协议）
//   · Anthropic 兼容网关：消息里 `content` 数组的最后一个元素加同字段
//     （我们用 OpenAI 格式发，Anthropic 兼容网关会自己转）
//   · 其他/未知厂商：跳过，不带任何标记 —— 让网关上自己的自动缓存生效
//
// 失败兜底：
//   少数严格端点对未知字段报 400。chatCompletion 已有"400 时去掉
//   思考参数重试"机制；这里复用同一套：检测到 400 且 body 含 cache_control
//   时，复制一份去掉重试。
//
// 开关：api.promptCache = 'auto' | 'on' | 'off'
//   · 'auto'（默认）：根据 baseUrl/厂商特征判断要不要打标
//   · 'on'：强制打标（不管认不认，反正成本就是多一对字段）
//   · 'off'：不打标（适合没 cache 概念的端点、或调试时排查是不是它引起的问题）
//
// 注意：所有改动都走 messages / tools，不动 body.tools 调用方式，
//      对原有 thinking / tools / tool_choice 零侵入。

const CACHE_MARKER = { cache_control: { type: 'ephemeral' } };

/**
 * 探测"这个 baseUrl 大概是什么厂商"——只覆盖已知支持 cache 的端点。
 * 没匹配上就返回 null，由开关 'on'/'off' 决定后续行为。
 */
function detectProvider(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (!u) return null;
  // Anthropic 官方 + 兼容层
  if (u.includes('anthropic.com') || u.includes('claude')) return 'anthropic';
  // OpenAI 官方
  if (u.includes('api.openai.com')) return 'openai';
  // DeepSeek 官方
  if (u.includes('deepseek.com')) return 'deepseek';
  // DashScope / 百炼（Qwen 系）—— 已确认支持 cache_control
  if (u.includes('dashscope') || u.includes('aliyuncs.com') || u.includes('bailian')) return 'qwen';
  // 月之暗面 Moonshot / Kimi
  if (u.includes('moonshot')) return 'moonshot';
  // Zhipu 智谱
  if (u.includes('bigmodel') || u.includes('zhipu')) return 'zhipu';
  return null;
}

/**
 * 是否要给 body 加 cache 标记。
 * 返回 true → 给 messages/工具打标；false → 不动。
 */
export function shouldApplyCache(api) {
  const mode = String(api?.promptCache ?? 'auto').toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;   // 强制打标；端点不认识的话由 400 兜底去重试
  // auto：只在能识别厂商时打标
  return Boolean(detectProvider(api?.baseUrl));
}

/**
 * 给 messages 与 tools 打上 cache 标记。
 *
 * 策略（关键设计）：
 *   · system 消息打 cache（最稳定，整段不变）
 *   · tools 数组打 cache（工具定义基本不变）
 *   · user 消息**不打**（每次都变；打 cache 没意义）
 *   · assistant 消息**不打**（也是易变的；多层 assistant 一起打反而降低命中率）
 *
 * 这样网关能识别"system + tools"是稳定段，其余按前缀延续，整段重发时
 * 大部分 prompt 命中缓存。
 *
 * @param {object} body 请求体（会被原地修改）
 * @returns {object} 同一 body（方便链式）
 */
export function applyPromptCache(body) {
  if (!body || !Array.isArray(body.messages)) return body;
  // 系统提示：标记整个 system 消息
  // 多个 system 消息只标第一个（其它视为变体，可能动态）
  let systemMarked = false;
  for (const m of body.messages) {
    if (m && m.role === 'system' && !systemMarked) {
      m.cache_control = CACHE_MARKER.cache_control;
      systemMarked = true;
    }
  }
  // 工具定义：给数组整体打 cache（OpenAI 新协议：tools 是数组，标在最末一个工具上；
  // Anthropic 兼容层会自动把整段标成 cache）
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    // 只标最后一个，前缀的 cache 自动覆盖前面（OpenAI 缓存是"前 N 个 token"语义）
    body.tools[body.tools.length - 1].cache_control = CACHE_MARKER.cache_control;
  }
  return body;
}

/**
 * body 里是否含有 cache_control 标记（用于 400 兜底判断）。
 */
export function hasCacheControl(body) {
  if (!body) return false;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && m.cache_control) return true;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t && t.cache_control) return true;
    }
  }
  return false;
}

/**
 * 把 body 里的 cache_control 标记全去掉（用于 400 重试时）。
 */
export function stripCacheControl(body) {
  if (!body) return body;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && m.cache_control) delete m.cache_control;
    }
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t && t.cache_control) delete t.cache_control;
    }
  }
  return body;
}

/**
 * body 复制时一并去掉 cache_control（用于"400 重试"路径，避免修改原 body 状态）。
 */
export function cloneBodyWithoutCache(body) {
  const c = JSON.parse(JSON.stringify(body || {}));
  return stripCacheControl(c);
}
