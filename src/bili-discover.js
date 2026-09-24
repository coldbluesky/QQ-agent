// B 站"最近在流行什么"的主动发现层。
//
// 为什么单独一个文件：bili-meme.js 负责"求证某个说法"，本文件负责"主动发现候选梗"，
// 两者职责不同；分开放也让 bili-meme.js 保持纯粹的"点名求证"语义。
//
// 思路（关键，改之前先读）：
//   热门视频标题往往很长（"【xx】xxx居然xxx，我笑死了"），整句不是梗，模型也不容易
//   从中提炼出"可复用的一句话"。而 B 站**搜索建议**接口（suggest）返回的正是
//   "被大量用户搜过的说法"——那才是"真有人在说"的证据。所以流程是：
//     热门标题 → 切候选片段 → 逐个问 suggest → 命中的才算候选梗。
//   这样交给模型的是"经过验证的短句"，而不是一堆长标题。
//
// 依赖 bili-meme.js 里已验证过的三个底层能力（免登录、无风控）：
//   biliHotVideos（ranking/popular）、biliSuggest、cleanBiliText、BILI_SEARCH_URL。
import { biliHotVideos, biliSuggest, cleanBiliText, BILI_SEARCH_URL } from './bili-meme.js';

/** 归一化：去空白 + 转小写（去重/匹配用）。 */
function normKey(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 从热门视频标题里"猜"出可能的梗词，并用 B 站搜索建议验证。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]     取多少条热门视频标题来切（默认 12）
 * @param {number} [opts.maxProbe]  最多验证几个候选片段（默认 6；每个都要请求一次，别设太大）
 * @param {number} [opts.timeoutMs] 单次请求超时
 * @returns {Promise<Array<{term:string, evidence:string, urls:string[]}>>}
 */
export async function discoverMemeCandidates({ limit = 12, maxProbe = 6, timeoutMs = 12000 } = {}) {
  // 榜单偶尔被风控（-352）挡住 → 退回热门接口（与 lookupMemeOnBili 同策略）
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
  const want = Math.max(1, Math.min(30, Number(limit) || 12));
  const videos = list.slice(0, want);

  // 切候选片段：按常见分隔符切开，丢掉纯符号 / 纯数字 / 过短过长（不是"一句话"）的片段。
  const stops = /[，。！？!?、\s|｜/／·—\-—【】\[\]（）()《》<>"'“”‘’,:：;；~～]+/;
  const candidates = [];
  const seenTerm = new Set();
  for (const v of videos) {
    for (const raw of String(v.title || '').split(stops)) {
      const piece = cleanBiliText(raw).replace(/^[0-9]+$/g, '').trim();
      if (piece.length < 2 || piece.length > 10) continue;
      if (/^[0-9a-zA-Z]+$/.test(piece) && piece.length < 4) continue;
      const key = normKey(piece);
      if (!key || seenTerm.has(key)) continue;
      seenTerm.add(key);
      candidates.push(piece);
    }
  }

  // 逐个用 suggest 验证（限量探针：每个候选一次请求，避免把接口打爆触发风控）
  const probeCount = Math.max(1, Math.min(20, Number(maxProbe) || 6));
  const out = [];
  const seenHit = new Set();
  for (const term of candidates) {
    if (out.length >= probeCount) break;
    const key = normKey(term);
    if (seenHit.has(key)) continue;
    try {
      const s = await biliSuggest(term, { timeoutMs });
      if (!s.exists) continue;
      seenHit.add(key);
      out.push({ term, evidence: 'B站搜索建议命中', urls: [BILI_SEARCH_URL(term)] });
    } catch {
      // 单个探针失败不影响整体（多半是限流）；跳过继续
      continue;
    }
  }
  return out;
}
