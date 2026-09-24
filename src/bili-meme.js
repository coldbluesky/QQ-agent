// B 站找梗：确认一个说法在 B 站是不是"真的有人这么说"，顺便看看当下在流行什么整活。
//
// 为什么用 suggest 而不是搜索接口？
// 实测 B 站的搜索页（https://search.bilibili.com/all?keyword=...）和
// x/web-interface/search/type 都被风控挡着：匿名请求直接 HTTP 412（请求被拦截），
// 想稳定拿到结果就得带 cookie（SESSDATA 等），对群机器人来说既不稳定也不合适。
// 而 /main/suggest 是搜索框的下拉联想接口，免登录、不触发风控、响应很快，
// 它返回的正是"用户在 B 站搜得多的说法"—— 恰好就是"有没有人这么说"的直接证据。
// 排行榜（ranking/v2）与热门（popular）同样免登录，用来补充"现在大家在玩什么"；
// 它们的标题偶尔带 <em class="keyword"> 高亮标签，所以统一走 cleanBiliText 清洗。
//
// 关于 ranking/v2 的 -352（实测记录，改代码前先看这段）：
// 未登录直接请求 ranking/v2 时，B 站可能返回 {code:-352}（风控），跟参数无关。实测：
//   · 只带 user-agent/referer/accept            → -352
//   · 再加 origin                             → 仍 -352
//   · 只带 buvid3 + buvid4 两个 cookie          → 仍 -352
//   · 带完整浏览器指纹 cookie（buvid3 + buvid4 +
//     b_nut + b_lsid + _uuid）+ origin         → code=0，100 条
//   · 请求太密集时也会 -352（隔几秒/换新指纹即恢复）
// 所以这里自己生成一套浏览器指纹 cookie，并在遇到 -352 时换新指纹重试一次。
// popular 接口没有这个限制（不带 cookie 也能过），这条只是为了 ranking。

/** 普通浏览器 UA + referer：B 站对无 referer 的匿名请求会更容易拦。 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 搜索建议接口（免登录、无风控）用的头。 */
const SUGGEST_HEADERS = {
  'user-agent': BROWSER_UA,
  'referer': 'https://www.bilibili.com/',
  'accept': 'application/json'
};

/** api.bilibili.com 上的接口再补 origin + 浏览器指纹 cookie（见文件头 -352 说明）。 */
const API_HEADERS = { ...SUGGEST_HEADERS, origin: 'https://www.bilibili.com' };

const SUGGEST_API = 'https://s.search.bilibili.com/main/suggest';
const RANKING_API = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all';
const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular';

const COOKIE_TTL = 30 * 60 * 1000;   // 指纹 cookie 复用 30 分钟，够用且不至于太假

/** 可直接引用的搜索页链接（给模型当出处用）。 */
export const BILI_SEARCH_URL = (term) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(term ?? ''))}`;

// ── 浏览器指纹 cookie ──────────────────────────────────────────────────────

let cookieJar = '';
let cookieAt = 0;

function randomHex(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out.toUpperCase();
}

/** 造一套"看起来像浏览器"的 cookie：ranking 接口就吃这一套。 */
function newCookieJar() {
  const now = Date.now();
  const b3 = `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}infoc`;
  const b4 = `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}-${now % 100000}-0`;
  const uuid = [1, 2, 3, 4].map(() => randomHex(4).toLowerCase()).join('-');
  return [
    `buvid3=${b3}`,
    `buvid4=${b4}`,
    `b_nut=${Math.floor(now / 1000)}`,
    `b_lsid=${randomHex(8)}${now.toString(16).toUpperCase()}`,
    `_uuid=${uuid}-infoc`
  ].join('; ');
}

function currentCookieJar({ fresh = false } = {}) {
  if (fresh || !cookieJar || Date.now() - cookieAt > COOKIE_TTL) {
    cookieJar = newCookieJar();
    cookieAt = Date.now();
  }
  return cookieJar;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── HTML 清洗 ──────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×', copy: '©',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’'
};

function fromCodePointSafe(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 还原常见 HTML 实体（含 &#39; / &#x27; 这类数字实体）。 */
function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    const key = String(body).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    if (key.startsWith('#x')) return fromCodePointSafe(parseInt(key.slice(2), 16)) || whole;
    if (key.startsWith('#')) return fromCodePointSafe(parseInt(key.slice(1), 10)) || whole;
    return whole;
  });
}

/**
 * 标题/简介清洗：去掉 <em class="keyword"> 这类高亮标签、还原实体、压缩空白。
 * 排行榜接口一般不带标签，但搜索类接口会带，统一处理更稳妥。
 */
export function cleanBiliText(input) {
  const withoutTags = String(input ?? '').replace(/<[^>]*>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/** 匹配用的归一化：去空白 + 转小写（避免大小写/空格造成漏匹配）。 */
function normKey(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

// ── 请求封装 ───────────────────────────────────────────────────────────────

/**
 * 拉一个 B 站 JSON 接口。任何失败（网络、超时、HTTP 非 2xx、code !== 0）都抛错，
 * 调用方（工具层）负责把 message 展示出来 —— 绝不静默返回空数据。
 */
async function fetchBiliJson(url, { timeoutMs, what, withCookie = false, cookie = '', emptyCodes = null }) {
  const headers = withCookie ? { ...API_HEADERS, cookie } : { ...SUGGEST_HEADERS };
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = String(error?.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`B站${what}接口超时（${timeoutMs}ms）`);
    }
    throw new Error(`B站${what}接口请求失败：${error?.message ?? error}`);
  }
  if (!res.ok) throw new Error(`B站${what}接口 HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`B站${what}接口返回的不是合法 JSON`);
  }
  if (Number(data?.code) !== 0) {
    // 有的接口用非 0 码表达"没结果"而不是"失败"：suggest 在完全查不到时会返回
    // code=3（total_count=0、result.tag 为空数组），这不是错误。
    // 这类码必须由调用方在 emptyCodes 里显式声明；其余非 0 码一律抛错。
    if (Array.isArray(emptyCodes) && emptyCodes.includes(Number(data?.code))) return data;
    const error = new Error(`B站${what}接口返回 code=${data?.code ?? 'null'}：${data?.message || data?.msg || '未知错误'}`);
    error.biliCode = Number(data?.code);   // 供上层识别 -352/-412 这类风控码
    throw error;
  }
  return data;
}

/**
 * 请求 api.bilibili.com 上的接口（ranking/popular）：带指纹 cookie；
 * 若被风控（-352/-412）挡住，换个新指纹再试一次 —— 实测这样能恢复。
 */
async function fetchBiliApi(url, { timeoutMs, what, retryOnRisk = true }) {
  try {
    return await fetchBiliJson(url, { timeoutMs, what, withCookie: true, cookie: currentCookieJar() });
  } catch (error) {
    const risk = error?.biliCode === -352 || error?.biliCode === -412;
    if (!retryOnRisk || !risk) throw error;
    await delay(800);
    return fetchBiliJson(url, { timeoutMs, what, withCookie: true, cookie: currentCookieJar({ fresh: true }) });
  }
}

// ── 搜索建议 ───────────────────────────────────────────────────────────────

function suggestionList(payload) {
  const result = payload?.result;
  const raw = Array.isArray(result?.tag) ? result.tag
    : Array.isArray(result) ? result
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const value = cleanBiliText(item?.value ?? item?.name ?? item?.term);
    if (!value) continue;
    const key = normKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      value,
      term: cleanBiliText(item?.term) || value,
      ref: item?.ref === undefined || item?.ref === null ? '' : String(item.ref)
    });
  }
  return out;
}

/**
 * 在 B 站确认一个说法是不是"真的有人这么说"：拿搜索建议当证据。
 * exists = 建议里存在与 term 高度重合的项（去空格/小写后相等或互相包含）。
 * 取前 8 条建议（够模型判断，也不至于把上下文塞满）。
 */
export async function biliSuggest(term, { timeoutMs = 10000 } = {}) {
  const raw = String(term ?? '').trim();
  if (!raw) throw new Error('要查的说法为空');
  const url = `${SUGGEST_API}?term=${encodeURIComponent(raw)}`;
  const data = await fetchBiliJson(url, { timeoutMs, what: '搜索建议', emptyCodes: [3] });
  const suggestions = suggestionList(data).slice(0, 8);
  const target = normKey(raw);
  const exists = suggestions.some((s) => {
    const value = normKey(s.value);
    if (!value || !target) return false;
    return value === target || value.includes(target) || target.includes(value);
  });
  return { ok: true, term: raw, exists, suggestions };
}

// ── 热门 / 排行榜 ─────────────────────────────────────────────────────────

function toVideo(item) {
  const bvid = String(item?.bvid ?? '').trim();
  return {
    bvid,
    title: cleanBiliText(item?.title),
    author: cleanBiliText(item?.owner?.name),
    view: Number(item?.stat?.view) || 0,    // stat 可能缺失 → 0
    like: Number(item?.stat?.like) || 0,
    desc: cleanBiliText(item?.desc),
    url: `https://www.bilibili.com/video/${bvid}`,
    duration: Number(item?.duration) || 0
  };
}

/**
 * 拉一批"热门视频"，用来找当下耳熟能详的梗/整活。
 * kind: 'ranking' = 全站排行榜（一次约 100 条）；'popular' = 热门（按 limit 请求）。
 * 返回按接口顺序，已截到 limit 条；没有 bvid 的条目（拼不出链接）直接丢掉。
 */
export async function biliHotVideos({ kind = 'ranking', limit = 20, timeoutMs = 15000 } = {}) {
  const which = String(kind || 'ranking').trim().toLowerCase();
  if (which !== 'ranking' && which !== 'popular') {
    throw new Error(`不支持的榜单类型 kind=${kind}（只能是 ranking 或 popular）`);
  }
  const want = Math.max(1, Math.min(100, Number(limit) || 20));
  const url = which === 'popular'
    ? `${POPULAR_API}?ps=${Math.min(50, want)}&pn=1`
    : RANKING_API;
  const data = await fetchBiliApi(url, { timeoutMs, what: which === 'popular' ? '热门视频' : '排行榜' });
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  return list.map(toVideo).filter((v) => v.bvid).slice(0, want);
}

// ── 综合入口 ───────────────────────────────────────────────────────────────

/**
 * 查一个梗在 B 站的情况：
 * 1) 搜索建议命中 → 说明"有人这么说"（exists=true）；
 * 2) 再从排行榜（不够就退回热门）里找标题/简介包含 term 的视频，作为可引用的素材。
 * "没找到证据"是正常结果（exists=false，不抛错）；真·网络失败才抛错。
 */
export async function lookupMemeOnBili(term, { timeoutMs = 12000, videoLimit = 6 } = {}) {
  const raw = String(term ?? '').trim();
  if (!raw) throw new Error('要查的说法为空');
  const target = normKey(raw);

  // 搜索建议是主证据：它失败说明网络/接口有问题，直接抛。
  const suggest = await biliSuggest(raw, { timeoutMs });

  // 视频侧：先用排行榜（100 条，覆盖广）；被风控挡住时退回热门（当下流行）。
  // 两条路都失败才算网络故障，才抛错 —— 只是"没命中"不算错。
  let list = [];
  try {
    list = await biliHotVideos({ kind: 'ranking', limit: 100, timeoutMs });
  } catch (rankingError) {
    try {
      list = await biliHotVideos({ kind: 'popular', limit: 50, timeoutMs });
    } catch (popularError) {
      throw new Error(`B站热门视频获取失败：排行榜(${rankingError?.message ?? rankingError})；热门(${popularError?.message ?? popularError})`);
    }
  }

  const seen = new Set();
  const videos = [];
  for (const v of list) {
    if (seen.has(v.bvid)) continue;
    seen.add(v.bvid);
    const hit = Boolean(target) && (normKey(v.title).includes(target) || normKey(v.desc).includes(target));
    if (!hit) continue;
    // 综合入口只给模型需要的字段（desc/duration 不进上下文，省 token）
    videos.push({ bvid: v.bvid, title: v.title, author: v.author, view: v.view, like: v.like, url: v.url });
  }
  const picked = videos.slice(0, Math.max(0, Number(videoLimit) || 0));

  const exists = suggest.exists || picked.length > 0;
  let evidence = '未在B站找到明确证据';
  if (suggest.exists) evidence = 'B站搜索建议命中';
  else if (picked.length) evidence = 'B站热门视频标题命中';

  return {
    term: raw,
    exists,
    suggestions: suggest.suggestions,
    videos: picked,
    evidence,
    urls: [BILI_SEARCH_URL(raw), ...picked.map((v) => v.url)]
  };
}
