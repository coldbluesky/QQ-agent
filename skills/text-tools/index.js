// 文本工具插件（旧格式兼容形态：register(api) + plugin.json）。
//
// 与 plugins/calculator/ 留在 plugins/ 的理由相同：它是**旧插件格式仍可加载**
// 这条兼容线的证据（test/skill-test.mjs、test/coverage-e2e.mjs 都断言它被加载
// 且工具挂上了 skillId='text-tools'）。见该文件顶部注释的详细说明。
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 纯函数：不碰网络、不碰磁盘、不改全局状态
//   · **不解析正则**：让模型传正则等于把一个可 Catastrophic Backtracking 的
//     引擎开进主进程（/^(a+)+$/ 对 "aaaa...b" 能让 CPU 跑满）。本项目里
//     文本匹配的需求都能用"包含/替换字面量"表达，所以只做字面量匹配。
//   · 输入长度硬上限：见 maxInputChars，超限直接拒绝而不是硬算。

import { createHash } from 'node:crypto';

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
const DEFAULTS = { maxInputChars: 20000, hashAlgo: 'sha256' };
const HASH_ALGOS = ['sha256', 'sha1', 'md5'];

let cfg = () => ({});

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  const n = Number(out.maxInputChars);
  out.maxInputChars = Number.isFinite(n) && n > 0 ? Math.min(200000, Math.trunc(n)) : 20000;
  if (!HASH_ALGOS.includes(out.hashAlgo)) out.hashAlgo = 'sha256';
  return out;
}

/** 统一的入参取文本 + 长度校验。返回 {ok:true,text} 或 {ok:false,error}。 */
function takeText(args) {
  const text = String(args?.text ?? '');
  if (!text) return { ok: false, error: 'text 不能为空' };
  const { maxInputChars } = settings();
  if ([...text].length > maxInputChars) {
    return { ok: false, error: `文本过长（${[...text].length} 字，上限 ${maxInputChars} 字）` };
  }
  return { ok: true, text };
}

/**
 * 字数统计。
 *
 * ⚠️ 三种口径都要给，因为问"多少字"的人想要的不一定是同一种：
 *   · chars      —— 字符数（含空格与标点），String.length 会按 UTF-16 把 emoji 算两个，所以这里按码点算
 *   · noSpace    —— 去掉所有空白后的字符数（"正文字数"通常指这个）
 *   · words      —— 词数：英文按空白切，中文按字算（对中英混排最接近直觉）
 */
export function countText(text) {
  const chars = [...text].length;
  const noSpace = [...text.replace(/\s/g, '')].length;
  // 中文（含扩展区）逐字计数 + 连续的拉丁字母/数字算一个词
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
  return { chars, noSpace, words: cjk.length + latin.length, lines: text.split(/\r\n|\r|\n/).length };
}

/**
 * 全角 ↔ 半角。
 * 全角 ASCII（U+FF01~U+FF5E）与半角（U+0021~U+007E）相差 0xFEE0；
 * 全角空格 U+3000 → U+0020 单独处理（它不在上面那个区间里）。
 */
export function convertWidth(text, { to = 'half' } = {}) {
  if (to === 'full') {
    return text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))
      .replace(/ /g, '\u3000');
  }
  return text.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

/** 去重复行（保持首次出现的顺序；空行默认保留一条）。 */
export function uniqueLines(text, { trim = true, dropEmpty = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const key = trim ? raw.trim() : raw;
    if (dropEmpty && !key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out.join('\n');
}

/** 按字面量替换（不走正则，见文件头说明）。occurrence='all' | 'first'。 */
export function replaceText(text, { from = '', to = '', occurrence = 'all' } = {}) {
  const needle = String(from);
  if (!needle) return { ok: false, error: 'from 不能为空' };
  if (occurrence === 'first') {
    const idx = text.indexOf(needle);
    if (idx < 0) return { ok: true, text, replaced: 0 };
    return { ok: true, text: text.slice(0, idx) + String(to) + text.slice(idx + needle.length), replaced: 1 };
  }
  let replaced = 0;
  let cursor = 0;
  let result = '';
  for (;;) {
    const idx = text.indexOf(needle, cursor);
    if (idx < 0) break;
    result += text.slice(cursor, idx) + String(to);
    cursor = idx + needle.length;
    replaced++;
  }
  result += text.slice(cursor);
  return { ok: true, text: result, replaced };
}

/** 取片段：按行号（1 起）或按字符偏移。 */
export function sliceText(text, { startLine = 0, endLine = 0, start = 0, length = 0, tail = 0 } = {}) {
  if (tail > 0) {
    const all = [...text];
    const n = Math.min(all.length, Math.trunc(tail));
    return { ok: true, text: all.slice(all.length - n).join('') };
  }
  if (startLine > 0 || endLine > 0) {
    const lines = text.split(/\r\n|\r|\n/);
    const from = Math.max(1, Math.trunc(startLine) || 1);
    const to = Math.trunc(endLine) > 0 ? Math.trunc(endLine) : lines.length;
    if (from > lines.length) return { ok: false, error: `起始行 ${from} 超过总行数 ${lines.length}` };
    return { ok: true, text: lines.slice(from - 1, to).join('\n'), totalLines: lines.length };
  }
  const s = Math.max(0, Math.trunc(start) || 0);
  const l = Math.trunc(length) > 0 ? Math.trunc(length) : [...text].length - s;
  return { ok: true, text: [...text].slice(s, s + l).join('') };
}

/** 文本指纹：用于"这段话是不是之前发过"这类比对。 */
export function digest(text, { algo = 'sha256' } = {}) {
  const use = HASH_ALGOS.includes(algo) ? algo : 'sha256';
  return { algo: use, hex: createHash(use).update(String(text), 'utf8').digest('hex') };
}

// ── 插件生命周期（旧入口 register）─────────────────────────────────────────

export function register(api) {
  cfg = api.config;
  const log = api.log || (() => {});
  log('文本工具已就绪');

  const needText = (args) => {
    const t = takeText(args);
    if (!t.ok) return { content: t.error, isError: true };
    return null;
  };

  api.registerTool({
    id: 'count',
    name: '数一下',
    description: '统计文本字数：返回总字符数、去空白字符数、词数、行数。回答"多少字"这类问题必须用它。',
    category: 'utility',
    icon: '🔢',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要统计的文本' } },
      required: ['text']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const r = countText(String(args.text));
      return { content: `共 ${r.chars} 个字符（去空白 ${r.noSpace} 字），${r.words} 个词，${r.lines} 行` };
    }
  });

  api.registerTool({
    id: 'convert',
    name: '转换文本',
    description: '文本转换：全角转半角/半角转全角、大写/小写。适合把用户从别处粘来的全角标点、全角英文整理成正常写法。',
    category: 'utility',
    icon: '🔤',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转换的文本' },
        mode: {
          type: 'string',
          enum: ['toHalf', 'toFull', 'upper', 'lower'],
          description: 'toHalf=全角转半角（默认），toFull=半角转全角，upper=转大写，lower=转小写'
        }
      },
      required: ['text']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const text = String(args.text);
      const mode = String(args.mode || 'toHalf');
      if (mode === 'upper') return { content: text.toUpperCase() };
      if (mode === 'lower') return { content: text.toLowerCase() };
      if (mode === 'toFull') return { content: convertWidth(text, { to: 'full' }) };
      return { content: convertWidth(text, { to: 'half' }) };
    }
  });

  api.registerTool({
    id: 'dedupe_lines',
    name: '去除重复行',
    description: '去掉文本里重复的行，保持首次出现的顺序。整理列表、去重名单时用。',
    category: 'utility',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '多行文本' },
        dropEmpty: { type: 'boolean', description: '是否顺便删掉空行（默认保留一条）' }
      },
      required: ['text']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const before = String(args.text).split(/\r\n|\r|\n/).length;
      const out = uniqueLines(String(args.text), { dropEmpty: args.dropEmpty === true });
      const after = out.split(/\r\n|\r|\n/).length;
      return { content: `去重后 ${after} 行（原 ${before} 行）：\n${out}` };
    }
  });

  api.registerTool({
    id: 'replace',
    name: '替换文本',
    description: '按字面量替换文本（不支持正则）。需要把某几个字统一换掉时用。',
    category: 'utility',
    icon: '✏️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '原文本' },
        from: { type: 'string', description: '要被替换的内容（字面量，不是正则）' },
        to: { type: 'string', description: '替换成什么（可以是空串=删除）' },
        occurrence: { type: 'string', enum: ['all', 'first'], description: '全部替换（默认）还是只替换第一处' }
      },
      required: ['text', 'from', 'to']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const r = replaceText(String(args.text), {
        from: args.from, to: args.to, occurrence: args.occurrence === 'first' ? 'first' : 'all'
      });
      if (!r.ok) return { content: r.error, isError: true };
      return { content: `替换了 ${r.replaced} 处：\n${r.text}` };
    }
  });

  api.registerTool({
    id: 'slice',
    name: '截取片段',
    description: '从文本里取一段：可以按行号取（第几行到第几行），也可以按字符位置取，或取最后 N 个字符。长文本里找片段时用。',
    category: 'utility',
    icon: '✂️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '原文本' },
        startLine: { type: 'integer', description: '起始行号（从 1 数，可选）' },
        endLine: { type: 'integer', description: '结束行号（含，可选；不填则到最后一行）' },
        start: { type: 'integer', description: '按字符取时的起始下标（从 0 数，可选）' },
        length: { type: 'integer', description: '按字符取时取多少字（可选）' },
        tail: { type: 'integer', description: '取最后 N 个字符（可选，优先级最高）' }
      },
      required: ['text']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const r = sliceText(String(args.text), args);
      if (!r.ok) return { content: r.error, isError: true };
      return { content: r.text };
    }
  });

  api.registerTool({
    id: 'digest',
    name: '算文本指纹',
    description: '计算文本的摘要（sha256/sha1/md5）。用于判断两段文本是否完全相同——比人眼比对可靠。',
    category: 'utility',
    icon: '🔐',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要算指纹的文本' },
        algo: { type: 'string', enum: HASH_ALGOS, description: '算法，默认 sha256' }
      },
      required: ['text']
    },
    async execute(_ctx, args) {
      const bad = needText(args); if (bad) return bad;
      const algo = args?.algo || settings().hashAlgo;
      const r = digest(String(args.text), { algo });
      return { content: `${r.algo}: ${r.hex}` };
    }
  });
}

export function available() { return { ok: true }; }

export const internals = { countText, convertWidth, uniqueLines, replaceText, sliceText, digest, settings };
