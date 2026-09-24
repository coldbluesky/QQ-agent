// 搜图（找图并发到群里）。
//
// 设计目标（按需求）：
//   1. 能"以图库的方式搜图"：默认接 pixiv（无需登录即可搜/取公开作品），
//      同时内置 safebooru / konachan / yandere，并支持自定义接口。
//   2. **默认屏蔽 AI 生成图**：pixiv 的 aiType 字段是官方标注，最准；
//      图库站则按标签（ai生成 / aiイラスト / ai_generated / -ai）过滤。
//      过滤不只靠站点，本模块在汇总时**统一再过一遍**，避免某个源漏标。
//   3. 绝不把外部图床的链接直接交给 OneBot 去抓：
//      所有图片先经 safe-fetch 校验并下载，再由发送层决定用 URL 还是 base64。
//
// 数据流：searchImages() → 归一化条目 → 过滤（AI/分级/重定向）→ sendImage()
import { getConfig } from './config.js';
import { safeFetchBinary, validateImageUrl } from './safe-fetch.js';
import { sanitizeQuery } from './web-search.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 把请求头里的非 ASCII 字符剔除。
 *
 * 为什么必须做：Node 的 fetch（undici）要求头值必须是 ByteString（每个字符 ≤ 255），
 * 否则直接抛一个**极难看懂**的错：
 *   Cannot convert argument to a ByteString because the character at index 20
 *   has a value of 8230 which is greater than 255
 * 实测起因：用户从浏览器复制 Cookie 时把一段带省略号（U+2026）的 Google 追踪参数
 * 一起粘了进来 → 每次搜图都在发头那一步炸掉，而报错完全指不到"Cookie 有问题"。
 * 这里统一净化 + 顺手把明显的脏值挑出来报错，让用户知道该改哪儿。
 */
export function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[^\t\x20-\x7E\x80-\xFF]/g, '').replace(/[\r\n]/g, ' ').trim();
}

/** 给用户看的"这个头有问题"提示（含首个非法字符的位置，便于对照修改）。 */
export function describeHeaderProblem(name, value) {
  const s = String(value ?? '');
  const idx = [...s].findIndex((c) => c.charCodeAt(0) > 255);
  if (idx < 0) return '';
  const ch = [...s][idx];
  const code = ch.charCodeAt(0);
  return `${name} 里有非 ASCII 字符（第 ${idx + 1} 个字符是 ${JSON.stringify(ch)}，U+${code.toString(16).toUpperCase()}），`
    + '它会让请求头构造失败。多半是从浏览器复制时带进了网页上的省略号/中文说明 —— '
    + '请只复制 Cookie 的值本身（形如 `PHPSESSID=xxx; device_token=yyy`），别带上页面上的其他文字。';
}

/** 净化一组请求头，并返回其中的问题说明（用于给出可读错误）。 */
function safeHeaders(headers = {}) {
  const cleaned = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase().trim();
    if (!key || v === undefined || v === null) continue;
    cleaned[key] = sanitizeHeaderValue(v);
  }
  return cleaned;
}

// ── 配置 ────────────────────────────────────────────────────────────────

/** 把 config.imageSearch 归一化成带默认值的结构（所有读取都走这里）。 */
export function imageSearchConfig() {
  const raw = getConfig().imageSearch || {};
  const providers = (Array.isArray(raw.providers) ? raw.providers : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      id: String(p.id || '').trim(),
      name: String(p.name || p.id || '自定义图源').trim(),
      type: String(p.type || 'custom').trim(),
      baseUrl: String(p.baseUrl || '').trim(),
      apiKey: String(p.apiKey || '').trim(),
      cookie: String(p.cookie || '').trim(),
      timeoutMs: Math.max(3000, Number(p.timeoutMs) || 15000)
    }))
    .filter((p) => p.id);
  const perChat = (raw.perChat && typeof raw.perChat === 'object' && !Array.isArray(raw.perChat)) ? raw.perChat : {};
  return {
    enabled: raw.enabled !== false,
    provider: String(raw.provider || 'pixiv').trim() || 'pixiv',
    providers,
    cookie: String(raw.cookie || '').trim(),
    hideAi: raw.hideAi !== false,
    aiBlockTags: (Array.isArray(raw.aiBlockTags) ? raw.aiBlockTags : [])
      .map((t) => String(t ?? '').trim()).filter(Boolean),
    defaultLimit: Math.min(10, Math.max(1, Number(raw.defaultLimit) || 3)),
    maxDownloadMb: Math.min(30, Math.max(0.5, Number(raw.maxDownloadMb) || 8)),
    timeoutMs: Math.max(3000, Number(raw.timeoutMs) || 15000),
    sendMode: ['auto', 'url', 'base64'].includes(String(raw.sendMode)) ? String(raw.sendMode) : 'auto',
    // 画质：preferOriginal 时发原图（pixiv 原图常有 1~5MB，但清晰得多）；
    // maxImageMb 是"原图太大就退回大图"的上限，避免把 20MB 的图往群里塞。
    preferOriginal: raw.preferOriginal !== false,
    maxImageMb: Math.min(30, Math.max(1, Number(raw.maxImageMb) || 12)),
    minPixels: Math.max(0, Number(raw.minPixels) || 0),
    // 人气（"好不好看"）：sortBy='popular' 时按收藏数排序；minBookmarks 是收藏门槛
    // （0 = 不过滤）。注意：pixiv 搜索接口不返回收藏数，所以这需要逐个作品补查，
    // 会多花 1~3 秒、且每个候选一次请求 —— rankPool 限制最多查多少个。
    sortBy: String(raw.sortBy || 'popular') === 'newest' ? 'newest' : 'popular',
    minBookmarks: Math.max(0, Number(raw.minBookmarks) || 0),
    rankPool: Math.min(60, Math.max(4, Number(raw.rankPool) || 20)),
    // 以图搜图：iqdb / trace.moe 都免 key；SauceNAO 要注册免费 key（最准，能直接给出 pixiv 作品号）
    sauceNaoKey: String(raw.sauceNaoKey || '').trim(),
    allowR18: raw.allowR18 === true,
    perChat
  };
}

/** 某个会话的覆盖配置（config.imageSearch.perChat[chatKey]）。 */
export function imageSearchConfigForChat(chatKey) {
  const cfg = imageSearchConfig();
  const key = String(chatKey || '').trim();
  const over = key && cfg.perChat[key] && typeof cfg.perChat[key] === 'object' ? cfg.perChat[key] : {};
  return {
    ...cfg,
    ...(over.enabled !== undefined ? { enabled: over.enabled !== false } : {}),
    ...(over.provider ? { provider: String(over.provider) } : {}),
    ...(over.hideAi !== undefined ? { hideAi: over.hideAi !== false } : {}),
    ...(over.allowR18 !== undefined ? { allowR18: over.allowR18 === true } : {}),
    ...(over.sendMode ? { sendMode: String(over.sendMode) } : {})
  };
}

// ── AI 图判定与分级 ─────────────────────────────────────────────────────

function normTag(tag) {
  return String(tag ?? '').trim().toLowerCase().replace(/^#/, '');
}

/** 把标签压成便于比较的形态：小写、去掉空格/下划线/连字符/点。 */
function compactTag(tag) {
  return normTag(tag).replace(/[\s_\-．.·]+/g, '');
}

/**
 * 标签是否命中 AI 屏蔽表（默认表 + 设置页自定义）。
 * 判定规则（刻意保守，宁可漏杀不可错杀 —— 把人工图误判成 AI 图会让机器人
 * 明明搜到了却说"没有"，比漏掉一张 AI 图更糟）：
 *   1. 压实后是 "ai" 本身 / "ai" + 已知后缀（art、イラスト、生成、画像、绘…）；
 *   2. 命中内置表或自定义屏蔽词（压实后相等或包含）。
 * 所以 "aiart"、"ai生成"、"aiイラスト" 命中，而 "aim"、"air"、"chair"、"paint" 不命中。
 */
const AI_SUFFIXES = [
  'art', 'arts', 'artwork', 'arts', 'illust', 'illustration', 'illustrations', 'drawing', 'drawings',
  'paint', 'painting', 'paintings', 'image', 'images', 'pic', 'pics', 'picture', 'pictures',
  'girl', 'girls', 'boy', 'waifu', 'generated', 'generate', 'generation', 'image', 'photo',
  'イラスト', '画像', '生成', '作画', '繪', '绘', '绘画', '繪圖', '绘图', '插图', '插畫'
];

export function isAiTag(tag, extra = []) {
  const compact = compactTag(tag);
  if (!compact) return false;
  if (compact === 'ai' || compact === 'ａｉ') return true;
  if (/^(ai|ａｉ)/.test(compact)) {
    const rest = compact.replace(/^(ai|ａｉ)/, '');
    if (AI_SUFFIXES.some((suf) => rest.startsWith(compactTag(suf)))) return true;
  }
  const block = [...DEFAULT_AI_TAGS, ...extra].map(compactTag).filter(Boolean);
  return block.some((b) => b.length >= 3 && (compact === b || compact.includes(b)));
}

/** 拼进图库搜索词里的"排除 AI"标签（各站语法一致，都是 -tag）。 */
const AI_STRIP_TAGS = ['-ai', '-ai生成', '-aiイラスト', '-ai_generated'];

const DEFAULT_AI_TAGS = [
  'ai', 'aiart', 'ai_art', 'ai-art', 'aiイラスト', 'aiillust', 'ai-generated', 'ai_generated',
  'aigenerated', 'ai生成', 'ai画像', 'ai作画', 'ai繪圖', 'ai绘画', 'ai繪', 'ai-artwork',
  'generated_by_ai', 'stable_diffusion', 'novelai', 'novel_ai', 'midjourney', 'nijijourney',
  'waifu_diffusion', 'dall-e', 'sdxl', 'comfyui', 'ai少女', 'ai_girl'
];

const R18_TAG_WORDS = [
  'r-18', 'r18', 'r18g', 'nsfw', 'explicit', 'hentai', 'porn', 'nude', 'naked', 'sex',
  'ecchi', 'ero', 'adult', 'loli', 'shota', 'guro', 'r-18g', '18禁', '色情', '露出'
];

/** 标签里是否出现 R18 词。 */
export function isR18Tag(tag) {
  const raw = normTag(tag);
  if (!raw) return false;
  return R18_TAG_WORDS.includes(raw) || R18_TAG_WORDS.includes(raw.replace(/[\s_]+/g, '-'));
}

/**
 * 判定一条结果的 AI 属性。
 * 优先级：站点官方字段（pixiv aiType）> 标签 > 未知。
 * @returns {'ai'|'human'|'unknown'}
 */
export function aiVerdict(item, extraTags = []) {
  if (item?.ai === true) return 'ai';
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  if (tags.some((t) => isAiTag(t, extraTags))) return 'ai';
  if (item?.ai === false) return 'human';
  return 'unknown';
}

/** 判定分级：'r18' | 'safe' | 'unknown'。 */
export function ratingVerdict(item) {
  const explicit = String(item?.rating || '').trim().toLowerCase();
  if (explicit === 'r18' || explicit === 'explicit' || explicit === 'questionable') return 'r18';
  if (explicit === 'safe' || explicit === 'general' || explicit === 'sensitive') return 'safe';
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  if (tags.some(isR18Tag)) return 'r18';
  return 'unknown';
}

/**
 * 统一过滤（所有图源的结果都过这里，不依赖各站点自己的过滤参数）。
 * @returns {{items:Array, dropped:{ai:number, r18:number, seen:number, bad:number}}}
 */
export function filterResults(items, { hideAi = true, allowR18 = false, aiBlockTags = [], seen = null } = {}) {
  const dropped = { ai: 0, r18: 0, seen: 0, bad: 0 };
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !String(item.url || '').trim()) { dropped.bad += 1; continue; }
    if (seen && typeof seen.has === 'function' && seen.has(String(item.id || item.url))) { dropped.seen += 1; continue; }
    const ai = aiVerdict(item, aiBlockTags);
    if (hideAi && ai === 'ai') { dropped.ai += 1; continue; }
    if (!allowR18 && ratingVerdict(item) === 'r18') { dropped.r18 += 1; continue; }
    out.push({ ...item, ai });
  }
  return { items: out, dropped };
}

// ── 内置图源 ────────────────────────────────────────────────────────────

function withTimeout(ms) {
  return AbortSignal.timeout(Math.max(3000, Number(ms) || 15000));
}

/**
 * pixiv 的"人机验证"检测。
 *
 * 实测踩过的坑：短时间内打太多 /ajax/* 请求后，Cloudflare 会对这个 IP 返回
 * **HTTP 429 + `Just a moment...` 挑战页**（不是普通的频率限制，重试没用），
 * 而 /ranking.php、作品页、图床仍然正常。所以：
 *   · 识别到挑战页要立刻停手并给出可读的提示，而不是把它当成"没搜到图"；
 *   · 记一个冷却窗口，冷却期内直接跳过搜索，避免越试越糟。
 */
const CHALLENGE_RE = /Just a moment\.\.\.|cf-browser-verification|Enable JavaScript and cookies to continue/i;
export const PIXIV_COOLDOWN_MS = 8 * 60 * 1000;
let pixivBlockedUntil = 0;

export function pixivCoolingDown() {
  return Date.now() < pixivBlockedUntil;
}
function markPixivBlocked() {
  pixivBlockedUntil = Date.now() + PIXIV_COOLDOWN_MS;
}
export function pixivCooldownLeftSec() {
  return Math.max(0, Math.round((pixivBlockedUntil - Date.now()) / 1000));
}
export function isChallengePage(text) {
  return CHALLENGE_RE.test(String(text || '').slice(0, 4000));
}

async function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  // 先净化头：Cookie/API Key 里混进中文或省略号会让 fetch 抛 ByteString 错（见上方说明）
  const clean = safeHeaders(headers);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', ...clean },
    signal: withTimeout(timeoutMs)
  });
  const text = await res.text();
  // 人机验证要先判：它是 429 + HTML 挑战页，当成普通错误会显示成"没搜到图"，
  // 让人以为是关键词问题，反复换词只会把 IP 关得更久。
  if (isChallengePage(text)) {
    markPixivBlocked();
    throw new Error(`pixiv 要求人机验证（短时间内请求太多）——已暂停 ${Math.round(PIXIV_COOLDOWN_MS / 60000)} 分钟内的 pixiv 请求。可以先用别的图源（safebooru / konachan / yande.re），或者在设置里填 pixiv 登录 Cookie 来避免`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON（前 80 字：${text.slice(0, 80)}）`);
  }
}

function clampLimit(limit, max = 60) {
  return Math.min(max, Math.max(1, Number(limit) || 3));
}

export function providerDisplayName(providerId, cfg = null) {
  const c = cfg || imageSearchConfig();
  const id = String(providerId || c.provider);
  if (id.startsWith('custom:')) {
    const found = c.providers.find((p) => `custom:${p.id}` === id || p.id === id.slice(7));
    return found?.name || '自定义图源';
  }
  return { pixiv: 'pixiv', safebooru: 'safebooru', konachan: 'konachan', yandere: 'yandere', custom: '自定义图源' }[id] || id;
}

/**
 * pixiv 搜索（公开 ajax 接口，未登录可用）。
 * 关键点：**先不加任何过滤搜**，再按 aiType 本地筛 —— 这样"屏蔽 AI"是真的屏蔽，
 * 而不是把整页 AI 图过滤完只剩两条。
 */
export async function pixivSearch(query, { limit = 3, page = 1, cookie = '', timeoutMs = 15000, mode = 'search' } = {}) {
  const word = sanitizeQuery(query);
  if (!word) throw new Error('搜索词为空');
  if (pixivCoolingDown()) {
    throw new Error(`pixiv 还在冷却中（约 ${Math.ceil(pixivCooldownLeftSec() / 60)} 分钟后恢复，之前触发了人机验证）。先用别的图源，或在设置里填 pixiv 登录 Cookie`);
  }
  const p = Math.min(200, Math.max(1, Number(page) || 1));
  const headers = safeHeaders({
    referer: 'https://www.pixiv.net/',
    'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8'
  });
  const cookieProblem = cookie ? describeHeaderProblem('pixiv Cookie', cookie) : '';
  if (cookieProblem) throw new Error(cookieProblem);
  if (cookie) headers.cookie = sanitizeHeaderValue(cookie);

  let data;
  if (String(mode) === 'ranking') {
    const modeMap = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', rookie: 'rookie', male: 'male', female: 'female' };
    const rmode = modeMap[String(query || 'daily')] || 'daily';
    data = await fetchJson(`https://www.pixiv.net/ranking.php?mode=${rmode}&format=json&p=${p}`, { headers, timeoutMs });
    const contents = Array.isArray(data?.contents) ? data.contents : [];
    const items = contents.map((it) => ({
      id: String(it.illust_id || ''),
      title: String(it.title || '').trim(),
      author: String(it.user_name || '').trim(),
      authorId: String(it.user_id || ''),
      pageUrl: `https://www.pixiv.net/artworks/${it.illust_id}`,
      url: String(it.url || '').replace('/c/240x240/', '/c/540x540_70/').replace('/c/250x250_80_a2/', '/c/540x540_70/'),
      thumb: String(it.url || ''),
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      pageCount: Number(it.illust_page_count) || 1,
      // 排行榜接口不带 aiType；标题/标签里带 AI 的会被标签规则拦下
      ai: null,
      rating: 'unknown',
      source: 'pixiv'
    }));
    return items.slice(0, clampLimit(limit, 50));
  }

  const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(word)}?word=${encodeURIComponent(word)}&p=${p}&lang=zh`;
  data = await fetchJson(url, { headers, timeoutMs });
  if (data?.error) throw new Error(`pixiv 返回错误：${data.message || '未知'}`);
  const rows = Array.isArray(data?.body?.illustManga?.data) ? data.body.illustManga.data : [];
  const tagZh = data?.body?.tagTranslation && typeof data.body.tagTranslation === 'object' ? data.body.tagTranslation : {};
  const items = rows.map((it) => {
    const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
    const zh = tags.map((t) => tagZh[t]?.zh).filter(Boolean);
    return {
      id: String(it.id || ''),
      title: String(it.title || '').trim(),
      author: String(it.userName || '').trim(),
      authorId: String(it.userId || ''),
      pageUrl: `https://www.pixiv.net/artworks/${it.id}`,
      url: pixivThumbToMedium(String(it.url || '')),
      thumb: String(it.url || ''),
      tags: [...new Set([...tags, ...zh])],
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      pageCount: Number(it.pageCount) || 1,
      // 2 = AI 生成（pixiv 官方标注），1 = 非 AI，其余未知
      ai: it.aiType === 2 ? true : (it.aiType === 1 ? false : null),
      rating: Number(it.xRestrict) > 0 ? 'r18' : 'safe',
      bookmarkCount: Number(it.bookmarkCount) || 0,
      source: 'pixiv',
      stage: 'search'
    };
  });
  // 接口按页返回 60 条，这里按需要截断（过滤在 filterResults 里统一做）
  return items.slice(0, clampLimit(limit, 60));
}

/** 缩略图 → 540px 中等图（原图要登录 + 防盗链，中等图足够 QQ 展示）。 */
export function pixivThumbToMedium(url) {
  const s = String(url || '');
  if (!s) return '';
  return s
    .replace('/c/250x250_80_a2/', '/c/540x540_70/')
    .replace('/c/360x360_70/', '/c/540x540_70/')
    .replace('/c/240x240/', '/c/540x540_70/')
    .replace('/c/48x48/', '/c/540x540_70/');
}

/**
 * 取 pixiv 作品的可用直链（依次尝试 original → regular → small）。
 * 返回的第一个候选通常就是原图；下载层会按顺序试，全部失败才算失败。
 * @returns {{id:string, title:string, author:string, tags:string[], ai:boolean|null, rating:string, candidates:string[], pageUrl:string}}
 */
export async function pixivIllustDetail(illustId, { cookie = '', timeoutMs = 15000 } = {}) {
  const id = String(illustId || '').replace(/\D/g, '');
  if (!id) throw new Error('作品 id 无效');
  if (pixivCoolingDown()) {
    throw new Error(`pixiv 还在冷却中（约 ${Math.ceil(pixivCooldownLeftSec() / 60)} 分钟后恢复）`);
  }
  const headers = { referer: 'https://www.pixiv.net/', 'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8' };
  const cookieProblem2 = cookie ? describeHeaderProblem('pixiv Cookie', cookie) : '';
  if (cookieProblem2) throw new Error(cookieProblem2);
  if (cookie) headers.cookie = sanitizeHeaderValue(cookie);
  const data = await fetchJson(`https://www.pixiv.net/ajax/illust/${id}?lang=zh`, { headers, timeoutMs });
  if (data?.error || !data?.body) throw new Error(`pixiv 作品 ${id} 读取失败（可能已删除或仅登录可见）`);
  const b = data.body;
  const tags = Array.isArray(b?.tags?.tags) ? b.tags.tags.map((t) => String(t?.tag || '')) : [];
  const zh = Array.isArray(b?.tags?.tags) ? b.tags.tags.map((t) => String(t?.translation?.zh || '')) : [];
  const urls = b?.urls || {};
  const candidates = [
    urls.original,
    String(urls.regular || '').replace('/img-master/', '/img-original/'),
    urls.regular,
    urls.small,
    pixivThumbToMedium(urls.thumb)
  ].map((u) => String(u || '').trim()).filter(Boolean);
  return {
    id,
    title: String(b.illustTitle || '').trim(),
    author: String(b.userName || '').trim(),
    authorId: String(b.userId || ''),
    pageUrl: `https://www.pixiv.net/artworks/${id}`,
    tags: [...new Set([...tags, ...zh.filter(Boolean)])],
    ai: b.aiType === 2 ? true : (b.aiType === 1 ? false : null),
    rating: Number(b.xRestrict) > 0 ? 'r18' : 'safe',
    pageCount: Number(b.pageCount) || 1,
    candidates: [...new Set(candidates)],
    original: String(urls.original || '').trim(),
    regular: String(urls.regular || '').trim(),
    preview: pixivThumbToMedium(urls.thumb),
    width: Number(b.width) || 0,
    height: Number(b.height) || 0,
    // 人气指标：判断"这张图好不好看"的硬依据（搜索接口不返回，只有详情接口有）
    bookmarkCount: Number(b.bookmarkCount) || 0,
    likeCount: Number(b.likeCount) || 0,
    viewCount: Number(b.viewCount) || 0,
    createDate: String(b.createDate || ''),
    source: 'pixiv',
    url: candidates[0] || ''
  };
}

/**
 * 挑一张"画质最好又发得出去"的图。
 *
 * 为什么不能直接发搜索结果里的 540px 缩略图：那是为了省流量的预览图，
 * 发到群里明显糊（实测同一作品缩略图 36KB、原图 1579KB）。
 * 策略：
 *   1. preferOriginal 时先试原图，但先 HEAD 探一下体积，超过 maxImageMb 就退回大图；
 *   2. 拿不到体积信息（有些图床不支持 HEAD）就直接试下载，下载层还有硬上限兜底；
 *   3. 失败一律退回 pixiv 的 regular（约 1200px）——它比缩略图清晰，体积也稳。
 *
 * @returns {{url:string, candidates:string[], quality:string, sizeKb:number|null, note:string}}
 */
export async function pickBestImage(item, cfg = {}) {
  const preferOriginal = cfg.preferOriginal !== false;
  const maxImageMb = Math.min(30, Math.max(1, Number(cfg.maxImageMb) || 12));
  const maxBytes = Math.round(maxImageMb * 1024 * 1024);
  // 内嵌发送的体积上限：base64 会把体积撑大约 1/3，QQ 对单图也有硬限制，
  // 所以"原图能下"不等于"原图能内嵌发出去"——超了就退回 regular（约 1200px）。
  const maxSendMb = Math.min(maxImageMb, Math.max(1, Number(cfg.maxSendMb) || 4));
  const maxSendBytes = Math.round(maxSendMb * 1024 * 1024);

  let detail = null;
  if (item?.source === 'pixiv' || /pximg\.net/.test(String(item?.url || ''))) {
    try {
      detail = await pixivIllustDetail(item.id || String(item.url).match(/\/(\d+)_p\d/)?.[1] || '', {
        cookie: cfg.cookie || '',
        timeoutMs: cfg.timeoutMs
      });
    } catch { /* 详情拿不到就用搜索结果里的地址 */ }
  }

  const original = String(detail?.original || item?.original || '').trim();
  const regular = String(detail?.regular || item?.regular || '').trim();
  const fallback = String(detail?.preview || item?.url || '').trim();
  const candidates = [];
  let quality = 'preview';
  let note = '';
  let sizeKb = null;

  if (preferOriginal && original) {
    const size = await headContentLength(original, cfg.timeoutMs);
    if (size && size > maxBytes) {
      note = `原图 ${(size / 1024 / 1024).toFixed(1)}MB 超过上限 ${maxImageMb}MB，改用大图`;
      if (regular) candidates.push(regular);
      quality = 'regular';
    } else if (size && size > maxSendBytes) {
      // 能下载但"内嵌发不出去"（base64 再涨 1/3，QQ 也有硬限制）→ 直接给大图
      note = `原图 ${(size / 1024 / 1024).toFixed(1)}MB 偏大（内嵌发送上限约 ${maxSendMb}MB），改用 ${regular ? '大图' : '预览图'}`;
      if (regular) candidates.push(regular);
      else candidates.push(original);
      quality = regular ? 'regular' : 'original';
    } else {
      candidates.push(original);
      quality = 'original';
      if (size) sizeKb = Math.round(size / 1024);
      // 原图之后仍然排上大图与预览，下载失败时自动降级
      if (regular) candidates.push(regular);
      if (fallback) candidates.push(fallback);
    }
  } else if (regular) {
    candidates.push(regular);
    quality = 'regular';
  }
  if (!candidates.length) {
    for (const u of [fallback, ...(item?.candidates || [])]) {
      const s = String(u || '').trim();
      if (s && !candidates.includes(s)) candidates.push(s);
    }
  }
  return { url: candidates[0] || '', candidates: [...new Set(candidates)], quality, sizeKb, note };
}

/** HEAD 探体积：拿不到就返回 null（不阻断流程）。 */
async function headContentLength(url, timeoutMs = 15000) {
  try {
    await validateImageUrl(url);
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'user-agent': UA,
        ...(refererFor(url) ? { referer: refererFor(url) } : {})
      },
      signal: withTimeout(timeoutMs)
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

/**
 * safebooru（免登录、有 JSON API，天然全年龄站）。
 *
 * ⚠️ 两个实测坑，必须在这里兜住（否则用户看到的就是"其他网站搜不了图"）：
 *   1. **它只认 ASCII 标签**：搜"初音ミク"返回的是**空 body**，JSON.parse 直接抛
 *      "返回的不是 JSON" —— 看上去像站点坏了，其实只是词用错了。
 *      所以中文/日文词会被翻成拼音（东方的日式词按日语音译）。
 *   2. 它不返回标签，AI 过滤只能靠 -ai 之类的搜索词。
 */
export async function safeBooruSearch(query, { limit = 3, page = 0, timeoutMs = 15000, aiNegatives = [] } = {}) {
  const raw = sanitizeQuery(query);
  const latin = raw.replace(/[^\x20-\x7E]/g, ' ');
  const ascii = latin.replace(/\s{2,}/g, ' ').trim();
  const cnWord = romanizeTags(raw);
  let word = ascii;
  let translitFrom = '';
  if (!word) {
    word = cnWord;
    translitFrom = raw;
  }
  if (!word) {
    // 翻不出来（比如纯符号）→ 明确报错，别让上层以为是站点故障
    throw new Error(`safebooru 只支持英文/罗马字标签，这个词（${raw}）翻不出来。换 konachan / yandere / pixiv 试试`);
  }
  const tags = [word, ...aiNegatives].map((t) => String(t || '').trim()).filter(Boolean).join(' ');
  const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=${clampLimit(limit, 100)}&pid=${Math.max(0, Number(page) || 0)}&tags=${encodeURIComponent(tags)}`;
  const rows = await fetchJson(url, { timeoutMs });
  const list = Array.isArray(rows) ? rows : [];
  return list.map((it) => ({
    id: String(it.id || ''),
    title: '',
    author: '',
    pageUrl: `https://safebooru.org/index.php?page=post&s=view&id=${it.id}`,
    // sample 是缩放图（体积友好），没有 sample 时退回原图
    url: String(it.sample_url || it.file_url || ''),
    fileUrl: String(it.file_url || ''),
    thumb: String(it.preview_url || ''),
    tags: [],
    width: Number(it.width) || 0,
    height: Number(it.height) || 0,
    rating: 'safe',
    ai: null,
    source: 'safebooru',
    transliterated: translitFrom ? { from: translitFrom, to: word } : null
  })).filter((it) => it.url || it.fileUrl);   // safebooru 偶尔返回空地址的坏记录，直接丢
}

/** konachan / yande.re（Moebooru，全年龄过滤用 rating:safe，AI 用 -ai 标签）。 */
export async function moebooruSearch(host, query, { limit = 3, page = 1, timeoutMs = 15000, aiNegatives = [] } = {}) {
  const base = String(host || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('图源地址无效');
  const tags = [sanitizeQuery(query), ...aiNegatives].map((t) => String(t || '').trim()).filter(Boolean).join(' ');
  const url = `${base}/post.json?limit=${clampLimit(limit, 100)}&page=${Math.max(1, Number(page) || 1)}&tags=${encodeURIComponent(tags)}`;
  const rows = await fetchJson(url, { timeoutMs });
  const list = Array.isArray(rows) ? rows : [];
  return list.map((it) => ({
    id: String(it.id || ''),
    title: '',
    author: String(it.author || ''),
    pageUrl: String(it.source || '') || `${base}/post/show/${it.id}`,
    url: String(it.sample_url || it.jpeg_url || it.file_url || ''),
    fileUrl: String(it.file_url || ''),
    thumb: String(it.preview_url || ''),
    tags: String(it.tags || '').split(/\s+/).filter(Boolean),
    width: Number(it.width) || 0,
    height: Number(it.height) || 0,
    rating: String(it.rating || 'unknown') === 's' ? 'safe' : 'unknown',
    ai: null,
    source: new URL(base).hostname
  }));
}

/**
 * 自定义图源：GET 一个 JSON 接口。
 * 兼容 pixiv 风格 / booru 风格 / {data:[...]} / {results:[...]} 等常见结构，
 * 字段名靠猜（id/url/file_url/sample_url/tags/rating），够粗糙但普适。
 */
export async function customImageSearch(provider, query, { limit = 3, page = 1, timeoutMs = 15000 } = {}) {
  const endpoint = String(provider?.baseUrl || '').trim();
  if (!endpoint) throw new Error(`自定义图源「${provider?.name || provider?.id}」没有填接口地址`);
  const target = new URL(endpoint);
  if (!/^https?:$/.test(target.protocol)) throw new Error(`自定义图源「${provider?.name || provider?.id}」的接口地址必须是 http/https`);
  /*
   * 域名里带中文要提前拦：直接从浏览器地址栏复制时很容易把中文一起带进来。
   * 注意 `new URL()` 会把 `例子.com` **自动转成 punycode**（xn--fsqu00a.com），
   * 所以必须检查**原始字符串**，光看 target.hostname 是查不出来的。
   */
  const rawHost = /^https?:\/\/([^/?#]+)/i.exec(endpoint)?.[1] || '';
  if (/[^\x20-\x7E]/.test(rawHost) || /^xn--/i.test(target.hostname)) {
    throw new Error(`自定义图源「${provider?.name || provider?.id}」的接口地址里域名含非 ASCII 字符（${rawHost || target.hostname}），请检查是不是复制时带进了中文`);
  }
  target.searchParams.set('q', sanitizeQuery(query));
  target.searchParams.set('word', sanitizeQuery(query));
  target.searchParams.set('limit', String(clampLimit(limit, 100)));
  target.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
  const headers = {};
  const pname = provider?.name || provider?.id || '自定义图源';
  const keyProblem = provider.apiKey ? describeHeaderProblem(`图源「${pname}」的 API Key`, provider.apiKey) : '';
  const cookieProblem3 = provider.cookie ? describeHeaderProblem(`图源「${pname}」的 Cookie`, provider.cookie) : '';
  if (keyProblem) throw new Error(keyProblem);
  if (cookieProblem3) throw new Error(cookieProblem3);
  if (provider.apiKey) headers.authorization = `Bearer ${sanitizeHeaderValue(provider.apiKey)}`;
  if (provider.cookie) headers.cookie = sanitizeHeaderValue(provider.cookie);
  const data = await fetchJson(target.toString(), { headers, timeoutMs: provider.timeoutMs || timeoutMs });
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.posts) ? data.posts
    : Array.isArray(data?.illustManga?.data) ? data.illustManga.data
    : [];
  return rows.map((it) => {
    const tags = Array.isArray(it?.tags)
      ? it.tags.map((t) => String(t?.tag ?? t?.name ?? t ?? '')).filter(Boolean)
      : String(it?.tags || '').split(/\s+/).filter(Boolean);
    const id = String(it?.id ?? it?.illust_id ?? it?.post_id ?? '');
    const raw = String(it?.url ?? it?.file_url ?? it?.sample_url ?? it?.large ?? it?.original ?? it?.jpeg_url ?? '');
    const pageUrl = String(it?.pageUrl ?? it?.page_url ?? it?.post_url ?? (id ? `https://www.pixiv.net/artworks/${id}` : ''));
    return {
      id,
      title: String(it?.title ?? it?.illust_title ?? '').trim(),
      author: String(it?.author ?? it?.userName ?? it?.user_name ?? it?.uploader ?? '').trim(),
      pageUrl,
      url: id && /pximg\.net/.test(raw) ? pixivThumbToMedium(raw) : raw,
      thumb: String(it?.thumb ?? it?.preview_url ?? ''),
      tags,
      width: Number(it?.width) || 0,
      height: Number(it?.height) || 0,
      rating: String(it?.rating ?? (Number(it?.xRestrict) > 0 ? 'r18' : '')),
      ai: it?.aiType === 2 || it?.ai === true ? true : (it?.aiType === 1 || it?.ai === false ? false : null),
      source: provider.name || provider.id
    };
  }).filter((it) => it.url || it.thumb);
}

/**
 * 取一批作品的人气数据（收藏/点赞/浏览）。
 *
 * 为什么必须一个个查：pixiv 的搜索接口**不返回** bookmarkCount，
 *   order=popular_d 在未登录时也不生效 —— 想按"好不好看"排序，只能自己补这一步。
 *
 * 限流是这里最大的风险：候选查太多会吃到 HTTP 429，**连搜图本身都会被拖挂**
 *   （实测把候选提到 60 时 pixiv 开始整片 429）。所以：
 *   · 并发压到 6、批次之间留间隔；
 *   · 一旦连续拿到 429 就**立刻停止补查**，已查到的照常用，剩下的当成"无数据"排后面。
 */
export async function enrichWithStats(items, { cookie = '', timeoutMs = 15000, concurrency = 6, limit = 24, batchDelayMs = 150 } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, Math.max(1, Number(limit) || 24));
  const rest = (Array.isArray(items) ? items : []).slice(list.length);
  const out = [];
  let rateLimited = 0;
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(async (it) => {
      try {
        const d = await pixivIllustDetail(it.id, { cookie, timeoutMs });
        return {
          ...it,
          bookmarkCount: Number(d.bookmarkCount) || 0,
          likeCount: Number(d.likeCount) || 0,
          viewCount: Number(d.viewCount) || 0,
          width: d.width || it.width,
          height: d.height || it.height,
          original: d.original,
          regular: d.regular,
          statsAt: Date.now()
        };
      } catch (error) {
        if (/\b429\b/.test(String(error?.message || ''))) rateLimited += 1;
        return { ...it, bookmarkCount: null };
      }
    }));
    out.push(...got);
    if (rateLimited >= 3) break;                     // 被限流了，别再打了
    if (i + concurrency < list.length && batchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
  // 提前中断时，没轮到的候选保留在原位（后面会排在有数据的之后）
  const done = new Set(out.map((it) => String(it.id || it.url)));
  for (const it of [...list, ...rest]) {
    if (!done.has(String(it.id || it.url))) out.push({ ...it, bookmarkCount: null });
  }
  return out;
}

/** 按人气排序（收藏数优先，其次点赞），拿不到数据的排最后。 */
export function sortByPopularity(items) {
  return [...(items || [])].sort((a, b) => {
    const av = a.bookmarkCount === null || a.bookmarkCount === undefined ? -1 : Number(a.bookmarkCount);
    const bv = b.bookmarkCount === null || b.bookmarkCount === undefined ? -1 : Number(b.bookmarkCount);
    return bv - av || (Number(b.likeCount) || 0) - (Number(a.likeCount) || 0);
  });
}

// ── 搜索入口 ────────────────────────────────────────────────────────────

const MEMORY_CACHE = new Map();      // key -> { at, items }
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key) {
  const hit = MEMORY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { MEMORY_CACHE.delete(key); return null; }
  return hit.items;
}

function cacheSet(key, items) {
  MEMORY_CACHE.set(key, { at: Date.now(), items });
  if (MEMORY_CACHE.size > 80) {
    const oldest = [...MEMORY_CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20);
    for (const [k] of oldest) MEMORY_CACHE.delete(k);
  }
}

/**
 * 返回"按需求逐步放宽"的搜索计划。
 * 组图站的标签体系不一样，用同一句中文硬搜很容易 0 结果，
 * 所以默认按 stage 顺序逐级放宽，并在最后一级带上全年龄过滤。
 */
export function stagePlan(providerId, query, stage = 'auto', opts = {}) {
  const q = sanitizeQuery(query);
  const aiNeg = opts.hideAi === false ? [] : [...AI_STRIP_TAGS];
  // safebooru 是全年龄站，没有分级标签；konachan/yande.re 用 rating:safe
  const safeTag = opts.allowR18 || providerId === 'safebooru' ? [] : ['rating:safe'];
  if (providerId === 'pixiv') {
    // pixiv 不支持在搜索词里排除标签（-tag 语法），AI 过滤全靠本地 aiType 判定，
    // 所以这里只有一级；拿不到就换词。
    return [{ mode: 'search', word: q }];
  }
  const strict = { word: [q, ...safeTag, ...aiNeg].join(' ') };
  const normal = { word: [q, ...aiNeg].join(' ') };
  const loose = { word: q };
  if (stage === 'strict') return [strict];
  if (stage === 'normal') return [normal];
  if (stage === 'loose') return [loose];
  return [strict, normal, loose];
}

/**
 * 常见角色/作品名的"标签写法"对照表。
 *
 * 为什么需要：safebooru 这类欧美图库**只认 ASCII 标签**，中文/日文词会直接返回空。
 * 但 pixiv 用日文、booru 用英文/罗马字，同一角色三套写法 —— 不转就搜不到。
 * 表不求全（全了也不可能），覆盖群里最可能出现的那些；没命中时退回逐字拼音，
 * 至少给个能用的查询，搜不到也不至于报"站点坏了"。
 */
const TAG_ALIAS = {
  初音ミク: 'hatsune miku', 初音未来: 'hatsune miku', ミク: 'hatsune miku',
  重音テト: 'kasane teto', 镜音铃: 'kagamine rin', 镜音连: 'kagamine len',
  巡音ルカ: 'megurine luka', 洛天依: 'luo tianyi',
  东方: 'touhou', 博丽灵梦: 'hakurei reimu', 霊夢: 'hakurei reimu',
  魔理沙: 'kirisame marisa', 芙兰朵露: 'flandre scarlet', 蕾米莉亚: 'remilia scarlet',
  帕秋莉: 'patchouli knowledge', 十六夜咲夜: 'izayoi sakuya', 幽幽子: 'yuyuko saigyouji',
  原神: 'genshin impact', 甘雨: 'ganyu', 胡桃: 'hu tao', 雷电将军: 'raiden shogun',
  荧: 'lumine', 空: 'aether', 温迪: 'venti', 钟离: 'zhongli', 纳西妲: 'nahida',
  八重神子: 'yae miko', 神里绫华: 'kamisato ayaka', 宵宫: 'yoimiya', 莫娜: 'mona',
  崩坏: 'honkai', 星穹铁道: 'honkai star rail', 三月七: 'march 7th',
  流萤: 'firefly', 花火: 'sparkle', 姬子: 'himeko',
  明日方舟: 'arknights', 阿米娅: 'amiya', 能天使: 'exusiai', 陈: 'chen',
  蔚蓝档案: 'blue archive', 白子: 'shiroko', 优香: 'yuuka', 星野: 'hoshino',
  亚托克斯: 'aatrox', 阿狸: 'ahri', 英雄联盟: 'league of legends',
  无畏契约: 'valorant', 捷风: 'jett', 贤者: 'sage',
  塞尔达: 'zelda', 林克: 'link', 马力欧: 'mario', 马里奥: 'mario',
  宝可梦: 'pokemon', 皮卡丘: 'pikachu', 伊布: 'eevee',
  猫: 'cat', 猫娘: 'catgirl', 女仆: 'maid', 和服: 'kimono', 泳装: 'swimsuit',
  风景: 'scenery', 城市: 'city', 机甲: 'mecha', 机器人: 'robot',
  赛博朋克: 'cyberpunk', 天使: 'angel', 恶魔: 'demon', 龙: 'dragon', 精灵: 'elf',
  吸血鬼: 'vampire', 女巫: 'witch', 骑士: 'knight', 公主: 'princess', 忍者: 'ninja',
  樱花: 'sakura', 星空: 'starry_sky', 夜晚: 'night', 雨: 'rain', 雪: 'snow',
  // 繁体/异体写法（群里混着用，缺了就搜不到）
  風景: 'scenery', 動漫: 'anime', 少女: 'girl', 女孩: 'girl', 男生: 'boy',
  龍: 'dragon', 惡魔: 'demon', 天使: 'angel', 劍: 'sword', 花: 'flower',
  貓: 'cat', 貓娘: 'catgirl', 女僕: 'maid', 機甲: 'mecha', 賽博朋克: 'cyberpunk',
  公主: 'princess', 騎士: 'knight', 忍者: 'ninja', 吸血鬼: 'vampire', 精靈: 'elf',
  // 常用英文别名的下划线写法（图库标签习惯）
  风景: 'scenery', 动漫: 'anime', 插画: 'illustration', 壁纸: 'wallpaper',
  女仆: 'maid', 机甲: 'mecha', 城堡: 'castle', 海边: 'beach', 学校: 'school',
  春天: 'spring', 夏天: 'summer', 秋天: 'autumn', 冬天: 'winter'
};

/**
 * 把中文/日文查询词转成图库能认的英文标签（查表 → 逐字拼音 → 空）。
 *
 * ⚠️ 关键细节：**多词标签必须用下划线连接**（`hatsune_miku`）。
 * 图库（moebooru/safebooru）把空格当"或"（`hatsune miku` = hatsune OR miku，实测 0 条），
 * 把 `hatsune_miku` 当成一个标签才搜得到 —— 这是"其他图源老是搜不到图"的真正原因。
 * pixiv 那边是分词搜索，所以调用方对 pixiv 不使用本函数的返回值。
 */
export function romanizeTags(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\s　,，、]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (TAG_ALIAS[p]) { out.push(TAG_ALIAS[p]); continue; }
    // 词组里含已知别名（如"甘雨同人"）
    let replaced = p;
    let hit = false;
    for (const [cn, en] of Object.entries(TAG_ALIAS)) {
      if (p.includes(cn)) { replaced = en; hit = true; break; }
    }
    if (hit) { out.push(replaced); continue; }
    // 没命中：逐字拼音（够粗糙，但能给图库一个合法查询）
    if (/[\u4e00-\u9fa5]/.test(p)) {
      const py = pinyinLite(p);
      if (py) out.push(py);
    } else if (/^[\x20-\x7E]+$/.test(p)) {
      out.push(p.toLowerCase());
    }
  }
  // 每个词内部的下划线保留，词与词之间用下划线连接（图库的多词标签写法）
  return [...new Set(out)].join('_').replace(/\s+/g, '_').replace(/_{2,}/g, '_').replace(/^_|_$/g, '').trim();
}

/**
 * moebooru 系的同义标签兜底表。
 * 各站标签习惯不同（konachan 有 landscape 没有 scenery，safebooru 反过来），
 * 命中 0 条时换一个再试一次，比直接报"没搜到"好得多。
 */
const MOEBOORU_SYNONYM = {
  scenery: 'landscape',
  landscape: 'scenery',
  starry_sky: 'stars',
  catgirl: 'neko',
  illustration: 'original',
  wallpaper: 'landscape'
};

/** 极简拼音（只覆盖常用字，够把"甘雨"这类词变成 ganyu）。 */const PINYIN_HINT = {
  甘: 'gan', 雨: 'yu', 胡: 'hu', 桃: 'tao', 雷: 'lei', 电: 'dian', 将: 'jiang', 军: 'jun',
  钟: 'zhong', 离: 'li', 温: 'wen', 迪: 'di', 纳: 'na', 西: 'xi', 妲: 'da',
  神: 'shen', 里: 'li', 绫: 'ling', 华: 'hua', 宵: 'xiao', 宫: 'gong', 莫: 'mo', 娜: 'na',
  阿: 'a', 米: 'mi', 娅: 'ya', 能: 'neng', 天: 'tian', 使: 'shi', 陈: 'chen',
  白: 'bai', 子: 'zi', 优: 'you', 香: 'xiang', 星: 'xing', 野: 'ye',
  猫: 'cat', 娘: 'girl', 女: 'girl', 仆: 'maid', 和: 'he', 服: 'fu', 泳: 'yong', 装: 'zhuang',
  风: 'feng', 景: 'jing', 城: 'cheng', 市: 'shi', 机: 'ji', 甲: 'jia',
  赛: 'sai', 博: 'bo', 朋: 'peng', 克: 'ke', 天: 'tian', 魔: 'mo', 龙: 'dragon', 精: 'jing', 灵: 'ling',
  樱: 'ying', 花: 'hua', 夜: 'ye', 晚: 'wan', 雨: 'yu', 雪: 'xue'
};
function pinyinLite(text) {
  const chars = [...String(text)];
  if (chars.length > 4) return '';
  const out = chars.map((c) => PINYIN_HINT[c] || '').join('');
  return out.length === chars.length * 0 && out === '' ? '' : out.replace(/\s+/g, '');
}

export function resolveProviderConfig(providerId, cfg = null) {  const c = cfg || imageSearchConfig();
  const id = String(providerId || c.provider);
  if (id.startsWith('custom:')) {
    const found = c.providers.find((p) => p.id === id.slice(7) || `custom:${p.id}` === id);
    if (!found) throw new Error(`找不到自定义图源 ${id}（设置 → 搜图服务）`);
    return found;
  }
  return null;
}

/**
 * 搜图主入口。
 * @param {string} query 搜索词（中文/日文/英文/标签都可以）
 * @param {object} options
 *   provider 图源 id（pixiv/safebooru/konachan/yandere/custom:<id>）
 *   limit    期望返回条数（会多取一些用于过滤后的补位）
 *   stage    'auto' | 'strict' | 'normal' | 'loose' | 'ranking'
 *   hideAi   覆盖"屏蔽 AI 图"
 *   allowR18 覆盖"允许 R18"
 *   seen     Set，用于排除已经发过的图
 * @returns {{provider:string, query:string, stage:string, items:Array, dropped:object, attempts:Array<string>}}
 */
export async function searchImages(query, options = {}) {
  const cfg = options.cfg || imageSearchConfig();
  let providerId = String(options.provider || cfg.provider);
  const limit = clampLimit(options.limit || cfg.defaultLimit, 10);
  const hideAi = options.hideAi === undefined ? cfg.hideAi !== false : options.hideAi !== false;
  const allowR18 = options.allowR18 === undefined ? cfg.allowR18 === true : options.allowR18 === true;
  const seen = options.seen instanceof Set ? options.seen : null;
  const word = sanitizeQuery(query);
  const stage = String(options.stage || 'auto');

  /*
   * pixiv 冷却期内的自动降级：被 Cloudflare 挑战之后 pixiv 会 8 分钟不可用，
   * 这时直接报错等于"群里要图，机器人说搜不了"。降级到免登录图库至少还能出图，
   * 并在返回里标明降级原因，让模型能跟群友解释一句。
   */
  let degraded = '';
  if (providerId === 'pixiv' && pixivCoolingDown()) {
    degraded = `pixiv 触发人机验证，已自动改用 ${providerDisplayName('safebooru', cfg)}（约 ${Math.ceil(pixivCooldownLeftSec() / 60)} 分钟后恢复）`;
    providerId = 'safebooru';
  }

  // 排行榜模式不需要搜索词
  if (providerId === 'pixiv' && stage === 'ranking') {
    const items = await pixivSearch(word || 'daily', {
      limit: limit * 3,
      page: options.page || 1,
      cookie: cfg.cookie,
      timeoutMs: cfg.timeoutMs,
      mode: 'ranking'
    });
    const filtered = filterResults(items, { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags, seen });
    return { provider: providerId, query: word, stage: 'ranking', ...filtered, attempts: ['ranking'], degraded };
  }

  if (!word) throw new Error('请给一个搜索词（如"初音未来"、"赛博朋克 城市"）');
  // 缓存键只包含"决定打不打接口"的东西（图源/词/stage/过滤开关）。
  // 人气门槛、画质门槛、条数这些**每次读取时重新应用** —— 否则在设置页把
  // 收藏门槛从 0 改成 1000 之后，5 分钟内的缓存会绕过新门槛（踩过这个坑）。
  const cacheKey = `${providerId}|${word}|${stage}|${hideAi}|${allowR18}`;

  /**
   * 缓存命中和新搜都要走的后处理：人气排序 → 收藏门槛 → 画质门槛。
   * @param {boolean} withStats 候选里已经带了收藏数吗（带了才谈得上按人气排序）
   */
  const applyQuality = (list, withStats = false) => {
    let out = Array.isArray(list) ? list.slice() : [];
    if (withStats && out.length && cfg.sortBy === 'popular') {
      out = sortByPopularity(out.filter((it) => it.bookmarkCount !== null && it.bookmarkCount !== undefined))
        .concat(out.filter((it) => it.bookmarkCount === null || it.bookmarkCount === undefined));
    }
    if (cfg.minBookmarks > 0) {
      const ok = out.filter((it) => it.bookmarkCount === null || it.bookmarkCount === undefined
        || Number(it.bookmarkCount) >= cfg.minBookmarks);
      // 门槛把整页都筛没了 → 宁可放宽也别报"没搜到"（返回里会带上实际收藏数，模型自己会判断）
      if (ok.length) out = ok;
    }
    if (cfg.minPixels > 0) {
      const big = out.filter((it) => {
        const w = Number(it.width) || 0;
        const h = Number(it.height) || 0;
        return !w || !h || Math.max(w, h) >= cfg.minPixels;
      });
      if (big.length) out = big;
    }
    return out;
  };

  const cached = cacheGet(cacheKey);
  if (cached) {
    const filtered = filterResults(applyQuality(cached, true), { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags, seen });
    return { provider: providerId, query: word, stage, ...filtered, attempts: ['缓存'], cached: true, degraded };
  }

  const attempts = [];
  let pool = [];        // 过滤后、但还没排除"已发过"的候选池
  let lastError = null;

  const runOnce = async (spec) => {
    // 候选池要够大：pixiv 一页 60 条，而**按收藏排序只能看到"池子里"的图** ——
    // 池子太小（比如只取 12 条）就会出现"人气最高的那张根本没进候选"，
    // 那样 sortBy=popular 等于白做。所以开了人气排序就尽量取满一页。
    // 注意：这里必须用**局部 providerId**（可能已被降级），不能用 options.provider，
    // 否则"pixiv 冷却 → 降级到 safebooru"会继续走 pixivSearch 又被冷却拦下（踩过）。
    const poolSize = providerId === 'pixiv' && cfg.sortBy === 'popular' ? 60 : Math.min(60, Math.max(limit * 4, 12));
    const common = { limit: Math.min(60, Math.max(poolSize, cfg.rankPool)), timeoutMs: cfg.timeoutMs };
    if (providerId === 'pixiv') {
      return pixivSearch(spec.word ?? word, { ...common, page: options.page || 1, cookie: cfg.cookie, mode: spec.mode || 'search' });
    }
    if (providerId === 'safebooru') {
      return safeBooruSearch(spec.word ?? word, { ...common, page: (Number(options.page) || 1) - 1, aiNegatives: hideAi ? AI_STRIP_TAGS : [] });
    }
    if (providerId === 'konachan' || providerId === 'yandere') {
      // moebooru 系支持日文标签，但中文不行（中文词实测 0 结果）——统一转成英文/罗马字标签，
      // 已经是拉丁字母的词 romanizeTags 会原样保留。
      // ⚠️ 多词标签必须用下划线：图库把空格当"或"（`hatsune miku` 实测 0 条，`hatsune_miku` 有）。
      const host = providerId === 'konachan' ? 'https://konachan.net' : 'https://yande.re';
      let roman = romanizeTags(spec.word ?? word) || (spec.word ?? word);
      try {
        let rows = await moebooruSearch(host, roman, { ...common, page: options.page || 1, aiNegatives: hideAi ? AI_STRIP_TAGS : [] });
        if (!rows.length) {
          // 换个同义词再试一次（各站标签习惯不同，最典型的是 scenery / landscape）
          const synonym = MOEBOORU_SYNONYM[roman];
          if (synonym) {
            attempts.push(`${synonym}(同义标签)`);
            rows = await moebooruSearch(host, synonym, { ...common, page: options.page || 1, aiNegatives: hideAi ? AI_STRIP_TAGS : [] });
          }
        }
        return rows;
      } catch (error) {
        throw error;
      }
    }
    const custom = resolveProviderConfig(providerId, cfg);
    if (custom) return customImageSearch(custom, spec.word ?? word, { ...common, page: options.page || 1 });
    throw new Error(`未知图源：${providerId}`);
  };

  // stage=auto 时逐级放宽：先按最严格的条件搜，不够再放开。
  // 注意"够不够"只看过滤后的**候选池**（还不排除"已发过的"）——
  // 否则发过几张之后每一轮都会退化到最宽的查询，把 AI 图/擦边图又捞回来。
  const plans = stagePlan(providerId, word, stage, { hideAi, allowR18 });
  for (const spec of plans) {
    attempts.push(spec.word ?? word);
    try {
      const rows = await runOnce(spec);
      const usable = filterResults(rows, { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags }).items;
      if (usable.length > pool.length) pool = usable;
      if (usable.length >= limit) break;
    } catch (error) {
      lastError = error;
    }
  }

  // 多词搜索兜底：pixiv 把"原神 甘雨"当成"同时带这两个标签"，太严 → 常常 0 结果。
  // 做法：拿第一个词去搜（结果多），再只保留**标签里真的含有其余词**的作品。
  // 这样"原神 甘雨"→ 搜"原神"→ 只留标签含"甘雨"的（比直接放宽成"只要原神"贴题得多）。
  if (!pool.length && stage === 'auto' && /[\s　]/.test(word) && providerId === 'pixiv') {
    const words = word.split(/[\s　]+/).map((w) => w.trim()).filter((w) => w.length >= 2).slice(0, 3);
    const [head, ...rest] = words;
    if (head) {
      attempts.push(`${head} + 标签过滤(${rest.join('/')})`);
      try {
        const rows = await runOnce({ mode: 'search', word: head });
        const usable = filterResults(rows, { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags }).items;
        const hitAll = (it) => rest.every((o) => (it.tags || []).some((t) => String(t).toLowerCase().includes(o.toLowerCase())));
        const narrowed = usable.filter(hitAll);
        if (narrowed.length) pool = narrowed;
        else if (rest.length === 1) {
          // 一个词都没对上（多半是标签写法不同，比如"甘雨"写成"甘雨(原神)"）→ 退一步用包含匹配
          const loose = usable.filter((it) => rest.some((o) => (it.tags || []).join(' ').toLowerCase().includes(o.toLowerCase())));
          pool = loose.length ? loose : usable;
        } else {
          pool = usable;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  // ── 画质 / 人气：这一步决定"推给群友的图好不好看" ──
  // pixiv 的搜索接口不给收藏数，所以要逐个作品补查一次详情（并发 6、批间留间隔，24 个约 1 秒）。
  if (pool.length && (cfg.sortBy === 'popular' || cfg.minBookmarks > 0)) {
    pool = await enrichWithStats(pool, { cookie: cfg.cookie, timeoutMs: cfg.timeoutMs, limit: cfg.rankPool });
  }
  pool = applyQuality(pool, true);
  /*
   * 关键：rankPool 之外没排到的候选要**丢掉**，而不是带着空收藏数留在池子里。
   * 否则调用方给 limit=3、接口却回 50 张（前面是排好序的，后面全是没数据的），
   * 用户看到的就是"试搜出来一大堆，秩序混乱"。
   */
  if (cfg.sortBy === 'popular' && pool.some((it) => Number.isFinite(Number(it.bookmarkCount)))) {
    pool = pool.filter((it) => Number.isFinite(Number(it.bookmarkCount)));
  }

  // 整轮搜索都失败（网络/接口报错）→ 失败缓存，短时间内的重试直接复用错误
  if (!pool.length && lastError) {
    throw lastError;
  }
  if (!pool.length) {
    const total = attempts.length ? `（试过：${attempts.join(' / ')}）` : '';
    throw new Error(`没有搜到图${total}。换个更通用的词（用作品标签更准，如"初音ミク"而不是"那个双马尾的"），或者把「屏蔽 AI 图」临时关掉试试`);
  }

  // 缓存过滤后的候选池（未按"已发过"排除）：同一关键词 5 分钟内换个 stage/limit
  // 不会再打接口；"已发过""屏蔽 AI"这些规则在每次读取时重新应用，
  // 所以用户在设置里改了屏蔽词，不用等缓存过期。
  cacheSet(cacheKey, pool);
  const filtered = filterResults(pool, { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags, seen });
  if (!filtered.items.length && seen && droppedAllSeen(pool, seen)) {
    // 池子里全是发过的图：把这一批重新算作候选（宁可重发一张，也别报"没搜到"）
    const retry = filterResults(pool, { hideAi, allowR18, aiBlockTags: cfg.aiBlockTags });
    return { provider: providerId, query: word, stage, ...retry, attempts, reused: true, degraded };
  }
  return { provider: providerId, query: word, stage, ...filtered, attempts, degraded };
}

function droppedAllSeen(pool, seen) {
  return pool.length > 0 && pool.every((it) => seen.has(String(it.id || it.url)));
}

// ── 下载 / 发给 QQ ──────────────────────────────────────────────────────

function detectMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/** pixiv 图床有防盗链，必须带 referer；其它站不需要。 */
export function refererFor(url) {
  const host = (() => {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
  })();
  if (/pximg\.net$/.test(host) || /pixiv\.net$/.test(host)) return 'https://www.pixiv.net/';
  if (/safebooru\.org$/.test(host)) return 'https://safebooru.org/';
  if (/konachan\./.test(host)) return 'https://konachan.net/';
  if (/yande\.re$/.test(host)) return 'https://yande.re/';
  return '';
}

/**
 * 下载一张图（SSRF 校验 + 体积上限；pixiv 自动补 referer）。
 * @returns {{buffer:Buffer, contentType:string, mime:string, url:string}}
 */
export async function downloadImageBuffer(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('图片地址为空');
  await validateImageUrl(target);   // 先做一次显式校验，错误信息更清楚
  const referer = refererFor(target);
  const { buffer, contentType } = await safeFetchBinary(target, maxBytes, referer ? { headers: { referer } } : {});
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0] || 'image/jpeg';
  if (!/^image\//i.test(mime)) throw new Error(`返回的不是图片（${mime}）`);
  return { buffer, contentType: String(contentType || ''), mime, url: target };
}

/**
 * 依次尝试多个候选直链，返回第一个能下下来的。
 * （pixiv 的 original 有时 404/需要登录，regular 一般都有。）
 */
export async function downloadFirstAvailable(urls, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || '').trim()).filter(Boolean);
  if (!list.length) throw new Error('没有可用的图片地址');
  const errors = [];
  for (const url of list) {
    try {
      const got = await downloadImageBuffer(url, { maxBytes });
      return { ...got, tried: list.indexOf(url) + 1 };
    } catch (error) {
      errors.push(`${url.slice(0, 60)}… ${error?.message ?? error}`);
    }
  }
  throw new Error(`图片下载失败：${errors.join('；')}`);
}

/** 下载成 data URL（给视觉模型看）。 */
export async function imageUrlToDataUrl(url, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const { buffer, mime } = await downloadImageBuffer(url, { maxBytes });
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// ── 以图搜图（反查出处 / 找同款）────────────────────────────────────────
//
// 三个后端，能力与门槛各不相同（都是实测过的）：
//   · iqdb      —— 免 key、免登录，覆盖 pixiv/各 booru，返回"相似图 + 相似度"。
//                  严格说它是"找相似图"而不是"精确反查"，但对"这张图哪来的、有没有更好的版本"
//                  这个真实需求足够用（实测能给出相同作品在 Gelbooru/yande.re 等站的更高清版本）。
//   · trace.moe —— 免 key，专治**动画截图**："这是哪部番哪一集第几秒"，很准。
//   · SauceNAO  —— 最准的反查（pixiv 出处、作者、P 站 id），但**必须注册免费 API key**
//                  （匿名调用会被拒：The anonymous account type does not permit API usage）。
//                  设置页填了 key 就自动启用。

/**
 * iqdb：把图 POST 上去，解析 HTML 结果（无官方 API）。
 *
 * ⚠️ 解析要点（实测踩过）：结果的 HTML 结构**不是**文档里那种 `div.pages`，
 * 而是纯文本流：「Best match / Additional match / Possible match」+ 站点名 +
 * 尺寸 + [分级] + 「NN% similarity」，紧随其后才是结果链接。所以按**文本块**切，
 * 而不是按 class 切 —— 之前按 class 切导致所有正常结果都被误判成"被限流"。
 */
export async function iqdbSearch(buffer, { timeoutMs = 30000, mime = 'image/jpeg' } = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), 'query.jpg');
  const res = await fetch('https://iqdb.org/', {
    method: 'POST',
    body: fd,
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: withTimeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`iqdb HTTP ${res.status}`);
  const html = await res.text();
  if (!/(Best|Additional|Possible) match/i.test(html)) {
    if (/No relevant matches/i.test(html)) return [];
    throw new Error('iqdb 没有返回可解析的结果（可能被限流，过一会儿再试）');
  }

  // 把结果区分成一段一段：每个 "… match" 是段首，段内包含站点名/尺寸/[分级]/相似度，
  // 后面跟着 <a href> 指向上游站点。
  const chunks = html.split(/(?=<(?:td|div|th)[^>]*>\s*(?:Best|Additional|Possible) match)/i).slice(1);
  const items = [];
  for (const chunk of chunks) {
    const sim = Number(/(\d+)\s*%\s*similarity/i.exec(chunk)?.[1]) || 0;
    const dim = /(\d+)\s*[×x]\s*(\d+)/.exec(chunk) || [];
    const rating = /\[(Safe|Explicit|Ero|Unrated|Questionable)\]/i.exec(chunk)?.[1] || '';
    // 结果链接：iqdb 把 "See more results" 也算一条，要排掉
    const hrefs = [...chunk.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    const href = hrefs.find((u) => !/iqdb\.org/i.test(u) && !/\/search/i.test(u)) || '';
    if (!href || !sim) continue;
    // 站点名优先从链接域名取（比从 HTML 里抠更可靠）；抠不到再退回文本匹配
    let service = '';
    try { service = new URL(href).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    if (!service) service = /(?:match[\s\S]{0,160}?)([A-Za-z][\w.\- ]{2,22})\s*\d+\s*[×x]\s*\d+/.exec(chunk)?.[1]?.trim() || 'iqdb';
    items.push({
      similarity: sim,
      service,
      pageUrl: href,
      source: service.split('.')[0],
      width: Number(dim[1]) || 0,
      height: Number(dim[2]) || 0,
      rating: rating.toLowerCase() === 'safe' ? 'safe' : (rating ? 'r18' : 'unknown')
    });
  }
  // 按相似度降序，去掉重复页面
  const seen = new Set();
  return items
    .sort((a, b) => b.similarity - a.similarity)
    .filter((it) => (seen.has(it.pageUrl) ? false : (seen.add(it.pageUrl), true)))
    .slice(0, 10);
}

/** trace.moe：动画截图反查（哪部番、第几集、第几秒）。 */
export async function traceMoeSearch(imageUrl, { timeoutMs = 25000, minSimilarity = 0.85 } = {}) {
  const url = `https://api.trace.moe/search?anilistInfo=true&url=${encodeURIComponent(imageUrl)}`;
  const data = await fetchJson(url, { timeoutMs });
  if (data?.error) throw new Error(`trace.moe：${data.error}`);
  const rows = Array.isArray(data?.result) ? data.result : [];
  // ⚠️ 必须设阈值：trace.moe 对**非动画截图**也会返回一堆 60~70% 的结果
  //    （实测一张 pixiv 插画被它匹配到 4 部毫不相干的番），不设阈值就是纯噪声。
  return rows
    .filter((r) => (Number(r.similarity) || 0) >= minSimilarity)
    .slice(0, 5)
    .map((r) => ({
      similarity: Math.round((Number(r.similarity) || 0) * 100),
      service: 'trace.moe',
      source: 'anime',
      title: String(r.anilist?.title?.native || r.anilist?.title?.romaji || r.filename || '').slice(0, 60),
      episode: r.episode ? `第 ${r.episode} 集` : '',
      at: Number(r.from) ? `${Math.floor(Number(r.from) / 60)}:${String(Math.floor(Number(r.from) % 60)).padStart(2, '0')}` : '',
      preview: String(r.image || ''),
      video: String(r.video || ''),
      pageUrl: r.anilist?.id ? `https://anilist.co/anime/${r.anilist.id}` : ''
    }));
}

/** SauceNAO：需要 API key（免费注册）。填了才走这里。 */
export async function sauceNaoSearch(buffer, { apiKey = '', timeoutMs = 30000, mime = 'image/jpeg', numres = 6 } = {}) {
  if (!apiKey) throw new Error('SauceNAO 需要 API key（saucenao.com 免费注册后可查）');
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), 'query.jpg');
  fd.append('output_type', '2');
  fd.append('numres', String(Math.min(10, Math.max(1, numres))));
  fd.append('db', '999');
  fd.append('api_key', apiKey);
  const res = await fetch('https://saucenao.com/search.php', {
    method: 'POST',
    body: fd,
    headers: { 'user-agent': UA },
    signal: withTimeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { throw new Error(`SauceNAO 返回异常：${text.slice(0, 120)}`); }
  if (data?.header?.status && Number(data.header.status) < 0) {
    throw new Error(`SauceNAO：${data.header.message || '调用失败'}`);
  }
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map((r) => {
    const h = r?.header || {};
    const d = r?.data || {};
    const ext = Array.isArray(d.ext_urls) ? d.ext_urls : [];
    const pixivId = String(d.pixiv_id || '').trim();
    return {
      similarity: Math.round(Number(h.similarity) || 0),
      service: `SauceNAO/${h.index_name || ''}`,
      source: pixivId ? 'pixiv' : (d.source ? String(d.source) : 'other'),
      id: pixivId,
      title: String(d.title || '').slice(0, 80),
      author: String(d.author_name || d.member_name || '').slice(0, 40),
      pageUrl: pixivId ? `https://www.pixiv.net/artworks/${pixivId}` : String(ext[0] || ''),
      links: ext.slice(0, 4),
      rating: String(d.rating || '')
    };
  }).filter((it) => it.pageUrl || it.title).slice(0, 10);
}

/**
 * 以图搜图主入口：跑所有可用后端，合并结果。
 * @param {Buffer} buffer 图片字节
 * @param {{imageUrl?:string, sauceNaoKey?:string, timeoutMs?:number, mime?:string}} opts
 */
export async function reverseImageSearch(buffer, opts = {}) {
  const cfg = opts.cfg || imageSearchConfig();
  const mime = opts.mime || 'image/jpeg';
  const backends = [];
  const out = { iqdb: [], saucenao: [], anime: [], errors: [] };

  // iqdb 和 SauceNAO 可以并行；trace.moe 需要公网 URL（本地字节它不收）
  const jobs = [
    iqdbSearch(buffer, { timeoutMs: opts.timeoutMs || cfg.timeoutMs * 2, mime })
      .then((r) => { out.iqdb = r; backends.push('iqdb'); })
      .catch((e) => out.errors.push(`iqdb: ${e.message}`))
  ];
  if (cfg.sauceNaoKey) {
    jobs.push(sauceNaoSearch(buffer, { apiKey: cfg.sauceNaoKey, timeoutMs: opts.timeoutMs || cfg.timeoutMs * 2, mime })
      .then((r) => { out.saucenao = r; backends.push('saucenao'); })
      .catch((e) => out.errors.push(`saucenao: ${e.message}`)));
  }
  if (opts.imageUrl) {
    jobs.push(traceMoeSearch(opts.imageUrl, { timeoutMs: opts.timeoutMs || 20000 })
      .then((r) => { out.anime = r; if (r.length) backends.push('trace.moe'); })
      .catch((e) => out.errors.push(`trace.moe: ${e.message}`)));
  }
  await Promise.all(jobs);

  // 合并去重：同一作品可能在多个后端/多个站点出现，按 (来源 + 页面地址) 去重，保留相似度最高的
  const merged = [];
  const seenKey = new Set();
  const push = (item) => {
    const key = `${item.source || ''}|${item.id || item.pageUrl || item.title || ''}`;
    if (!key.replace(/\|/g, '') || seenKey.has(key)) return;
    seenKey.add(key);
    merged.push(item);
  };
  for (const it of out.saucenao) push(it);      // SauceNAO 最准，排最前
  for (const it of out.iqdb) push(it);
  for (const it of out.anime) push(it);
  merged.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  return { items: merged, backends, errors: out.errors };
}

/** iqdb 之类给出的相似图，把它的详情页转成"能给模型看的一行"。 */
export function describeReverse(item, index = null) {
  const bits = [];
  if (index !== null && index !== undefined) bits.push(`[${index}]`);
  bits.push(`${item.similarity || 0}% 相似`);
  if (item.service) bits.push(item.service);
  if (item.title) bits.push(`「${item.title}」`);
  if (item.author) bits.push(`by ${item.author}`);
  if (item.episode || item.at) bits.push(`${item.episode || ''}${item.at ? ` @ ${item.at}` : ''}`);
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.rating) bits.push(`[${item.rating}]`);
  if (item.pageUrl) bits.push(item.pageUrl);
  return bits.join(' · ');
}

/** 给模型看的一行摘要。 */
export function describeResult(item, index = null) {
  const bits = [];
  if (index !== null && index !== undefined) bits.push(`[${index}]`);
  bits.push(item.title ? `「${item.title}」` : '（无标题）');
  if (item.author) bits.push(`by ${item.author}`);
  // 人气是"好不好看"最直接的信号，必须给模型看到（它据此决定发哪张）
  const bm = Number(item.bookmarkCount);
  if (Number.isFinite(bm) && bm >= 0) bits.push(`❤${bm}`);
  if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
  if (item.pageCount > 1) bits.push(`${item.pageCount}页`);
  if (item.ai === true) bits.push('AI生成');
  else if (item.ai === false) bits.push('人工绘制');
  if (item.tags?.length) bits.push(item.tags.slice(0, 8).join('/'));
  if (item.pageUrl) bits.push(item.pageUrl);
  return bits.join(' · ');
}

export function resetImageSearchCache() {
  MEMORY_CACHE.clear();
}
