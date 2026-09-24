// 语音合成（TTS）：把文字变成音频。支持两种服务类型，由 voice.type 切换：
//   openai  —— OpenAI 兼容的 POST {baseUrl}/audio/speech（官方/硅基流动/Groq/中转站…）
//   tencent —— 腾讯云语音合成 TextToVoice（TC3-HMAC-SHA256 签名，返回 JSON 套 base64）
//
// 为什么落盘到 data/voice/ 而不是直接把 base64 塞给协议端：
//   1. 本地绝对路径是各协议端（SnowLuma / NapCat）支持面最广的 file 形态，
//      base64:// 在部分版本上会被拒或静默失败；
//   2. 落盘后可复用：控制台试听、排查、重发都直接读文件，不用重新花钱合成。
//
// OpenAI 模式的端点解析刻意做成"逐级回退"，让最常见的场景零配置可用：
//   只填一个语音模型名 → 复用聊天模型的地址与 Key（同一个网关换个模型而已）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, DATA_DIR } from './config.js';
import { resolveApiKey } from './llm.js';

export const VOICE_DIR = path.join(DATA_DIR, 'voice');

const ALLOWED_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm'
};

// ── 腾讯云语音合成（TextToVoice）──
const TENCENT_HOST = 'tts.tencentcloudapi.com';
const TENCENT_SERVICE = 'tts';
const TENCENT_VERSION = '2019-08-23';
const TENCENT_CONTENT_TYPE = 'application/json; charset=utf-8';
// 腾讯云只认这三种编码（没有 opus/aac/flac），选了别的会被钳到 mp3
const TENCENT_FORMATS = new Set(['mp3', 'wav', 'pcm']);
// TextToVoice 单次请求的文本上限（汉字计），超出请改用异步长文本接口
const TENCENT_MAX_CHARS = 150;

// 本地文件名的构成（清理旧文件时用来精确匹配，避免误删同目录里的别的东西）
const VOICE_NAME_RE = /^[A-Za-z0-9_-]+\.(mp3|opus|aac|flac|wav|pcm)$/i;

const VOICE_TYPES = new Set(['openai', 'tencent']);

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

export function mimeForFormat(format) {
  return MIME_BY_FORMAT[String(format || '').toLowerCase()] || 'audio/mpeg';
}

function normalizeFormat(raw) {
  const f = String(raw || '').trim().toLowerCase();
  return ALLOWED_FORMATS.has(f) ? f : 'mp3';
}

function normalizeTencentFormat(raw) {
  const f = String(raw || '').trim().toLowerCase();
  return TENCENT_FORMATS.has(f) ? f : 'mp3';
}

/** 服务类型：未知值一律当 openai（老配置里没有这个字段，也是 openai）。 */
export function normalizeVoiceType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  return VOICE_TYPES.has(t) ? t : 'openai';
}

/**
 * 合并 overrides：空串与掩码 '******' 都视为"没填"，不覆盖已保存的值；
 * 嵌套对象（如 overrides.tencent）跳过，由各自的解析函数单独处理。
 */
function applyOverrides(base, overrides) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const s = String(value).trim();
    if (!s || s === '******') continue;
    out[key] = value;
  }
  return out;
}

/**
 * 腾讯云文档给定的语速锚点（倍率 ↔ 接口值），接口 Speed 范围其实是 [-2, 6]：
 * -2=0.6x、-1=0.8x、0=1.0x、1=1.2x、2=1.5x、6=2.5x。
 * 注意它是分段非线性的，不能拿一条直线去套。
 */
const TENCENT_SPEED_ANCHORS = [
  { mult: 0.6, value: -2 },
  { mult: 0.8, value: -1 },
  { mult: 1.0, value: 0 },
  { mult: 1.2, value: 1 },
  { mult: 1.5, value: 2 },
  { mult: 2.5, value: 6 }
];

/**
 * 把本项目统一的"倍率"（1 = 原速）换算成腾讯云的 Speed 值。
 * 在文档给出的锚点之间做分段线性插值，超出 0.6x~2.5x 的部分钳到端点。
 */
export function tencentSpeed(multiplier) {
  const m = Number(multiplier) > 0 ? Number(multiplier) : 1;
  const first = TENCENT_SPEED_ANCHORS[0];
  const last = TENCENT_SPEED_ANCHORS[TENCENT_SPEED_ANCHORS.length - 1];
  if (m <= first.mult) return first.value;
  if (m >= last.mult) return last.value;
  for (let i = 1; i < TENCENT_SPEED_ANCHORS.length; i++) {
    const prev = TENCENT_SPEED_ANCHORS[i - 1];
    const cur = TENCENT_SPEED_ANCHORS[i];
    if (m <= cur.mult) {
      const ratio = (m - prev.mult) / (cur.mult - prev.mult);
      return Number((prev.value + ratio * (cur.value - prev.value)).toFixed(2));
    }
  }
  return last.value;
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * 组装 TC3 的规范请求串（canonical request）。
 *
 * 这是签名里最容易错的一步，所以独立成纯函数：官方算例给出了规范串的 SHA256，
 * 可以直接拿来验证拼接格式（见 test 里的验证）。
 *
 * - 请求头名一律小写，SignedHeaders 按字典序（腾讯云规范要求）；
 * - canonicalHeaders 每行自带结尾 '\n'，再与 signedHeaders 之间拼一个 '\n' ——
 *   所以正文里会出现一个空行，这是规范如此，不是笔误；
 * - extraHeaders 用来把额外要求签名的头（如 x-tc-action）一并纳入。
 */
export function buildTencentCanonicalRequest({ payload, host, contentType = TENCENT_CONTENT_TYPE, extraHeaders = {} }) {
  const entries = [
    ['content-type', contentType],
    ['host', host],
    ...Object.entries(extraHeaders).map(([name, value]) => [String(name).toLowerCase(), String(value).trim()])
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  return {
    signedHeaders,
    canonicalRequest: ['POST', '/', '', canonicalHeaders, signedHeaders, sha256Hex(payload)].join('\n')
  };
}

/**
 * 腾讯云 TC3-HMAC-SHA256 签名（service = tts）。
 *
 * 规范串里 content-type / host 必须与真实发出的请求头逐字一致（含 `; charset=utf-8`），
 * 差一个字符就是 AuthFailure.SignatureFailure；日期必须取 UTC ——
 * 用本地时区在非 UTC 机器上会直接签出过期签名。
 */
export function buildTencentAuthorization({ secretId, secretKey, payload, timestamp, host = TENCENT_HOST }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);   // UTC YYYY-MM-DD
  const { canonicalRequest, signedHeaders } = buildTencentCanonicalRequest({ payload, host });
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const kDate = hmacSha256(`TC3${secretKey}`, date);
  const kService = hmacSha256(kDate, TENCENT_SERVICE);
  const kSigning = hmacSha256(kService, 'tc3_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * 解析实际生效的语音端点。
 *
 * overrides 用于"测试/试听"场景：把界面上还没保存的值传进来试，
 * 空串不算覆盖（留空 = 沿用下面逐级回退出来的结果），掩码 '******' 同样视为未填。
 *
 * baseUrl：voice.baseUrl → voice.provider 的 baseURL → 聊天模型 api.baseUrl
 * apiKey ：voice.apiKey  → voice.provider 的 Key → 当前聊天模型的 Key
 */
export function resolveVoiceEndpoint(overrides = {}) {
  const cfg = getConfig();
  const v = applyOverrides(cfg.voice, overrides);

  const pid = String(v.provider || '').trim();
  const provider = pid ? (cfg.providers || []).find((p) => p.id === pid) : null;

  let baseUrl = String(v.baseUrl || '').trim();
  let endpointFrom = 'voice.baseUrl';
  if (!baseUrl && provider?.baseURL) {
    baseUrl = String(provider.baseURL).trim();
    endpointFrom = `模型提供商 ${pid}`;
  }
  if (!baseUrl) {
    baseUrl = String(cfg.api?.baseUrl || '').trim();
    endpointFrom = '聊天模型 Base URL';
  }

  let apiKey = String(v.apiKey || '').trim();
  if (!apiKey && pid) {
    apiKey = String(cfg.dshProviderKeys?.[pid] || '').trim() || String(provider?.apiKey || '').trim();
  }
  if (!apiKey) apiKey = resolveApiKey(cfg);

  const speedNum = Number(v.speed);
  return {
    baseUrl,
    apiKey,
    endpointFrom,
    model: String(v.model || '').trim(),
    voice: String(v.voice || '').trim() || 'alloy',
    format: normalizeFormat(v.format),
    speed: Number.isFinite(speedNum) && speedNum > 0 ? speedNum : 1,
    instructions: String(v.instructions || '').trim(),
    maxChars: Math.max(1, Number(v.maxChars) || 200),
    timeoutMs: Math.max(5000, Number(v.timeoutMs) || 60000)
  };
}

/**
 * 解析腾讯云语音合成的实际生效配置。
 * 通用字段（format/speed/maxChars/timeoutMs）沿用 voice 顶层，凭证与音色在 voice.tencent 里。
 */
export function resolveTencentConfig(overrides = {}) {
  const cfg = getConfig();
  const topOverrides = { ...(overrides || {}) };
  delete topOverrides.tencent;
  const top = applyOverrides(cfg.voice, topOverrides);
  const t = applyOverrides(cfg.voice?.tencent, overrides?.tencent);

  const speedNum = Number(top.speed);
  const volumeNum = Number(t.volume);
  return {
    secretId: String(t.secretId || '').trim(),
    secretKey: String(t.secretKey || '').trim(),
    region: String(t.region || '').trim() || 'ap-guangzhou',
    voiceType: Number(t.voiceType) || 0,
    sampleRate: Number(t.sampleRate) || 16000,
    volume: Number.isFinite(volumeNum) ? volumeNum : 0,
    modelType: Number(t.modelType) || 1,
    primaryLanguage: Number(t.primaryLanguage) || 1,
    format: normalizeTencentFormat(top.format),
    speed: Number.isFinite(speedNum) && speedNum > 0 ? speedNum : 1,
    maxChars: Math.min(TENCENT_MAX_CHARS, Math.max(1, Number(top.maxChars) || 200)),
    timeoutMs: Math.max(5000, Number(top.timeoutMs) || 60000)
  };
}

/**
 * 当前配置是否"真的能合成"。
 *
 * 用途：orchestrator 只在可用时才把 send_voice 交给模型。配置残缺时如果照样注册，
 * 模型会一次次调用一个必然失败的工具，既白烧 token 又污染会话记录 ——
 * 而缺什么在设置页已经明确提示了。
 * 返回 { ok, missing: ['语音模型', ...] }。
 */
export function voiceReady() {
  const cfg = getConfig();
  if (normalizeVoiceType(cfg.voice?.type) === 'tencent') {
    const t = resolveTencentConfig();
    const missing = [];
    if (!t.secretId) missing.push('SecretId');
    if (!t.secretKey) missing.push('SecretKey');
    if (!t.voiceType) missing.push('音色 ID');
    return { ok: missing.length === 0, missing };
  }
  const ep = resolveVoiceEndpoint();
  const missing = [];
  if (!ep.model) missing.push('语音模型');
  if (!ep.baseUrl) missing.push('接口地址');
  return { ok: missing.length === 0, missing };
}

/**
 * 合成一段语音。按 voice.type 分派到对应实现。
 * 统一返回 { buffer, format, contentType, model, voice }。失败抛错（带可读原因）。
 */
export async function synthesizeSpeech(text, overrides = {}) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('语音内容为空');
  const type = normalizeVoiceType(overrides.type ?? getConfig().voice?.type);
  return type === 'tencent'
    ? synthesizeTencent(input, overrides)
    : synthesizeOpenAi(input, overrides);
}

/** OpenAI 兼容：POST {baseUrl}/audio/speech，响应体就是原始音频字节。 */
async function synthesizeOpenAi(input, overrides) {
  const ep = resolveVoiceEndpoint(overrides);
  // 报错里点名"当前服务类型"：最常见的情况是服务类型还是 OpenAI 兼容、
  // 而用户填的是腾讯云那组字段 —— 不写清楚会让人对着腾讯云的配置反复检查。
  if (!ep.model) {
    throw new Error('未配置语音模型 —— 当前服务类型是「OpenAI 兼容」，这个模式必须填「语音模型」（设置 → 语音输出）。想用腾讯云请先把服务类型切过去。');
  }
  if (!ep.baseUrl) throw new Error('未配置语音接口地址（设置 → 语音输出）');

  const body = {
    model: ep.model,
    input,
    voice: ep.voice,
    response_format: ep.format
  };
  // speed / instructions 不是所有端点都认，只在用户真的填了才下发，
  // 免得默认值把不支持的厂商直接顶成 400。
  if (Number(ep.speed) !== 1) body.speed = Number(ep.speed);
  if (ep.instructions) body.instructions = ep.instructions;

  let res;
  try {
    res = await fetch(joinUrl(ep.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ep.timeoutMs)
    });
  } catch (error) {
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    if (/timeout|timed out|abort/i.test(msg)) throw new Error(`语音合成超时（${ep.timeoutMs}ms）`);
    throw new Error(`语音合成请求失败：${msg}`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`语音接口 HTTP ${res.status}：${raw.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('语音接口返回了空内容（检查模型名与音色是否被支持）');
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim();
  return {
    buffer,
    format: ep.format,
    contentType: contentType || mimeForFormat(ep.format),
    model: ep.model,
    voice: ep.voice
  };
}

/**
 * 腾讯云语音合成（TextToVoice）。
 *
 * 与 OpenAI 模式的三点关键差异：
 *   1. 鉴权是 TC3-HMAC-SHA256 签名，要 SecretId + SecretKey 两个值（不是单个 Bearer Key）；
 *   2. 响应是 JSON，音频以 base64 放在 Response.Audio 里；
 *   3. **业务失败也返回 HTTP 200**，错误在 Response.Error —— 不看这个字段会把
 *      一段"报错文本"当成音频存成 mp3，表现为"发送成功但听不到声音"。
 *
 * host 头不能手动设置（fetch 规范里的禁止头，会被忽略）；签名用的 host 从 URL 推导，
 * 与运行时真实发出的 Host 一致。
 */
async function synthesizeTencent(input, overrides) {
  const t = resolveTencentConfig(overrides);
  if (!t.secretId) throw new Error('未配置腾讯云 SecretId（设置 → 语音输出）');
  if (!t.secretKey) throw new Error('未配置腾讯云 SecretKey（设置 → 语音输出）');
  if (!t.voiceType) throw new Error('未配置腾讯云音色 ID（VoiceType）（设置 → 语音输出）');

  const endpoint = String(
    overrides.tencent?.endpoint || getConfig().voice?.tencent?.endpoint || `https://${TENCENT_HOST}`
  ).trim();
  let host;
  try {
    host = new URL(endpoint).host;
  } catch {
    throw new Error(`腾讯云语音合成地址不合法：${endpoint}`);
  }

  const payload = JSON.stringify({
    Text: input.slice(0, t.maxChars),
    SessionId: `qqagent-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    VoiceType: t.voiceType,
    Codec: t.format,
    SampleRate: t.sampleRate,
    Speed: tencentSpeed(t.speed),
    Volume: t.volume,
    ModelType: t.modelType,
    PrimaryLanguage: t.primaryLanguage,
    EnableSubtitle: false
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const authorization = buildTencentAuthorization({
    secretId: t.secretId,
    secretKey: t.secretKey,
    payload,
    timestamp,
    host
  });

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': TENCENT_CONTENT_TYPE,
        'x-tc-action': 'TextToVoice',
        'x-tc-timestamp': String(timestamp),
        'x-tc-version': TENCENT_VERSION,
        'x-tc-region': t.region
      },
      body: payload,
      signal: AbortSignal.timeout(t.timeoutMs)
    });
  } catch (error) {
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    if (/timeout|timed out|abort/i.test(msg)) throw new Error(`腾讯云语音合成超时（${t.timeoutMs}ms）`);
    throw new Error(`腾讯云语音合成请求失败：${msg}`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`腾讯云语音合成 HTTP ${res.status}：${raw.slice(0, 300)}`);
  }

  const data = await res.json().catch(() => null);
  const body = data?.Response;
  if (!body) throw new Error(`腾讯云语音合成返回了无法解析的响应：${JSON.stringify(data).slice(0, 300)}`);
  if (body.Error) {
    const code = String(body.Error.Code ?? '');
    const message = String(body.Error.Message ?? '');
    const hint = /AuthFailure|Signature/i.test(code)
      ? '（检查 SecretId/SecretKey 是否正确，以及本机时间是否准 —— 腾讯云要求与服务端时间偏差不超过 5 分钟）'
      : '';
    throw new Error(`腾讯云语音合成失败：${code} ${message}${hint}`);
  }

  const base64Audio = String(body.Audio || '').trim();
  if (!base64Audio) throw new Error('腾讯云语音合成未返回音频数据（检查音色 ID 是否可用）');
  const buffer = Buffer.from(base64Audio, 'base64');
  if (!buffer.length) throw new Error('腾讯云返回的音频数据为空');
  return {
    buffer,
    format: t.format,
    contentType: mimeForFormat(t.format),
    model: `腾讯云 TTS（VoiceType=${t.voiceType}）`,
    voice: String(t.voiceType)
  };
}

/**
 * 把本地音频文件转成协议端能识别的 file 参数（OneBot record 段的 file 字段）。
 *
 * 为什么不能直接传路径：NapCat 系协议端（SnowLuma 也是基于它）对 file 是按前缀分派的，
 * 只认 http(s):// / base64:// / file:// 三种。传裸绝对路径会走进 URL 解析分支并报
 * "识别URL失败" —— 这正是 Windows 上没暴露（试听不经过 OneBot）、一上 Linux 就炸的原因。
 *
 * base64 模式的价值在跨容器/跨机器部署：协议端在 Docker 里时看不到宿主机的
 * /opt/qq-agent/data/...，走路径必然失败；内联数据则与文件系统无关。
 */
export function voiceFileParam(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) throw new Error('语音文件路径为空');
  // 已经是完整形式（URL / base64 / file URI）就原样透传，只做斜杠归一化
  if (/^(https?:|base64:|file:)/i.test(raw)) return raw.replace(/\\/g, '/');

  const local = raw.replace(/\\/g, '/');
  const mode = String(getConfig().voice?.fileMode || 'file-uri');
  if (mode === 'path') return local;
  if (mode === 'base64') {
    const buffer = fs.readFileSync(filePath);
    if (!buffer.length) throw new Error('语音文件为空，无法内联');
    return `base64://${buffer.toString('base64')}`;
  }
  // POSIX 的 /opt/x.mp3 → file:///opt/x.mp3（三斜杠）
  // Windows 的 D:/x.mp3 → file:///D:/x.mp3
  return local.startsWith('/') ? `file://${local}` : `file:///${local}`;
}

/**
 * 按保留个数清理旧语音文件（keepFiles<=0 表示不限制，直接跳过）。
 * 导出给 songs.js 复用：歌曲片段也落在 data/voice/，共用同一套清理策略。
 */
export function pruneVoiceFiles(keepRaw) {
  const keep = Number(keepRaw);
  const limit = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0;
  if (!limit) return;
  try {
    const entries = fs.readdirSync(VOICE_DIR)
      .filter((name) => VOICE_NAME_RE.test(name) || /\.(mp3|opus|aac|flac|wav|pcm)$/i.test(name))
      .map((name) => {
        const full = path.join(VOICE_DIR, name);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(limit)) {
      try { fs.unlinkSync(entry.full); } catch { /* 被占用就下次再清 */ }
    }
  } catch { /* 清理失败不影响发送 */ }
}

/** 把音频写进 data/voice/，返回绝对路径。 */
export function saveVoiceFile(buffer, format = 'mp3') {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${normalizeFormat(format)}`;
  const file = path.join(VOICE_DIR, name);
  fs.writeFileSync(file, buffer);
  pruneVoiceFiles(getConfig().voice?.keepFiles);
  return file;
}

/**
 * 合成 + 落盘一步到位（工具调用与控制台试听都走这里）。
 * 返回 { file, name, format, bytes, contentType, model, voice, buffer }。
 * buffer 一并带出，控制台试听可以就地转 data URL，不用再读一次盘。
 */
export async function speak(text, overrides = {}) {
  const result = await synthesizeSpeech(text, overrides);
  const file = saveVoiceFile(result.buffer, result.format);
  return {
    file,
    name: path.basename(file),
    format: result.format,
    bytes: result.buffer.length,
    contentType: result.contentType,
    model: result.model,
    voice: result.voice,
    buffer: result.buffer
  };
}

/**
 * 试听/测试：合成一句话并落盘，返回结构化结果（不抛错，便于直接回给前端）。
 * preview 是 data URL —— 控制台直接塞进 <audio src> 试听，不额外开一条
 * 静态文件路由（少一个需要鉴权的端点，也不受 server.token 影响）。
 */
export async function testVoice(text = '你好，我是小鲸鱼，这是一条测试语音。', overrides = {}) {
  const startedAt = Date.now();
  try {
    const clip = await speak(String(text).slice(0, 100), overrides);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      file: clip.name,
      bytes: clip.bytes,
      format: clip.format,
      model: clip.model,
      voice: clip.voice,
      preview: `data:${clip.contentType || mimeForFormat(clip.format)};base64,${clip.buffer.toString('base64')}`
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, note: String(error?.message ?? error) };
  }
}

