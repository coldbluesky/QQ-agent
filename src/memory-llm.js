// 记忆/蒸馏类"后台思考"调用共用的模型入口。
// 抽出来是为了让 orchestrator（记忆整理、事件抽取）和 persona-distill（角色蒸馏）
// 用同一套"用哪个模型"的规则，避免两处各写一份、改一处漏一处。
import { getConfig } from './config.js';
import { chatCompletion } from './llm.js';
import { currentProviders } from './providers.js';

/**
 * 调一次记忆/蒸馏专用模型。
 * useChatModel !== false  → 跟随聊天模型；
 * 否则用 config.memory.provider/model 指向的目录模型（端点与密钥取自 providers）。
 *
 * 思考档位：后台整理/蒸馏这类任务不需要长思考，默认用 api.thinkingBackground（'off'），
 * 比聊天便宜得多 —— 它们跑得频繁，是省 token 的第二大来源。
 */
export async function memoryChat(messages, { temperature = 0.2 } = {}) {
  const mem = getConfig().memory || {};
  const thinking = getConfig().api?.thinkingBackground ?? 'off';
  if (mem.useChatModel !== false) {
    return chatCompletion({ messages, temperature, thinking });
  }
  const p = currentProviders().find((x) => x.id === mem.provider);
  if (!p?.baseURL || !p?.apiKey || !mem.model) {
    throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
  }
  return chatCompletion({
    messages,
    temperature,
    thinking,
    overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
  });
}

/** 从模型回复里抠出第一个完整的 JSON 对象（容忍 ```json 包裹与前后废话）。 */
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
