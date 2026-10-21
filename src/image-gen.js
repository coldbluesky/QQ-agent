// 文生图（自建，不依赖插件）：OpenAI 兼容的 POST {baseUrl}/images/generations
//
// 为什么自建而不是装市场里的插件：
//   插件是"模型自己拼 prompt 再调工具"，外貌设定靠模型自觉压缩（实测 700 字人设
//   会被压成一句"蓝发鲸鱼娘"）。自建后角色形象存在配置里，由**代码**拼进 prompt，
//   模型只负责写镜头/动作/场景 —— 外貌不可能被它省略。
//
// 端点解析与语音输出（tts.js）同一套逐级回退：
//   baseUrl：imageGen.baseUrl → imageGen.provider 的 baseURL → 聊天模型 api.baseUrl
//   apiKey ：imageGen.apiKey  → imageGen.provider 的 Key → 当前聊天模型的 Key
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, DATA_DIR } from './config.js';
import { resolveApiKey } from './llm.js';
import { safeFetchBinary } from './safe-fetch.js';

export const IMAGE_DIR = path.join(DATA_DIR, 'images');

export const DEFAULT_IMAGE_SIZE = '1024x1024';

// 本地文件名（清理旧图时用来精确匹配，别误删同目录里的其他东西）
const IMAGE_NAME_RE = /^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/i;

const MAX_BYTES = 12 * 1024 * 1024;

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

/** 空串/掩码 = 未填，不算覆盖（测试按钮会把界面上未保存的值传进来）。 */
function applyOverrides(base, overrides) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s || s === '******') continue;
      out[k] = s;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 规范化绘图尺寸。
 *
 * 为什么要收口：尺寸会直接写进提示词、再由模型塞进工具参数，是自由文本。
 * 手滑成 "1024" / "big" 时生图接口可能 400，也可能静默出默认尺寸 ——
 * 统一在**发请求前**规范化，配置里允许存脏值（手改 JSON 不会把机器人搞挂）。
 */
export function normalizeImageSize(raw) {
  const m = String(raw ?? '')
    .trim()
    .replace(/[×*]/g, 'x')
    .toLowerCase()
    .match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  if (!m) return DEFAULT_IMAGE_SIZE;
  const w = Number(m[1]);
  const h = Number(m[2]);
  // 64 太小没有意义，8192 是主流生图接口的上限；越界一律回落，不做猜测式修正
  if (w < 64 || h < 64 || w > 8192 || h > 8192) return DEFAULT_IMAGE_SIZE;
  return `${w}x${h}`;
}

/** 解析实际生效的接口配置（与 voice 同口径）。 */
export function resolveImageEndpoint(overrides = {}) {
  const cfg = getConfig();
  const g = applyOverrides(cfg.imageGen, overrides);

  const pid = String(g.provider || '').trim();
  const provider = pid ? (cfg.providers || []).find((p) => p.id === pid) : null;

  let baseUrl = String(g.baseUrl || '').trim();
  let endpointFrom = 'imageGen.baseUrl';
  if (!baseUrl && provider?.baseURL) {
    baseUrl = String(provider.baseURL).trim();
    endpointFrom = `模型提供商 ${pid}`;
  }
  if (!baseUrl) {
    baseUrl = String(cfg.api?.baseUrl || '').trim();
    endpointFrom = '聊天模型 Base URL';
  }

  let apiKey = String(g.apiKey || '').trim();
  if (!apiKey && pid) {
    apiKey = String(cfg.dshProviderKeys?.[pid] || '').trim() || String(provider?.apiKey || '').trim();
  }
  if (!apiKey) apiKey = resolveApiKey(cfg);

  return {
    baseUrl,
    apiKey,
    endpointFrom,
    model: String(g.model || '').trim(),
    size: normalizeImageSize(g.size),
    count: Math.min(4, Math.max(1, Number(g.count) || 1)),
    quality: String(g.quality || '').trim(),
    style: String(g.style || '').trim(),
    responseFormat: String(g.responseFormat || '').trim(),
    timeoutMs: Math.max(10000, Number(g.timeoutMs) || 120000),
    characterPrompt: String(g.characterPrompt || '').trim(),
    keepFiles: Number.isFinite(Number(g.keepFiles)) ? Math.floor(Number(g.keepFiles)) : 50
  };
}

/** 当前配置是否"真的能出图"。缺字段时 orchestrator 不会把 draw_image 交给模型。 */
export function imageGenReady() {
  const ep = resolveImageEndpoint();
  const missing = [];
  if (!ep.model) missing.push('绘图模型');
  if (!ep.baseUrl) missing.push('接口地址');
  if (!ep.apiKey) missing.push('API Key');
  return { ok: missing.length === 0, missing, model: ep.model };
}

/**
 * 拼最终 prompt。
 *
 * self=true 时把配置里的【形象设定】原样垫在前面 —— 这是"角色不会走形"的唯一
 * 保险：模型只写镜头/动作/场景，外貌由代码补，它没有机会概括成"蓝发鲸鱼娘"。
 */
export function composeImagePrompt({ prompt, self = false, characterPrompt = '' } = {}) {
  const body = String(prompt ?? '').trim();
  const char = String(characterPrompt ?? '').trim();
  if (!self || !char) return body;
  // 外貌在前、场景在后：多数生图模型对前置描述权重更高
  return `${char}\n\n${body}`;
}

/** 构造请求体（导出给单测；字段名按 OpenAI 兼容口径）。 */
export function buildImageRequestBody({ model, prompt, size, count = 1, quality = '', style = '', responseFormat = '' } = {}) {
  const body = {
    model,
    prompt,
    size: normalizeImageSize(size),
    n: Math.min(4, Math.max(1, Number(count) || 1))
  };
  // 只有用户显式配了才发：部分中转站对未知字段直接 400
  if (quality) body.quality = quality;
  if (style) body.style = style;
  if (responseFormat) body.response_format = responseFormat;
  return body;
}

/** 从响应里取图（b64_json 优先，其次 url）。导出给单测。 */
export function extractImagePayloads(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  return list
    .map((item) => {
      if (item?.b64_json) return { b64: String(item.b64_json) };
      if (item?.url) return { url: String(item.url) };
      return null;
    })
    .filter(Boolean);
}

function mimeToExt(mime) {
  if (/png/i.test(mime)) return 'png';
  if (/webp/i.test(mime)) return 'webp';
  return 'jpg';
}

function mimeFromMagic(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** 按保留个数清理旧图（keepFiles<=0 = 不限制）。 */
export function pruneImageFiles(keepRaw) {
  const keep = Number(keepRaw);
  const limit = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0;
  if (!limit) return;
  try {
    const entries = fs.readdirSync(IMAGE_DIR)
      .filter((name) => IMAGE_NAME_RE.test(name))
      .map((name) => {
        const full = path.join(IMAGE_DIR, name);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(limit)) {
      try { fs.unlinkSync(entry.full); } catch { /* 被占用就下次再清 */ }
    }
  } catch { /* 清理失败不影响出图 */ }
}

/** 把图片写进 data/images/，返回绝对路径。 */
export function saveImageFile(buffer, mime = 'image/png') {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${mimeToExt(mime)}`;
  const file = path.join(IMAGE_DIR, name);
  fs.writeFileSync(file, buffer);
  pruneImageFiles(getConfig().imageGen?.keepFiles);
  return file;
}

/**
 * 调一次生图接口，返回已落盘的图片。
 * 抛错时错误信息要能直接给用户看（设置页测试按钮会原样显示）。
 */
export async function generateImage({ prompt, self = false, size, count, overrides = {} } = {}) {
  const ep = resolveImageEndpoint(overrides);
  if (!ep.model) throw new Error('未配置绘图模型（设置 → 图片 / 视频 → 绘图模型）');
  if (!ep.baseUrl) throw new Error('未配置绘图接口地址（设置 → 图片 / 视频）');

  const finalPrompt = composeImagePrompt({ prompt, self, characterPrompt: ep.characterPrompt });
  if (!finalPrompt) throw new Error('绘图内容为空');

  const url = joinUrl(ep.baseUrl, '/images/generations');
  const body = buildImageRequestBody({
    model: ep.model,
    prompt: finalPrompt,
    size: normalizeImageSize(size || ep.size),
    count: count || ep.count,
    quality: ep.quality,
    style: ep.style,
    responseFormat: ep.responseFormat
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ep.timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时（${Math.round(ep.timeoutMs / 1000)}s）` : String(error?.message ?? error);
    throw new Error(`绘图请求失败：${reason}（${url}）`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 401/404 是最常见的两类：错的 Key、错的路径（忘了 /v1 或重复拼端点）
    let pretty = text.slice(0, 400) || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      pretty = j?.error?.message || j?.message || pretty;
    } catch { /* 非 JSON 就原样给 */ }
    const hint = res.status === 401
      ? '（Key 无效或没权限）'
      : res.status === 404
        ? '（接口路径不对：Base URL 应填到 /v1 为止，程序会自动拼 /images/generations）'
        : '';
    throw new Error(`绘图接口 HTTP ${res.status}${hint}：${pretty}`);
  }

  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error('绘图接口返回的不是 JSON（可能是网关错误页）');
  }

  const payloads = extractImagePayloads(json);
  if (!payloads.length) {
    const note = json?.error?.message || json?.message || '响应里没有图片数据';
    throw new Error(`绘图接口未返回图片：${note}`);
  }

  const images = [];
  for (const p of payloads) {
    let buffer;
    let mime = 'image/png';
    if (p.b64) {
      // 有些厂商给的是带前缀的 data URL
      const raw = p.b64.includes(',') && p.b64.startsWith('data:') ? p.b64.slice(p.b64.indexOf(',') + 1) : p.b64;
      buffer = Buffer.from(raw, 'base64');
    } else {
      const got = await safeFetchBinary(p.url, MAX_BYTES);
      buffer = got.buffer;
      mime = mimeFromMagic(buffer) || String(got.contentType || 'image/png').split(';')[0];
    }
    if (!buffer?.length) throw new Error('绘图接口返回的图片是空的');
    if (!p.b64) mime = mimeFromMagic(buffer) || mime;
    const file = saveImageFile(buffer, mime);
    images.push({ file, name: path.basename(file), bytes: buffer.length, mime });
  }

  return {
    images,
    model: ep.model,
    size: body.size,
    prompt: finalPrompt,
    shotPrompt: String(prompt ?? '').trim(),
    endpointFrom: ep.endpointFrom
  };
}

/** 控制台「测试出图」：不抛错，回一张 data URL 让页面直接预览。 */
export async function testImageGen({ prompt = '手机自拍视角，窗边，光线偏亮', self = false, size = '', overrides = {} } = {}) {
  const startedAt = Date.now();
  try {
    const result = await generateImage({ prompt, self, size: size || undefined, overrides });
    const first = result.images[0];
    const buffer = fs.readFileSync(first.file);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      file: first.name,
      bytes: first.bytes,
      mime: first.mime,
      size: result.size,
      model: result.model,
      endpointFrom: result.endpointFrom,
      preview: `data:${first.mime};base64,${buffer.toString('base64')}`
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, note: String(error?.message ?? error) };
  }
}
