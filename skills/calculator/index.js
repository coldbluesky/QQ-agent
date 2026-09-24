// 计算器插件（旧格式兼容形态：register(api) 而非 setup(api)）。
//
// ── 两型归位 ───────────────────────────────────────────────────────────
// 计算器**注册了工具**（calculator__eval），按两型语义属 LLM 型，因此归位在
// skills/（审计第 15 节：skills/ 条目必须 tools>0；plugins/ 条目必须 caps/hooks>0）。
// 它同时是"旧格式兼容"的活证据：`register(api)` 入口 + `plugin.json` 清单
// 是本项目从插件体系演进到 Skill 体系前的写法，test/skill-test.mjs 与
// test/coverage-e2e.mjs 都断言它**仍然能被加载**（README 承诺旧插件不失效）。
// 两种清单文件走同一条 normalizeManifest（src/skills/manifest.js），目录不挑清单 ——
// skills/ 下放 plugin.json 完全合法。
//
// ── 边界 ─────────────────────────────────────────────────────────────────
//   · 纯函数，不碰网络、不碰磁盘、不改全局状态
//   · 不做"表达式解析成任意 JS"那种事：手写递归下降，只认识白名单运算符与函数，
//     绝不 eval —— 模型给的字符串是不可信输入，eval 等于把进程交出去
//   · 指数上限硬编码（见 MAX_POW），避免 10^999999 这种表达式把进程卡死

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = { precision: 8, allowPower: true };

/** 幂的上限：超过就直接拒绝。10^999999 会让 Math.pow 返回 Infinity，
 *  更糟的是某些实现会先算大整数把内存吃光。这里从源头挡住。 */
const MAX_POW = 10000;

let cfg = () => ({});

/** 当前设置（出厂默认 ← 用户在设置页改过的值）。 */
function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  // precision 钳到 0~15：负数会让 toFixed 抛 RangeError，>15 在双精度下没有意义
  const p = Number(out.precision);
  out.precision = Number.isFinite(p) ? Math.min(15, Math.max(0, Math.trunc(p))) : 8;
  return out;
}

/**
 * 按精度收干净浮点误差。
 *
 * 为什么要这一步：0.1 + 0.2 在 IEEE754 下是 0.30000000000000004。
 * 直接把原始值给模型，模型会照着念进群里 —— 那看起来就像计算器坏了。
 */
export function roundTo(value, precision) {
  const n = Number(value);
  if (!Number.isFinite(n)) return n;
  const digits = Math.min(15, Math.max(0, Number(precision) || 0));
  // 先按科学计数法挪位再乘除回来，避免 toFixed 在大数上返回字符串再解析的精度损失
  const shift = 10 ** digits;
  return Math.round((n + Number.EPSILON) * shift) / shift;
}

/** 数字字面量：整数、小数、科学计数法（1e3）。 */
const NUM = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** 允许的函数名白名单 —— 不在表里的一律拒绝，不是"未知函数"就是攻击面。 */
const FUNCS = {
  sqrt: (x) => Math.sqrt(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs)
};

/**
 * 表达式求值：手写递归下降，绝不 eval。
 *
 * 文法（由低到高优先级）：
 *   expr   := term (('+' | '-') term)*
 *   term   := power (('*' | '/' | '%') power)*
 *   power  := unary ('^' power)?          ← 右结合，与数学惯例一致
 *   unary  := ('-' | '+')* atom
 *   atom   := number | func '(' expr (',' expr)* ')' | '(' expr ')'
 *
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function evaluate(expr, { precision = 8, allowPower = true } = {}) {
  const src = String(expr ?? '').trim();
  if (!src) return { ok: false, error: '表达式为空' };
  // 长度上限：正常算式不会很长，超长基本是模型复读或恶意构造
  if (src.length > 500) return { ok: false, error: '表达式过长（超过 500 字符）' };

  let i = 0;
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = () => { skipWs(); return src[i]; };

  // 用错误码而不是抛异常：调用方是工具层，抛错会变成一句难懂的 stack
  const fail = (msg) => { throw new Error(msg); };

  function parseExpr() {
    let left = parseTerm();
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') return left;
      i++;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
  }

  function parseTerm() {
    let left = parsePower();
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return left;
      i++;
      const right = parsePower();
      if (op === '*') left *= right;
      // 除零 / 取模零要报明确的话，而不是让 NaN 或 Infinity 漏给用户
      else if (op === '/') {
        if (right === 0) fail('除数不能为 0');
        left /= right;
      } else {
        if (right === 0) fail('取模的除数不能为 0');
        left %= right;
      }
    }
  }

  function parsePower() {
    const base = parseUnary();
    if (peek() !== '^') return base;
    i++;
    if (!allowPower) fail('幂运算已关闭（可在设置里打开「允许幂运算」）');
    const exp = parsePower();          // 右结合：2^3^2 = 2^(3^2) = 512
    // 上限防护：见 MAX_POW 的说明
    if (!Number.isFinite(exp) || Math.abs(exp) > MAX_POW) {
      fail(`指数超出允许范围（|指数| ≤ ${MAX_POW}）`);
    }
    const r = base ** exp;
    if (!Number.isFinite(r)) fail('幂运算结果溢出（超出浮点范围）');
    return r;
  }

  function parseUnary() {
    const op = peek();
    if (op === '-') { i++; return -parseUnary(); }
    if (op === '+') { i++; return parseUnary(); }
    return parseAtom();
  }

  function parseAtom() {
    skipWs();
    if (i >= src.length) fail('表达式意外结束（是不是少写了一段？）');

    if (src[i] === '(') {
      i++;
      const v = parseExpr();
      skipWs();
      if (src[i] !== ')') fail('括号没有闭合');
      i++;
      return v;
    }

    // 函数调用：先读标识符，再看后面是不是 '('
    const idMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
    if (idMatch) {
      const name = idMatch[0].toLowerCase();
      i += idMatch[0].length;
      const fn = FUNCS[name];
      if (!fn) fail(`不认识的函数：${name}（支持 ${Object.keys(FUNCS).join(' / ')}）`);
      skipWs();
      if (src[i] !== '(') fail(`${name} 后面要跟括号，例如 ${name}(2)`);
      i++;
      const args = [parseExpr()];
      skipWs();
      while (src[i] === ',') { i++; args.push(parseExpr()); skipWs(); }
      if (src[i] !== ')') fail(`${name} 的括号没有闭合`);
      i++;
      const r = fn(...args);
      if (!Number.isFinite(r)) fail(`${name} 的参数超出定义域（比如 sqrt 收到负数）`);
      return r;
    }

    // 数字字面量：自己截取到下一个运算符/空白/括号为止，再交给正则校验。
    // 不用 parseFloat 直接吞 —— 它遇到 "1abc" 会返回 1 并静默忽略后面的字符，
    // 于是 "1abc" 被当成合法的 1，模型写错的东西会被悄悄算出一个假答案。
    const numMatch = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (!numMatch || !NUM.test(numMatch[0])) fail(`看不懂这一段：${src.slice(i, i + 12)}`);
    i += numMatch[0].length;
    const v = Number(numMatch[0]);
    if (!Number.isFinite(v)) fail('数字超出可表示范围');
    return v;
  }

  try {
    const value = parseExpr();
    skipWs();
    if (i < src.length) fail(`表达式多出来一段：${src.slice(i, i + 12)}`);
    if (!Number.isFinite(value)) fail('计算结果不是有限数');
    return { ok: true, value: roundTo(value, precision) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ── 插件生命周期（旧入口 register）─────────────────────────────────────────

export function register(api) {
  cfg = api.config;
  const log = api.log || (() => {});
  log('计算器已就绪');

  api.registerTool({
    id: 'eval',
    name: '算一下',
    description: '计算数学表达式。支持 + - * / % ^、括号，以及 sqrt/abs/round/floor/ceil/min/max。算数一律用它，不要心算。',
    category: 'utility',
    icon: '🧮',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要计算的表达式，例如 (12.5*8-4)/3 或 sqrt(2)+2^10'
        }
      },
      required: ['expression']
    },
    async execute(_ctx, args) {
      const s = settings();
      const r = evaluate(args?.expression, { precision: s.precision, allowPower: s.allowPower });
      if (!r.ok) return { content: `算不出来：${r.error}`, isError: true };
      return { content: String(r.value) };
    }
  });
}

export function available() { return { ok: true }; }

export const internals = { evaluate, roundTo, settings, FUNCS, MAX_POW };
