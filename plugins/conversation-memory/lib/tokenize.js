// 分词：中文按字 bigram + ASCII 词，给海马倒排用。
// 不追求语言学完美，只求「给对关键词能搜到」。

const STOP = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '在',
  '和', '与', '也', '就', '都', '很', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
  'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'in', 'on', 'at'
]);

/** 规范化：全角半角、大小写。 */
export function normText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 切出检索 token。
 * - ASCII/数字连续段 → 整词
 * - 汉字串 → 每个字 + 相邻 bigram（过滤单字停用）
 */
export function tokenize(text) {
  const s = normText(text);
  if (!s) return [];
  const out = new Set();
  const push = (t) => {
    if (!t || t.length < 1) return;
    if (STOP.has(t)) return;
    if (t.length > 40) return;
    out.add(t);
  };

  // ASCII words / numbers / mixed
  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) push(m[0]);

  // CJK runs → chars + bigrams
  for (const run of s.match(/[一-鿿㐀-䶿]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      push(run[i]);
      if (i + 1 < run.length) push(run.slice(i, i + 2));
    }
  }

  return [...out];
}

/** 查询串 → 带权 token 列表（长词权重大）。 */
export function queryTokens(text) {
  const s = normText(text);
  const toks = tokenize(s);
  const weights = new Map();
  for (const t of toks) {
    const w = t.length >= 4 ? 2.5 : t.length >= 2 ? 1.5 : 1;
    weights.set(t, Math.max(weights.get(t) || 0, w));
  }
  // 整句若不长也进索引，精确短语加分
  if (s && s.length >= 2 && s.length <= 24) {
    weights.set(s, 4);
  }
  return weights;
}
