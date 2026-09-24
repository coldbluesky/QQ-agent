// 国际象棋（棋路记录）—— 让她能和你真的下一盘棋，并且**记住棋路**。
//
// 为什么要有这个模块（而不是让她凭记忆"想象"棋盘）：
//   1. LLM 没有局面记忆，靠【过去状态】那几十条聊天记录去"推"棋盘必然错乱
//      （用户报的"她太容易被记忆影响"在下棋这件事上最致命）。
//      所以这里存一份**权威局面**，每次唤醒按 FEN 重算棋盘 + 棋路 + 合法着法列表注入提示词。
//   2. 没有引擎就连合法性都不知道 —— 她会走出"马从 g1 跳到 e5"这种幻觉步。
//      本模块自带完整合法着法生成（易位 / 过路兵 / 升变 / 将军 / 将死 / 逼和 / 和棋），
//      非法着法会被**拒绝并回一份合法着法表**，从源头堵住作弊与幻觉。
//   3. "记棋路"本身是需求：每盘棋的完整着法序列（UCI + SAN + 中文）落盘归档，
//      控制台可看、可复盘。
//
// 数据放在 `data/memory/<persona>/_global/chess.json`（跟人设走，理由同 emotions.json /
// reminders.json —— 换人设就该换一个人，上一局不该带过去）。文件结构：
//   { version: 1,
//     games: { [chatKey]: { startFen, moves:[{uci,san,cn,by,ts}], botSide, startedAt,
//                           updatedAt, status, result, winner } },
//     done:  [ 最近 N 盘已结束的对局（同上结构 + plyCount/endedAt）] }
//
// 设计要点（踩过的坑写在各自函数旁边）：
//   · 局面从不落盘，只落**起始局面 + 着法序列** —— 读的时候回放重算。
//     好处：着法序列是唯一的真相，任何一处 bug 都能靠回放定位，也不怕字段漂移。
//   · 一切"是不是合法/是谁走/将没将军"都从引擎现算，不信任何缓存字段。
//   · 记法解析走"别名表"而不是写一个 SAN 解析器：先枚举全部合法着法、为每步生成
//     UCI / SAN / 中文 三种别名，再把用户输入归一化去匹配。这样 SAN 的消歧规则
//     （Nbd2 / R1e2 / Qh4e1）不用手写，且天然支持中文（马g1到f3 / 马f3）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { currentMemoryKey } from './persona-store.js';
import { writeJsonAtomic } from './util.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** 棋子字母 → 中文（国际象棋的通用中文叫法）。 */
export const PIECE_CN = { K: '王', Q: '后', R: '车', B: '象', N: '马', P: '兵' };

/** 白棋用大写、黑棋用小写；♙=白（大写 P），♟=黑。 */
const FILES = 'abcdefgh';
const PROMO = ['q', 'r', 'b', 'n'];

const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const SLIDE_DIRS = { B: DIAG_D, R: ORTH_D, Q: [...DIAG_D, ...ORTH_D] };

// ── 局面基本操作 ─────────────────────────────────────────────────────────

function colorOf(piece) {
  if (!piece) return '';
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function rowOf(sq) { return (sq / 8) | 0; }
function colOf(sq) { return sq % 8; }

/** 0..63 → 'e4'；越界返回 ''。索引 0 = a8（左上），索引 63 = h1。 */
export function squareName(sq) {
  const i = Number(sq);
  if (!Number.isInteger(i) || i < 0 || i > 63) return '';
  return FILES[colOf(i)] + String(8 - rowOf(i));
}

/** 'e4' → 索引；不合法返回 -1。 */
export function squareIndex(name) {
  const m = /^([a-h])([1-8])$/.exec(String(name || '').trim().toLowerCase());
  if (!m) return -1;
  return (8 - Number(m[2])) * 8 + FILES.indexOf(m[1]);
}

/**
 * 解析 FEN。返回 { board(64 格字符串数组，''=空), turn, castling, ep, halfmove, fullmove }。
 * board 里大写=白、小写=黑（'P'=白兵 / 'p'=黑兵）。
 * 解析失败直接抛错 —— 坏 FEN 静默当空盘比报错危险得多（会算出"全盘都能走"）。
 */
export function parseFen(fen) {
  const text = String(fen || '').trim();
  const parts = text.split(/\s+/);
  if (parts.length < 4) throw new Error(`FEN 不合法（至少要有 4 段）：${text}`);
  const rows = parts[0].split('/');
  if (rows.length !== 8) throw new Error(`FEN 棋盘不是 8 行：${text}`);
  const board = new Array(64).fill('');
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { c += Number(ch); continue; }
      if (!'pnbrqkPNBRQK'.includes(ch)) throw new Error(`FEN 里有不认识的棋子 "${ch}"：${text}`);
      if (c > 7) throw new Error(`FEN 第 ${r + 1} 行超过 8 格：${text}`);
      board[r * 8 + c] = ch;
      c += 1;
    }
    if (c !== 8) throw new Error(`FEN 第 ${r + 1} 行不是 8 格：${text}`);
  }
  const turn = parts[1] === 'b' ? 'b' : 'w';
  const castling = parts[2] === '-' ? '' : String(parts[2]).replace(/[^KQkq]/g, '');
  const epSq = parts[3] && parts[3] !== '-' ? squareIndex(parts[3]) : -1;
  return {
    board,
    turn,
    castling,
    ep: epSq >= 0 ? epSq : null,
    halfmove: Math.max(0, Number(parts[4]) || 0),
    fullmove: Math.max(1, Number(parts[5]) || 1)
  };
}

export function toFen(pos) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let line = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r * 8 + c];
      if (!p) { empty += 1; continue; }
      if (empty) { line += String(empty); empty = 0; }
      line += p;
    }
    if (empty) line += String(empty);
    rows.push(line);
  }
  return [
    rows.join('/'),
    pos.turn,
    pos.castling || '-',
    pos.ep === null || pos.ep === undefined ? '-' : squareName(pos.ep),
    String(pos.halfmove || 0),
    String(pos.fullmove || 1)
  ].join(' ');
}

/** 找某色王的格子；找不到返回 -1。 */
export function kingSquare(pos, color) {
  const target = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (pos.board[i] === target) return i;
  return -1;
}

/**
 * sq 是否被 byColor 这一方攻击。
 * 从**目标格**往回看（射线 + 马 + 兵 + 王），比"枚举对方所有子再问它能不能打到"快得多。
 * 白兵向上走（行号减小），所以攻击 sq 的白兵在 sq 的**下一行**（row+1）。
 */
export function isAttacked(pos, sq, byColor) {
  if (sq < 0) return false;
  const b = pos.board;
  const r = rowOf(sq);
  const c = colOf(sq);

  // 兵
  const pawnRow = byColor === 'w' ? r + 1 : r - 1;
  if (pawnRow >= 0 && pawnRow < 8) {
    const want = byColor === 'w' ? 'P' : 'p';
    for (const dc of [-1, 1]) {
      const cc = c + dc;
      if (cc < 0 || cc > 7) continue;
      if (b[pawnRow * 8 + cc] === want) return true;
    }
  }
  // 马
  const knight = byColor === 'w' ? 'N' : 'n';
  for (const [dr, dc] of KNIGHT_D) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
    if (b[rr * 8 + cc] === knight) return true;
  }
  // 王
  const king = byColor === 'w' ? 'K' : 'k';
  for (const [dr, dc] of KING_D) {
    const rr = r + dr;
    const cc = c + dc;
    if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
    if (b[rr * 8 + cc] === king) return true;
  }
  // 斜线 / 直线（象、后 / 车、后）
  for (const [dirs, letters] of [[DIAG_D, byColor === 'w' ? 'BQ' : 'bq'], [ORTH_D, byColor === 'w' ? 'RQ' : 'rq']]) {
    for (const [dr, dc] of dirs) {
      let rr = r + dr;
      let cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p) {
          if (letters.includes(p)) return true;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
  }
  return false;
}

export function inCheck(pos, color) {
  return isAttacked(pos, kingSquare(pos, color), color === 'w' ? 'b' : 'w');
}

// ── 着法生成 ─────────────────────────────────────────────────────────────

function mkMove(pos, from, to, extra = {}) {
  return {
    from,
    to,
    piece: pos.board[from],
    captured: extra.captured !== undefined ? extra.captured : pos.board[to],
    promotion: extra.promotion || '',
    ep: !!extra.ep,
    double: !!extra.double,
    castle: extra.castle || ''
  };
}

/** 伪合法着法（不检查"走完自己王是否被将"）。 */
export function generatePseudo(pos) {
  const out = [];
  const me = pos.turn;
  const b = pos.board;
  for (let sq = 0; sq < 64; sq++) {
    const piece = b[sq];
    if (!piece || colorOf(piece) !== me) continue;
    const type = piece.toUpperCase();
    const r = rowOf(sq);
    const c = colOf(sq);

    if (type === 'P') {
      const dir = me === 'w' ? -1 : 1;
      const startRow = me === 'w' ? 6 : 1;
      const promoRow = me === 'w' ? 0 : 7;
      const one = (r + dir) * 8 + c;
      if (r + dir >= 0 && r + dir < 8 && !b[one]) {
        if (r + dir === promoRow) for (const q of PROMO) out.push(mkMove(pos, sq, one, { promotion: q }));
        else out.push(mkMove(pos, sq, one));
        const two = (r + dir * 2) * 8 + c;
        if (r === startRow && !b[two]) out.push(mkMove(pos, sq, two, { double: true }));
      }
      for (const dc of [-1, 1]) {
        const rr = r + dir;
        const cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const to = rr * 8 + cc;
        const target = b[to];
        if (target && colorOf(target) !== me) {
          if (rr === promoRow) for (const q of PROMO) out.push(mkMove(pos, sq, to, { promotion: q }));
          else out.push(mkMove(pos, sq, to));
        } else if (!target && pos.ep !== null && to === pos.ep) {
          // 过路兵：被吃的兵在"目标格的后面一格"（对我方来说是来时的方向）
          const capSq = to - dir * 8;
          out.push(mkMove(pos, sq, to, { ep: true, captured: b[capSq] }));
        }
      }
      continue;
    }

    if (type === 'N' || type === 'K') {
      const dirs = type === 'N' ? KNIGHT_D : KING_D;
      for (const [dr, dc] of dirs) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const to = rr * 8 + cc;
        if (b[to] && colorOf(b[to]) === me) continue;
        out.push(mkMove(pos, sq, to));
      }
      continue;
    }

    const dirs = SLIDE_DIRS[type] || [];
    for (const [dr, dc] of dirs) {
      let rr = r + dr;
      let cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const to = rr * 8 + cc;
        const target = b[to];
        if (!target) out.push(mkMove(pos, sq, to));
        else {
          if (colorOf(target) !== me) out.push(mkMove(pos, sq, to));
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
  }

  // 易位：王与车都没动过 + 中间空 + **王不在被将 / 不经过被攻击的格**
  // ⚠️ 最后一条最常被漏：只检查"目标格安全"会放过"王从 e1 穿到 g1 时路过 f1 被将"。
  const kingFrom = me === 'w' ? 60 : 4;          // e1 / e8
  const kingHome = me === 'w' ? 'K' : 'k';
  if (b[kingFrom] === kingHome && !isAttacked(pos, kingFrom, me === 'w' ? 'b' : 'w')) {
    const rights = me === 'w' ? ['K', 'Q'] : ['k', 'q'];
    const rookHome = me === 'w' ? ['R', 'R'] : ['r', 'r'];
    const enemy = me === 'w' ? 'b' : 'w';
    // 短易位 h 侧
    if (pos.castling.includes(rights[0]) && b[kingFrom + 3] === rookHome[0]
      && !b[kingFrom + 1] && !b[kingFrom + 2]
      && !isAttacked(pos, kingFrom + 1, enemy) && !isAttacked(pos, kingFrom + 2, enemy)) {
      out.push(mkMove(pos, kingFrom, kingFrom + 2, { castle: 'K', captured: '' }));
    }
    // 长易位 a 侧（b 格可以有人，只有 b1/b8 允许被攻击，王不经过它）
    if (pos.castling.includes(rights[1]) && b[kingFrom - 4] === rookHome[1]
      && !b[kingFrom - 1] && !b[kingFrom - 2] && !b[kingFrom - 3]
      && !isAttacked(pos, kingFrom - 1, enemy) && !isAttacked(pos, kingFrom - 2, enemy)) {
      out.push(mkMove(pos, kingFrom, kingFrom - 2, { castle: 'Q', captured: '' }));
    }
  }
  return out;
}

/** 应用一步，返回**新的**局面（不改原对象 —— 回放/试算都依赖这个纯函数性质）。 */
export function applyMove(pos, mv) {
  const board = pos.board.slice();
  const me = colorOf(mv.piece);
  const piece = mv.promotion
    ? (me === 'w' ? mv.promotion.toUpperCase() : mv.promotion.toLowerCase())
    : board[mv.from];
  board[mv.from] = '';
  board[mv.to] = piece;

  if (mv.ep) {
    const capSq = mv.to + (me === 'w' ? 8 : -8);
    board[capSq] = '';
  }
  if (mv.castle) {
    const home = me === 'w' ? 56 : 0;               // a1 / a8
    if (mv.castle === 'K') { board[home + 5] = board[home + 7]; board[home + 7] = ''; }
    else { board[home + 3] = board[home + 0]; board[home + 0] = ''; }
  }

  // 易位权：王一动就两边都没了；车动/车被吃则只看那一侧
  let castling = pos.castling || '';
  const fromName = squareName(mv.from);
  const toName = squareName(mv.to);
  if (mv.piece.toUpperCase() === 'K') {
    castling = me === 'w' ? castling.replace(/[KQ]/g, '') : castling.replace(/[kq]/g, '');
  }
  for (const [square, right] of [['a1', 'Q'], ['h1', 'K'], ['a8', 'q'], ['h8', 'k']]) {
    if (fromName === square || toName === square) castling = castling.replace(right, '');
  }

  return {
    board,
    turn: me === 'w' ? 'b' : 'w',
    castling,
    // 只有"两格冲"才留下过路兵目标格，且**下一层必须验证真有敌兵可吃**
    // （否则会生成一个永远吃不到的 ep 标记，还会污染三次重复的判定键）
    ep: mv.double ? (mv.from + mv.to) / 2 : null,
    halfmove: (mv.piece.toUpperCase() === 'P' || mv.captured) ? 0 : (pos.halfmove || 0) + 1,
    fullmove: me === 'b' ? (pos.fullmove || 1) + 1 : (pos.fullmove || 1)
  };
}

export function generateLegal(pos) {
  const me = pos.turn;
  const enemy = me === 'w' ? 'b' : 'w';
  const out = [];
  for (const mv of generatePseudo(pos)) {
    const after = applyMove(pos, mv);
    if (!isAttacked(after, kingSquare(after, me), enemy)) out.push(mv);
  }
  return out;
}

// ── 记谱 ─────────────────────────────────────────────────────────────────

/** 标准代数记谱 SAN（含消歧 + 将军/将死后缀）。legal 必须是**走这一步之前**的合法着法表。 */
export function moveToSan(pos, mv, legal = null) {
  if (mv.castle) return mv.castle === 'K' ? 'O-O' : 'O-O-O';
  const list = legal || generateLegal(pos);
  const type = mv.piece.toUpperCase();
  let s = '';
  if (type === 'P') {
    s = mv.captured ? `${FILES[colOf(mv.from)]}x${squareName(mv.to)}` : squareName(mv.to);
    if (mv.promotion) s += `=${mv.promotion.toUpperCase()}`;
  } else {
    const rivals = list.filter((m) => m.piece === mv.piece && m.to === mv.to && m.from !== mv.from);
    let dis = '';
    if (rivals.length) {
      const sameFile = rivals.some((m) => colOf(m.from) === colOf(mv.from));
      const sameRank = rivals.some((m) => rowOf(m.from) === rowOf(mv.from));
      if (!sameFile) dis = FILES[colOf(mv.from)];
      else if (!sameRank) dis = String(8 - rowOf(mv.from));
      else dis = squareName(mv.from);
    }
    s = `${type}${dis}${mv.captured ? 'x' : ''}${squareName(mv.to)}`;
  }
  const after = applyMove(pos, mv);
  if (inCheck(after, after.turn)) s += generateLegal(after).length ? '+' : '#';
  return s;
}

/** 中文记法：`马g1到f3` / `兵e2到e4` / `车h1吃h8` / `兵e7到e8升变后`。 */
export function moveToCn(mv) {
  if (mv.castle) return mv.castle === 'K' ? '王车易位(短)' : '王车易位(长)';
  const name = PIECE_CN[mv.piece.toUpperCase()] || '?';
  const tail = mv.promotion ? `升变${PIECE_CN[mv.promotion.toUpperCase()]}` : '';
  return `${name}${squareName(mv.from)}${mv.captured ? '吃' : '到'}${squareName(mv.to)}${tail}`;
}

/** UCI：`e2e4` / `e7e8q`。工具参数与着法记录都以它为主键。 */
export function moveToUci(mv) {
  return `${squareName(mv.from)}${squareName(mv.to)}${mv.promotion || ''}`;
}

/**
 * 归一化"人写的着法"：小写 → 0 视作 O（易位）→ 去掉一切符号空格 → 抹掉连接词 → 去掉"将军"尾巴。
 * ⚠️ 顺序不能反：先把 0 换成 o，否则 `0-0` 去掉横线后是 `00`、而别名是 `oo`，永远匹配不上。
 * ⚠️ 升变数字是 1~8，不含 0，所以这次替换不会碰到升变。
 * ⚠️ `到/吃/升变` 这些**连接词必须两边一起抹掉**：别名是 `兵e2到e4`，而人会写 `兵e2-e4`
 *    （查中文棋盘都爱用横线）。抹掉之后两边都归一成 `兵e2e4`，才认得出是同一步。
 */
export function normalizeMoveText(input) {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    .replace(/(到|吃|升变|至|→|->)/g, '')
    .replace(/(将军|绝杀|将死|将)$/, '');
}

/** 一步棋的全部可接受写法（UCI / SAN / 中文长短两式 / 字母+目标格）。 */
export function aliasesFor(pos, mv, legal = null) {
  const list = legal || generateLegal(pos);
  const out = new Set();
  out.add(moveToUci(mv));
  if (mv.castle) {
    out.add(mv.castle === 'K' ? 'o-o' : 'o-o-o');
    out.add(mv.castle === 'K' ? '短易位' : '长易位');
    out.add('王车易位');
    out.add('易位');
  } else {
    const san = moveToSan(pos, mv, list);
    out.add(san);
    out.add(san.replace(/[+#]$/, ''));
    out.add(moveToCn(mv));
    const type = mv.piece.toUpperCase();
    const cn = PIECE_CN[type];
    const dest = squareName(mv.to);
    // 中文短式（缺起点）与字母短式：唯一时才好用，冲突由 resolveMoveInput 报"有多个走法"
    out.add(cn + dest);
    out.add(type + dest);
    // 长代数记法（`Ra8e8` / `Ra8xe8`）：模型自己报着法时很爱这么写（实测 `Ra8xe8`
    // 就是这么被拒掉的 —— 它看着像 SAN 其实既不是 UCI 也不是 SAN）。
    // 只加"带起点"的两种，且升变不加（`Pe7e8` 会把升变后/升变车混成同一个别名）。
    if (!mv.promotion) {
      out.add(`${type}${squareName(mv.from)}${dest}`);
      out.add(`${type}${squareName(mv.from)}x${dest}`);
    }
    if (mv.promotion) {
      out.add(moveToCn(mv).replace(/升变.$/, ''));
      out.add(type + dest + '=' + mv.promotion.toUpperCase());
    }
  }
  return [...out];
}

/**
 * 把用户/模型给的着法文本解析成某一步合法着法。
 * 返回 { ok:true, move } 或 { ok:false, error, candidates? }。
 */
export function resolveMoveInput(pos, input) {
  const legal = generateLegal(pos);
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '没有给出着法' };
  if (!legal.length) return { ok: false, error: '当前没有合法着法（棋局已结束）' };
  const norm = normalizeMoveText(raw);
  if (!norm) return { ok: false, error: `看不懂这个着法：${raw}` };
  const hits = legal.filter((mv) => aliasesFor(pos, mv, legal).some((a) => normalizeMoveText(a) === norm));
  if (hits.length === 1) return { ok: true, move: hits[0] };
  if (hits.length > 1) {
    return {
      ok: false,
      ambiguous: true,
      candidates: hits.map((mv) => moveToUci(mv)),
      error: `"${raw}" 能对上 ${hits.length} 种走法（${hits.map((mv) => moveToUci(mv)).join(' / ')}），请用 UCI 指定起点和终点`
    };
  }
  return { ok: false, error: `"${raw}" 不是合法着法（可能记法不对，或者走了走不了的一步）` };
}

// ── 终局判定 ─────────────────────────────────────────────────────────────

function positionKey(pos) {
  // 三次重复只看"棋盘 + 走子方 + 易位权 + 过路兵"，不看步数
  return `${toFen(pos).split(' ').slice(0, 4).join(' ')}`;
}

function insufficientMaterial(pos) {
  const pieces = [];
  for (let i = 0; i < 64; i++) if (pos.board[i]) pieces.push(pos.board[i].toUpperCase());
  const nonKing = pieces.filter((p) => p !== 'K');
  if (!nonKing.length) return true;                                  // 光杆王
  if (nonKing.length === 1 && (nonKing[0] === 'B' || nonKing[0] === 'N')) return true; // K+B / K+N
  if (nonKing.length === 2 && nonKing.every((p) => p === 'B')) {
    // 双象但异色格 = 也是和棋；这里保守只判"同色格双象"太绕，直接按两象判和
    return true;
  }
  return false;
}

/**
 * 当前局面状态：playing / checkmate / stalemate / draw-*。
 * @param {object} pos          当前局面
 * @param {string[]} keys       从开局到**当前**（含）每一步之后的局面键，用于三次重复
 */
export function gameStatusOf(pos, keys = []) {
  const legal = generateLegal(pos);
  const check = inCheck(pos, pos.turn);
  if (!legal.length) return check ? 'checkmate' : 'stalemate';
  if ((pos.halfmove || 0) >= 100) return 'draw-fifty';
  if (insufficientMaterial(pos)) return 'draw-material';
  const cur = positionKey(pos);
  if (keys.filter((k) => k === cur).length >= 3) return 'draw-repetition';
  return 'playing';
}

export const STATUS_CN = {
  playing: '进行中',
  checkmate: '将死',
  stalemate: '逼和',
  'draw-fifty': '和棋（50 回合规则）',
  'draw-material': '和棋（子力不足）',
  'draw-repetition': '和棋（三次重复局面）',
  resigned: '认输',
  aborted: '中途结束'
};

// ── 回放 ─────────────────────────────────────────────────────────────────

/**
 * 从起始局面回放着法序列。返回：
 *   { pos, keys, sanList[], plies, error }
 * 任何一步不合法就停在那一刻并带上 error —— 绝不"跳过坏步继续"，那会让棋路与棋盘错位。
 */
export function replay(startFen, uciList = []) {
  let pos = parseFen(startFen || START_FEN);
  const keys = [positionKey(pos)];
  const sanList = [];
  for (let i = 0; i < uciList.length; i++) {
    const item = uciList[i];
    const uci = typeof item === 'string' ? item : String(item?.uci || '');
    const r = resolveMoveInput(pos, uci);
    if (!r.ok) return { pos, keys, sanList, plies: i, error: `第 ${i + 1} 步回放失败：${r.error}` };
    sanList.push(moveToSan(pos, r.move));
    pos = applyMove(pos, r.move);
    keys.push(positionKey(pos));
  }
  return { pos, keys, sanList, plies: uciList.length, error: '' };
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

/**
 * ASCII 棋盘（大写=白、小写=黑、'.'=空）。**这是给模型看的**，
 * 用字母而不是 ♙♟ 是为了避免"白兵黑兵看混"这类低级错误。
 */
export function renderBoardAscii(pos, { coords = true } = {}) {
  const lines = [];
  if (coords) lines.push('   ' + FILES.split('').join(' '));
  for (let r = 0; r < 8; r++) {
    const cells = [];
    for (let c = 0; c < 8; c++) cells.push(pos.board[r * 8 + c] || '.');
    lines.push(`${8 - r}  ${cells.join(' ')}` + (coords ? `  ${8 - r}` : ''));
  }
  if (coords) lines.push('   ' + FILES.split('').join(' '));
  return lines.join('\n');
}

const UNICODE_MAP = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'
};

/** Unicode 棋盘 —— **给人看的**（工具结果里让它可以原样复制发给对方）。 */
export function renderBoardUnicode(pos) {
  const lines = ['　 a b c d e f g h'];
  for (let r = 0; r < 8; r++) {
    const cells = [];
    for (let c = 0; c < 8; c++) {
      const p = pos.board[r * 8 + c];
      cells.push(p ? UNICODE_MAP[p] : '·');
    }
    lines.push(`${8 - r} ${cells.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * 棋路文本。max 为空/0 = 全给；超长时保留**开局与最近**两段（两端的信息量最大，
 * 中局那一大段对模型判断"现在该走哪"几乎没用）。
 */
export function renderMovesText(moves = [], { max = 0 } = {}) {
  const items = [];
  for (let i = 0; i < moves.length; i++) {
    items.push({ ply: i + 1, san: String(moves[i]?.san || moves[i]?.uci || ''), by: moves[i]?.by || '' });
  }
  if (!items.length) return '（还没走几步）';
  let picked = items;
  let cut = 0;
  if (max > 0 && items.length > max) {
    const head = Math.ceil(max / 2);
    const tail = max - head;
    picked = [...items.slice(0, head), ...items.slice(items.length - tail)];
    cut = items.length - picked.length;
  }
  const tokens = [];
  for (const it of picked) {
    // 白方走的是奇数步：用"1. e4 e5"这种成对排版（棋路看起来像棋谱）
    const num = Math.ceil(it.ply / 2);
    tokens.push(it.ply % 2 === 1 ? `${num}.${it.san}` : it.san);
  }
  let text = tokens.join(' ');
  if (cut > 0) text += `（中间省了 ${cut} 步）`;
  return text;
}

// ── 配置 ─────────────────────────────────────────────────────────────────

export function chessCfg(rawIn = null) {
  const raw = (rawIn && typeof rawIn === 'object') ? rawIn : (getConfig().chess || {});
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const side = String(raw.defaultBotSide || 'black').toLowerCase();
  return {
    enabled: raw.enabled !== false,
    // 注入合法着法列表：**强烈建议开着** —— 模型要"照抄一条"，它才走不出幻觉步。
    showLegalMoves: raw.showLegalMoves !== false,
    legalMovesMax: clamp(Math.round(num(raw.legalMovesMax, 80)), 10, 200),
    // 棋路注入上限（0 = 全给）。默认 60 步 ≈ 30 回合，够复盘又不会把提示词撑爆。
    kifuMax: clamp(Math.round(num(raw.kifuMax, 60)), 0, 400),
    // 默认对方执白先走、她执黑（"陪玩"最自然的默认值）
    defaultBotSide: side === 'white' || side === 'w' ? 'w' : 'b',
    maxGames: clamp(Math.round(num(raw.maxGames, 200)), 5, 5000),
    // 已结束对局的棋路归档条数（"记棋路"的长期留存）
    archiveMax: clamp(Math.round(num(raw.archiveMax, 50)), 0, 1000),
    // 悔棋最多能回退几步（防"一路悔到开局"）
    undoMax: clamp(Math.round(num(raw.undoMax, 10)), 1, 400),
    // 对局期间是否在【记忆】里刻意压低"旧事"的权重（见 prompt.js 的说明）
    quietMemory: raw.quietMemory === true
  };
}

// ── 落盘 ─────────────────────────────────────────────────────────────────

function storeFile(dir = '') {
  const base = dir || path.join(DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'chess.json');
}

export function chessFilePath(dir = '') {
  return storeFile(dir);
}

function readStore(dir = '') {
  const file = storeFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        version: 1,
        games: (raw.games && typeof raw.games === 'object') ? raw.games : {},
        done: Array.isArray(raw.done) ? raw.done : []
      };
    }
  } catch { /* 首次运行 / 文件损坏：当空库，不抛 */ }
  return { version: 1, games: {}, done: [] };
}

function writeStore(store, dir = '') {
  const file = storeFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: 1, games: store.games || {}, done: store.done || [] });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

// ── 对局状态 ─────────────────────────────────────────────────────────────

const EMPTY_MOVES = [];

/** 把一条落盘记录变成"活的状态"（局面 / 状态 / 合法着法全部现算）。 */
function hydrate(game, cfg) {
  if (!game) return null;
  const startFen = game.startFen || START_FEN;
  const list = Array.isArray(game.moves) ? game.moves : EMPTY_MOVES;
  const rp = replay(startFen, list);
  const status = game.status && game.status !== 'playing'
    ? game.status
    : gameStatusOf(rp.pos, rp.keys);
  const botSide = game.botSide === 'w' ? 'w' : 'b';
  const legal = status === 'playing' ? generateLegal(rp.pos) : [];
  return {
    chatKey: game.chatKey || '',
    startFen,
    pos: rp.pos,
    fen: toFen(rp.pos),
    replayError: rp.error || '',
    moves: list,
    ply: list.length,
    turn: rp.pos.turn,
    botSide,
    humanSide: botSide === 'w' ? 'b' : 'w',
    botTurn: status === 'playing' && rp.pos.turn === botSide,
    status,
    statusText: STATUS_CN[status] || status,
    result: game.result || '',
    winner: game.winner || '',
    startedAt: Number(game.startedAt) || 0,
    updatedAt: Number(game.updatedAt) || 0,
    legal,
    check: status === 'playing' ? inCheck(rp.pos, rp.pos.turn) : false,
    showLegal: cfg?.showLegalMoves !== false
  };
}

/** 取某会话的当前对局（没有返回 null）。 */
export function readChess(chatKey, { dir = '', cfg = null } = {}) {
  const c = chessCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return null;
  const g = readStore(dir).games[key];
  if (!g) return null;
  return hydrate({ ...g, chatKey: key }, c);
}

/** 全部会话的当前对局 + 已结束棋路。 */
export function listChess({ dir = '', cfg = null, limit = 500 } = {}) {
  const c = chessCfg(cfg);
  const store = readStore(dir);
  const items = [];
  for (const key of Object.keys(store.games)) {
    const st = hydrate({ ...store.games[key], chatKey: key }, c);
    if (st) items.push(st);
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const rows = items.slice(0, limit);
  return {
    items: rows,
    // 已终局但还没归档的（就等下一局开始时归进 done）—— 控制台分开显示，
    // 免得把"已经将死的那盘"当成"还在下"。
    playing: rows.filter((x) => x.status === 'playing'),
    finished: rows.filter((x) => x.status !== 'playing'),
    done: store.done.slice(0, c.archiveMax),
    file: chessFilePath(dir)
  };
}

function persist(store, dir) {
  const r = writeStore(store, dir);
  if (!r.ok) throw new Error(`棋局存档写入失败：${r.error}`);
  return r;
}

function prune(store, cfg) {
  const keys = Object.keys(store.games);
  if (keys.length <= cfg.maxGames) return;
  const rows = keys.map((k) => ({ k, at: Number(store.games[k]?.updatedAt) || 0 }))
    .sort((a, b) => b.at - a.at);
  for (const { k } of rows.slice(cfg.maxGames)) delete store.games[k];
}

/**
 * 开一局。默认对方执白先走（她执黑）—— 陪玩最自然的默认值，可用 botSide 改。
 * 已有进行中的对局时**不覆盖**，返回 existing:true 让调用方自己决定要不要重开。
 */
export function startGame(chatKey, { botSide = '', force = false, dir = '', cfg = null, now = Date.now() } = {}) {
  const c = chessCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const prev = store.games[key];
  if (prev && !force) {
    const st = hydrate({ ...prev, chatKey: key }, c);
    if (st && st.status === 'playing') {
      return { ok: true, existing: true, state: st, message: '这个会话已经有一盘没下完的棋' };
    }
  }
  const side = String(botSide || '').toLowerCase();
  const bot = side === 'white' || side === 'w' ? 'w'
    : (side === 'black' || side === 'b' ? 'b' : c.defaultBotSide);
  // 开新局之前先把上一盘归档（无论下完没有）—— "记棋路"是需求本体，
  // 开新局把上一盘的棋路冲掉就等于白记了。
  if (prev) {
    if (!prev.status || prev.status === 'playing') {
      prev.status = 'aborted';
      prev.result = prev.result || '中途结束（换新局）';
    }
    archive(store, key, c);
  }
  const game = {
    chatKey: key,
    startFen: START_FEN,
    moves: [],
    botSide: bot,
    startedAt: now,
    updatedAt: now,
    status: 'playing',
    result: '',
    winner: ''
  };
  store.games[key] = game;
  prune(store, c);
  persist(store, dir);
  return { ok: true, state: hydrate(game, c), message: '新开了一局' };
}

/**
 * 走一步 / 记一步。
 * @param {string} move          着法文本（UCI 优先，SAN / 中文也认）
 * @param {string} as            'human' | 'bot' | ''（空 = 按当前轮次自动判断）
 * 自动判断的规则：轮到她走 → 记为她的；否则记为对方的（她替对方把着法记下来）。
 */
export function playMove(chatKey, { move, as = '', by = 'model', dir = '', cfg = null, now = Date.now() } = {}) {
  const c = chessCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const raw = store.games[key];
  if (!raw) return { ok: false, error: '这个会话还没有棋局（先用 action:"new" 开一局）' };
  const st = hydrate({ ...raw, chatKey: key }, c);
  if (st.replayError) return { ok: false, error: `存档坏了，无法继续：${st.replayError}` };
  if (st.status !== 'playing') {
    return { ok: false, error: `这盘棋已经结束了（${st.statusText}），要下就重新开一局`, state: st };
  }
  const resolved = resolveMoveInput(st.pos, move);
  if (!resolved.ok) return { ok: false, error: resolved.error, candidates: resolved.candidates || [], state: st };
  const mv = resolved.move;

  const want = String(as || '').toLowerCase();
  let actor = '';
  if (want === 'human' || want === '对方' || want === 'you') actor = 'human';
  else if (want === 'bot' || want === '我' || want === 'me') actor = 'bot';
  else actor = st.turn === st.botSide ? 'bot' : 'human';
  // 显式指定与轮次矛盾时以轮次为准（轮次是硬事实，指定只是意图）
  if (actor === 'bot' && st.turn !== st.botSide) actor = 'human';
  if (actor === 'human' && st.turn === st.botSide) actor = 'bot';

  const san = moveToSan(st.pos, mv, st.legal);
  raw.moves = Array.isArray(raw.moves) ? raw.moves.slice() : [];
  raw.moves.push({ uci: moveToUci(mv), san, cn: moveToCn(mv), by: actor, ts: now });
  raw.updatedAt = now;
  raw.status = 'playing';
  raw.result = '';
  raw.winner = '';

  const after = hydrate({ ...raw, chatKey: key }, c);
  // 终局（将死/逼和/和棋）只把状态写进存档，**不立刻归档** ——
  // 归档会让 readChess 变成 null，"终局局面"和"谁赢了"就没了下文，
  // 模型下一轮醒来会以为"这盘棋不存在"。归档交给 startGame / finishGame。
  if (after.status !== 'playing') {
    raw.status = after.status;
    raw.result = STATUS_CN[after.status] || after.status;
    raw.winner = after.status === 'checkmate' ? (after.turn === 'w' ? 'b' : 'w') : '';
  }
  store.games[key] = raw;
  persist(store, dir);
  const state = hydrate({ ...raw, chatKey: key }, c);
  return {
    ok: true,
    actor,
    san,
    uci: moveToUci(mv),
    cn: moveToCn(mv),
    captured: mv.captured || '',
    promotion: mv.promotion || '',
    castle: mv.castle || '',
    ended: state.status !== 'playing',
    check: state.check,
    state
  };
}

/** 把已结束的对局挪进归档（`done`），并清掉当前位。 */
function archive(store, key, cfg) {
  const g = store.games[key];
  if (!g) return;
  const copy = { ...g, chatKey: key, endedAt: g.updatedAt || Date.now() };
  if (cfg.archiveMax > 0) {
    store.done = [copy, ...(store.done || [])].slice(0, cfg.archiveMax);
  }
  delete store.games[key];
}

/**
 * 悔棋：回退 plies 步，默认 2（把"对方一步 + 她一步"一起收回来，重新走）。
 * 超过 undoMax 会被截断。
 */
export function undoMove(chatKey, { plies = 2, dir = '', cfg = null, now = Date.now() } = {}) {
  const c = chessCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const raw = store.games[key];
  if (!raw) return { ok: false, error: '这个会话还没有棋局' };
  const list = Array.isArray(raw.moves) ? raw.moves.slice() : [];
  if (!list.length) return { ok: false, error: '一步都还没走，没法悔棋' };
  const want = Math.max(1, Math.min(Math.round(Number(plies) || 2), c.undoMax));
  const back = Math.min(want, list.length);
  const removed = list.splice(list.length - back, back);
  raw.moves = list;
  raw.updatedAt = now;
  raw.status = 'playing';
  raw.result = '';
  raw.winner = '';
  store.games[key] = raw;
  persist(store, dir);
  return { ok: true, undone: back, removed: removed.map((m) => m.uci), state: hydrate({ ...raw, chatKey: key }, c) };
}

/**
 * 结束对局。resign=认输（要记结果）、abort=就这么算了。
 * 两者都会把棋路归档 —— "记棋路"是需求本体，不能因为中途结束就丢掉。
 */
export function finishGame(chatKey, { kind = 'abort', who = '', dir = '', cfg = null, now = Date.now() } = {}) {
  const c = chessCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  const raw = store.games[key];
  if (!raw) return { ok: false, error: '这个会话还没有棋局' };
  const st = hydrate({ ...raw, chatKey: key }, c);
  let result = '中途结束';
  let winner = '';
  if (String(kind).toLowerCase() === 'resign') {
    const side = String(who || '').toLowerCase();
    const resigner = side === 'bot' || side === '我' || side === 'me' ? st.botSide
      : (side === 'human' || side === '对方' || side === 'you' ? st.humanSide : st.turn);
    winner = resigner === 'w' ? 'b' : 'w';
    result = `认输（${resigner === st.botSide ? '她' : '你'}投降）`;
    raw.status = 'resigned';
  } else {
    raw.status = 'aborted';
  }
  raw.result = result;
  raw.winner = winner;
  raw.updatedAt = now;
  store.games[key] = raw;
  const archived = { ...raw, plyCount: st.ply, endedAt: now };
  archive(store, key, c);
  persist(store, dir);
  return { ok: true, result, winner, plies: st.ply, archived };
}

/** 彻底删掉当前对局（连棋路一起），归档不动。 */
export function clearChess(chatKey, { dir = '' } = {}) {
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const store = readStore(dir);
  if (!store.games[key]) return { ok: true, removed: 0 };
  delete store.games[key];
  persist(store, dir);
  return { ok: true, removed: 1 };
}

// ── 提示词 ───────────────────────────────────────────────────────────────

/**
 * 棋局块（注入**用户消息**、紧贴【本次唤醒】之前）。
 *
 * 为什么不进系统提示：
 *   1. 它每次运行都不一样（棋盘在动），进去会让 prompt 缓存次次失效；
 *   2. 更重要的是**位置**——项目实测"离最新消息越近越被重视"，而这块是硬事实，
 *      必须压过【过去状态】【记忆】里那些"关于棋局的二手描述"（用户报的
 *      "她太容易被记忆影响"在下棋时就是这么翻车的：她会照着三天前的聊天记录
 *      去"接着下"，而真实棋盘早就不是那样了）。
 *
 * 所以块首第一句就写死**优先级**：以本段为准。
 *
 * 2026-09-17 补的两条（用户报"有时她不说下哪了，得自己去控制台看她走了哪"）：
 *   ① 「轮到你走时，走子与说话放在**同一次回复**里」—— 实测 50 次棋局运行里有 25 次是
 *      `chess → chess → send_message` 三次往返，合并后只要两次，**每次省掉一整轮 API**
 *      （棋局运行平均累计 promptTokens 55501，对照无棋局 22425；少一轮 ≈ −18k prompt token
 *      + 2~4 秒）。不写这一句，模型天生倾向"先走子、看了工具结果再说话"。
 *   ② 「必须说清哪个子、走到哪一格」—— 旧的措辞是"别播报'我走 e5'这种机械话"，
 *      结果矫枉过正：实测 37 次她走子里只有 21 次（57%）提到了落点，其余是
 *      "这兵我收下了""那我Nb8躲后面去了"（连起点目标格都糊）这类，对方只能去翻后台。
 *      注意这里**只要求"带上落点"，不要求固定句式** —— 示例台词会被照抄（本项目踩过多次）。
 */
export function chessPromptBlock(state, rawCfg = null) {
  const cfg = chessCfg(rawCfg);
  if (!state) return '';
  const lines = [];
  lines.push('【棋局 · 国际象棋】（本段是唯一权威局面 —— 别用【过去状态】【记忆】里任何关于"棋盘/下到哪了"的说法来推断，那些是二手描述，随时是过期的）');

  const gameNo = state.status === 'playing' ? '' : '（已结束）';
  const whoText = state.botSide === 'w' ? '你执白（先走）' : '你执黑（后走）';
  lines.push(`对局${gameNo}：${whoText} · 对方执${state.botSide === 'w' ? '黑' : '白'} · 已走 ${state.ply} 步`);

  lines.push(renderBoardAscii(state.pos));
  lines.push('（大写=白方，小写=黑方，. = 空格）');

  if (state.check) lines.push(`⚠️ 现在轮到的这一方**正在被将军**，必须应将。`);

  lines.push(`棋路（从开局第一步开始，` + '`1.e2e4 e7e5` 这种格式是"回合.白棋 黑棋"）：');
  lines.push(renderMovesText(state.moves, { max: cfg.kifuMax }));

  if (state.replayError) {
    lines.push(`⚠️ 存档回放出过错（${state.replayError}），局面以回放到出错点为准，别自己脑补后面的步。`);
  }

  if (state.status === 'playing') {
    if (state.botTurn) {
      const list = state.legal.map((m) => moveToUci(m));
      lines.push(`现在轮到**你**走（${state.turn === 'w' ? '白方' : '黑方'}）。`);
      if (cfg.showLegalMoves && list.length) {
        const shown = list.slice(0, cfg.legalMovesMax);
        lines.push(`合法着法（${list.length} 条，**直接照抄其中一条** —— 别自己编，编出来的会被引擎拒绝）：`);
        lines.push(shown.join(' ') + (shown.length < list.length ? ` …等 ${list.length} 条` : ''));
      }
      lines.push('**走子和说话放在同一次回复里**：这一次回复里既调 chess(action:"move") 走你的这一步，又调 send_message 跟他说 —— 拆成两次回复会多跑一整轮（又慢又费 token），而且很容易就忘了说。');
      lines.push('说话时**必须把这一步说清楚：哪个子、走到哪一格**（吃子、将军也一并说）。他看不到你的操作，你不说他只能去翻后台才知道你走了哪 —— 那这盘棋他就没在跟你下。落点不能省，语气还是你自己的（别干巴巴念棋谱）。');
    } else {
      lines.push(`现在轮到**对方**走（${state.turn === 'w' ? '白方' : '黑方'}）。`);
      lines.push('对方报的着法也用 chess(action:"move") 记下来（该谁走由局面决定，不用你判断）；');
      lines.push('对方要是报了个走不了的着法，就温和地告诉他这一步不合规则，然后把合法着法里最像他意图的那几个报给他挑。');
      lines.push('记下他的着法之后，**下一条回复里一次做完**：调 chess(action:"move") 走你自己的这一步 + 调 send_message 把这一步告诉他（哪个子、走到哪一格）—— 别拆成"先走子、过会儿再说"。');
    }
  } else {
    lines.push(`这盘已经结束了：**${state.statusText}**${state.winner ? `，${state.winner === state.botSide ? '你' : '对方'}赢了` : ''}。`);
    lines.push('想再来一盘就 chess(action:"new")；想回看以前的棋路用 chess(action:"list")。');
  }
  return lines.join('\n');
}

/** 没有棋局、但对方在聊下棋时的一行引导（省 token：只在触发批提到"棋"字时才注入）。 */
export function chessInviteBlock() {
  return [
    '【棋局】这个会话还没有进行中的棋局。对方想下的话，用 chess(action:"new") 开一局',
    '（默认他执白先走、你执黑；也可以 action:"new", botSide:"white" 让你先走）。开完把棋盘发给他看一眼。'
  ].join('\n');
}
