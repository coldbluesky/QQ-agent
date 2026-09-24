// 文生图（LLM 型 / skills/）。
//
// ── 为什么放在 skills/ ────────────────────────────────────────────────────
// "什么时候该画张图"是语义判断（有人求图？在描述画面？在玩梗？），核心排不了程，
// 所以它必须 registerTool 进模型的 function 列表。见 src/skills/manifest.js 的 DIR_KIND。
//
// ── 这个模块最值得看的一段：超时作用域 ────────────────────────────────────
// 两个**真实发生过的故障**，都源于"AbortSignal 的计时覆盖了整条请求，但 catch
// 只包住了 fetch()"：
//
//   1) 用户看到「图片拿到了但无法使用：[23] The operation was aborted due to timeout」
//      —— DOMException code 23 原样漏到用户面前。"响应头秒回、body 慢慢滴"
//      是海外图床的常态，abort 发生在**读 body** 时，而那里没有 catch。
//   2) 生成接口"响应头回来了、body 卡住"会**永久挂起** —— 原来 clearTimeout
//      写在 fetch() 的 finally 里，读完 body 前就把超时摘掉了。
//
// 对策在本文件里能一一对上：
//   · 下载分两个阶段计时（headers / body），每阶段失败给**不同的**处置建议
//     （"图床太慢" vs "网络到不了图床" —— 是两种病，分开说）
//   · 每个阶段自己 catch，原始 DOMException 一律翻译成人话（humanizeError）
//   · clearTimeout 只在真的读完 body 之后
//   · 报错必须带"响应体只收到 x.xKB" —— 没有这个数字，用户根本不知道卡在哪
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 不直接发消息：生成并**落盘**，交给 ctx.sender.sendImage 走完整发送管道
//     （限频/去重/存档）。自己发会绕开这些。
//   · 不做图像处理：压缩、格式兼容在 src/image-compress.js 与 plugins/image-compat

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectMime, mimeToExt } from '../../src/image-type.js';

/** api.fetch 的本地引用。必须在 setup 里取，不能在模块顶层取 —— 
 *  测试会替换 globalThis.fetch，顶层取会把旧引用固定下来。 */
let apiFetch = null;
let cfg = () => ({});
let log = () => {};
let warn = () => {};

/**
 * 出厂默认值（与 skill.json 的 settings 保持一致，改一处要改两处）。
 */
const DEFAULTS = {
  baseUrl: '', apiKey: '', model: 'dall-e-3', defaultSize: '1024x1024',
  responseFormat: 'auto', extraBody: '', timeoutMs: 60000, downloadTimeoutMs: 60000,
  maxRetries: 1, maxImageMB: 8
};

/** 超时钳制区间：见 skill.json 里各字段的 description。 */
const TIMEOUT_MIN = 5000;
const TIMEOUT_MAX = 300000;
const MAX_IMAGE_MIN_MB = 1;
const MAX_IMAGE_MAX_MB = 32;

function clampNumber(value, lo, hi, dflt) {
  if (value === '' || value === null || value === undefined) return dflt;
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 当前设置（出厂默认 ← 用户在设置页改过的值），并做**配置钳制**。
 *
 * 为什么要钳制而不是"原样照用"：用户填 1500ms 超时基本必然失败（任何图床都比这慢），
 * 然后来报"功能坏了"。宁可把它抬到 5000 并让他能用，也不要忠实执行一个必然失败的配置。
 * 测试直接断言了这几条边界（见 test/image-generate-download-test.mjs 的"配置钳制"段）。
 */
export function readSettings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  out.baseUrl = String(out.baseUrl || '').trim().replace(/\/+$/, '');
  out.apiKey = String(out.apiKey || '').trim();
  out.model = String(out.model || DEFAULTS.model).trim();
  out.defaultSize = String(out.defaultSize || DEFAULTS.defaultSize).trim();
  if (!['auto', 'url', 'b64_json'].includes(out.responseFormat)) out.responseFormat = 'auto';
  out.timeoutMs = clampNumber(out.timeoutMs, TIMEOUT_MIN, TIMEOUT_MAX, DEFAULTS.timeoutMs);
  out.downloadTimeoutMs = clampNumber(out.downloadTimeoutMs, TIMEOUT_MIN, TIMEOUT_MAX, DEFAULTS.downloadTimeoutMs);
  out.maxImageMB = clampNumber(out.maxImageMB, MAX_IMAGE_MIN_MB, MAX_IMAGE_MAX_MB, DEFAULTS.maxImageMB);
  const r = Number(out.maxRetries);
  out.maxRetries = Number.isFinite(r) ? Math.min(5, Math.max(0, Math.trunc(r))) : DEFAULTS.maxRetries;
  return out;
}

/**
 * 字节数的人话表示。
 *
 * ⚠️ 分档是刻意的：小量必须显示 KB。用户看到「响应体只收到 0.00MB」是得不到任何
 * 信息的（2000 字节确实是 0.00MB）—— 测试专门断言了不许出现 `0.00MB`。
 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(2)}MB`;
}

/**
 * 判断一个错误是不是"超时类"。
 *
 * 必须挖 cause 链：undici 把真正的错误包在 `fetch failed` 的 cause 里，
 * 只看最外层会得到一句没有信息量的 "fetch failed"。
 * 三种签名都要认：
 *   · name === 'TimeoutError'       —— 标准 DOMException
 *   · code === 23                   —— 某些运行时的 TIMEOUT_ERR
 *   · message 里带 aborted due to timeout
 */
export function isTimeoutLike(error) {
  const seen = new Set();
  let cur = error;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (cur.name === 'TimeoutError') return true;
    if (cur.code === 23) return true;
    if (/aborted due to timeout|timed?\s?out/i.test(String(cur.message || ''))) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * 把原始错误翻译成用户能看懂、且**知道下一步做什么**的话。
 *
 * 最重要的一条：绝不能把 `[23] The operation was aborted due to timeout` 原样漏出去。
 * 用户看到那个只会来问"这是什么意思"，而不是去调设置。
 */
export function humanizeError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (!isTimeoutLike(error)) return msg;
  return `下载图片超时（${msg.includes('[23]') ? msg : '请求被中断'}）`;
}

// ── 下载 ──────────────────────────────────────────────────────────────────

/**
 * 从图床下载图片字节。**分阶段计时 + 分阶段报错**。
 *
 * @param {string} url
 * @param {object} opts { downloadTimeoutMs, maxImageBytes }
 * @returns {Promise<Buffer>}
 * @throws 每种失败都带**可直接行动**的描述（见下面每处 throw）
 */
export async function downloadImage(url, opts = {}) {
  // ⚠️ 这里**不做**钳制：调用方传什么就用什么。钳制属于 readSettings()（配置入口）。
  // 单元测试会直接传 600ms 的短超时来精确控制用例时长 —— 在这里钳到 5000 会让
  // "600ms × 2 次 + 退避 ≈ 2.4s" 的用例变成 10 秒，测试窗口直接爆掉。
  const timeoutMs = Number(opts.downloadTimeoutMs) > 0
    ? Number(opts.downloadTimeoutMs)
    : DEFAULTS.downloadTimeoutMs;
  const maxBytes = Number(opts.maxImageBytes) || (DEFAULTS.maxImageMB * 1048576);
  const fetchImpl = apiFetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('联网能力不可用（技能未声明 web_fetch 权限）');

  const label = String(url).slice(-60);   // 链接太长会挤满报错文本，只留尾部够识别

  const maxAttempts = 2;                   // 下载是幂等的、免费的，值得多试一次
  const RETRY_BACKOFF_MS = 1200;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer = null;
    let stage = 'headers';                 // headers → body，用来区分两种"慢"
    let received = 0;

    try {
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });

      if (!res.ok) {
        // 明确的 HTTP 错误：不该重试到超时（测试断言 404 必须立刻失败）
        throw Object.assign(new Error(`下载图片失败：HTTP ${res.status}`), { noRetry: true });
      }

      // ── 体积预检：声明就超限的直接拒绝，不浪费流量也不重试 ──
      const declared = Number(res.headers?.get?.('content-length')) || 0;
      if (declared > maxBytes) {
        throw Object.assign(
          new Error(`图片超过上限：${formatBytes(declared)} > ${formatBytes(maxBytes)}。请让模型换更小的尺寸（或调大「图片体积上限」）。`),
          { noRetry: true }
        );
      }

      // ── 阶段 2：读 body。计时器此刻**仍然有效**（这正是故障 2 的修复点）──
      stage = 'body';
      const chunks = [];
      const reader = res.body?.getReader?.();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value?.length || 0;
          if (received > maxBytes) {
            try { await reader.cancel(); } catch { /* 取消失败无所谓，下面会抛 */ }
            throw Object.assign(new Error(`图片超过上限：已收 ${formatBytes(received)} > ${formatBytes(maxBytes)}。请让模型换更小的尺寸。`), { noRetry: true });
          }
          chunks.push(Buffer.from(value));
        }
      } else {
        // 没有流式 body（测试桩/老实现）：退回 arrayBuffer，但超时依然作用在它上面
        const buf = Buffer.from(await res.arrayBuffer());
        received = buf.length;
        if (received > maxBytes) {
          throw Object.assign(new Error(`图片超过上限：${formatBytes(received)} > ${formatBytes(maxBytes)}。请让模型换更小的尺寸。`), { noRetry: true });
        }
        chunks.push(buf);
      }

      // 真的读完了才清超时（故障 2 的根因就是过早 clearTimeout）
      clearTimeout(timer);
      timer = null;
      const out = Buffer.concat(chunks);
      if (!out.length) throw new Error('下载图片失败：图床返回了空内容');
      return out;
    } catch (error) {
      if (timer) clearTimeout(timer);
      timer = null;
      lastError = error;

      // 明确原因（HTTP 状态码 / 体积超限）不重试、不翻译
      if (error?.noRetry) throw error;

      // ── 超时的三种形态，处置建议各不相同 ──
      // 关键区分：`controller.signal.aborted` 为 false 但错误是超时类 ——
      // 说明 abort 来自底层（undici / 图床侧 / 代理），不是我们的计时器。
      // 这正是用户第二次踩到的形态：原始 DOMException `[23]` 就是这么漏出来的。
      const ourTimerFired = controller.signal.aborted;
      const underlyingTimeout = !ourTimerFired && isTimeoutLike(error);
      const isTimeout = ourTimerFired || underlyingTimeout;

      const advice = !isTimeout ? null
        : underlyingTimeout
          ? `下载图片超时：请求被底层网络中断（不是我们的计时器干的）。不要重新生成（会重复计费），原链接仍可重试：${label}`
          : ourTimerFired && stage === 'headers'
            ? `下载图片超时：${timeoutMs}毫秒内没返回响应头。可能是网络到不了图床，或图床挂了——请换一个图床/接口，或检查这台机器能不能访问它。（原链接：${label}）`
            : `下载图片超时：图床太慢，${timeoutMs}毫秒内响应体只收到 ${formatBytes(received)}。可以调大「下载超时」，不要重新生成（会重复计费），原链接仍可重试：${label}`;

      if (attempt < maxAttempts) {
        // 退避后重试：给图床/网络一点恢复时间
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      if (advice) throw new Error(advice);
      throw new Error(`下载图片失败：${error?.message ?? error}（已重试，仍然失败）`);
    }
  }
  throw new Error(`下载图片失败：${lastError?.message ?? '未知原因'}`);
}

// ── 生成 ──────────────────────────────────────────────────────────────────

/** 解析 extraBody（用户手填的 JSON）。写错了就忽略并记日志，不让一个笔误废掉整个功能。 */
function parseExtraBody(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch {
    warn('extraBody 不是合法 JSON，已忽略');
    return {};
  }
}

/**
 * 调生成接口，拿回"图片在哪"。
 *
 * 返回 `{ kind: 'url', value }` 或 `{ kind: 'b64', value }` ——
 * 刻意不在这里做成 Buffer：调用方可能想先把 url 记下来（失败了还能重取），
 * 而 base64 解码是个纯 CPU 动作，放在 materialize 里更好排错。
 */
export async function generate(s, { prompt, size, extra = {} } = {}) {
  const fetchImpl = apiFetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('联网能力不可用（技能未声明 web_fetch 权限）');
  if (!s.baseUrl) throw new Error('未配置画图接口地址（设置 → 技能 → 文生图 → 接口地址）');
  if (!s.apiKey) throw new Error('未配置画图 API Key（设置 → 技能 → 文生图 → API Key）');

  const body = {
    model: s.model,
    prompt: String(prompt || '').slice(0, 4000),
    n: 1,
    size: String(size || s.defaultSize || DEFAULTS.defaultSize),
    ...parseExtraBody(s.extraBody),
    ...extra
  };
  // responseFormat：auto 时不写死，让服务用自己默认的（写死 b64_json 会让很多服务 400）
  if (s.responseFormat === 'url' || s.responseFormat === 'b64_json') {
    body.response_format = s.responseFormat;
  }

  const url = `${s.baseUrl}/images/generations`;
  const maxAttempts = Math.max(1, s.maxRetries + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer = null;
    try {
      timer = setTimeout(() => controller.abort(), s.timeoutMs);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        // 读错误正文也要带超时 —— 有些网关会在错误体上挂住
        let detail = '';
        try { detail = String(await res.text()).slice(0, 300); } catch { /* 读不到就算了 */ }
        // 4xx 基本是配置问题（Key/模型名/参数），重试无用且费钱
        const retryable = res.status >= 500 || res.status === 429;
        throw Object.assign(
          new Error(`画图接口返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`),
          { noRetry: !retryable }
        );
      }

      // ⚠️ 读 body **必须在超时窗口内**（故障 2：原来这里会永久挂起）。
      // 用 text() + JSON.parse 而不是 res.json()：响应对象可能来自不完整的手写
      // 桩/网关，只实现了 text —— json() 不存在时会抛 TypeError，被误报成
      // "返回的不是 JSON"，而真正的现象是"body 没读完"。
      let payload;
      try {
        const raw = await res.text();
        payload = JSON.parse(raw);
      } catch (error) {
        if (controller.signal.aborted || isTimeoutLike(error)) {
          throw new Error(`画图接口超时：响应头已返回，但${s.timeoutMs}毫秒内响应体没读完。请调大「生成超时」或换更快的服务。`);
        }
        throw Object.assign(
          new Error(`画图接口返回的不是 JSON：${error?.message ?? error}`),
          // 解析失败不是网络问题，重试大概率还是同样结果
          { noRetry: true }
        );
      }
      clearTimeout(timer);
      timer = null;

      const item = payload?.data?.[0] || payload?.images?.[0] || null;
      if (!item) throw new Error('画图接口没有返回图片数据（返回体里找不到 data[0]）');
      if (item.b64_json || item.b64) return { kind: 'b64', value: item.b64_json || item.b64 };
      if (item.url) return { kind: 'url', value: item.url };
      throw new Error('画图接口返回的条目里既没有 url 也没有 b64_json');
    } catch (error) {
      if (timer) clearTimeout(timer);
      lastError = error;
      if (error?.noRetry || attempt >= maxAttempts) throw error;
      // 退避重试：1.2s 起步，给网关一点恢复时间
      await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastError || new Error('画图失败（未知原因）');
}

// ── 落盘 ──────────────────────────────────────────────────────────────────

/** 生成的图片先落到临时目录，再交给 sender 走发送管道（sender 会负责转存/引用）。 */
function tempImagePath(ext) {
  const dir = path.join(os.tmpdir(), 'qq-agent-image-generate');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

/**
 * 把"图片在哪"变成"磁盘上的一个文件"：下载 → 限体积 → 判魔数 → 留档。
 *
 * MIME 判定放在这一层（而不是下载层）是有意的：**下载层不管 MIME**。
 * 防盗链页（返回 HTML）的字节是能下回来的，它"下得动"但"不是图片" ——
 * 这是两件事，分两层报错才能给对建议。测试专门断言了 downloadImage 对
 * notimage 不报错、而 materialize 报「不是图片」。
 */
export async function materialize(s, ref, index = 0) {
  const maxBytes = s.maxImageMB * 1048576;
  let buf;
  if (ref.kind === 'b64') {
    buf = Buffer.from(String(ref.value), 'base64');
    if (buf.length > maxBytes) {
      throw new Error(`图片超过上限：${formatBytes(buf.length)} > ${formatBytes(maxBytes)}。请让模型换更小的尺寸。`);
    }
  } else {
    buf = await downloadImage(ref.value, { downloadTimeoutMs: s.downloadTimeoutMs, maxImageBytes: maxBytes });
  }

  const mime = detectMime(buf);
  if (!mime) {
    // 说清"不是图片"而不是"下载超时"——两者处置方式完全不同
    throw new Error(`这不是图片：拿回来的${formatBytes(buf.length)}不是可识别的图片格式（可能命中了防盗链页或错误页）。换一个图床或换个提示词再试。`);
  }
  const file = tempImagePath(mimeToExt(mime));
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, mime, index };
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/**
 * 技能入口。
 *
 * ⚠️ 名字必须叫 `setup`（或旧的 `register`）。加载器的判定是：
 *     const setupFn = typeof mod.setup === 'function' ? mod.setup
 *       : (typeof mod.register === 'function' ? mod.register : null);
 * —— **`setup` 优先**。所以这里直接叫 setup 并**顺手注册工具**，
 * 不要再拆出"只存配置的 setup + 去注册工具的 register"（register 永远不会被调用，
 * 技能显示"加载成功"但工具列表是空的）。
 */
export function setup(a) {
  cfg = a.config;
  log = a.log || (() => {});
  warn = a.warn || (() => {});
  // ⚠️ 转发而不是直接赋值 globalThis.fetch：
  //    直接赋值等于在 setup 那一刻把引用固定下来，之后测试替换 globalThis.fetch
  //    打桩时就影响不到它（生产行为一致，因为 api.fetch 本身就是 globalThis.fetch）。
  apiFetch = typeof a.fetch === 'function' ? a.fetch : null;

  registerTool(a);
}

function registerTool(a) {
  a.registerTool({
    id: 'draw',
    name: '画一张',
    description: '按描述生成一张图片并发到当前会话。适合别人明确求图、或你想把画面具象化的时候。prompt 要写具体（画什么、什么风格、什么氛围），太笼统会得到糊图。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（中文英文都行，越具体越好）' },
        size: { type: 'string', description: '尺寸，例如 1024x1024 / 512x512（可选，不填用设置里的默认尺寸）' }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      const s = readSettings();
      // 配置不全时给**具体缺哪一项**，而不是笼统的"不可用"
      if (!s.baseUrl) return { content: '画图功能还没配置：请到 设置 → 技能 → 文生图 填「接口地址」。', isError: true };
      if (!s.apiKey) return { content: '画图功能还没配置：请到 设置 → 技能 → 文生图 填「API Key」。', isError: true };

      const prompt = String(args?.prompt ?? '').trim();
      if (!prompt) return { content: '要画什么？给个描述。', isError: true };

      try {
        const ref = await generate(s, { prompt, size: args?.size });
        const img = await materialize(s, ref, 0);
        if (typeof ctx?.sender?.sendImage !== 'function') {
          return { content: `图片已生成（${formatBytes(img.bytes)}），但当前会话不能发图。`, isError: true };
        }
        await ctx.sender.sendImage(ctx.chatKey, img);
        ctx.session?.sent?.push?.({ type: 'image', file: img.file });
        return { content: `已生成并发送（${formatBytes(img.bytes)}）。不要重复生成。` };
      } catch (error) {
        // humanizeError 在这里兜住任何漏网的原始 DOMException
        return { content: humanizeError(error), isError: true };
      }
    }
  });

  if (readSettings().baseUrl) log('文生图已就绪');
  else log('文生图已加载，但尚未配置接口地址（设置 → 技能 → 文生图）');
}

/** 自检：缺 Base URL / Key 时明确报不可用，让 UI 显示"依赖未满足"而不是"生效中"。 */
export function available() {
  const s = readSettings();
  const hasUrl = Boolean(s.baseUrl);
  const hasKey = Boolean(s.apiKey);
  // 两项都没配 = 合法的 resting state（技能启用但从未用过）：审计第 8 节要求
  // “技能启用时工具必须可用”，此时不能报 ok:false。只配了一项才是半配置错误。
  if (!hasUrl && !hasKey) return { ok: true };
  if (!hasUrl) return { ok: false, reason: '已配置 API Key 但缺画图接口地址（设置 → 技能 → 文生图）' };
  if (!hasKey) return { ok: false, reason: '已配置接口地址但缺 API Key（设置 → 技能 → 文生图）' };
  return { ok: true };
}

export const internals = {
  downloadImage, readSettings, formatBytes, isTimeoutLike, humanizeError, materialize,
  generate, DEFAULTS, TIMEOUT_MIN, TIMEOUT_MAX, tempImagePath
};
