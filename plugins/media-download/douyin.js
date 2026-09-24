// 抖音访问与下载公共库
//
// 供 data/plugins/ 下抖音相关插件共用（与 src/bili.js 同构）：
//   · douyin-video  —— 群友分享抖音视频（链接/卡片/口令文案）→ 自动下载发送
// 下载逻辑排查只改这里，不用在插件里各改一遍。
//
// ── 接口实测结论（2026-09-11，全部在本机实测通过）──
//   ① 老办法已死：`iesdouyin.com/share/video/{id}/` 页面里的
//      `window._ROUTER_DATA → loaderData → videoInfoRes.item_list[0]` 现在只返回 32KB
//      空壳页（含 "special-case" 兜底标记），有效视频与失效视频返回完全一致。
//      视频数据改由签名 API 投递（需 a_bogus / X-Bogus），匿名不可得。
//   ② yt-dlp（2026.08.19，含 curl_cffi）仍报 `Fresh cookies (not necessarily logged
//      in) are needed`：其 tiktok.py 里的 DouyinIE 打 `www.douyin.com` 的 detail 接口
//      拿到的是**空响应体**（`Expecting value in '': line 1 column 1`），
//      即使给了 ttwid + __ac_nonce + --impersonate chrome 也不行。
//   ③ ✅ 可用路径（无需签名、无需登录、无需 yt-dlp / ffmpeg）：
//        GET https://www.douyin.com/aweme/v1/web/aweme/detail/
//            ?device_platform=webapp&aid=6383&channel=channel_pc_web
//            &aweme_id={id}&pc_client_type=1&version_code=170400&version_name=17.4.0
//            &cookie_enabled=true&screen_width=1920&screen_height=1080
//            &browser_language=zh-CN&browser_platform=Win32
//            &browser_name=Chrome&browser_version=120.0.0.0
//        → 200，约 60KB JSON，`aweme_detail` 完整（desc/duration/ratio/video/author）
//      对照实验（同 URL、仅换 Cookie 头）：
//          无 cookie        → 200 空体（len=0）
//          仅 __ac_nonce    → 200 空体
//          仅 ttwid         → 200 len=60104，aweme_detail ✓
//          ttwid+__ac_nonce → 200 len=60105，aweme_detail ✓
//          假 ttwid         → 200 空体
//      ⇒ 唯一硬依赖是 **ttwid**（无效值一律空体，无法用假值蒙混）。
//   ④ ttwid 可完全自助获取：请求 `https://www.iesdouyin.com/share/video/{id}/`
//      的 Set-Cookie 就会带 ttwid（有效期约 2 年，2027-09 到期）。
//      `douyin.com` 各页只给 __ac_nonce，不给 ttwid。
//   ⑤ 播放地址：`video.download_addr.url_list[0]` 已是**无水印**（不含 playwm），
//      直接是 MP4，无需 ffmpeg 转封装。仍保留 playwm→play 替换作为历史兜底（当前为无害 no-op）。
//   ⑥ 短链 `v.douyin.com/{code}/` 用 safeFetch 跟重定向即可，最终 URL 形如
//      `https://www.douyin.com/video/{id}?previous_page=app_code_link`。
//
// 依赖：
//   · safe-fetch（防 SSRF；抖音 CDN 是公网不会拦）
//   · 无需 ffmpeg、无需 yt-dlp、无需登录凭证
//
// 安全：公共库供管理员放入 data/plugins/ 的可信插件调用，与内置工具同信任级。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetch, safeFetchBinary } from '../../src/safe-fetch.js';
import { safeFetchToFile } from './media-common.js';
import { resolveParam, sleep, safeName, cleanupDir, createFailureNotifier } from './media-common.js';

/**
 * 发一批媒体段：优先走核心的发送队列（限频 / 去重 / 留档），
 * 没有 sender 时才退回直发 —— 直发分支只为让本模块能独立复用，
 * 在正式链路里**不该**走到（会跳过限频与留档，媒体会把文字配额吃光）。
 */
async function sendMediaSegments({ onebot, sender, kind, chatId }, segments, { label }) {
  if (sender?.sendMedia) {
    await sender.sendMedia(`${kind}:${chatId}`, segments, { label });
    return;
  }
  if (onebot?.sendSegments) await onebot.sendSegments(kind, chatId, segments);
}

export const CACHE_DIR = path.join(process.cwd(), 'data', 'media-cache', 'douyin');
// 小件（参数解包/文件名安全化/目录清扫/失败通知）收口在 media-common.js，这里 re-export 保持插件契约
export { resolveParam, sleep, safeName };

// 桌面 Chrome UA（detail 接口与 CDN 都认这个）
export const DY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// 移动端 Safari UA：iesdouyin 入口对移动端返回 Set-Cookie: ttwid
const DY_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const IE_HOST = 'https://www.iesdouyin.com';   // ttwid 自助获取入口
const WEB_HOST = 'https://www.douyin.com';     // detail 接口 + 分享落地页
const AID = '6383';                            // 抖音 web 端应用 id（webapp 通用值）

/** detail 接口查询串（顺序与实测一致，缺任一参数都会退回空体） */
function detailQuery(awemeId) {
  const q = new URLSearchParams({
    device_platform: 'webapp',
    aid: AID,
    channel: 'channel_pc_web',
    aweme_id: String(awemeId),
    pc_client_type: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '120.0.0.0',
  });
  return `${WEB_HOST}/aweme/v1/web/aweme/detail/?${q}`;
}

export function dyHeaders(referer, ttwid) {
  const h = { 'User-Agent': DY_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };
  if (referer) h['Referer'] = referer;
  if (ttwid) h['Cookie'] = `ttwid=${ttwid}`;
  return h;
}

// ── ttwid：进程级内存缓存 + 磁盘缓存 ──────────────────────────────────────
// 磁盘缓存文件 data/dy-cache/ttwid.json：机器人重启后不用重新走一次 iesdouyin。
// 有效期 2 年，这里按 30 天判过期重取（保守，代价只是一次轻量请求）。

const COOKIE_CACHE_FILE = path.join(CACHE_DIR, 'ttwid.json');
const TTWID_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let ttwidMemory = null;   // { value, at }

function readCookieCache() {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_CACHE_FILE, 'utf8'));
    if (j && typeof j.value === 'string' && j.value.length > 20) return j;
  } catch { /* 文件不存在/损坏 → 重取 */ }
  return null;
}

function writeCookieCache(value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_CACHE_FILE, JSON.stringify({ value, at: Date.now() }), 'utf8');
  } catch (e) { /* 写盘失败不影响运行（内存缓存仍在） */ }
}

/**
 * 取 ttwid。优先级：插件配置里用户填的 cookie → 内存缓存 → 磁盘缓存 → 自助获取。
 * 自助获取是唯一一处用原始 fetch 的地方（safeFetch 不返回 Set-Cookie 头），
 * 目标域是硬编码常量、URL 里只插入经过 /^\d{10,25}$/ 校验的 aweme id，无 SSRF 面。
 *
 * @returns {Promise<string>} ttwid 值（可能为空串，调用方按匿名降级）
 */
async function getTtwid(cookieOverride) {
  const userCookie = String(cookieOverride || '').trim();
  // 用户配置支持直接填完整 Cookie 串或裸 ttwid 值
  if (userCookie) {
    const m = userCookie.match(/(?:^|;\s*)ttwid=([^;]+)/);
    return (m ? m[1] : userCookie).trim();
  }
  if (ttwidMemory && Date.now() - ttwidMemory.at < TTWID_TTL_MS) return ttwidMemory.value;

  const cached = readCookieCache();
  if (cached && Date.now() - (Number(cached.at) || 0) < TTWID_TTL_MS) {
    ttwidMemory = { value: cached.value, at: Date.now() };
    return cached.value;
  }

  // 自助获取：需要任意一个 aweme id 作入口参数
  // 用一个真实存在的公共 id 作固定入口（即使该视频失效也会正常返回 Set-Cookie: ttwid）
  const bootstrapId = '7483776975832763706';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 这是写死的官方域名和固定 bootstrap ID，非用户输入；仅用于读取 Set-Cookie。
      const r = await fetch(`${IE_HOST}/share/video/${bootstrapId}/`, {
        headers: { 'User-Agent': DY_MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      await r.text().catch(() => { });
      for (const c of sc) {
        const m = c.match(/^ttwid=([^;]+)/);
        if (m && m[1].length > 20) {
          const v = m[1];
          ttwidMemory = { value: v, at: Date.now() };
          writeCookieCache(v);
          return v;
        }
      }
    } catch (e) {
      if (attempt === 0) await sleep(1000);
    }
  }
  // 取不到也别阻塞：返回空串，detail 接口会返回空体，调用方给出明确报错
  return cached?.value || '';
}

// ── aweme id 解析 ─────────────────────────────────────────────────────────

const ID_RE = /\d{10,25}/;

/** 从任意文本/URL 里提取 aweme id（长链、分享落地页） */
export function extractAwemeId(text) {
  const s = String(text || '');
  // douyin.com/video/{id} 或 douyin.com/note/{id}
  let m = s.match(/douyin\.com\/(?:video|note)\/(\d{10,25})/i);
  if (m) return m[1];
  // iesdouyin.com/share/video/{id}/
  m = s.match(/iesdouyin\.com\/share\/video\/(\d{10,25})/i);
  if (m) return m[1];
  // 裸 15-25 位数字（用户直接贴 id）
  m = s.match(/\b(\d{15,25})\b/);
  if (m) return m[1];
  return null;
}

/** 从文本里提取所有抖音相关 URL（短链 / 长链 / 分享文案里夹杂的链接） */
export function extractDouyinUrls(text) {
  const s = String(text || '');
  return s.match(/https?:\/\/[^\s"'<>，。！？）\]】]*douyin\.com[^\s"'<>，。！？）\]】]*/gi) || [];
}

/**
 * 会话触发消息的抖音分享特征判定（onSessionStart 用）。
 * 只认「分享/视频/短视频」等意图字样或真实链接标记——
 * 防止群里随口提到「抖音」（如「抖音今天咋了」）误触发自动下载。
 */
export function looksLikeDouyinShare(text) {
  return /douyin\.com|iesdouyin\.com|douyin:\/\/|抖音(分享|视频|短视频)|复制打开抖音|打开抖音看/i.test(String(text || ''));
}

/**
 * 短链 → aweme id。safeFetch 自动跟重定向，最终 URL 里带 id。
 */
async function resolveShortUrl(url) {
  const { url: finalUrl } = await safeFetch(url, {
    timeoutMs: 15000,
    headers: { 'User-Agent': DY_UA, 'Accept': '*/*' },
    maxBytes: 200000,
  });
  return extractAwemeId(finalUrl) || extractAwemeId(url);
}

/**
 * 把模型传入的参数解析成 aweme id。与 src/bili.js 的 resolveBvid 同构：
 *   args.messageId → 调 getMsg 拿原始消息段 → 从所有段数据提取链接
 *   args.url       → 直接从链接/裸 id 提取；v.douyin.com 短链自动跟重定向
 *
 * @param {object} args 工具入参 { messageId?, url? }
 * @param {object} deps { onebot }
 */
export async function resolveAwemeId(args, { onebot } = {}) {
  // ① messageId 优先：拿原始段，扫所有段类型找抖音链接
  //    小程序卡片可能是 json/markdown/未知段，统一 stringify 后正则搜索
  if (args.messageId != null && String(args.messageId).trim() !== '') {
    const mid = String(args.messageId).replace(/^#/, '').trim();
    const msg = await onebot?.getMsg(mid);
    // 段数组/raw_message/message_content 三种 OneBot 形态的兼容与转义清理收口在 onebot.js
    const combined = flattenMessageToText(msg);

    const direct = extractAwemeId(combined);
    if (direct) return direct;
    const urls = extractDouyinUrls(combined);
    for (const u of urls) {
      if (/v\.douyin\.com/.test(u)) {
        try { const id = await resolveShortUrl(u); if (id) return id; } catch { /* 继续下一个 */ }
      }
    }
    console.error('[douyin] 无法提取 aweme id，卡片原始数据:\n', combined.slice(0, 2000));
    throw new Error('这条消息里没有找到抖音链接（很可能是 messageId 指错了消息：检查是否指到了「抖音分享」那条；也可以直接传 url 或 19 位内容 id，不要对非抖音消息调用本工具）。');
  }

  // ② 直接 url / 裸 id
  const src = String(args.url || '').trim();
  if (!src) throw new Error('请提供 messageId 或 url');
  const direct = extractAwemeId(src);
  if (direct) return direct;
  const urls = extractDouyinUrls(src);
  if (urls.length) {
    for (const u of urls) {
      try {
        const id = /v\.douyin\.com/.test(u) ? await resolveShortUrl(u) : extractAwemeId(u);
        if (id) return id;
      } catch { /* 继续下一个 */ }
    }
  }
  throw new Error('无法从输入中识别抖音链接（支持 v.douyin.com 短链、douyin.com/video/{id} 或 /note/{id} 长链、或 15-25 位内容 id）。');
}

// ── 视频信息 ─────────────────────────────────────────────────────────────

/**
 * 取视频详情。
 * @returns {Promise<object>} aweme_detail
 */
async function getAwemeDetail(awemeId, ttwid) {
  const { body, statusCode, truncated } = await safeFetch(detailQuery(awemeId), {
    timeoutMs: 20000,
    headers: dyHeaders(`https://www.douyin.com/video/${awemeId}`, ttwid),
    maxBytes: 1024 * 1024,   // 实测 ~60KB，但多图帖/长简介会更大；截断在下面显式报错
  });
  if (truncated) throw new Error('抖音 detail 接口响应超过读取上限被截断，拿不到完整数据');
  if (statusCode !== 200 || !body) {
    throw new Error('抖音 detail 接口返回空响应（ttwid 无效或缺失，请检查插件配置里的 cookie 或稍后重试）');
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('抖音 detail 接口返回了非 JSON 内容（可能被风控）'); }
  const detail = data.aweme_detail;
  if (!detail) {
    // 视频已删除/设为私密/不存在：接口返回 JSON 但没有 aweme_detail（顶层可能带 status_code）
    const status = Number(data.status_code ?? data.status ?? 0) || 0;
    throw new Error(`抖音未返回视频数据（status_code=${status}，视频可能已删除、设为私密或不存在）`);
  }
  return detail;
}

/** 判断是否为图文帖（图集 / 笔记）。
 *
 * 实测（2026-09-11，aweme_id=7684204009624689578，来自真实群分享）：
 *   · aweme_type = 68（视频帖为 0）
 *   · is_image_post = undefined —— **该字段不可靠，不能依赖**
 *   · images = 图片数组（非空）
 *   · video 对象**存在**但 duration = 0，且 video.play_addr 指向的是 **BGM 的 MP3**
 *
 * ⚠️ 不识别就往下走的后果：pickPlayUrl 会把 BGM 当视频地址返回，下载下来是 ID3 音频，
 * 被 MP4 魔数校验拦下后报「下载内容不是视频」，再被 briefFailure 误报成「可能被风控」——
 * 群友会以为是网络问题，实际上是图文帖。
 */
export function isImagePost(detail) {
  if (!detail || typeof detail !== 'object') return false;
  if (detail.aweme_type === 68) return true;
  const imgs = Array.isArray(detail.images) ? detail.images : [];
  return imgs.length > 0 && !(Number(detail.video?.duration) > 0);
}

/** 从图文帖里取**无水印**的图片直链列表。
 *
 * 实测（2026-09-11，aweme_id=7684204009624689578）：
 *   · images[n].url_list          → 无水印（~tplv-dy-aweme-images-v2）
 *   · images[n].download_url_list → 有水印（~tplv-dy-water-v10）
 *
 * ⚠️ 与视频**正好相反**：视频的 download_addr 才是无水印的，别沿用 preferDownloadAddr。
 *   直链已带 x-signature 预签名，无需 Referer；但带 x-expires（约 1 个月，过期后需重新查 detail）。
 * 另：images[n].video.play_addr 是嵌套字段，那是动图/livephoto 的表示，**静图也有这个字段**，
 * 本实现按静图处理，忽略嵌套视频。
 */
export function pickImageUrls(detail) {
  const imgs = Array.isArray(detail?.images) ? detail.images : [];
  const out = [];
  for (const img of imgs) {
    const list = Array.isArray(img?.url_list) ? img.url_list : [];
    for (const u of list) {
      if (typeof u === 'string' && /^https?:\/\//.test(u)) { out.push(u); break; }
    }
  }
  return out;
}

/** 图片魔数判定，返回扩展名（无魔数返回 null）。
 * 存盘时按**实际内容**命名而不是 URL 声称的格式 —— CDN 换格式/缓存过期时不错名。
 * 抖音图片 CDN 实测返回 WEBP（`RIFF....WEBP`）。
 */
export function imageMagicType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const latin = (a, b) => buffer.slice(a, b).toString('latin1');
  if (latin(0, 4) === 'RIFF' && latin(8, 12) === 'WEBP') return 'webp';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  return null;
}

/** 挑播放地址：优先 download_addr（实测已无水印），退化 play_addr，再做历史 playwm→play 替换 */
function pickPlayUrl(detail, { preferDownloadAddr = true, removeWatermark = true } = {}) {
  const cand = [];
  if (preferDownloadAddr !== false) cand.push(...(detail.video?.download_addr?.url_list || []));
  cand.push(...(detail.video?.play_addr?.url_list || []));
  cand.push(...(detail.video?.play_addr_265?.url_list || []));
  for (const u of cand) {
    if (!u || typeof u !== 'string' || !/^https?:\/\//.test(u)) continue;
    return removeWatermark !== false ? u.replace('playwm', 'play') : u;
  }
  return null;
}

// ── 下载与发送 ───────────────────────────────────────────────────────────

/** 清理 1 小时前的缓存文件（ttwid.json 是状态文件，保留） */
export function cleanupOldFiles() {
  cleanupDir(CACHE_DIR, 3600 * 1000, { skipNames: ['ttwid.json'] });
}

/** 读文件头 n 字节（魔数校验用，不把大文件整读进内存）。 */
function readHead(p, n = 64) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(n);
    const read = fs.readSync(fd, b, 0, n, 0);
    return b.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 下载图文帖的全部图片，并作为**一条多图片消息**发出（QQ 原生图文形态：一个气泡、多张可滑动）。
 *
 * 下载走 3 路并发（图多时提速约 3 倍）；files 按下标存放，消息内图片顺序不变。
 *
 * @param {object} detail aweme_detail（已确认 isImagePost 为真）
 * @param {string} awemeId 图文 id
 * @param {object} deps { onebot, kind, chatId, params }
 * @returns {Promise<{title:string,count:number,author:string}>}
 */
async function downloadImagePost(detail, awemeId, { onebot, sender = null, kind, chatId, params = {} }) {
  const maxBytes = Math.max(5 * 1024 * 1024, Number(resolveParam(params, 'maxBytes', 209715200)) || 209715200);
  const urls = pickImageUrls(detail);
  if (!urls.length) throw new Error('抖音图文帖没有返回可用的图片地址');

  const title = String(detail.desc || detail.aweme_id).slice(0, 100);
  const author = String(detail.author?.nickname || '');
  const baseName = `${safeName(title)}_${awemeId}`;
  const files = [];

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  cleanupOldFiles();

  let result = null;
  try {
    let cursor = 0;   // 简单工作池：3 个 worker 共享任务游标（单线程 JS，游标自增安全）
    const workers = Array.from({ length: Math.min(3, urls.length) }, async () => {
      while (cursor < urls.length) {
        const i = cursor++;
        const { buffer, contentType } = await safeFetchBinary(urls[i], maxBytes, {
          timeoutMs: 120000,
          headers: { 'User-Agent': DY_UA, 'Referer': 'https://www.douyin.com/' },
        });
        if (!buffer || buffer.length < 1024) throw new Error(`第 ${i + 1} 张图下载为空`);
        const ext = imageMagicType(buffer);
        if (!ext) throw new Error(`第 ${i + 1} 张图不是图片（CDN 返回 ${contentType || '未知类型'}）`);
        const outPath = path.join(CACHE_DIR, `${baseName}_${i + 1}.${ext}`);
        fs.writeFileSync(outPath, buffer);
        files[i] = outPath;
      }
    });
    await Promise.all(workers);
    const ordered = files.filter(Boolean);

    // 图文帖：一次发多条 image 段（一图一气泡会把 9 张图炸成 9 条消息）
    await sendMediaSegments({ onebot, sender, kind, chatId }, ordered.map((f) => ({ type: 'image', data: { file: f } })), {
      label: `[图文:${title.slice(0, 30)}]`
    });
    result = { title, count: ordered.length, author };

    // 与视频同策略：keepFile=true 时保留供排查，否则 2 分钟后清
    if (resolveParam(params, 'keepFile', false) !== true) {
      const doomed = [...ordered];
      setTimeout(() => { for (const f of doomed) { try { fs.unlinkSync(f); } catch { } } }, 120000);
    }
  } finally {
    if (!result) {
      // 失败：立刻清掉已下载的半成品，不留垃圾（并发下载中途抛错时 files 里是已写盘的部分）
      for (const f of [...files]) { if (f) { try { fs.unlinkSync(f); } catch { } } }
    }
  }
  return result;
}

const inFlight = new Set();

/**
 * 下载抖音视频/图文并以消息发出（自动分流）。
 *
 * 图文帖走 downloadImagePost（images[] → 一条多图片消息）；视频帖走原视频路径。
 * 必须在此分流：图文的 video 对象存在但 duration=0，且 play_addr 指向 BGM 的 MP3 ——
 * 不分流会把背景音乐当视频下载，再被 MP4 魔数校验拦成「不是视频」。
 *
 * @param {string} awemeId 抖音内容 id（15-25 位数字）
 * @param {object} deps { onebot, kind, chatId, params }
 *   params: { cookie, maxDurationMin, maxBytes, preferDownloadAddr, removeWatermark, keepFile }
 * @returns {Promise<{kind:'video'|'images',title,dur,ratio,author,count}>}
 *   kind='video'  → dur/ratio 有值，count 为 undefined
 *   kind='images' → count 有值，dur/ratio 为 null
 */
export async function downloadAndSend(awemeId, { onebot, sender = null, kind, chatId, params = {} }) {
  if (!ID_RE.test(String(awemeId))) throw new Error(`无效的视频 id：${awemeId}`);
  if (inFlight.has(awemeId)) throw new Error(`视频 ${awemeId} 正在下载中，请勿重复操作`);
  inFlight.add(awemeId);
  try {
    const maxBytes = Math.max(5 * 1024 * 1024, Number(resolveParam(params, 'maxBytes', 209715200)) || 209715200);
    const maxDurMin = Math.max(1, Number(resolveParam(params, 'maxDurationMin', 10)) || 10);

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cleanupOldFiles();

    // ① ttwid + 视频信息
    const ttwid = await getTtwid(resolveParam(params, 'cookie', ''));
    const detail = await getAwemeDetail(awemeId, ttwid);

    // 图文帖分流（理由见函数注释）：images[] → 一条多图片消息
    if (isImagePost(detail)) {
      const r = await downloadImagePost(detail, awemeId, { onebot, sender, kind, chatId, params });
      return { kind: 'images', title: r.title, count: r.count, author: r.author, dur: null, ratio: null };
    }

    const title = String(detail.desc || detail.aweme_id).slice(0, 100);
    const durMs = Number(detail.video?.duration) || 0;
    const dur = Math.round(durMs / 1000);
    const ratio = String(detail.video?.ratio || '');
    const author = String(detail.author?.nickname || '');

    if (dur > maxDurMin * 60) {
      throw new Error(`视频《${title}》时长 ${Math.floor(dur / 60)} 分 ${dur % 60} 秒，超过 ${maxDurMin} 分钟上限，已跳过`);
    }

    // ② 播放地址
    const playUrl = pickPlayUrl(detail, {
      preferDownloadAddr: resolveParam(params, 'preferDownloadAddr', true),
      removeWatermark: resolveParam(params, 'removeWatermark', true),
    });
    if (!playUrl) throw new Error('抖音未返回可用的视频流地址');

    const baseName = `${safeName(title)}_${awemeId}`;
    const outPath = path.join(CACHE_DIR, `${baseName}.mp4`);

    // ③ 下载（抖音直接给 MP4，无需 ffmpeg）——流式落盘，内存占用与视频大小无关
    const { bytes, contentType } = await safeFetchToFile(playUrl, outPath, maxBytes, {
      timeoutMs: 240000,
      headers: { 'User-Agent': DY_UA, 'Referer': 'https://www.douyin.com/' },
    });
    if (bytes < 1024) {
      try { fs.unlinkSync(outPath); } catch { }
      throw new Error('下载到的视频为空');
    }
    // MP4 魔数校验（只读文件头，不整读）：偏移 4 处应为 "ftyp"（失败说明拿到的是 HTML 风控页之类）
    const headText = readHead(outPath, 64).toString('latin1');
    if (headText.slice(4, 8) !== 'ftyp' && !/video\//i.test(contentType)) {
      try { fs.unlinkSync(outPath); } catch { }
      throw new Error(`下载内容不是视频（CDN 返回 ${contentType || '未知类型'}，前 12 字节：${headText.slice(0, 12).replace(/[^\x20-\x7e]/g, '?')}）`);
    }

    // ④ 发送（走发送队列：限频 / 去重 / 留档）
    await sendMediaSegments({ onebot, sender, kind, chatId }, [{ type: 'video', data: { file: outPath } }], {
      label: `[视频:${title.slice(0, 30)}]`
    });

    // ⑤ 清理（keepFile=true 时保留，供排查）
    if (resolveParam(params, 'keepFile', false) !== true) {
      setTimeout(() => { try { fs.unlinkSync(outPath); } catch { } }, 120000);
    }

    return { kind: 'video', title, dur, ratio, author, filePath: outPath };
  } finally {
    inFlight.delete(awemeId);
  }
}

// ── 失败提示 ─────────────────────────────────────────────────────────────

/** 把下载错误压成一句人话（给群友看，不带技术细节） */
export function briefFailure(e) {
  const m = String(e?.message ?? e ?? '');
  // 截断/坏 JSON：接口响应过大被截、返回风控页等——重试可能好
  if (/截断|Unterminated|not valid JSON|Unexpected token|Unexpected end/i.test(m)) return '抖音那边返回的数据不完整，稍后再试一次';
  if (/大小上限/.test(m)) return '这个视频太大了，超出下载大小上限，下不了';
  if (/ttwid|空响应|cookie/i.test(m)) return '抖音视频解析不了（接口凭证过期了），稍后再试或让管理员更新插件配置里的 cookie';
  if (/已删除|私密|不存在|status_code/i.test(m)) return '这个视频取不到（可能已删除或设为私密）';
  if (/图文|第 \d+ 张图/.test(m)) return '这条抖音是图文帖，图片没取到，稍后再试';
  if (/时长|上限/.test(m)) return '这个视频太长了，超过下载时长上限，下不了';
  if (/无效的视频 id|没有找到抖音|识别抖音|不是抖音/.test(m)) return '这个视频链接解析不了（可能消息指错了，或不是抖音视频）';
  if (/不是视频|风控|非 JSON/.test(m)) return '抖音那边没给视频地址（可能被风控了），稍后再试';
  if (/正在下载中/.test(m)) return '这个视频正在下载，稍等就好';
  // 兜底：抹掉 host:port / URL，避免内部地址/链接随报错漏进群（与 bili.js 同策略）
  const clean = m.replace(/https?:\/\/\S+/g, '该地址').replace(/[\w.-]+:\d{2,5}\b/g, '抖音节点').replace(/\s+/g, ' ').slice(0, 30);
  return `下载失败（${clean}），稍后再试`;
}

/** 失败极简提示。同原因 10 分钟去重，异常不影响主流程。 */
export const notifyFailure = createFailureNotifier(briefFailure);
