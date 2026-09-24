// OpenAI 兼容 Chat Completions 客户端（非流式）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';
import { resolveOfficialPrice, resolveModelPrice, priceAt } from './model-prices.js';
import { skillManager } from './skills/manager.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey, baseUrl = '', model = '') {
  const h = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  // OpenCode Go 强制要求会话头做路由（缺了直接 400）。注意不能只认域名：
  // 走中转站转发时 baseUrl 不是 opencode.ai，只能靠模型 id 的 opencode-go/ 前缀识别。
  if (/opencode\.ai/i.test(String(baseUrl)) || /^opencode-go\//i.test(String(model || ''))) {
    h['x-opencode-session'] = getOpencodeSessionId();
    h['user-agent'] = 'qq-agent/0.3';   // 官方文档要求客户端自报身份，别用通用库名
  }
  return h;
}

// OpenCode Go 会话 ID：进程级生成一次，全程复用（路由粘性 + 缓存命中）
let opencodeSessionId = '';
function getOpencodeSessionId() {
  if (!opencodeSessionId) {
    opencodeSessionId = `qqagent-${crypto.randomUUID()}`;
  }
  return opencodeSessionId;
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：**当前选中的目录提供商的 Key > 顶层 api.apiKey**。
 *
 * 注意顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个
 * 目录提供商，就该用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的
 * Key 去请求 openrouter.ai」的情况 —— 表现为全部会话 401 Missing Authentication。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromDsh = String(cfg?.dshProviderKeys?.[pid] ?? '').trim();
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  return { ...cfg.api, apiKey: resolveApiKey(cfg) };
}

/**
 * 按请求里的模态挑选专用模型。
 *
 * 背景：设置页有「图片输入专用模型」和「视频输入专用模型」两个字段 ——
 * 允许用一个便宜的纯文本模型聊天、只在真的要看图/看视频时才切到贵的多模态模型。
 * 但此前这两个字段**只被存下来、从来没有任何代码读取**：
 * 用户在 UI 里填了模型，实际请求还是走主模型 —— 填了不起作用。
 *
 * 现在在这里生效：扫描本次 messages，出现 video 部分就优先用 videoModel，
 * 出现图片部分就用 visionModel（视频优先，因为视频能同时包含图片部分）。
 *
 * 位置放在 effectiveApi 之后、只在**主调用路径**生效：
 *   · 记忆整理等显式传 overrides 的调用不受影响（它有自己指定的模型）
 *   · 备选模型降级也不受影响（overrides 已由候选序列给出）
 * 这样"切专用模型"不会意外覆盖用户明确指定的模型。
 */
function specializedModelFor(messages, cfg) {
  if (!Array.isArray(messages)) return '';
  let hasImage = false;
  let hasVideo = false;
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'video_url') hasVideo = true;
      else if (part?.type === 'image_url') hasImage = true;
      if (hasVideo) break;
    }
    if (hasVideo) break;
  }
  if (hasVideo) {
    const v = String(cfg?.api?.videoModel ?? '').trim();
    if (v) return v;
  }
  if (hasImage || hasVideo) {
    const v = String(cfg?.api?.visionModel ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * 解析某个提供商 id 对应的 { baseUrl, apiKey }。
 * 用于备选模型跨提供商切换：备选项指定了 provider 时，要用那个提供商的
 * baseUrl + Key 发请求，而不是主模型的。
 * 找不到该提供商时返回 null（调用方应跳过这个备选）。
 */
function resolveProviderEndpoint(providerId) {
  const cfg = getConfig();
  const pid = String(providerId ?? '').trim();
  if (!pid) return null;
  const p = (cfg.providers || []).find((x) => x.id === pid);
  if (!p || !String(p.baseURL ?? '').trim()) return null;
  const key = String(cfg.dshProviderKeys?.[pid] ?? p.apiKey ?? '').trim();
  return { baseUrl: String(p.baseURL).trim(), apiKey: key === '******' ? '' : key };
}

/**
 * 构建"主模型 + 备选模型"的候选请求序列。
 * 第一项永远是当前主模型；之后按 api.fallbackModels 顺序追加。
 * 每项是一个可直接传给 chatCompletion 的 overrides 对象。
 */
function buildCandidateApis() {
  const cfg = getConfig();
  const main = effectiveApi();
  const candidates = [{ overrides: null, label: main.model || '(未设置模型)' }];   // null = 用 effectiveApi()
  const fallbacks = Array.isArray(cfg.api?.fallbackModels) ? cfg.api.fallbackModels : [];
  for (const fb of fallbacks) {
    const model = String(fb?.model ?? '').trim();
    if (!model) continue;
    const pid = String(fb?.provider ?? '').trim();
    if (pid) {
      const ep = resolveProviderEndpoint(pid);
      if (!ep) continue;   // 提供商不存在/无 baseUrl，跳过这个备选
      candidates.push({
        overrides: { ...main, ...ep, model, provider: pid },
        label: `${model} @ ${pid}`
      });
    } else {
      // 未指定 provider：沿用主模型的 baseUrl + Key，只换模型 id
      candidates.push({ overrides: { ...main, model }, label: model });
    }
  }
  return candidates;
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障
  if (/HTTP\s*5\d\d/i.test(msg)) return true;                        // 5xx
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 只在**可重试**的错误上重试（网络抖动、5xx、429），
 * 4xx（密钥错、参数错）直接抛出 —— 重试不会让它变好。
 * 退避策略：1s → 2s（指数退避，避免雪崩）。
 *
 * 注意：这里重试的是**同一轮**请求，messages 不变，所以是幂等的，
 * 不会造成重复发言。会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 最多额外重试几次（默认 2，即总共最多 3 次尝试）
 */
export async function chatCompletionWithRetry(args, retries = 2) {
  // 显式传了 overrides（记忆整理专用模型等）：尊重调用方的指定，不参与备选降级。
  const explicit = args?.overrides ?? null;
  const candidates = explicit ? [{ overrides: explicit, label: explicit.model || '' }] : buildCandidateApis();
  let lastError = null;

  for (let ci = 0; ci < candidates.length; ci++) {
    const { overrides, label } = candidates[ci];
    // 主模型失败且要切备选时，先提示一次（让用户在日志里看到降级发生）
    if (ci > 0) {
      console.warn(`[llm] 主模型重试仍失败，切换到备选模型 ${ci}/${candidates.length - 1}：${label}`);
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 外部已中断（如调用方的 AbortSignal）就别再发起注定失败的请求 ——
      // 曾经退避 sleep 期间不看中断，最多再白打一次 API（白花一份钱）
      if (args?.signal?.aborted) throw args.signal.reason ?? new Error('aborted');
      try {
        const r = await chatCompletion({ ...args, overrides });
        r._usedModel = r.model || (overrides?.model ?? getConfig().api?.model ?? '');
        // 把"这次实际用的端点"一并带回去：备选模型可能来自**另一个 provider**，
        // 调用方要据此同步 vendor，否则成本看板的「渠道：模型」聚合会串味。
        r._usedApi = overrides ?? getConfig().api;
        return r;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableError(error)) break;   // 换下一个候选模型
        const wait = 1000 * Math.pow(2, attempt);   // 1s, 2s
        console.warn(`[llm] 请求失败（${label}，第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
        // 退避等待可被 signal 打断：中止时立刻抛出，不再等下一次注定失败的请求
        const sleepSignal = args?.signal ?? null;
        await new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(t); reject(sleepSignal.reason ?? new Error('aborted')); };
          const t = setTimeout(() => { sleepSignal?.removeEventListener?.('abort', onAbort); resolve(); }, wait);
          if (sleepSignal?.aborted) { clearTimeout(t); reject(sleepSignal.reason ?? new Error('aborted')); return; }
          sleepSignal?.addEventListener?.('abort', onAbort, { once: true });
        });
      }
    }
  }
  throw lastError ?? new Error('模型请求失败（主模型与全部备选均不可用）');
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, overrides = null, skillContext = null }) {
  let api = overrides || effectiveApi();
  // 主调用路径才切"图片/视频专用模型"（见 specializedModelFor 注释）——
  // 显式传 overrides 的调用（记忆整理、备选模型降级）不受影响。
  if (!overrides) {
    const forced = specializedModelFor(messages, getConfig());
    if (forced && forced !== api.model) api = { ...api, model: forced };
  }
  const buildBaseBody = () => {
    const body = {
      model: api.model,
      messages,
      stream: false
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;
    if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);
    return body;
  };
  const ctx = skillContext || { api, model: api.model, messages };

  // 让 Skill 改写请求体。转换器串行，后者看到前者的输出；
  // 任何一个转换器抛错只记日志并跳过（不能因为 Skill 坏了就发不出请求）。
  const applyRequestTransforms = async (base) => {
    let body = base;
    // 记录"因为与思考参数互斥而被删掉的 temperature"，降级时好还原。
    // 不记录的话，降级路径会永久丢掉用户设的采样温度。
    let removedTemperature;
    for (const fn of skillManager.getRequestTransforms(ctx)) {
      try {
        const next = await fn({ body, api, model: api.model, messages, tools, temperature: api.temperature, context: ctx });
        if (!next || typeof next !== 'object') continue;
        body = next.body || next;
        // 思考模式与 temperature 在部分厂商互斥（OpenAI o 系、DeepSeek 思考），
        // Skill 只能"声明互斥"，删字段这个动作留在核心做，避免 Skill 意外删掉别的键。
        if (next.omitTemperature && body.temperature !== undefined) {
          removedTemperature = body.temperature;
          delete body.temperature;
        }
      } catch (error) {
        skillManager.recordError('llm.request-params', error);
      }
    }
    return { body, removedTemperature };
  };

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  const post = async (body) => {
    try {
      return await fetch(joinUrl(api.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(api.apiKey, api.baseUrl, api.model) },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      // 主动中止 ≠ 超时：两者都被 fetch 报成 AbortError，但用户中止不该显示成"超时"。
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (error?.name === 'AbortError') throw new Error(`模型请求超时（${timeoutMs}ms）`);
      throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    }
  };

  try {
    const firstTransform = await applyRequestTransforms(buildBaseBody());
    let res = await post(firstTransform.body);

    // 被网关拒绝（400/415/422）时，问 Skill 是否值得"去掉某些参数重试一次"。
    // 只问一次、只重试一次：避免参数互斥时来回重试把配额烧穿。
    if (!res.ok && [400, 415, 422].includes(res.status)) {
      const firstText = await res.text().catch(() => '');
      const advice = await withoutRejectedParams(firstTransform.body, firstText, ctx, res.status);
      if (advice) {
        console.warn(`[llm] 请求被拒（HTTP ${res.status}），按 Skill 建议降级重试：${advice.reason}`);
        const retryBody = { ...advice.body };
        // 思考参数与 temperature 互斥：转换器删掉的温度在降级路径要还原
        if (firstTransform.removedTemperature !== undefined && retryBody.temperature === undefined) {
          retryBody.temperature = firstTransform.removedTemperature;
        }
        res = await post(retryBody);
      } else {
        throw new Error(`模型 API HTTP ${res.status}：${firstText.slice(0, 500)}`);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
    }

    // ── "返回了无法解析的 JSON" 根因治理 ──
    // 根因：中转站/网关在高负载或流式截断时，会返回**非 JSON 的响应体**（空串、
    // HTML 错误页、或被截断的半截 JSON）。res.json() 直接抛 SyntaxError，
    // 上层只看到一句"无法解析的 JSON"，完全不知道实际收到了什么。
    // 治理：先读原文，尝试解析；失败时把**实际收到的内容摘要**（前 200 字符 +
    // 内容类型 + 长度）写进错误，便于定位是网关返回了 HTML、空响应还是截断。
    const rawText = await res.text().catch(() => '');
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      const preview = rawText.replace(/\s+/g, ' ').trim().slice(0, 200);
      const looksLikeHtml = /^\s*</.test(rawText);
      const hint = !rawText.trim()
        ? '响应体为空（网关可能提前断流）'
        : looksLikeHtml
          ? '响应是 HTML 而非 JSON（可能是网关错误页/鉴权页）'
          : '响应不是合法 JSON（可能被截断）';
      throw new Error(`模型 API 返回了无法解析的 JSON：${hint}。content-type=${res.headers.get('content-type') || '未知'}，长度=${rawText.length}，内容预览：${preview || '（空）'}`);
    }
    const choice = data?.choices?.[0];
    if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);

    const result = {
      message: choice.message ?? {},
      finishReason: choice.finish_reason ?? null,
      usage: data.usage ?? null,
      model: data.model ?? api.model,
      raw: data
    };
    // 响应加工：让 Skill 提取 reasoning、补统计等。同样是错误隔离 + 串行。
    await applyResultTransforms(result, ctx);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** 依次执行 llm.response / llm.usage 转换器（错误隔离）。 */
async function applyResultTransforms(result, ctx) {
  for (const fn of skillManager.getResponseTransforms(ctx)) {
    try {
      const next = await fn({ result, ...ctx });
      if (next && typeof next === 'object' && next.result) Object.assign(result, next.result);
    } catch (error) {
      skillManager.recordError('llm.response', error);
    }
  }
  // reasoning tokens 这类附加统计：写进 result.extraUsage，由 orchestrator 决定怎么累加
  const extra = {};
  let hasExtra = false;
  for (const fn of skillManager.getUsageTransforms(ctx)) {
    try {
      const add = await fn({ result, usage: result.usage, ...ctx });
      if (add && typeof add === 'object') {
        for (const [k, v] of Object.entries(add)) {
          const n = Number(v) || 0;
          if (n) { extra[k] = (extra[k] || 0) + n; hasExtra = true; }
        }
      }
    } catch (error) {
      skillManager.recordError('llm.usage', error);
    }
  }
  if (hasExtra) result.extraUsage = extra;
}

/**
 * 询问 Skill 是否应该"去掉被拒参数后重试一次"。
 * 返回 { body, reason } 或 null（不重试）。
 *
 * 只询问一次、只重试一次：避免参数互斥时来回重试把配额烧穿。
 */
async function withoutRejectedParams(body, errorText, ctx, status = 400) {
  const advisors = skillManager.getRetryAdvisors(ctx);
  for (const { fn, skillId } of advisors) {
    try {
      // 把真实状态码传下去：不同顾问关心的码不同
      // （思考参数只看 400/422，图片兼容还要看 415）。
      // 顾问返回 null 表示"这个错误不归我管"，继续问下一个。
      const r = await fn({ body, errorText, status, ...ctx });
      if (!r) continue;
      if (r.body && typeof r.body === 'object') {
        return { body: r.body, reason: String(r.reason || `已按 ${skillId} 建议降级重试`) };
      }
    } catch (error) {
      skillManager.recordError(skillId, error);
    }
  }
  return null;
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey, cfg.baseUrl),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）—— 中转站会在
 * usage.prompt_tokens_details.cached_tokens 里返回它，成本看板与缓存命中率统计都依赖这个数。
 */
export function addUsage(target, usage) {
  if (!usage) return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  // 各家返回路径不同，逐个兼容
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0;
  target.cachedTokens = (Number(target.cachedTokens) || 0) + (Number(cached) || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}

/**
 * 按配置单价折算成本（元）。
 *
 * 三种单价来源：
 *   1. useOfficialPrice=true 且模型 id 在内置价格表里 → 用官方价（缓存部分单独计价）
 *   2. 否则用用户手填的 priceInputPerM / priceOutputPerM / priceCachedPerM
 *   3. 都没有 → 0（不估算）
 *
 * 缓存命中部分优先走 cached 单价；官方价里 cached 为 null 时（该模型无缓存优惠）
 * 退回按普通输入价计算。
 *
 * 峰谷分时：opts.at 传调用时刻（毫秒时间戳）时，对支持分时的厂商（DeepSeek）
 * 按该时刻自动取高峰价或闲时价。不传 at 则按闲时计价（保守估值，会偏低）。
 * 历史统计请看 sumCostByTime() —— 它按每条记录的时刻分别计价后汇总，更准。
 */
export function estimateCost(usage, opts = {}) {
  const cfg = effectiveApi();
  // 成本只与"实际调用的模型"有关。opts.model 优先（统计时逐条传入各自的模型），
  // 不传才回退到当前选中的模型。
  const model = String(opts.model ?? cfg.model ?? '');

  const promptTokens = Number(usage?.promptTokens) || 0;
  const completionTokens = Number(usage?.completionTokens) || 0;
  const cachedTokens = Math.min(Number(usage?.cachedTokens) || 0, promptTokens);
  // 未命中缓存的输入 = 总输入 - 命中部分
  const freshTokens = Math.max(0, promptTokens - cachedTokens);

  // 统一走 resolveModelPrice：自定义 > 内置官方表 > 全局兜底
  // 注意：第二个参数要传完整配置对象（内部读 cfg.api.*），
  // 传 effectiveApi() 的返回值（它就是 api 本身）会导致取不到字段。
  const p = resolveModelPrice(model, getConfig());

  // 峰谷：传了 at（调用时刻）且该模型有 peak 档位就取对应档
  const tier = p.peak && opts.at ? priceAt(p, opts.at) : null;
  const inPrice = tier ? tier.in : p.in;
  const outPrice = tier ? tier.out : p.out;
  const cachedPrice = tier ? tier.cached : p.cached;

  const source = p.source;
  const matched = p.matched;
  const peak = Boolean(tier?.peak);
  const hasPeakTiers = Boolean(p.peak);

  const cost =
    (freshTokens / 1_000_000) * inPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outPrice;

  return {
    cost,
    source,
    breakdown: {
      fresh: (freshTokens / 1_000_000) * inPrice,
      cached: (cachedTokens / 1_000_000) * cachedPrice,
      output: (completionTokens / 1_000_000) * outPrice
    },
    prices: { in: inPrice, out: outPrice, cached: cachedPrice },
    matched,
    // 峰谷信息：hasPeakTiers 表示这个模型是否分时段计价
    peak,
    hasPeakTiers
  };
}
