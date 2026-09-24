// 群禁言模式：把"这个群我先不说话"持久化下来，禁言期间**完全不触发 AI 运行**。
//
// 为什么需要它（用户原始需求）：
//   有些群是"我在但不想理"或"这号被禁言/被踢了"的状态。老做法只能靠上下文档位
//   压到 1 档，可一旦有人在群里 @ 机器人，照样会唤起一次模型调用 —— 白烧 token。
//   禁言是**硬开关**：命中的群连提示词都不拼，消息照存档，等解禁再正常处理。
//
// 存储：写进 config.mutedGroups（{ [群号]: { at, reason, until, by } }），
// 跟配置一起备份/迁移；`until` 为 0 表示"永久直到手动解禁"。
import { getConfig, updateConfig } from './config.js';

function normGroupId(id) {
  const s = String(id ?? '').trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

/** 该群现在是否处于禁言（考虑到期）。 */
export function isMuted(groupId, now = Date.now()) {
  const gid = normGroupId(groupId);
  if (!gid) return false;
  const rec = getConfig().mutedGroups?.[gid];
  if (!rec) return false;
  const until = Number(rec.until) || 0;
  // until=0 → 永久；否则过了到期时间自动失效（不主动删记录，状态查询时判定）
  return until === 0 || until > now;
}

/**
 * 禁言一个群。
 * @param {string} groupId 群号
 * @param {object} [opts]
 * @param {number} [opts.until] 到期时间戳（毫秒）；0 或不传 = 永久
 * @param {string} [opts.reason] 原因（备忘，给控制台看）
 * @param {string} [opts.by] 谁设的（manual / model / auto / admin）
 * @param {boolean} [opts.admin] 管理员群内指令设的（admin.js）——控制台按它
 *   区分"管理员在群里喊的"与"控制台手点的"（前者禁言期间被 @ 要回固定话术）
 */
export function muteGroup(groupId, { until = 0, reason = '', by = 'manual', admin = false } = {}) {
  const gid = normGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const all = { ...(getConfig().mutedGroups || {}) };
  all[gid] = {
    at: Date.now(),
    until: Math.max(0, Number(until) || 0),
    reason: String(reason || '').slice(0, 120),
    by: String(by || 'manual'),
    admin: admin === true
  };
  // 注意：updateConfig 走的是 deepMerge（只增不删），所以映射型字段必须用
  // { __replace__: ... } 整体替换，否则"删除某个群"会被旧值合并回来。
  updateConfig({ mutedGroups: { __replace__: all } });
  return { ok: true, groupId: gid, ...all[gid] };
}

/** 解除禁言（返回原本是否在禁言）。 */
export function unmuteGroup(groupId) {
  const gid = normGroupId(groupId);
  if (!gid) return { ok: false, error: '群号必须是数字' };
  const all = { ...(getConfig().mutedGroups || {}) };
  const existed = Object.prototype.hasOwnProperty.call(all, gid);
  delete all[gid];
  updateConfig({ mutedGroups: { __replace__: all } });
  return { ok: true, groupId: gid, wasMuted: existed };
}

/** 当前处于禁言状态的群列表（自动过滤已到期的）。 */
export function listMuted(now = Date.now()) {
  const all = getConfig().mutedGroups || {};
  return Object.entries(all)
    .map(([groupId, rec]) => ({
      groupId,
      at: Number(rec?.at) || 0,
      until: Number(rec?.until) || 0,
      reason: String(rec?.reason || ''),
      by: String(rec?.by || 'manual'),
      admin: rec?.admin === true,
      permanent: !(Number(rec?.until) || 0),
      expired: Number(rec?.until) > 0 && Number(rec?.until) <= now
    }))
    .sort((a, b) => b.at - a.at);
}

/** 清理已到期的永久/临时禁言记录（维护循环调用，保持配置干净）。 */
export function pruneMuted(now = Date.now()) {
  const all = { ...(getConfig().mutedGroups || {}) };
  let removed = 0;
  for (const [gid, rec] of Object.entries(all)) {
    const until = Number(rec?.until) || 0;
    if (until > 0 && until <= now) { delete all[gid]; removed += 1; }
  }
  if (removed) updateConfig({ mutedGroups: { __replace__: all } });
  return removed;
}
