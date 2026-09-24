// 内联工具调用解析：少数模型（尤其本地小模型）不返回原生 tool_calls，
// 而是把"工具调用"直接写进正文，或者把整段数组文本塞进工具参数里。
//
// 独立成模块的原因：orchestrator 和 tools 都要用，
// 放在 orchestrator 里会被 tools 反向 import 形成循环依赖。
//
// 支持的文本格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
//   4. 裸数组文本：["这啥鬼啊！"] ["我翻出来了！"] [collected_-921448915]

/** 表情 id 的形状：collected_123456789 / 1927…_0_0 —— 不是备注文字、不是 QQ 面板小数字。 */
function looksLikeStickerId(text) {
  const s = String(text ?? '').replace(/^["'“”]|["'“”]$/g, '').trim();
  if (!s || s.length < 8) return false;
  if (/[\u4e00-\u9fff]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  return /^(collected_[\w-]{4,}|[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{2,})$/.test(s);
}

/**
 * 方括号片段：ASCII 的 [] 和全角的【】都算，而且**允许混搭**。
 * 实测（2026-09-11 00:41）模型写出过这种：
 *   ["先低头认错"】\n["别闹了嘛"]\n【发个抱抱表情包卖萌】
 * —— ASCII 开括号配全角闭括号，旧正则只认 []，于是整段被当成普通聊天发进了群。
 */
const SEGMENT_RE = /[\[【]([^\[\]【】]*)[\]】]/g;
const SEGMENT_STRIP_RE = /[\[【][^\[\]【】]*[\]】]/g;

/** 混合括号（[…】 或 【…]）—— 这本身就是"模型在硬写工具调用"的铁证。 */
const MIXED_BRACKET_RE = /\[[^\[\]【】]*】|【[^\[\]【】]*\]/;

/** 草稿纸倾倒的识别标志：XML 工具语法，或者代码围栏里塞了一堆自述。 */
const SCRATCHPAD_RE = /<\s*\/?\s*(tool_call|function|parameter)\b/i;

/**
 * 从"草稿纸"里抢救出真正要说的话。
 *
 * 实测形态（02:05，389 字整坨当参数发出去）：
 *   ["好嘞～收好啦"]</parameter></function></tool_call>
 *   ``` 1. "在啊～…" -> 09-11 02:04（我）  2. "#67723144 [图片][哭哭]" -> 沫钤 …
 *      现在该回个话给沫钤，说收好啦。```
 *   <tool_call><function=send_message><parameter=messages>["好嘞～收好啦"]</parameter></function></tool_call>
 *
 * 做法：只认"结构化位置"里的内容 —— `<parameter=messages>` 的值、以及**带引号**的数组片段。
 * 其余（思考过程、回忆的历史、finish 的 summary）一律丢掉。
 * 只收带引号的片段是刻意的：草稿里引用的历史会出现 `[图片][哭哭]`，那不是要说的话。
 */
function salvageScratchpad(raw) {
  const messages = [];
  let stickerId = '';

  const harvest = (text) => {
    const calls = parseInlineLooseCalls(text);
    for (const call of calls || []) {
      if (call.name === 'send_message') {
        for (const t of [].concat(call.args.messages ?? [])) {
          const s = String(t).trim();
          if (s) messages.push(s);
        }
      } else if (call.name === 'send_sticker' && call.args.stickerId) {
        stickerId = String(call.args.stickerId);
      }
    }
  };

  // ① <parameter=messages> 的值（最可靠：模型自己就是这么写的）
  for (const m of raw.matchAll(/<\s*parameter\s*=\s*messages\s*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi)) harvest(m[1]);
  // ② <parameter=stickerId> 的值
  const st = raw.match(/<\s*parameter\s*=\s*stickerId\s*>\s*([^\s<]+)/i);
  if (st) stickerId = st[1].trim();
  // ③ 还没捞到就退一步：只认**带引号**的数组片段（["好嘞～收好啦"]）
  if (!messages.length) {
    for (const m of raw.matchAll(/\[\s*"[\s\S]{1,200}?"\s*\]/g)) harvest(m[0]);
  }

  if (!messages.length && !stickerId) return null;
  // 去重（同一句话可能在草稿里出现两三次）
  return { messages: [...new Set(messages)], stickerId };
}

/**
 * 「【发个抱抱表情包卖萌】」这类是模型在描述"我要发表情"，不是要说的话。
 * 真发出去群里就是一串方括号废话，所以丢掉（要发表情得用 send_sticker 带真 id）。
 */
function isStickerIntent(text) {
  const s = String(text ?? '').replace(/^["'“”]|["'“”]$/g, '').trim();
  if (!s || s.length > 24) return false;
  return /(表情包?|贴图|颜文字|emoji)/i.test(s) && /(发|来|给|塞|甩|贴|整个|弄|配)/.test(s);
}

/**
 * `key=值` 形式的参数（Python 风格关键字参数）。
 *
 * 实测（2026-09-11 22:51，号A 私聊）：模型**没调工具**，把调用写成了正文：
 *   send_message(messages=["搜你个头", "别逼我骂人"])
 * 用户看到的就是"怎么又不发"。上面第 ② 步只认 JSON 参数（`send_message(["a"])` 或
 * `send_message({"messages":[...]})`），这种 `messages=[...]` 的写法解析不出值 → 整轮静默。
 *
 * 只按顶层逗号切分（跳过括号/引号内部），每个片段必须是 `key=值`，否则整体放弃。
 * 判定很窄：只有"整段正文就是这个调用写法"时才会走到这里，正常聊天不受影响。
 */
function parseKwargs(inner) {
  const s = String(inner ?? '').trim();
  if (!s) return null;
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      quote = ch === '“' ? '”' : ch;
      cur += ch;
      continue;
    }
    if ('([{【'.includes(ch)) depth += 1;
    else if (')]}】'.includes(ch)) depth -= 1;
    if (ch === ',' && depth <= 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    let value = part.slice(eq + 1).trim();
    if (!/^[A-Za-z_][\w-]*$/.test(key)) return null;
    try { value = JSON.parse(value.replace(/'/g, '"')); } catch { /* 保持字符串 */ }
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 解析 <tool_call>…</tool_call> 包裹的块。返回 [{ name, args }]；没解析到返回 []。
 */
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

/**
 * 小模型专用兜底：把"工具调用"直接写成文本时的解析。
 *
 * 实测本地 4B（qwen3.5-4b）会这样输出（原生 tool_calls 完全没调）：
 *   ["这啥鬼啊！"] ["我翻出来了！"] [collected_-921448915]
 *   ["灵梦嘛～"] ["东方project的角色呗"] ["就是那啥..."]}
 * 也就是把 send_message 的参数数组直接写进正文，群里看到的就是一串方括号。
 *
 * 判定刻意收紧，避免把正常聊天吃掉：**除了 [...] 片段和分隔符之外不允许有别的字符**。
 * 数组里的字符串 → send_message；单个看起来像表情 id 的 → send_sticker。
 */
export function parseInlineLooseCalls(text) {
  const body = String(text || '').trim();
  if (!body) return null;
  const cleaned = body
    .replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '')   // 代码围栏
    // XML 方言：4B 会把工具调用的 XML 语法混进参数里（实测 01:55）
    //   ["行啊～你收藏嘛"]</parameter>\n<parameter=replyToMessageId>\n-1362839140
    // 标签本身没有信息量，整段丢掉；剩下的片段照常解析。
    .replace(/<\/?[^<>\s]{0,60}>/g, ' ')
    // ⚠️ 只裁尾部的花括号/引号/空白，**不能裁 ]** ——
    //    否则 ["a"] ["b"] 会被削成 ["a"] ["b 从而判定失败（踩过这个坑）。
    .replace(/[}"'“”\s]+$/, '')
    .trim();
  if (!cleaned) return null;
  // ⚠️ 不要再做"削尾部多余 ]"的修补：多余的 ] 可能在中间，
  //    而尾部的那个 ] 往往是合法片段（[collected_x]）的收尾 —— 削它反而把片段弄断。
  //    交给下面的 leftover 判定统一处理。

  // ① 裸表情 id：模型有时把 id 直接当正文写出来（collected_123456789 / 1927…_0_0）
  const bare = cleaned.replace(/^["'“”]|["'“”]$/g, '').trim();
  if (looksLikeStickerId(bare)) {
    return [{ name: 'send_sticker', args: { stickerId: bare } }];
  }

  // ② 函数调用写法：send_message(["a","b"]) / send_sticker("collected_1") / send_message({messages:[...]})
  const fnCall = cleaned.match(/^(send_message|send_sticker|send_image|search_images|finish)\s*\(([\s\S]*)\)$/);
  if (fnCall) {
    const name = fnCall[1];
    const inner = fnCall[2].trim();
    const parseLoose = (s) => {
      try { return JSON.parse(s); } catch { /* 继续宽松处理 */ }
      try { return JSON.parse(s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')); } catch { return null; }
    };
    const val = parseLoose(inner) ?? parseKwargs(inner);
    if (name === 'send_message') {
      const messages = Array.isArray(val) ? val.filter((x) => typeof x === 'string') : (val?.messages ? [].concat(val.messages).filter((x) => typeof x === 'string') : (typeof val === 'string' ? [val] : []));
      if (messages.length) {
        const args = { messages };
        // 关键字参数里可能还带着引用/点名，一并传下去（没有就不加）
        for (const k of ['replyToMessageId', 'atUserId']) {
          if (val && !Array.isArray(val) && val[k] !== undefined && val[k] !== null && val[k] !== '') args[k] = val[k];
        }
        return [{ name, args }];
      }
    } else if (name === 'send_sticker') {
      const id = typeof val === 'string' ? val : (val?.stickerId ?? val?.id ?? null);
      if (id) return [{ name, args: { stickerId: String(id) } }];
    } else if (name === 'send_image' && (val?.url || typeof val === 'string')) {
      return [{ name, args: { url: String(val?.url || val) } }];
    } else if (name === 'search_images' && (val?.query || typeof val === 'string')) {
      return [{ name, args: { query: String(val?.query || val) } }];
    } else if (name === 'finish') {
      return [{ name, args: typeof val === 'object' && val ? val : {} }];
    }
  }

  // ③ 纯数组写法：整段只由 [...] / 【...】 片段 + 标点/空白/多余括号组成。
  //    ⚠️ 多余的 ] } 可能出现在**中间**（实测 ["a"] ["b"]] [collected_x] 这种），
  //    所以判定不能只看结尾 —— 而是"把所有片段去掉、再去掉标点括号后，不许剩下词语"。
  const leftover = cleaned
    .replace(SEGMENT_STRIP_RE, '')
    // 孤立的 QQ 消息 id（6 位以上数字，可能带负号）：那是 replyToMessageId 的值漏出来了，
    // 不是要说的话 —— 只认"单独成段"的数字，正文里的数字（"2026年"）不会被动。
    .replace(/(?:^|[\s,，;；])\s*-?\d{6,}\s*(?=$|[\s,，;；])/g, '')
    .replace(/[\s,，;；、·"'“”’‘`}\]\[【】()（）]+/g, '');
  if (leftover) return null;    // 还有词语 → 是正常聊天文本，不要动它
  const messages = [];
  let stickerId = '';
  for (const m of cleaned.matchAll(SEGMENT_RE)) {
    const inner = m[1].trim();
    if (!inner) continue;
    // 「发个抱抱表情包卖萌」这种是"我要发表情"的意图描述，不是要说的话：丢掉
    if (isStickerIntent(inner)) continue;
    const single = inner.replace(/^["'“”]|["'“”]$/g, '').trim();
    // 单元素且长得像表情 id（collected_xxx / 1927…_0_0）→ 当发表情。
    // 要求：没有分隔符、中文为 0、带数字、长度够（避免把 hello_world 这种词吃掉）
    if (!/[，,、]/.test(inner) && looksLikeStickerId(single)) {
      stickerId = single;
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(`[${inner}]`); } catch { parsed = null; }
    const parts = Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === 'string')
      : inner.split(/\s*[,，、]\s*/).map((s) => s.replace(/^["'“”]|["'“”]$/g, '').trim());
    for (const s of parts) if (String(s).trim()) messages.push(String(s).trim());
  }
  const calls = [];
  if (messages.length) calls.push({ name: 'send_message', args: { messages } });
  if (stickerId) calls.push({ name: 'send_sticker', args: { stickerId } });
  return calls.length ? calls : null;
}

/**
 * send_message 参数兜底。
 *
 * 实测（2026-09-10 23:57，本地 4B）模型**确实调了工具**，但把整段数组文本塞进了参数：
 *   send_message({"messages":"[\"好嘞～\"] [\"初音嘛～\"] [collected_1979302071]"})
 * 正文解析（parseInlineLooseCalls）在这种情况下永远不会触发，所以必须在参数这一层再兜一次。
 *
 * 判定要比 parseInlineLooseCalls 更保守：send_message 的参数本来就是人话，
 * 误判会把正常消息拆烂。只有出现"这明显是数组字面量 / 表情 id / 语法碎片"的证据才动手：
 *   - 片段之外还残留 ] } 之类碎片（["a"] ["b"]] 这种）
 *   - 唯一的片段就是表情 id
 *   - 有片段是以引号开头的（["在呢～"]）—— 正常聊天几乎不会这么写
 * 单独一个 [图片] / [笑] 一律不动，交给占位符检查和正常发送。
 *
 * @returns {{ messages: string[], stickerId: string }|null}
 */
export function extractStickerAnnotation(text) {
  const ids = [];
  const message = String(text ?? '').replace(/[\[【]([^\[\]【】\n]*)[\]】]/g, (block, body) => {
    const match = body.match(/(?:^|\s)(?:stickerId|id)\s*[=:：]\s*([\w-]+)\s*$/i);
    if (!match || !looksLikeStickerId(match[1])) return block;
    ids.push(match[1]);
    return '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
  return ids.length ? { message, ids: [...new Set(ids)] } : null;
}

export function recoverLooseSend(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // ⓪ 草稿纸倾倒（实测 02:05，最凶的一种）：
  //    模型把"思考过程 + 刚看到的历史 + 完整 XML 调用块"整坨塞进 messages，一共 389 字，
  //    结果群里收到一大段带方括号的自言自语。识别标志：XML 工具语法或代码围栏。
  if (SCRATCHPAD_RE.test(raw)) {
    const salvaged = salvageScratchpad(raw);
    // 认得出是草稿纸却捞不出一句人话 → 交给上层报错，绝不把整坨倒进群里
    return salvaged || { messages: [], stickerId: '', scratchpad: true };
  }

  const segments = [...raw.matchAll(SEGMENT_RE)].map((m) => m[1].trim()).filter(Boolean);

  const outside = raw.replace(SEGMENT_STRIP_RE, '');
  const strayJunk = /[\]}】]/.test(outside)                   // 片段外还有多余的括号
    && outside.replace(/[\s,，;；、·"'“”’‘`\]\[【】()（）}]+/g, '') === '';
  const quoted = segments.some((s) => /^["'“”]/.test(s));
  const singleIsId = segments.length === 1 && looksLikeStickerId(segments[0]);
  const mixedBracket = MIXED_BRACKET_RE.test(raw);           // ["a"】 这种混搭 = 模型在手搓调用
  // 没有方括号时再救两种实测形态：参数整段就是表情 id、或整段是 send_message(...) 写法
  const bareId = !segments.length && looksLikeStickerId(raw.replace(/^["'“”]|["'“”]$/g, '').trim());
  const callText = /^(send_message|send_sticker)\s*\(/.test(raw);
  if (!strayJunk && !quoted && !singleIsId && !mixedBracket && !bareId && !callText) return null;

  const calls = parseInlineLooseCalls(raw);
  if (!calls?.length) return null;
  const messages = [];
  let stickerId = '';
  for (const call of calls) {
    if (call.name === 'send_message') {
      for (const t of [].concat(call.args.messages ?? [])) {
        const s = String(t).trim();
        if (s) messages.push(s);
      }
    } else if (call.name === 'send_sticker' && call.args.stickerId) {
      stickerId = String(call.args.stickerId);
    }
  }
  if (!messages.length && !stickerId) return null;
  return { messages, stickerId };
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
