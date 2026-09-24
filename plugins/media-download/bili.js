// B站访问与下载公共库
//
// 供 data/plugins/ 下 B站相关插件共用：
//   · bilibili-video  —— 群友分享 B站视频 → 自动下载发送
//   · bili-music      —— @机器人 说「我想听 xxx」→ 搜索最相关的音乐视频下载发送
// 两个插件各自独立配置（sessdata / 画质 / 时长上限），但下载管道只有一份：
// 下载逻辑排查只改这里，不用在两个插件里各改一遍。
//
// ── 搜索接口实测结论（2026-09-11）──
//   ① 匿名 /x/web-interface/search/type             → 返回 HTML 风控页，不可用
//   ② 带 SESSDATA /x/web-interface/search/type      → 仍返回 HTML，旧端点已废弃
//   ③ 带 SESSDATA /x/web-interface/wbi/search/type + WBI 签名 → code:0，正常返回 20 条 ✅
//   ⇒ 搜索**必须**走 WBI 签名端点 + SESSDATA，没有退化路径。
//
// ── 相关度排序实测结论 ──
//   B站返回的默认相关度排序对歌曲查询**不可用**：
//     「高松灯 落花流水」前 5 名无一是正确答案（有陈奕迅版、千早爱音翻唱、AI高松灯雨爱）
//     「晴天」前 2 名是 222 分钟 / 40 分钟的合集
//   ⇒ 必须自己做「时长硬门槛 + 标题命中度 + 热度」打分，不能取第 1 名。
//
// 依赖：
//   · safe-fetch（防 SSRF，B站 CDN 是公网不会拦）
//   · ffmpeg（DASH 分轨合流需要；没装则降级 FLV 单流，画质低但有声音）
//   · SESSDATA（搜索必需；下载时能拿高清，不填则 480P/720P）
//
// 安全：公共库供管理员放入 data/plugins/ 的可信插件调用，与内置工具同信任级。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeFetch } from '../../src/safe-fetch.js';
import { safeFetchToFile } from './media-common.js';
import { resolveParam, sleep, safeName, cleanupDir, createFailureNotifier } from './media-common.js';

export const CACHE_DIR = path.join(process.cwd(), 'data', 'media-cache', 'bilibili');
const execFileAsync = promisify(execFile);
// 小件（参数解包/文件名安全化/目录清扫/失败通知）收口在 media-common.js，这里 re-export 保持插件契约
export { resolveParam, sleep, safeName };

// B站 API / CDN 请求头（Referer 是防盗链关键，少一个 403）
export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function biliHeaders(referer, sessdata) {
  const h = { 'User-Agent': BILI_UA, 'Referer': referer || 'https://www.bilibili.com' };
  if (sessdata) h['Cookie'] = `SESSDATA=${sessdata}`;
  return h;
}

/**
 * 抓取 B站 API 的 JSON 响应：统一"截断检查 + 解析"。
 *
 * ⚠️ 必须检查 truncated：safe-fetch 读到 maxBytes 上限会**静默截断**并正常返回，
 * 截断的 JSON 必然解析失败（2026-09-12 群里 BV1cEY26pEoD 的
 * "Unterminated string in JSON at position 177329" 就是 playurl 清单超过
 * 200KB 被截断所致）。在这里拦下并给出明确错误，而不是让 JSON.parse 掷骰子。
 */
async function biliJson(url, { maxBytes = 1024 * 1024, referer = '', sessdata = '', timeoutMs = 15000 } = {}) {
  // 凭证兜底防线：SESSDATA 只发给 B站自家域（hostAllowedForCookie）。
  // biliJson 的目标全部是 api.bilibili.com，这里恒为真；未来若新增非 B站域调用，
  // 凭证也不会跟着请求（连同 safe-fetch 的跨域重定向剥离形成双保险）。
  const res = await safeFetch(url, { timeoutMs, headers: biliHeaders(referer, hostAllowedForCookie(url) ? sessdata : ''), maxBytes });
  if (res.truncated) {
    throw new Error(`B站接口响应超过读取上限（${Math.round(maxBytes / 1024)}KB）被截断，拿不到完整数据`);
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error(`B站接口返回了非 JSON 内容（可能被风控，${e?.message ?? e}）`);
  }
}

/** 剥离搜索结果里的 HTML 标签（title 常含 <span class="keyword">…</span>）。 */
export function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/** B站 duration 字符串（"4:6" / "1:0" / "222:28" / "1:02:03"）→ 秒。 */
export function parseDuration(s) {
  const parts = String(s || '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// ── ffmpeg ─────────────────────────────────────────────────────────────

// ffmpeg 可用性缓存（进程级，只查一次；reloadPlugins 重导会清空）
let ffmpegPath = undefined;
export async function findFfmpeg(customPath) {
  if (ffmpegPath !== undefined) return ffmpegPath;
  // ① 用户在插件配置里指定的路径
  if (customPath && fs.existsSync(customPath)) {
    try {
      await execFileAsync(customPath, ['-version'], { timeout: 5000 });
      ffmpegPath = customPath;
      return ffmpegPath;
    } catch { /* 路径存在但执行失败，继续往下找 */ }
  }
  // ② 系统 PATH 里的 ffmpeg
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegPath = 'ffmpeg';
    return ffmpegPath;
  } catch { /* PATH 里没有 */ }
  // ③ 常见自带位置（B站桌面客户端等 —— B站自带 3.x，足够做 -c copy 合流）
  const bundled = [
    path.join(process.env.APPDATA || '', 'bilibili', 'ffmpeg', 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'bilibili', 'ffmpeg', 'ffmpeg.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe')
  ];
  for (const p of bundled) {
    try {
      if (fs.existsSync(p)) {
        await execFileAsync(p, ['-version'], { timeout: 5000 });
        ffmpegPath = p;
        return ffmpegPath;
      }
    } catch { /* skip */ }
  }
  ffmpegPath = '';
  return ffmpegPath;
}

// ── BV 号解析 ──────────────────────────────────────────────────────────

/** 从字符串里提取 BV 号 */
export function extractBvid(str) {
  const m = String(str).match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

/** AV 号 → BV 号：走 B站 API 转换（比本地算法更可靠，B站 API 同时接受 aid 和 bvid） */
export async function avToBvViaApi(av, sessdata) {
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/view?aid=${av}`, {
    maxBytes: 1024 * 1024, sessdata
  });
  if (data.code === 0 && data.data?.bvid) return data.data.bvid;
  return null;
}

/** b23.tv 短链 → 跟重定向拿最终 URL → 提取 BV 号。
 *  ⚠️ 不带 SESSDATA：解析只需跟随重定向，匿名即可；凭证跟着任意请求走是泄漏面。 */
export async function resolveB23(shortUrl) {
  const { url: final } = await safeFetch(shortUrl, { timeoutMs: 10000, headers: biliHeaders(null) });
  return extractBvid(final) || extractBvid(shortUrl);
}

/**
 * 把模型传入的参数解析成 BV 号。
 *   args.messageId → 调 getMsg 拿原始消息段 → 从 json/text 段提取 BV
 *   args.url      → 直接从链接/BV 号提取；b23 短链自动跟重定向
 *
 * @param {object} args 工具入参 { messageId?, url? }
 * @param {object} deps { onebot, sessdata }
 */
export async function resolveBvid(args, { onebot }) {
  // ⚠️ 解析路径全程不带 SESSDATA：BV 号解析（b23 重定向 / 页面重定向 / av→BV API）
  // 匿名即可完成。曾经这里把管理员的 SESSDATA 发给消息里出现的**任意第三方 URL**
  // （"任意 URL 兜底"分支 + safeFetch 跟随跨域重定向复用同一份 headers），
  // 群友一条消息就能偷走登录态。需要凭证的只有下载/搜索路径，且已用
  // hostAllowedForCookie 限定 B站自家域。

  // ① messageId 优先：拿原始段，扫所有段类型找 B站链接
  //    小程序卡片可能是 json/markdown/未知段，统一 stringify 后正则搜索
  if (args.messageId != null && String(args.messageId).trim() !== '') {
    const mid = String(args.messageId).replace(/^#/, '').trim();
    const msg = await onebot.getMsg(mid);
    // 段数组/raw_message/message_content 三种 OneBot 形态的兼容与转义清理收口在 onebot.js
    const combined = flattenMessageToText(msg);

    // BV 号最直接（全局搜索所有段数据）
    const bv = extractBvid(combined);
    if (bv) return bv;
    // b23 短链 → 跟重定向
    const b23 = combined.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/);
    if (b23) return await resolveB23(b23[0]);
    // bilibili.com/video/ 链接 → URL 里通常含 BV 号
    const biliUrl = combined.match(/https?:\/\/[^\s"'<>]*bilibili\.com\/video\/[^\s"'<>]*/);
    if (biliUrl) {
      const bv2 = extractBvid(biliUrl[0]);
      if (bv2) return bv2;
      // URL 里没 BV → 跟重定向
      const { url: final } = await safeFetch(biliUrl[0], { timeoutMs: 10000, headers: biliHeaders(null) });
      const bv3 = extractBvid(final);
      if (bv3) return bv3;
    }
    // AV 号（av12345678）→ 走 API 转 BV
    const avMatch = combined.match(/av(\d{6,})/i);
    if (avMatch) {
      const bvid = await avToBvViaApi(Number(avMatch[1]));
      if (bvid) return bvid;
    }
    // 任意 http URL → 跟重定向碰运气（小程序可能用中间跳转页）
    const anyUrl = combined.match(/https?:\/\/[^\s"'<>]{10,}/);
    if (anyUrl && !/bilibili\.com|b23\.tv/i.test(anyUrl[0])) {
      try {
        const { url: final } = await safeFetch(anyUrl[0], { timeoutMs: 10000, headers: biliHeaders(null) });
        // safeFetch 已跟随全部重定向到终点，final 即最终 URL，无需再请求一次
        const bv4 = extractBvid(final);
        if (bv4) return bv4;
      } catch { /* 中间页打不开，跳过 */ }
    }
    // 全没命中：记录卡片原始数据方便诊断
    console.error('[bili] 无法提取 BV 号，卡片原始数据:\n', combined.slice(0, 2000));
    throw new Error('这条消息里没有找到 B站 视频链接（很可能是 messageId 指错了消息：检查是否指到了「B站分享」卡片那条；也可以直接传 url 或 BV 号，不要对非B站消息调用本工具）。');
  }

  // ② 直接 url / bvid
  const src = String(args.url || '').trim();
  if (!src) throw new Error('请提供 messageId 或 url');
  if (/^BV[0-9A-Za-z]{10}$/.test(src)) return src;
  const bv = extractBvid(src);
  if (bv) return bv;
  if (/b23\.tv/.test(src)) return await resolveB23(src);
  if (/bilibili\.com/.test(src)) {
    const bv2 = extractBvid(src);
    if (bv2) return bv2;
    // URL 里没 BV（可能是 av 号旧链）→ 跟重定向拿最终 URL
    const { url: final } = await safeFetch(src, { timeoutMs: 10000, headers: biliHeaders(null) });
    const bv3 = extractBvid(final);
    if (bv3) return bv3;
  }
  throw new Error('无法从输入中识别 B站视频链接或 BV 号');
}

// ── WBI 签名与搜索 ─────────────────────────────────────────────────────

// WBI 密钥混淆表（B站前端固定的 64 位重排表，取前 32 位与 mixin_key 对齐）
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

// 密钥缓存：sessdata -> { mixin, at }。密钥变更不频繁，10 分钟内复用。
const mixinCache = new Map();
const MIXIN_TTL = 10 * 60 * 1000;

/** 取 WBI mixin_key（从 nav 接口拿 img_key/sub_key 后按混淆表重排取前 32 位）。 */
export async function getWbiMixinKey(sessdata) {
  const cached = mixinCache.get(sessdata);
  if (cached && Date.now() - cached.at < MIXIN_TTL) return cached.mixin;

  const j = await biliJson('https://api.bilibili.com/x/web-interface/nav', { maxBytes: 200000, sessdata });
  const imgKey = String(j.data?.wbi_img?.img_url || '').split('/').pop() || '';
  const subKey = String(j.data?.wbi_img?.sub_url || '').split('/').pop() || '';
  const orig = imgKey.replace(/\.png$/, '') + subKey.replace(/\.png$/, '');
  if (orig.length < 32) throw new Error('无法获取 WBI 密钥（SESSDATA 可能失效，请在插件配置里更新）');
  const mixin = MIXIN_KEY_ENC_TAB.slice(0, 32).map((i) => orig[i] || '').join('');
  mixinCache.set(sessdata, { mixin, at: Date.now() });
  return mixin;
}

/**
 * 给参数加 WBI 签名：剔除 w_rid/wts，value 过滤 `!'()*`，按 key 字典序 urlencode，
 * 加 wts=当前秒，w_rid = md5(query + mixin_key)。
 */
export function signWbi(params, mixin) {
  const p = { ...params };
  delete p.w_rid;
  delete p.wts;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) query.set(k, String(v).replace(/[!'()*]/g, ''));
  const entries = [...query.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const qs = new URLSearchParams(entries).toString();
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = crypto.createHash('md5').update(qs + mixin).digest('hex');
  return { ...p, wts, w_rid };
}

/**
 * B站关键词搜索。
 *
 * ⚠️ 必须走 WBI 签名端点 + SESSDATA —— 匿名或旧端点 /search/type 已返回 HTML 风控页，不可用。
 *
 * @returns {Promise<Array<{bvid,title,author,play,duration,desc,review}>>} 按 B站默认相关度排序的候选
 */
export async function searchVideos(keyword, { sessdata = '', searchType = 'video', page = 1, limit = 20 } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  if (!sessdata) {
    throw new Error('B站搜索需要 SESSDATA（在插件配置里填）：B站 已风控匿名搜索，不填令牌拿不到结果');
  }
  const mixin = await getWbiMixinKey(sessdata);
  const signed = signWbi({ keyword: kw, search_type: searchType, page: String(page) }, mixin);
  const qs = new URLSearchParams(signed).toString();
  const j = await biliJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, {
    maxBytes: 1024 * 1024, referer: 'https://www.bilibili.com', sessdata, timeoutMs: 15000
  });
  if (j.code !== 0) throw new Error(`B站搜索: ${j.message || j.code}`);
  const arr = j.data?.result || [];
  return arr.slice(0, Math.max(1, Number(limit) || 20)).map((r) => ({
    bvid: r.bvid,
    aid: r.aid,
    title: stripHtml(r.title || ''),
    author: r.author || '',
    play: Number(r.play) || 0,
    duration: String(r.duration || ''),
    desc: stripHtml(r.description || ''),
    review: Number(r.review) || 0
  }));
}

// 关键词里的信号词：表达意图但不参与标题匹配（"我想听XX唱YY" 里的"我想听""唱"都不该算命中）
const SIGNAL_WORDS = new Set([
  '我想听', '想听', '来首', '来一首', '来点', '放一首', '播放', '单曲循环', '这首歌', '这首',
  '唱', '唱歌', '歌', '歌曲', '音乐', '一首', '点', '听', '给我', '一下', '下', '的', '了', '把'
]);

/**
 * 对搜索结果打分排序。
 *
 * 打分依据（按优先级）：
 *   ① 时长硬门槛 —— 音乐通常在 1~8 分钟；过滤掉 15 秒片段和 40/222 分钟合集
 *   ② 标题命中度 —— 完整关键词 > 全部分词命中 > 部分命中；标题一个词都不含的直接淘汰
 *   ③ 热度（log 播放量）—— 同分时的 tiebreaker：热门 ≈ 大家公认的那版
 *
 * 实测依据：B站默认相关度排序对歌曲查询不可用（「高松灯 落花流水」前 5 名无一正确），
 * 所以必须自己打分，不能直接取第 1 名。
 *
 * @returns {Array<{item,title,dur,hit,heat,score}>} 按 score 降序；已过滤掉的不在结果里
 */
export function rankCandidates(results, keyword, opts = {}) {
  // 注意单位：maxDurationMin 是「分钟」，这里转秒。最小 1 分钟 = 60 秒。
  const minSec = Math.max(0, Number(opts.minDurationSec) || 60);
  const maxSec = Math.max(1, Number(opts.maxDurationMin) || 6) * 60;

  const tokens = [...new Set(
    String(keyword || '')
      .split(/[\s,，、\/|｜]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !SIGNAL_WORDS.has(t))
  )];
  if (!tokens.length) throw new Error('关键词里没有找到可搜索的歌名或歌手（只剩「我想听」「唱」这类词，请给出具体歌名）');

  const kwNorm = String(keyword || '').replace(/\s+/g, '');
  const scored = [];
  for (const r of results) {
    if (!r?.bvid) continue;
    const title = r.title || '';
    const dur = parseDuration(r.duration);
    // ① 时长硬门槛
    if (dur < minSec || dur > maxSec) continue;
    // ② 标题命中度
    const titleNorm = title.replace(/\s+/g, '');
    let hit;
    if (kwNorm && titleNorm.includes(kwNorm)) hit = 1.0;
    else hit = tokens.filter((t) => titleNorm.includes(t)).length / tokens.length;
    if (hit <= 0) continue;   // 标题一个词都不含 → 不是用户想听的，直接淘汰
    // ③ 热度（log 标度，避免百万播放量碾压一切）
    const heat = Math.log10(Math.max(1, Number(r.play) || 0));
    scored.push({
      item: r, title, dur, hit, heat,
      score: hit * 100 + (hit === 1.0 ? 10 : 0) + heat * 3
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** 秒 → "X分Y秒" */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

/** 把候选列表压成给模型/群友看的文本（供找不到理想结果时列出备选）。 */
export function formatCandidates(candidates, limit = 3) {
  if (!candidates?.length) return '';
  return candidates.slice(0, limit)
    .map((c, i) => `${i + 1}) 《${c.title.slice(0, 40)}》-${c.item.author}（${fmtDuration(c.dur)}，${c.item.play >= 10000 ? `${Math.round(c.item.play / 10000)}万播放` : `${c.item.play}播放`}）`)
    .join('\n');
}

// ── 视频信息与播放地址 ─────────────────────────────────────────────────

/** 取视频信息（标题/cid/时长）。超长简介/多 P 的 view 响应也会很大，上限 1MB + 截断检查。 */
export async function getVideoInfo(bvid, sessdata) {
  const data = await biliJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    maxBytes: 1024 * 1024, referer: `https://www.bilibili.com/video/${bvid}`, sessdata
  });
  if (data.code !== 0) throw new Error(`B站 API: ${data.message || data.code}`);
  return data.data;  // { bvid, aid, cid, title, duration, pic, owner, stat }
}

/** 取播放地址：fnval=16 → DASH（分轨）；fnval=1 → FLV durl（单流含音）。
 *
 * ⚠️ maxBytes 必须 4MB 起步：DASH 清单包含全部画质 + 每条流十几个 backup_url，
 * 大视频的清单轻松超过 200KB（2026-09-12 BV1cEY26pEoD 即被 200KB 截断报
 * "Unterminated string in JSON"）。截断在 biliJson 里显式报错。
 */
export async function getPlayUrl(bvid, cid, fnval, sessdata) {
  const data = await biliJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=${fnval}&fnver=0&fourk=1`,
    { maxBytes: 4 * 1024 * 1024, referer: `https://www.bilibili.com/video/${bvid}`, sessdata }
  );
  if (data.code !== 0) throw new Error(`B站 playurl: ${data.message || data.code}`);
  return data.data;
}

/** 把流的候选地址压成有序数组（主地址在前，backup_url 在后），去重。
 *
 * B站 playurl 给每个流都带 `backup_url`（备选 CDN 节点）。实测（2026-09-11，
 * BV1Actq6LEAM / BV17kYu63EkC 的真实群分享）：
 *   · 主地址落在 `*.mcdn.bilivideo.cn:8082` 段时**整段不可达** —— 8s 试连超时
 *   · 同一资源的 backup_url 指向 `*.bilivideo.com` / `upos-sz-mirror*` 时 37ms 连上
 * 所以候选列表必须带上 backup_url，否则死节点无解。
 */
export function streamCandidates(url, backups) {
  const out = [];
  for (const u of [url, ...(Array.isArray(backups) ? backups : [])]) {
    if (typeof u === 'string' && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Cookie 域白名单：SESSDATA 只发给 B站自家域。
 * 浏览器播放器本来也不会把 SESSDATA 带到 bilivideo CDN（视频靠 Referer 防盗链），
 * 收紧后与浏览器行为一致，避免登录态跟随 backup_url 外流到第三方镜像域名。
 */
export function hostAllowedForCookie(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /(^|\.)(bilibili\.com|bilivideo\.com|bilivideo\.cn|hdslb\.com)$/.test(h);
  } catch {
    return false;
  }
}

/** 下载内容魔数校验（视频/流分段）。CDN 返回风控页/HTML 时拦下，不把垃圾当视频发群。
 * DASH 的 m4s 分段与 MP4 同为 ISO-BMFF（偏移 4 处 'ftyp'），一并接受。 */
export function videoMagicType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.subarray(0, 3).toString('latin1') === 'FLV') return 'flv';
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  return null;
}

/** 读文件头 16 字节做魔数校验（不把大文件整读进内存）。 */
export function fileMagicType(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(16);
    const n = fs.readSync(fd, b, 0, 16, 0);
    return videoMagicType(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/** 下载流直接落盘（流式，内存占用恒定）。返回 { bytes, contentType }。
 *
 * streamUrl 可传单个 URL 字符串，或候选数组（主地址 + backup_url，见 streamCandidates）。
 *
 * 失败策略：**逐候选各试 1 次**，连接类失败立刻换下一个 CDN 节点。
 *   旧版在同址重试 3 次，注释假设"节点会轮换"——但固定 CDN URL 不会轮换，
 *   死节点上重试 3 次 = 白等 ~63 秒后照样失败（2026-09-11 群里两次事故均如此）。
 * 只有候选只剩 1 个（没有 backup）时才在同址重试，保留瞬断容错。
 * HTTP 4xx/5xx、字节超限、空流不重试（重试无意义）。
 */
export async function downloadStreamToFile(streamUrl, outPath, maxBytes, bvid, sessdata) {
  // 传字符串 = 单候选（旧调用方式兼容）；传数组 = 主 + backup 候选
  const urls = (Array.isArray(streamUrl) ? streamUrl : [streamUrl])
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
  if (!urls.length) throw new Error('没有可用的流地址');

  const referer = `https://www.bilibili.com/video/${bvid}`;
  const triesPerUrl = urls.length > 1 ? 1 : 3;
  let lastErr = null;

  for (let i = 0; i < urls.length; i++) {
    for (let attempt = 1; attempt <= triesPerUrl; attempt++) {
      try {
        const res = await safeFetchToFile(urls[i], outPath, maxBytes, {
          timeoutMs: 240000,   // 大文件给足下载时间
          headers: biliHeaders(referer, hostAllowedForCookie(urls[i]) ? sessdata : '')
        });
        if (!res.bytes) throw new Error('下载到的视频流为空');
        if (i > 0) console.log(`[bili] 主 CDN 不可用，已改用备用节点 ${i + 1}/${urls.length} 下载成功`);
        return res;
      } catch (error) {
        lastErr = error;
        const m = String(error?.message ?? error ?? '');
        const retryable = /ETIMEDOUT|ECONN[A-Z]+|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|请求超时|timeout|超时/i.test(m);
        if (retryable && attempt < triesPerUrl) {
          console.log(`[bili] 流下载连接失败，同址重试 ${attempt + 1}/${triesPerUrl}: ${m.slice(0, 90)}`);
          await sleep(800 * attempt);
          continue;
        }
        break;   // 这个节点试不动了，换下一个候选
      }
    }
    if (i < urls.length - 1) {
      console.log(`[bili] CDN 节点 ${i + 1}/${urls.length} 不可用，换 backup_url 节点`);
    }
  }
  throw lastErr;
}

/** DASH 视频流选择。preferHigh=false 选最低码率(省流量)，true 选最高码率(画质最好)。优先 H.264(codecid=7) 兼容性。 */
export function pickVideoStream(arr, preferHigh = false) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let pool = arr.filter((s) => s.codecid === 7);
  if (!pool.length) pool = arr;
  const sorted = [...pool].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
  return preferHigh ? sorted[sorted.length - 1] || null : sorted[0] || null;
}

/** DASH 音频流选最低码率 */
export function pickAudioStream(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return [...arr].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0] || null;
}

/** 清理 1 小时前的缓存文件 */
export function cleanupOldFiles() {
  cleanupDir(CACHE_DIR, 60 * 60 * 1000);
}

// ── 下载并发控制 ───────────────────────────────────────────────────────

// 全局去重：同一个 BV 号正在下载时不重复（两个插件共用，避免同时下同一个视频）
export const inFlight = new Set();

/** 把下载错误压成一句极简中文（给群友看，不带技术细节）。
 *
 * ⚠️ 网络类错误必须显式映射：旧版没有这个分支，`connect ETIMEDOUT 115.56.95.6:8082`
 * 会被兜底原样发进群，等于把内部 CDN 的 IP:端口泄露给群友（2026-09-11 群里出现两次）。
 * 管理员要看原始错误请看日志（[bilibili-video] 自动下载失败: ...）。
 */
export function briefFailure(e) {
  const m = String(e?.message ?? e ?? '');
  // 截断/坏 JSON：playurl 清单过大被截（已调大上限兜底）、CDN 返回风控页等——重试可能好
  if (/截断|Unterminated|not valid JSON|Unexpected token|Unexpected end|非 JSON/i.test(m)) return 'B站那边返回的数据不完整，稍后再试一次';
  if (/大小上限/.test(m)) return '这个视频太大了，超出下载大小上限，下不了';
  if (/啥都木有|code=-404|-404/.test(m)) return '这个视频下载不了（B站那边已失效/私密，发不了）';
  if (/时长|上限/.test(m)) return '这个视频太长了，超过下载时长上限，下不了';
  if (/无法从输入中识别|无法解析|识别.*BV|没有找到 B站|没有 B站 视频链接/.test(m)) return '这个视频链接解析不了（可能消息指错了，或不是B站视频）';
  if (/SESSDATA|WBI|密钥/.test(m)) return 'B站搜索配置有问题（缺 SESSDATA 或令牌失效），请找管理员在插件配置里更新';
  if (/关键词/.test(m)) return '没识别出要听的歌名，换个说法再试试';
  if (/ETIMEDOUT|ECONN[A-Z]+|EHOSTUNREACH|ENETUNREACH|socket hang up|请求超时|fetch failed|流为空|没有可用的流地址/.test(m)) {
    return 'B站那边现在连不上，稍后再试一次';
  }
  if (/正在下载中/.test(m)) return '这个视频正在下载，稍等就好';
  // 兜底：抹掉 host:port / URL，避免将来新增的错误类型又把原始信息发到群里
  const clean = m.replace(/https?:\/\/\S+/g, '该地址').replace(/[\w.-]+:\d{2,5}\b/g, 'B站节点').replace(/\s+/g, ' ').slice(0, 30);
  return `下载失败（${clean}），稍后再试`;
}

/** 失败极简提示。同原因 10 分钟去重，异常不影响主流程。 */
export const notifyFailure = createFailureNotifier(briefFailure);

/**
 * 下载 B站视频并以视频消息发送。两个插件共用这一个下载管道。
 *
 * @param {string} bvid BV 号
 * @param {object} deps { onebot, kind, chatId, params, sender }
 *   params: { sessdata, maxDurationMin, maxBytes, preferQuality, ffmpegPath, preferDash }
 *   sender: 核心注入的发送队列（SendQueue）；给了它才算"正规发送"（限频/去重/留档）
 * @returns {Promise<{title,dur,filePath}>}
 */
export async function downloadAndSend(bvid, { onebot, kind, chatId, params = {}, sender = null }) {
  if (inFlight.has(bvid)) throw new Error(`视频 ${bvid} 正在下载中，请勿重复操作`);
  inFlight.add(bvid);
  try {
    const p = params;
    const sessdata = String(resolveParam(p, 'sessdata', '') || '').trim();
    const maxBytes = Math.max(5 * 1024 * 1024, Number(resolveParam(p, 'maxBytes', 50331648)) || 50331648);
    const maxDurMin = Math.max(1, Number(resolveParam(p, 'maxDurationMin', 10)) || 10);
    const preferHigh = String(resolveParam(p, 'preferQuality', 'low') || 'low') === 'high';

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cleanupOldFiles();

    // ① 视频信息
    const info = await getVideoInfo(bvid, sessdata);
    const title = String(info.title || bvid).slice(0, 100);
    const dur = Number(info.duration) || 0;
    if (dur > maxDurMin * 60) {
      throw new Error(`视频《${title}》时长 ${Math.round(dur / 60)} 分钟，超过 ${maxDurMin} 分钟上限，已跳过`);
    }

    // ② 播放地址
    const ffmpeg = await findFfmpeg(String(resolveParam(p, 'ffmpegPath', '') || '').trim());
    const useDash = !!(ffmpeg && resolveParam(p, 'preferDash', true) !== false);
    const playData = await getPlayUrl(bvid, info.cid, useDash ? 16 : 1, sessdata);

    const baseName = `${safeName(title)}_${bvid}`;
    let outPath;

    if (useDash && playData.dash) {
      const vStream = pickVideoStream(playData.dash.video, preferHigh);
      if (!vStream) throw new Error('找不到可用的视频流');
      const aStream = pickAudioStream(playData.dash.audio);
      // 候选列表 = 主地址 + backup_url：死节点（实测 mcdn.bilivideo.cn:8082 整段不可达）时自动换 CDN
      const vUrl = streamCandidates(vStream.baseUrl || vStream.base_url, vStream.backup_url);
      outPath = path.join(CACHE_DIR, `${baseName}.mp4`);
      if (aStream) {
        const aUrl = streamCandidates(aStream.baseUrl || aStream.base_url, aStream.backup_url);
        // 音频上限与视频同额：旧版音频硬编码 5MB，128kbps 下 6 分钟就 5.6MB，
        // 会被静默截断成半截音频（safeFetchBinary 截断返回的老行为），合出来视频短一截
        const vFile = outPath + '.v', aFile = outPath + '.a';
        try {
          await Promise.all([
            downloadStreamToFile(vUrl, vFile, maxBytes, bvid, sessdata),
            downloadStreamToFile(aUrl, aFile, maxBytes, bvid, sessdata)
          ]);
          // 内容校验：DASH 分段与 MP4 同为 ftyp；CDN 返回风控页/HTML 在这里拦下（对齐抖音侧）
          for (const [label, f] of [['视频流', vFile], ['音频流', aFile]]) {
            if (!fileMagicType(f)) throw new Error(`下载到的${label}不是音视频内容（CDN 可能返回了风控页）`);
          }
          await execFileAsync(ffmpeg, ['-i', vFile, '-i', aFile, '-c', 'copy', '-y', outPath], { timeout: 60000 });
        } finally {
          // 中间分段无论成败都清理（旧版 ffmpeg 抛错时 .v/.a 会泄漏到 1 小时后）
          try { fs.unlinkSync(vFile); } catch { }
          try { fs.unlinkSync(aFile); } catch { }
        }
      } else {
        await downloadStreamToFile(vUrl, outPath, maxBytes, bvid, sessdata);
        if (!fileMagicType(outPath)) {
          try { fs.unlinkSync(outPath); } catch { }
          throw new Error('下载到的视频流不是视频内容（CDN 可能返回了风控页）');
        }
      }
    } else if (playData.durl && playData.durl.length) {
      const part = playData.durl[0];
      // 先落 .raw，魔数定扩展名（CDN 的 content-type 不可信，旧版按它定 ext 会错名）
      const rawPath = path.join(CACHE_DIR, `${baseName}.raw`);
      const { contentType } = await downloadStreamToFile(
        streamCandidates(part.url, part.backup_url), rawPath, maxBytes, bvid, sessdata);
      const magic = fileMagicType(rawPath);
      if (!magic) {
        try { fs.unlinkSync(rawPath); } catch { }
        throw new Error(`下载内容不是视频（CDN 返回 ${contentType || '未知类型'}，魔数校验未通过）`);
      }
      const ext = magic === 'flv' ? '.flv' : magic === 'webm' ? '.webm' : '.mp4';
      outPath = path.join(CACHE_DIR, `${baseName}${ext}`);
      fs.renameSync(rawPath, outPath);
      if (ffmpeg && ext === '.flv') {
        const mp4Path = path.join(CACHE_DIR, `${baseName}.mp4`);
        await execFileAsync(ffmpeg, ['-i', outPath, '-c', 'copy', '-y', mp4Path], { timeout: 60000 });
        try { fs.unlinkSync(outPath); } catch { }
        outPath = mp4Path;
      }
    } else {
      throw new Error('B站未返回可用的视频流');
    }

    // ③ 发送：优先走核心的发送队列（限频 / 去重 / 留档都在这条链路上）。
    //    绕过去直发会跳过限频与留档 —— 媒体把配额吃光后文字突然发不出，
    //    而且下一次运行不知道自己发过。sender 缺失时退回直发，仅为让本模块能独立复用。
    const segments = [{ type: 'video', data: { file: outPath } }];
    if (sender?.sendMedia) {
      await sender.sendMedia(`${kind}:${chatId}`, segments, { label: `[视频:${title.slice(0, 30)}]` });
    } else if (onebot?.sendSegments) {
      await onebot.sendSegments(kind, chatId, segments);
    }
    setTimeout(() => { try { fs.unlinkSync(outPath); } catch { } }, 120000);

    return { title, dur, filePath: outPath };
  } finally {
    inFlight.delete(bvid);
  }
}
