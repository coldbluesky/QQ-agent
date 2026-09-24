// 发言人身份档案：QQ 号 → 见过的昵称历史。
//
// 为什么单独做一层：
//   QQ 群名片/昵称随时会改。只按名字认人，同一个人改名后模型会当成两个陌生人，
//   记忆、印象、恩怨全部对不上（用户明确反馈过这个问题）。QQ 号是稳定锚点，
//   但"这个号以前叫什么"是变化的，需要单独记录下来，才能反过来提示模型
//   "张三(123456) 以前叫 小明" —— 这样即使群友改名，模型也认得出来。
//
// 存储：直接写进 config（memberAliases），跟人设无关、跨群共享（同一个 QQ 号
// 在不同群是同一人）。不用单独文件，是为了让"备份/迁移配置"一次带走。
import { getConfig, updateConfig } from './config.js';

const MAX_ALIASES = 6;        // 每人最多保留几个曾用名
const MAX_ALIAS_LEN = 40;     // 名字长度上限（防脏数据）

function isValidId(id) {
  return /^\d{1,15}$/.test(String(id ?? '').trim());
}

function cleanName(name) {
  return String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, MAX_ALIAS_LEN);
}

/**
 * 记录一次"某人在某会话里叫这个名字"。
 *
 * 不落盘到独立文件，而是并入 config（高频调用时由 scheduleConfigSave 节流）。
 * 同名重复出现不新增；名字变了则把新名字推到最前，旧名字保留在后面作为"曾用名"。
 *
 * @returns {{changed:boolean, isRename:boolean, prevName:string}}
 */
export function observeName(userId, name, { at = Date.now() } = {}) {
  const uid = String(userId ?? '').trim();
  const nm = cleanName(name);
  if (!isValidId(uid) || !nm) return { changed: false, isRename: false, prevName: '' };

  const cfg = getConfig();
  const all = { ...(cfg.memberAliases || {}) };
  const list = Array.isArray(all[uid]) ? all[uid].slice() : [];
  const current = list[0]?.name || '';
  if (current === nm) return { changed: false, isRename: false, prevName: '' };

  // 名字已存在过（改回去）→ 提到最前，不重复堆
  const rest = list.filter((x) => x && x.name !== nm);
  const next = [{ name: nm, at: Number(at) || Date.now() }, ...rest].slice(0, MAX_ALIASES);
  all[uid] = next;
  // { __replace__ } 整体替换：updateConfig 用 deepMerge 只增不删，
  // 普通传对象会让"名字回退到旧名"这类覆盖无法生效。
  updateConfig({ memberAliases: { __replace__: all } });
  return { changed: true, isRename: Boolean(current), prevName: current };
}

/** 取某人的昵称历史（最新在前）。 */
export function aliasesOf(userId) {
  const list = getConfig().memberAliases?.[String(userId ?? '').trim()];
  return Array.isArray(list) ? list.map((x) => ({ name: String(x?.name || ''), at: Number(x?.at) || 0 })).filter((x) => x.name) : [];
}

/** 当前名字（最近一次见到的）。 */
export function currentNameOf(userId) {
  return aliasesOf(userId)[0]?.name || '';
}

/**
 * 曾用名（不含当前名）的文字描述，给提示词用。
 * 没有改名史时返回空串 —— 调用方据此决定要不要在身份标注后追加"（曾用名：…）"。
 */
export function formerNamesOf(userId, limit = 3) {
  const list = aliasesOf(userId);
  if (list.length <= 1) return '';
  return list.slice(1, 1 + Math.max(1, limit)).map((x) => x.name).join('、');
}

/**
 * 生成给提示词用的"身份标注"：`昵称(QQ号)`，改过名时补 `[曾用名：A、B]`。
 *
 * 这是解决"改名认不出"的核心：只要 QQ 号没变，模型就能顺着曾用名接上
 * 之前的记忆与印象。
 */
export function identityTag(userId, name = '', notes = null) {
  const uid = String(userId ?? '').trim();
  if (!isValidId(uid)) return cleanName(name) || uid || '未知';
  const nx = notes || getConfig().memberNotes || {};
  const display = cleanName(nx[uid]) || cleanName(name) || currentNameOf(uid) || `QQ ${uid}`;
  const former = formerNamesOf(uid, 3);
  const base = display === `QQ ${uid}` ? `QQ ${uid}` : `${display}(${uid})`;
  return former ? `${base}[曾用名：${former}]` : base;
}

/** 该成员改过名吗（供控制台/诊断用）。 */
export function hasRenamed(userId) {
  return aliasesOf(userId).length > 1;
}

/** 全部成员的昵称历史快照（控制台展示用）。 */
export function aliasSnapshot() {
  const all = getConfig().memberAliases || {};
  return Object.entries(all).map(([userId, list]) => ({
    userId,
    current: Array.isArray(list) && list[0]?.name || '',
    history: Array.isArray(list) ? list.map((x) => ({ name: String(x?.name || ''), at: Number(x?.at) || 0 })) : [],
    renamed: Array.isArray(list) && list.length > 1
  })).filter((x) => x.current);
}
