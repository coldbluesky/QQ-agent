// Opt-in policy for the local 4B instance. No extra model calls or tools.
export function localReplyPolicy(api, entries = []) {
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api.baseUrl).hostname); } catch {}
  const options = api.localReplyTrial || {};
  const enabled = options.enabled === true && local && /^qwen3\.5-4b$/i.test(api.model || '');
  const text = entries.map(e => String(e.text || '')).join('\n');
  const complex = /分析|推理|推导|计算|算一下|解题|证明|比较|对比|区别|解释|为什么|怎么实现|如何实现|排查|报错|代码|方案|步骤|详细|总结|梳理|利弊|优缺点|\d\s*[+*/×÷=]\s*\d/i.test(text);
  const base = Math.max(0, Number(api.maxTokens) || 0);
  const cap = Math.max(base, Math.min(8192, Math.max(2048, Number(options.maxTokens) || 4096)));
  return {
    enabled, complex, autoFinish: enabled && options.autoFinish === true,
    budget: enabled && complex ? Math.min(cap, Math.max(base, Number(options.complexTokens) || 3072)) : base,
    cap,
    needsImage: /(?:发|来|找|搜|给).{0,16}(?:图片|照片|壁纸|张.{0,8}图)|(?:图片|照片|壁纸).{0,8}(?:发|给)/.test(text),
    needsSearch: /查一下|查一查|查查|搜索|搜一下|真新闻|最新.{0,8}(?:新闻|消息|价格)/.test(text)
  };
}

export function nextTruncationBudget(current, cap) {
  return Math.min(cap, Math.max(1800, (current || 900) * 2));
}

// End only after a successful delivery-only batch. Failed sends, previews and
// outstanding image/search work must retain the normal tool loop.
export function canEndReplyBatch(policy, calls, results, newSent, allSent, searched) {
  if (!policy.autoFinish || !newSent.length || !calls.length || results.some(r => r.isError)) return false;
  if (!calls.every(c => ['send_message', 'send_image', 'finish'].includes(c.function?.name))) return false;
  if (allSent.filter(s => s.type === 'text').length < 2 && !allSent.some(s => s.type === 'image')) return false;
  if (policy.needsImage && !allSent.some(s => s.type === 'image')) return false;
  if (policy.needsSearch && !searched) return false;
  if (newSent.some(s => /(?:我|先|再|马上|稍等).{0,8}(?:去查|查一下|搜一下|找一下|再查|再搜|发图|找图)/.test(s.text || ''))) return false;
  if (newSent.some(s => /(?:[:：]|算式是|原因是|分别是|如下|首先|然后|接下来|还有)[\s…。.]*$/.test(s.text || ''))) return false;
  return true;
}
