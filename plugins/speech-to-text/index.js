// 语音转文字（本地 whisper.cpp）：把 QQ 语音转成文字，方便模型理解。
//
// 数据流：record media（url/file）→ OneBot get_record 拿 wav（SnowLuma 内置 silk 转码）
//         → whisper-cli 识别 → 返回文字。
//
// ── 设计原则 ──────────────────────────────────────────────────────────
//   · 失败一律抛错，由调用方静默吞掉 —— 绝不阻塞/影响聊天主流程；
//   · 识别是「增强」不是「必需」：失败时消息保持 [语音] 占位，行为与未启用时一致；
//   · 临时文件用完即删，不残留磁盘（一次识别会产生 .wav 和 .txt 两个临时文件，
//     漏删会在长期运行里堆满临时目录）；
//   · **全程本地**：不上传音频到任何第三方服务。语音属于比较私密的内容，
//     这一点是刻意的取舍 —— 换来的是需要用户自己准备 whisper 二进制和模型。
//
// ── 这不是"核心功能" ──────────────────────────────────────────────────
// 它需要外部可执行文件 + 模型文件（几百 MB），不是所有人都想装。
// 所以做成默认关闭的 Skill：装好的人在设置页打开，没装的人完全不受影响。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cfg = () => ({});
let log = () => {};

/**
 * 定位 whisper-cli 可执行文件。
 * 优先用配置里的完整路径；留空则探测 PATH 里的常见名字。
 *
 * ⚠️ 刻意**不**探测裸的 `main` / `main.exe`：这名字太通用，
 * PATH 里恰好有同名无关程序时会被误选，然后拿错误参数去执行一个不认识的程序。
 */
export async function resolveWhisperPath(configured) {
  const p = String(configured || '').trim();
  if (p && fs.existsSync(p)) return p;
  for (const name of ['whisper-cli', 'whisper-cli.exe', 'whisper', 'whisper.exe']) {
    try {
      await execFileAsync(name, ['--version'], { timeout: 5000, windowsHide: true });
      return name;                       // 能执行到这一步 = 命令存在
    } catch (e) {
      if (e?.code === 'ENOENT') continue;   // 找不到，试下一个
      // 超时（killed / SIGTERM）不能当成"找到了"：5 秒跑不完 --version 说明二进制本身就挂了
      if (e?.killed || e?.signal === 'SIGTERM') continue;
      return name;                          // 找到了但参数不被识别（退出码非零），也算找到
    }
  }
  return '';
}

/** 临时文件路径（带随机后缀，避免并发识别互相覆盖）。 */
function tmpPath(ext) {
  return path.join(os.tmpdir(), `qq-agent-stt-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** 把 base64（含 base64:// 前缀或纯 base64）解码写临时文件。 */
function writeBase64ToTemp(raw, ext) {
  let b64 = String(raw);
  if (b64.startsWith('base64://')) b64 = b64.slice('base64://'.length);
  const tmp = tmpPath(ext);
  fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
  return tmp;
}

/**
 * 通过 OneBot get_record 拿到 wav 音频，写到临时文件并返回路径。
 *
 * SnowLuma 实现了 get_record 的 out_format 转码（内置 silk 解码），直接要 wav 最省事。
 * 路径要兼容三种返回形态（不同 OneBot 实现差别很大）：
 *   1) base64 字段（SnowLuma 转码结果放在这里）
 *   2) file 字段是 base64:// 前缀或长 base64 串
 *   3) file 字段是 http(s) 下载链接，或本地路径
 *
 * ⚠️ 第 3 种的 http(s) 分支刻意**不走 safe-fetch 的公网校验**：
 *    这个 URL 是本机 OneBot 服务（SnowLuma）给的，不是群友可控的输入，
 *    和用户自己填的 baseUrl 同一信任级。如果对它做内网拦截，
 *    反而会把"OneBot 跑在 127.0.0.1"这种最常见的情况挡掉。
 */
async function fetchRecordAsWav(record, onebot) {
  const key = String(record?.file || record?.url || '').trim();
  if (!key) throw new Error('语音没有可获取的 file/url 标识');

  const r = await onebot.call('get_record', { file: key, out_format: 'wav' });
  const b64 = r?.base64 ?? r?.data?.base64;
  if (b64) return writeBase64ToTemp(b64, '.wav');

  const raw = r?.file ?? r?.data?.file ?? (typeof r === 'string' ? r : '');
  if (!raw) throw new Error('get_record 未返回音频数据（无 base64 也无 file）');

  const s = String(raw).trim();
  if (s.startsWith('base64://') || /^[A-Za-z0-9+/=]{120,}$/.test(s)) {
    return writeBase64ToTemp(s, '.wav');
  }
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`get_record 返回的音频 URL 下载失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('get_record 返回的音频 URL 下载为空');
    const tmp = tmpPath('.wav');
    fs.writeFileSync(tmp, buf);
    return tmp;
  }
  if (!fs.existsSync(s)) throw new Error(`get_record 返回的文件不存在：${s}`);
  const tmp = tmpPath('.wav');
  fs.copyFileSync(s, tmp);
  return tmp;
}

/**
 * 清理 whisper-cli 输出：去掉时间戳/进度/日志行，得到纯文字。
 *
 * ⚠️ 时间戳行是**剥掉前缀保留正文**，不是整行丢弃。
 * 原实现把 `^\[` 开头的行整行过滤掉 —— 那是假设 `-nt`（no timestamps）一定生效。
 * 但只要某个 whisper 版本忽略 `-nt`（或走 .txt 分支），输出的每一行都带
 * `[00:00:00.000 --> 00:00:02.000] 正文` 前缀，于是**每一行都被丢掉**，
 * 识别结果恒为空，表现为"语音永远只有 [语音] 占位"。
 * 剥前缀后两种输出形态都能拿到正文，不再依赖那个假设。
 */
export function cleanWhisperOutput(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    // 先剥时间戳前缀：[00:00:00.000 --> 00:00:02.000] 或 [00:00.000 --> 00:02.000]
    .map((l) => l.replace(/^\[[\d:.,\s\->]*\]\s*/u, '').trim())
    .filter((l) => l && !/^whisper_|^\[|^main:|^system_info|^%|^pcmf32|^mel_|^log_|^encode_cb|^decode_cb|^detect_cb/i.test(l))
    .join(' ')
    .trim();
}

/**
 * 识别一条 QQ 语音（record media）→ 文字。
 * @param {object} record  { kind:'record', url, file }
 * @param {object} deps    { onebot }
 * @returns {Promise<string>} 识别出的文字；失败抛错（调用方负责吞掉）。
 */
export async function transcribeRecord(record, { onebot } = {}) {
  const c = cfg();
  const whisperPath = await resolveWhisperPath(c.whisperPath);
  if (!whisperPath) throw new Error('找不到 whisper-cli，请在技能设置里填写完整路径');
  const modelPath = String(c.modelPath || '').trim();
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('语音识别模型未配置或文件不存在（modelPath）');
  }
  if (!onebot?.call) throw new Error('缺少 OneBot 客户端，无法取语音文件');

  const lang = String(c.language || 'zh').trim() || 'zh';
  const timeoutMs = Math.max(5000, Number(c.timeoutMs) || 30000);

  const wavPath = await fetchRecordAsWav(record, onebot);
  const outBase = wavPath.replace(/\.wav$/i, '');
  try {
    await execFileAsync(whisperPath, ['-m', modelPath, '-f', wavPath, '-l', lang, '-nt', '-otxt', '-of', outBase], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    const txtPath = `${outBase}.txt`;
    let text = '';
    if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8').trim();
    if (!text) {
      // 某些版本不输出 .txt：重新跑一次只抓 stdout（-nt 纯文本）
      const r2 = await execFileAsync(whisperPath, ['-m', modelPath, '-f', wavPath, '-l', lang, '-nt'], {
        timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true
      });
      text = cleanWhisperOutput(r2.stdout);
    }
    if (!text) throw new Error('语音识别结果为空');
    return text;
  } finally {
    // 临时文件用完即删（wav / txt 都清）——漏删会在长期运行里堆满临时目录
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${outBase}.txt`); } catch { /* ignore */ }
  }
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // { record, onebot } → 文字
  'media.transcribe': async ({ record, onebot } = {}) => {
    try {
      const text = await transcribeRecord(record, { onebot });
      return { ok: true, text };
    } catch (error) {
      // 返回 error 而不是抛错：识别失败绝不该打断整轮对话
      log(`语音识别失败：${error?.message ?? error}`);
      return { ok: false, text: '', error: String(error?.message ?? error) };
    }
  }
};

/**
 * 自检：缺 whisper 或缺模型就报"依赖不满足"，设置页会直接显示原因。
 * ⚠️ 必须同步 —— 可用性判定走的是同步调用链，返回 Promise 会被当成"可用"。
 * 探测要 spawn 进程（异步），所以用"首次乐观放行 + 后台探测 + 缓存结果"。
 */
let probeState = null;   // null = 未探测；'' = 不可用；路径 = 可用
let probing = false;
let probeAt = 0;         // 上次探测时间（失败结果最多缓存 60 秒，之后允许重探）
let probedWith = '';     // 探测时的配置快照：配置变了（用户补填 modelPath）立即重探
const PROBE_RETRY_MS = 60000;
function probeInBackground() {
  if (probing) return;
  // 已有成功结果且配置没变 → 不重探；失败结果过期重探
  if (probeState && probedWith === JSON.stringify(cfg())) return;
  if (probeState !== null && Date.now() - probeAt < PROBE_RETRY_MS && probedWith === JSON.stringify(cfg())) return;
  probing = true;
  probedWith = JSON.stringify(cfg());
  (async () => {
    const c = cfg();
    if (!String(c.modelPath || '').trim() || !fs.existsSync(String(c.modelPath))) return '';
    return await resolveWhisperPath(c.whisperPath);
  })().then((p) => { probeState = p || ''; probeAt = Date.now(); }).catch(() => { probeState = ''; probeAt = Date.now(); }).finally(() => { probing = false; });
}

export function available() {
  // 配置变化 / 失败结果超 60 秒 → 自动重探（修复"首次失败后装好了也永远不可用"）
  if (probeState !== null && (probedWith !== JSON.stringify(cfg()) || (!probeState && Date.now() - probeAt > PROBE_RETRY_MS))) {
    probeState = null;
  }
  if (probeState === null) { probeInBackground(); return { ok: true }; }   // 首次乐观放行
  if (!probeState) {
    const c = cfg();
    if (!String(c.modelPath || '').trim()) return { ok: false, reason: '还没填模型文件路径（modelPath）' };
    return { ok: false, reason: '找不到 whisper-cli，或模型文件不存在' };
  }
  return { ok: true };
}

export const internals = {
  transcribeRecord, resolveWhisperPath, cleanWhisperOutput,
  __resetProbe: () => { probeState = null; probing = false; }
};
