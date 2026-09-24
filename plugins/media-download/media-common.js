// 媒体插件公共小件——bili.js 与 douyin.js 的重复家族收口（第 3 个媒体插件出现前的防屎山措施）。
// 只收"零业务语义"的小件；各平台的接口协议/打分/报错文案仍留在 bili.js / douyin.js。
// 插件契约不变：bili.js / douyin.js 继续以同名导出转发这些函数。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBinaryToFile } from '../../src/safe-fetch.js';

/**
 * 解析插件参数值。
 * configDefaults 用类型化声明（{type,label,default,...}）时，
 * 用户**未保存过**配置的话 params 里放的还是整个声明对象。
 * 这里把声明对象解包成 default；已保存过配置时拿到的就是 UI 写好的真值，原样返回。
 *
 * 没有这个，`Number({type:'number',default:60})` 会得到 NaN —— 时长/字节上限会静默失效。
 */
export function resolveParam(params, key, fallback) {
  const v = params?.[key];
  if (v && typeof v === 'object' && !Array.isArray(v) && 'default' in v) return v.default;
  return (v === undefined || v === null || v === '') ? fallback : v;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 文件名安全化：去 Windows 非法字符与控制字符、折叠空白、截断、空值兜底。 */
export function safeName(name, maxLen = 80) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'video';
}

/** 清理目录里超过 maxAgeMs 的旧文件（best-effort，任何异常吞掉）。skipNames 用于保留状态文件。 */
export function cleanupDir(dir, maxAgeMs, { skipNames = [] } = {}) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const skip = new Set(skipNames);
    for (const f of fs.readdirSync(dir)) {
      if (skip.has(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不存在等，忽略 */ }
}

/**
 * 失败通知器工厂：把下载错误压成一句人话（briefFailure 由各平台提供自己的文案映射），
 * 同原因 10 分钟内只发一条（防刷屏），通知失败不影响主流程。
 */
export function createFailureNotifier(briefFailure) {
  const notifiedKey = new Map();
  return async function notifyFailure({ sender, chatKey }, e) {
    const key = String(e?.message ?? e ?? '?').slice(0, 80);
    const last = notifiedKey.get(key);
    if (last && Date.now() - last < 10 * 60 * 1000) return;
    // 先淘汰最旧再写入：之前先 set 后 clear，把刚记录的键也一起清掉，
    // 同一错误在 10 分钟窗口内可能再次通知（防刷屏失效）
    if (notifiedKey.size >= 50) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, at] of notifiedKey) { if (at < oldestAt) { oldestAt = at; oldestKey = k; } }
      if (oldestKey) notifiedKey.delete(oldestKey);
    }
    notifiedKey.set(key, Date.now());
    try { await sender?.sendTextBatch(chatKey, [briefFailure(e)]); } catch { /* 通知失败忽略 */ }
  };
}

/**
 * 把远端 URL 下载成本地文件（限量 + 流式落盘 + 失败清理）。
 *
 * 为什么必须走 safe-fetch 而不是裸 fetch：
 *   URL 来自 QQ 群消息，是**攻击者可控**的。裸 fetch 等于把宿主变成 SSRF 跳板
 *   （群友发一条 http://192.168.1.1/... 就能让宿主去探内网）。
 *   safeFetchBinaryToFile 入口与每一跳重定向都过 validateFetchUrl（DNS 全记录
 *   内网拦截 + IP 固定防 rebinding）。
 *
 * 为什么流式（2026-09-19 M8）：旧实现 safeFetchBinary 整读进内存再写盘，
 * 100MB 上限就真的占 100MB 内存；现在边收边写盘，占用与视频大小无关。
 * safeFetchBinaryToFile 已保证"失败删半截文件"，这里不再需要 .part 中转。
 *
 * @param {string} url
 * @param {string} destPath
 * @param {number} maxBytes 体积上限（到达即中止并清理）
 * @param {object} [opts] 透传给 safeFetchBinaryToFile：{ timeoutMs }（空闲超时）等。
 *                        bili/douyin 传入的 headers 尚未生效（见下），保留参数兼容现有调用。
 * @returns {Promise<{ok:boolean, bytes?:number, contentType?:string, error?:string}>}
 */
export async function safeFetchToFile(url, destPath, maxBytes = 100 * 1024 * 1024, opts = {}) {
  const dest = String(destPath || '');
  if (!dest) return { ok: false, error: '缺少目标路径' };
  const limit = Math.max(1, Number(maxBytes) || 100 * 1024 * 1024);
  try {
    const { bytes, contentType } = await safeFetchBinaryToFile(String(url || ''), dest, limit, {
      timeoutMs: Number(opts?.timeoutMs) || 30000
    });
    return { ok: true, bytes, contentType };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
