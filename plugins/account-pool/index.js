// 账号池路由：多端点/多 Key 的负载均衡。
//
// ── 解决什么问题 ──────────────────────────────────────────────────────
// 有人手上有好几把免费 API Key（同一网关多把，或不同网关），速度参差不齐。
// 本 Skill 在每次请求时按权重挑一个端点：权重由**实测延迟**的 EWMA 动态调整 ——
// 快的多接活，慢的少接活；被限流（429）的临时冷却，冷却后自动恢复。
// 不需要人肉盯着切换。
//
// ── 为什么是 Skill ────────────────────────────────────────────────────
// 大多数用户只有一个端点，用不上它；而且"怎么分配"是策略问题，不是核心能力。
// 关掉它就是纯粹的单端点行为，和没有这个功能时完全一致。
//
// ── 数据分两层（刻意的）───────────────────────────────────────────────
//   持久层：Skill 配置里的 accounts[]（用户可编辑：增删改、启停）
//   运行时：内存 Map（延迟 EWMA / 错误数 / 权重 / 最近使用）**不落盘**
// 不落盘的原因：这些是秒级波动的观测值，写进配置文件既增加写盘频率，
// 又会在重启后留下过期的"快照"误导判断。重启后权重归零重新学习更干净。

import crypto from 'node:crypto';

let cfg = () => ({});
let log = () => {};

// accountId -> { latencyEWMA, errorCount, weight, lastUsed, lastErrorAt, totalCalls, rateLimited }
const runtime = new Map();

function accounts() {
  const list = cfg().accounts;
  return Array.isArray(list) ? list : [];
}

/** 合并持久账号 + 内存统计，返回给路由/UI 用的视图（key 可脱敏）。 */
function accountView(a, maskKey = true) {
  const r = runtime.get(a.id) || {};
  const cooldownMs = Number(cfg().cooldownMs) || 60000;
  const lastErrorAt = r.lastErrorAt || 0;
  // 只有"限流类错误"才进入冷却；其它错误（超时、4xx、5xx）只降权，不冷却。
  const rateLimited = !!r.rateLimited;
  return {
    id: a.id,
    name: String(a.name || ''),
    baseUrl: String(a.baseUrl || ''),
    model: String(a.model || ''),
    enabled: a.enabled !== false,
    hasKey: !!a.key,
    key: maskKey ? (a.key ? '******' : '') : String(a.key || ''),
    latencyEWMA: Math.round(r.latencyEWMA || 0),
    errorCount: r.errorCount || 0,
    weight: Number(r.weight ?? 1.0),
    totalCalls: r.totalCalls || 0,
    lastUsed: r.lastUsed || 0,
    lastErrorAt,
    coolingDown: rateLimited && cooldownMs > 0 && lastErrorAt > 0 && Date.now() - lastErrorAt < cooldownMs
  };
}

/** 账号池快照（key 脱敏，供 UI 展示）。 */
export function snapshot() {
  const c = cfg();
  return {
    strategy: ['weighted', 'round-robin', 'fixed'].includes(c.strategy) ? c.strategy : 'weighted',
    weightDecay: Number(c.weightDecay) || 0.05,
    minWeight: Number(c.minWeight) || 0.1,
    cooldownMs: Number(c.cooldownMs) || 60000,
    accounts: accounts().map((a) => accountView(a))
  };
}

/**
 * 按当前策略挑一个端点。
 * @returns {{ id, baseUrl, apiKey, model } | null}
 *   null = 池空 / 全部冷却 / 全部未填 baseUrl —— 调用方回退到自己的配置。
 */
export function pickAccount() {
  const c = cfg();
  const pool = accounts()
    .filter((a) => a.enabled !== false && String(a.baseUrl || '').trim())
    .map((a) => accountView(a, false))
    .filter((a) => !a.coolingDown);
  if (!pool.length) return null;

  const strategy = String(c.strategy || 'weighted');
  let chosen;
  if (strategy === 'fixed') {
    chosen = pool[0];
  } else if (strategy === 'round-robin') {
    // 最久没用的优先 —— 等价于轮流，且不需要维护游标
    chosen = pool.reduce((min, a) => (a.lastUsed < min.lastUsed ? a : min));
  } else {
    const minWeight = Number(c.minWeight) || 0.1;
    const weights = pool.map((a) => Math.max(minWeight, Number(a.weight) || 1.0));
    const total = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { idx = i; break; }
    }
    chosen = pool[idx];
  }
  if (!chosen) return null;
  return { id: chosen.id, baseUrl: chosen.baseUrl, apiKey: chosen.key, model: chosen.model };
}

/**
 * 记录一次成功请求的延迟，更新 EWMA 与权重。
 * 权重 = 池内平均 EWMA 延迟 / 本账号 EWMA 延迟（越快权重越高），
 * 夹在 [minWeight, 3] 之间防止极端化（某个账号快到把其它全饿死）。
 */
export function recordLatency(accountId, latencyMs) {
  if (!accountId || !Number.isFinite(Number(latencyMs))) return;
  const c = cfg();
  const decay = Number(c.weightDecay) || 0.05;
  const minWeight = Number(c.minWeight) || 0.1;
  const prev = runtime.get(accountId) || {};
  const prevLatency = Number(prev.latencyEWMA) || 0;
  const latencyEWMA = prevLatency === 0
    ? Number(latencyMs)
    : (1 - decay) * prevLatency + decay * Number(latencyMs);

  let avg = 0;
  let n = 0;
  for (const a of accounts().filter((x) => x.enabled !== false)) {
    const lat = Number(runtime.get(a.id)?.latencyEWMA || 0);
    if (lat > 0) { avg += lat; n++; }
  }
  avg = n ? avg / n : latencyEWMA;
  const rawWeight = avg > 0 && latencyEWMA > 0 ? avg / latencyEWMA : 1.0;
  const weight = Math.min(3, Math.max(minWeight, rawWeight));

  runtime.set(accountId, {
    ...prev,
    latencyEWMA,
    weight,
    lastUsed: Date.now(),
    totalCalls: (prev.totalCalls || 0) + 1
  });
}

/**
 * 记录一次失败。
 * @param {boolean} isRateLimited 是否限流（429/速率类错误）—— 限流进冷却，其它只降权。
 *
 * ⚠️ 限流标记在冷却窗口内**保持粘性**：429 进入冷却后，几秒后同账号的一次超时/5xx
 * 不能把标记覆写成 false —— 否则 coolingDown 立即失效，冷却中的账号被重新投用，
 * 继续撞 429，陷入"刚冷却就被投用"的循环。窗口自然过期后标记失效，不会永久冷却。
 */
export function recordError(accountId, isRateLimited) {
  if (!accountId) return;
  const c = cfg();
  const minWeight = Number(c.minWeight) || 0.1;
  const cooldownMs = Number(c.cooldownMs) || 60000;
  const now = Date.now();
  const prev = runtime.get(accountId) || {};
  const base = Number(prev.weight ?? 1.0);
  const rateLimited = !!isRateLimited
    || (prev.rateLimited === true && (now - (prev.lastErrorAt || 0)) < cooldownMs);
  runtime.set(accountId, {
    ...prev,
    errorCount: (prev.errorCount || 0) + 1,
    weight: Math.max(minWeight, base * 0.8),
    rateLimited,
    lastErrorAt: now,
    lastUsed: now
  });
}

/** 重置统计（UI 上的"恢复"按钮）。不传 id 则全部重置。 */
export function resetStats(accountId) {
  if (accountId) runtime.delete(accountId);
  else runtime.clear();
}

// ── 账号增删改（只改 Skill 配置命名空间，不碰核心 api 配置）─────────────

export function addAccount({ baseUrl, key = '', model = '', name = '' } = {}) {
  const base = String(baseUrl || '').trim();
  if (!base) return { error: 'Base URL 不能为空' };
  const account = {
    id: 'acc_' + crypto.randomBytes(4).toString('hex'),
    name: String(name || '').trim(),
    baseUrl: base,
    key: String(key || '').trim(),
    model: String(model || '').trim(),
    enabled: true
  };
  return { account: accountView(account), accounts: [...accounts(), account] };
}

export function updateAccount(id, patch = {}) {
  const list = accounts();
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return { error: '账号不存在' };
  const next = { ...list[idx] };
  for (const k of ['name', 'baseUrl', 'model']) if (k in patch) next[k] = String(patch[k] ?? '').trim();
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  // 留空 = 不换 Key（避免用户在 UI 里没动 Key 却把它清掉）
  if ('key' in patch) {
    const k = String(patch.key ?? '').trim();
    if (k) next.key = k;
  }
  const out = [...list];
  out[idx] = next;
  if (patch.enabled === false) runtime.delete(id);   // 停用即清空统计
  return { account: accountView(next), accounts: out };
}

export function removeAccount(id) {
  runtime.delete(id);
  return { ok: true, accounts: accounts().filter((a) => a.id !== id) };
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  /** 挑一个端点。核心在"主调用路径"上取用；返回 null 表示回退到自身配置。 */
  'llm.endpoint-pick': () => pickAccount(),

  /** 回报结果，用于动态调权。 */
  'llm.endpoint-feedback': ({ accountId, ok, latencyMs, error, status } = {}) => {
    if (!accountId) return { ok: true };
    if (ok) {
      recordLatency(accountId, latencyMs);
      return { ok: true };
    }
    // 只在明确的限流信号上冷却：429，或错误文本里带 rate limit / 限流 / 配额
    const limited = Number(status) === 429 || /429|rate.?limit|too many requests|限流|配额/i.test(String(error || ''));
    recordError(accountId, limited);
    return { ok: true, cooling: limited };
  }
};

// 说明：原先还声明过 'llm.endpoint-snapshot' 能力（"快照，UI 用"），
// 但全项目没有任何消费方 —— UI 并没有账号池面板，核心也不需要它。
// 声明了却没人取用的能力会让审计报"孤儿"、也让使用者误以为有现成的接口。
// 现在改为普通导出 snapshot()（下面 internals 里已有），要接 UI 时再显式声明并接线。


/** 有可用账号才算就绪；池子空时 UI 直接显示原因，而不是假装生效。 */
export function available() {
  if (!accounts().filter((a) => a.enabled !== false && String(a.baseUrl || '').trim()).length) {
    return { ok: false, reason: '账号池是空的（至少加一个 Base URL）' };
  }
  return { ok: true };
}

export const internals = {
  snapshot, pickAccount, recordLatency, recordError, resetStats,
  addAccount, updateAccount, removeAccount,
  __accountView: accountView
};
