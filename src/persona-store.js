// 人设身份 + 「人设级记忆隔离」。
//
// 背景（改造前的两个问题）：
//   1) 人设库里 id 是数组下标（custom_0 / custom_1），删一个后面全部错位；
//      "当前人设"也只是 config.persona.roleText 一段文本，没有稳定身份。
//   2) 记忆完全不区分人设 —— 换个角色，它还记着上一个角色认识的人、聊过的事。
//
// 这里做三件事：
//   1) 给每个人设一个稳定 id（builtin:xxx / custom:xxxx）和一个 memoryKey（记忆目录名）
//   2) 用 config.persona.activeId 记录当前激活的人设
//   3) 一次性把老布局 data/memory/<群>/ 迁进当前人设自己的目录
//
// 迁移后布局：
//   data/memory/<memoryKey>/group_<群号>/<QQ>.json      本群群友印象
//   data/memory/<memoryKey>/private_<QQ>/<QQ>.json
//   data/memory/<memoryKey>/_global/…                   跨群档案 + 长期事件
//   data/memory/<memoryKey>/backups/
// → 两个人设的记忆在文件系统层面就是两棵互不相交的树，不存在"漏读另一份"的可能。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { PERSONAS } from './personas.js';

const LEGACY_CHAT_DIR = /^(group|private)_\d+$/;
const LEGACY_CHAT_FILE = /^(group|private)_\d+\.json$/;
const RESERVED = new Set(['_global', 'backups']);

export function memoryRoot() {
  return path.join(DATA_DIR, 'memory');
}

/** 人设的记忆目录绝对路径。 */
export function memoryDirOf(memoryKey) {
  return path.join(memoryRoot(), String(memoryKey || ''));
}

function newMemoryKey() {
  return `p_${crypto.randomBytes(6).toString('hex')}`;
}

function newCustomId() {
  return `custom:${crypto.randomBytes(4).toString('hex')}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** 内置人设：id 用 PERSONAS 的键，记忆目录固定 b_<id>（升级也不会漂）。 */
export function builtinPersonas() {
  return Object.entries(PERSONAS).map(([id, p]) => ({
    id: `builtin:${id}`,
    name: p.name || id,
    text: String(p.text || ''),
    customRules: '',
    builtin: true,
    nsfw: false,          // 内置人设一律不开成人向
    touchReaction: true,  // 触碰反应默认开
    touchDepth: 'light',  // 细致度默认含蓄
    memoryKey: `b_${id}`
  }));
}

/**
 * 归一化自定义人设：补齐缺失/冲突的 id 与 memoryKey。
 * 老配置里只有 {name, text}，这里就地补上并落盘 —— 补一次就固定下来，
 * 之后重命名、重新排序都不会改变记忆目录。
 */
function normalizeCustoms() {
  const cfg = getConfig();
  const raw = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
  const usedIds = new Set(builtinPersonas().map((p) => p.id));
  const usedKeys = new Set(builtinPersonas().map((p) => p.memoryKey));
  let changed = false;
  const list = raw.map((p, i) => {
    const rec = { ...(p && typeof p === 'object' ? p : {}) };
    rec.name = String(rec.name || `人设 ${i + 1}`).slice(0, 60);
    rec.text = String(rec.text || '');
    rec.customRules = String(rec.customRules || '');
    if (!rec.id || typeof rec.id !== 'string' || !rec.id.startsWith('custom:') || usedIds.has(rec.id)) {
      rec.id = newCustomId();
      changed = true;
    }
    usedIds.add(rec.id);
    if (!rec.memoryKey || typeof rec.memoryKey !== 'string' || !/^[A-Za-z0-9_]+$/.test(rec.memoryKey) || usedKeys.has(rec.memoryKey)) {
      rec.memoryKey = newMemoryKey();
      changed = true;
    }
    usedKeys.add(rec.memoryKey);
    return rec;
  });
  return { list, changed };
}

/** 全部人设（内置 + 自定义）。 */
export function listPersonas() {
  // 必须先跑一次 ensurePersonas：老配置里的人设还没有 id/memoryKey，
  // 归一化时是"当场随机生成"的 —— 如果先列表后迁移，两次拿到的会是两套 id，
  // 调用方按 id 回查就会扑空。先落盘再读，保证前后一致。
  ensurePersonas();
  const { list } = normalizeCustoms();
  return [...builtinPersonas(), ...list];
}

export function getPersona(id) {
  const key = String(id || '');
  return listPersonas().find((p) => p.id === key) || null;
}

// ── 老记忆迁移 ──
/**
 * 把老布局（data/memory/<群>/、_global/、backups/）整体搬进当前人设的目录。
 * 只搬"目标不存在"的项，绝不覆盖；搬不动就原样留着，不影响使用。
 *
 * ⚠️ 有一个必须排除的东西：`_global/memes/`（梗知识库）。
 * 梗库是**全局资产**，路径固定在 `data/memory/_global/memes/`（见 src/meme-store.js），
 * 不跟人设走。而 `_global` 恰好是老布局里要整目录搬走的一项 —— 两者相遇的后果是：
 * 新建/切换到一个还没有 `_global` 的人设时，**整个梗库被 rename 进那个人设的树里**，
 * 顶层重新变空 → 界面上梗全没了（实际数据还在，但用户会以为丢了）。
 * 所以这里遇到 `_global` 只搬它里面除 memes 之外的内容，memes 原地不动。
 */
function migrateLegacyMemory(activeKey) {
  const root = memoryRoot();
  const target = memoryDirOf(activeKey);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { moved: 0 }; }
  const legacy = entries.filter((e) => (
    (e.isDirectory() && (LEGACY_CHAT_DIR.test(e.name) || RESERVED.has(e.name)))
    || (e.isFile() && LEGACY_CHAT_FILE.test(e.name))
  ));
  if (!legacy.length) return { moved: 0 };
  try { fs.mkdirSync(target, { recursive: true }); } catch { return { moved: 0 }; }
  let moved = 0;
  for (const e of legacy) {
    const from = path.join(root, e.name);
    const to = path.join(target, e.name);
    if (fs.existsSync(to)) continue;
    // `_global` 里如果只有 memes（梗库），就整个跳过 —— 别把梗库搬走
    if (e.isDirectory() && e.name === '_global' && !hasNonMemeContent(from)) continue;
    try {
      if (e.isDirectory() && e.name === '_global') {
        // 有别的旧内容要搬，但 memes 必须留在顶层：逐项搬，跳过 memes
        fs.mkdirSync(to, { recursive: true });
        for (const sub of fs.readdirSync(from, { withFileTypes: true })) {
          if (sub.name === 'memes') continue;
          const sFrom = path.join(from, sub.name);
          const sTo = path.join(to, sub.name);
          if (fs.existsSync(sTo)) continue;
          try { fs.renameSync(sFrom, sTo); moved += 1; } catch { /* 留着不影响 */ }
        }
        continue;
      }
      fs.renameSync(from, to);
      moved += 1;
    } catch { /* 占用/跨盘等，留着不影响 */ }
  }
  return { moved };
}

/** `_global` 里除了 memes（梗库）之外还有别的东西吗（没有就不该被当"老记忆"搬走）。 */
function hasNonMemeContent(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.name !== 'memes');
  } catch {
    return false;
  }
}

// ── 激活人设解析 ──
let resolved = null;   // { key, id }

/**
 * 从角色卡里猜角色名。
 * 优先取第一行标题，例如：
 *   "角色卡：笙 —— QQ 群友版"        → "笙"
 *   "# 角色卡：DeepSeek 小鲸鱼 …"    → "DeepSeek 小鲸鱼"
 *   "人设：慢半拍的诗人（测试用）"    → "慢半拍的诗人"
 */
function guessPersonaName(text) {
  const firstLine = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const cleaned = firstLine
    .replace(/^#+\s*/, '')
    .replace(/^角色卡\s*[:：]\s*/, '')
    .replace(/^人设\s*[:：]\s*/, '')
    .split(/[—–]{2,}|[|｜]/)[0]          // 去掉 "—— QQ 群友版" 这类副标题
    .replace(/[（(].*?[）)]/g, '')        // 去掉括号备注
    .trim();
  // 单字名（如"笙""凛"）是常见的中文角色名，不能因为短就排除；
  // 但单字只认完全相同，避免"的""了"这种字到处误匹配。
  return cleaned.length >= 1 && cleaned.length <= 24 ? cleaned : '';
}

/** 人设名归一化，便于和猜出来的名字比对。 */
function bareName(name) {
  return String(name || '').replace(/[（(].*?[）)]/g, '').trim();
}

function resolveActiveId(all, cfg) {
  const want = String(cfg.persona?.activeId || '');
  if (want && all.some((p) => p.id === want)) return { id: want, created: false };
  // 1) 按 roleText 内容精确认领：老配置没有 activeId，只能靠角色卡内容对号入座
  const role = String(cfg.persona?.roleText || '').trim();
  if (role) {
    const hit = all.find((p) => String(p.text || '').trim() === role);
    if (hit) return { id: hit.id, created: false };
  }
  // 2) 精确比不过就按名字认领 —— 用户在原卡片上改过几句话是很常见的，
  //    这种情况不该被当成"另一个人设"，否则同一个人会出现两份、记忆还被劈开。
  const guess = guessPersonaName(role);
  if (guess) {
    const byName = all.filter((p) => {
      const nm = bareName(p.name);
      if (!nm) return false;
      if (nm === guess) return true;
      if (nm.length >= 2 && (guess.includes(nm) || nm.includes(guess))) return true;
      return false;
    });
    if (byName.length) {
      // 多个同名时取卡片最长的那个（信息最全），保证结果稳定
      byName.sort((a, b) => String(b.text || '').length - String(a.text || '').length);
      return { id: byName[0].id, created: false, byName: true };
    }
  }
  return { id: '', created: false };
}

/**
 * 幂等的初始化：补齐 id/memoryKey → 定下当前人设 → 迁移老记忆。
 * 返回当前人设的 memoryKey。
 */
export function ensurePersonas({ force = false } = {}) {
  if (resolved && !force) return resolved.key;
  const cfg = getConfig();
  const { list: customs, changed } = normalizeCustoms();
  let all = [...builtinPersonas(), ...customs];
  let nextCustoms = customs;
  let activeId = '';
  let changedCustoms = changed;

  const picked = resolveActiveId(all, cfg);
  activeId = picked.id;

  if (!activeId) {
    // 认不出来（用户改过角色卡、或本来就是手写的）：把当前 roleText 固化成一个人设，
    // 这样"升级前那套记忆"有明确归属，用户的角色卡也不会丢。
    const text = String(cfg.persona?.roleText || '').trim() || PERSONAS.xiaojingyu?.text || '';
    const rec = {
      id: newCustomId(),
      name: '迁移前的当前人设',
      text,
      customRules: String(cfg.persona?.customRules || ''),
      memoryKey: newMemoryKey()
    };
    nextCustoms = [...customs, rec];
    changedCustoms = true;
    activeId = rec.id;
    all = [...builtinPersonas(), ...nextCustoms];
  }

  const active = all.find((p) => p.id === activeId);

  // 当前人设的卡片以 config.persona.roleText 为准：用户可能刚在设置页改过它。
  // 不同步的话，「按名字认领」回来的那份记录会一直停留在旧文本，
  // 下次切换走再切回来就把用户的修改盖回去了。
  if (active && !active.builtin) {
    const roleNow = String(cfg.persona?.roleText || '').trim();
    const rulesNow = String(cfg.persona?.customRules || '');
    if (roleNow && (String(active.text || '').trim() !== roleNow || String(active.customRules || '') !== rulesNow)) {
      const idx = nextCustoms.findIndex((p) => p.id === active.id);
      if (idx >= 0) {
        const copy = nextCustoms.slice();
        copy[idx] = { ...copy[idx], text: roleNow, customRules: rulesNow };
        nextCustoms = copy;
        changedCustoms = true;
        active.text = roleNow;
      }
    }
  }

  if (changedCustoms) {
    try { updateConfig({ customPersonas: nextCustoms }); } catch { /* 落盘失败也不影响本次会话 */ }
  }
  if (String(cfg.persona?.activeId || '') !== activeId) {
    try { updateConfig({ persona: { activeId } }); } catch { /* ignore */ }
  }

  const mig = migrateLegacyMemory(active.memoryKey);
  if (mig.moved) {
    console.log(`[persona] 已把 ${mig.moved} 项旧记忆迁入人设「${active.name}」（${active.memoryKey}/）`);
  }

  resolved = { key: active.memoryKey, id: active.id };
  return resolved.key;
}

/** 当前人设的记忆目录名。记忆层只需要这一个入口。 */
export function currentMemoryKey() {
  return ensurePersonas();
}

export function currentPersonaId() {
  ensurePersonas();
  return resolved?.id || '';
}

export function currentPersona() {
  ensurePersonas();
  return listPersonas().find((p) => p.id === resolved?.id) || null;
}

/** 切换人设：同时把角色卡写进 config.persona，让提示词立刻用新的。 */
export function setActivePersona(id) {
  const hit = getPersona(id);
  if (!hit) return { ok: false, error: '人设不存在' };
  updateConfig({
    persona: {
      activeId: hit.id,
      roleText: hit.text,
      customRules: hit.customRules || '',
      // ⚠️ R18 是"人设属性"，必须跟着人设走。
      // 不同步的话：给 A 人设开了成人向 → 切到 B 人设时限制仍是解除的（跨人设泄漏）。
      // 内置人设没有该字段 → 一律 false。
      nsfw: hit.nsfw === true,
      // 触碰反应 / 细致度同样是"人设属性"，一起跟着走。
      // 不同步的话：给人设 A 选了"细致"，切到 B 时 A 的细致度会残留（跨人设泄漏）；
      // 而人设记录里没写过这两个字段的老配置（undefined）会一直沿用上一份设置 ——
      // 这正是"细致档看着没生效"的一个隐蔽来源。
      // 记录里没有该字段时回落到默认值（touchReaction 默认开、touchDepth 默认 light）。
      touchReaction: hit.touchReaction !== false,
      touchDepth: hit.touchDepth === 'deep' ? 'deep' : 'light'
    }
  });
  ensurePersonas({ force: true });
  return { ok: true, persona: hit };
}

/**
 * 新增人设（手动创建 / 角色蒸馏都走这里）。
 *
 * ⚠️ 角色设定**允许为空** —— 这正是「＋ 新建空白人设」的用法：
 * 先建一个只带名字的壳，切过去再慢慢在「角色设定」框里写（或直接用角色蒸馏生成）。
 * 早期这里要求 text 非空，导致空白人设根本建不出来。
 * 空卡片不会破坏提示词：prompt.js 里【角色设定】段对空文本是直接跳过。
 */
export function addPersona({ name, text, customRules = '', nsfw = false } = {}) {
  const nm = String(name || '').trim().slice(0, 60);
  const tx = String(text || '').trim();
  if (!nm) return { ok: false, error: '人设名称不能为空' };
  const { list } = normalizeCustoms();
  // nsfw 是"人设属性"（切换人设时随 persona.nsfw 一起生效，见 setActivePersona）：
  // 只有显式 true 才开 —— 蒸馏/手填的默认草稿一律全年龄。
  const rec = {
    id: newCustomId(), name: nm, text: tx, customRules: String(customRules || ''),
    nsfw: nsfw === true, memoryKey: newMemoryKey()
  };
  updateConfig({ customPersonas: [...list, rec] });
  return { ok: true, persona: rec };
}

/** 删除人设。内置人设不能删；正在使用的人设不能删（避免记忆无处归属）。 */
export function deletePersona(id) {
  const key = String(id || '');
  if (!key.startsWith('custom:')) return { ok: false, error: '内置人设不能删除' };
  ensurePersonas();
  if (resolved?.id === key) return { ok: false, error: '不能删除正在使用的人设，请先切换到别的' };
  const { list } = normalizeCustoms();
  const hit = list.find((p) => p.id === key);
  if (!hit) return { ok: false, error: '人设不存在' };
  updateConfig({ customPersonas: list.filter((p) => p.id !== key) });
  return { ok: true, removed: hit, memoryKey: hit.memoryKey };
}

export function renamePersona(id, name) {
  const key = String(id || '');
  const nm = String(name || '').trim().slice(0, 60);
  if (!key.startsWith('custom:') || !nm) return { ok: false, error: '只有自定义人设可以改名' };
  const { list } = normalizeCustoms();
  const idx = list.findIndex((p) => p.id === key);
  if (idx < 0) return { ok: false, error: '人设不存在' };
  const next = list.slice();
  next[idx] = { ...next[idx], name: nm };
  updateConfig({ customPersonas: next });
  ensurePersonas({ force: true });
  return { ok: true };
}

/**
 * 设置页直接改了 roleText / customRules 时，同步回当前人设的记录。
 * 不这么做的话：改完角色卡 → 切到别人设 → 切回来，改动就没了。
 */
export function syncActivePersonaFromConfig() {
  const cfg = getConfig();
  ensurePersonas();
  const activeId = resolved?.id || '';
  if (!activeId.startsWith('custom:')) return false;
  const { list } = normalizeCustoms();
  const idx = list.findIndex((p) => p.id === activeId);
  if (idx < 0) return false;
  const text = String(cfg.persona?.roleText || '');
  const rules = String(cfg.persona?.customRules || '');
  const nsfw = cfg.persona?.nsfw === true;
  const touchReaction = cfg.persona?.touchReaction !== false;
  const touchDepth = cfg.persona?.touchDepth === 'deep' ? 'deep' : 'light';
  if (list[idx].text === text && String(list[idx].customRules || '') === rules
      && (list[idx].nsfw === true) === nsfw
      && (list[idx].touchReaction !== false) === touchReaction
      && (list[idx].touchDepth === 'deep' ? 'deep' : 'light') === touchDepth) return false;
  const next = list.slice();
  next[idx] = { ...next[idx], text, customRules: rules, nsfw, touchReaction, touchDepth };
  try {
    updateConfig({ customPersonas: next });
    ensurePersonas({ force: true });
  } catch { return false; }
  return true;
}

/**
 * 把 source 人设并进 target 人设（同一个角色的两份合成一份）。
 *
 * 规则（都是为了让"记忆不丢、也不混"）：
 *   - 目标没有记忆 → 接管来源的记忆（自定义目标只换 memoryKey，不搬文件）
 *   - 目标是内置人设 → 内置的 memoryKey 是固定的，把来源目录整体搬过去
 *   - 两边都有记忆 → 拒绝。两份混成一团后谁也说不清哪条是哪来的，交给人决定
 *   - 来源正是"当前使用中"的那份 → 目标连角色卡一起继承（正在跑的卡片才是最新的）
 *   - 合并后来源记录从列表移除；它自己的记忆目录留在磁盘上不删
 */
export function absorbPersona(targetId, sourceId) {
  ensurePersonas();
  const t = getPersona(targetId);
  const s = getPersona(sourceId);
  if (!t || !s) return { ok: false, error: '人设不存在' };
  if (t.id === s.id) return { ok: false, error: '不能并给自己' };
  if (s.builtin) return { ok: false, error: '内置人设不能作为被合并的一方' };

  const tStats = personaMemoryStats(t.memoryKey);
  const sStats = personaMemoryStats(s.memoryKey);
  const has = (st) => (st.chats > 0 || st.people > 0 || st.events > 0);
  const tHas = has(tStats);
  const sHas = has(sStats);
  if (tHas && sHas) {
    return {
      ok: false,
      error: `两边都有记忆（目标 ${tStats.chats} 会话 / ${tStats.people} 人，来源 ${sStats.chats} 会话 / ${sStats.people} 人）。`
        + '自动合并会把两份记忆混成一团，已拒绝 —— 请先决定保留哪一份。'
    };
  }

  const cfg = getConfig();
  const sourceIsActive = String(cfg.persona?.activeId || '') === s.id;
  let memoryKey = t.memoryKey;
  let movedDir = false;

  if (!t.builtin) {
    // 自定义目标：只改指针（目标本来就没记忆，不会打架）
    memoryKey = tHas ? t.memoryKey : s.memoryKey;
  } else if (sHas) {
    // 内置目标：memoryKey 固定为 b_<id>，只能把来源目录搬过去。
    // 注意：目标目录往往已经被"空骨架"占位（首次访问会建出 _global/people），
    // 所以能不能接管要看"有没有真实记忆"，而不是"目录空不空"。
    if (tHas) {
      return { ok: false, error: `内置人设「${t.name}」已经有记忆了，无法接管` };
    }
    const from = memoryDirOf(s.memoryKey);
    const to = memoryDirOf(t.memoryKey);
    try {
      if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      movedDir = true;
    } catch (error) {
      return { ok: false, error: `搬移记忆目录失败：${error?.message ?? error}` };
    }
  }

  const { list } = normalizeCustoms();
  const next = list.filter((p) => p.id !== s.id);
  const at = next.findIndex((p) => p.id === t.id);
  if (at >= 0) {
    next[at] = {
      ...next[at],
      memoryKey,
      // 来源是"当前使用中"的那份 → 它手上的卡片才是最新的，由目标继承
      ...(sourceIsActive ? { text: s.text, customRules: s.customRules || '' } : {})
    };
  }

  const patch = { customPersonas: next };
  if (sourceIsActive) {
    patch.persona = {
      activeId: t.id,
      roleText: t.builtin ? t.text : (s.text || t.text),
      customRules: t.builtin ? '' : (s.customRules || '')
    };
  }
  updateConfig(patch);
  ensurePersonas({ force: true });

  return {
    ok: true,
    target: { id: t.id, name: t.name, builtin: !!t.builtin },
    memoryKey,
    movedDir,
    tookOverMemory: !tHas && sHas,
    inheritedCard: sourceIsActive && !t.builtin
  };
}

/** 一个人设的记忆规模（设置页展示用，让人一眼看出"这份记忆属于谁"）。 */
export function personaMemoryStats(memoryKey) {
  const dir = memoryDirOf(memoryKey);
  const out = { chats: 0, members: 0, impressions: 0, people: 0, facts: 0, events: 0, exists: false };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  out.exists = true;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (LEGACY_CHAT_DIR.test(e.name)) {
      out.chats += 1;
      let files = [];
      try { files = fs.readdirSync(path.join(dir, e.name)); } catch { continue; }
      for (const f of files) {
        if (f === '_meta.json' || !f.endsWith('.json')) continue;
        out.members += 1;
        const raw = readJson(path.join(dir, e.name, f));
        if (Array.isArray(raw?.impressions)) out.impressions += raw.impressions.length;
      }
    } else if (e.name === '_global') {
      let pfiles = [];
      try { pfiles = fs.readdirSync(path.join(dir, '_global', 'people')); } catch { /* ignore */ }
      for (const f of pfiles) {
        if (!f.endsWith('.json')) continue;
        out.people += 1;
        const raw = readJson(path.join(dir, '_global', 'people', f));
        if (Array.isArray(raw?.facts)) out.facts += raw.facts.length;
      }
      const ev = readJson(path.join(dir, '_global', 'events.json'));
      if (Array.isArray(ev?.events)) out.events = ev.events.length;
    }
  }
  return out;
}
