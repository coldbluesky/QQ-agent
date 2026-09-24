// 梗知识库（网梗 / 游戏梗 / 群内黑话）。
//
// 为什么单独做一层，而不是塞进长期记忆：
//   1. 长期记忆是"模型聊着聊着自动记下来的"，靠遗忘曲线管理、随时可能被淡忘；
//      梗库是**管理员手工维护的知识**，必须稳定、可检索、可备注使用场景。
//   2. 梗的用法需要"范例"：同一个梗在不同语境下用法完全不同。所以每条梗都带
//      useCases（什么场景能用）与 examples（范例句），注入提示词时一起给模型看。
//   3. 注入要花 token，所以：按相关度+优先级挑一小撮注入，其余靠 meme_search 工具查。
//
// 目录：data/memory/memes/
//   memes.json   梗库本体（可手改可备份；UI 与模型都写这里）
//   README.md    格式说明 + 可以直接抄的模板
//   memes.md     可选：导入源（设置页点"从 memes.md 导入"才会读）
//
// ⚠️ 为什么放在 `memory/memes/` 而不是 `memory/_global/memes/`：
// 梗库是**全局资产**，不跟人设走；而 `_global/` 在老版布局里是"要被搬进当前人设"的
// 保留目录之一（见 persona-store.js 的 migrateLegacyMemory）。两者相遇时，切到一个人设
// 会把整个梗库 rename 进那个人的树里、顶层重建空库 —— 用户看到的是"梗全没了"。
// 放在 memory/memes/ 既不跟人设走，也不会被任何迁移规则碰到。
// 老位置（_global/memes）会自动搬过来一次，用户无感。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { writeJsonAtomic } from './util.js';

export const MEME_DIR = path.join(DATA_DIR, 'memory', 'memes');
const LEGACY_MEME_DIR = path.join(DATA_DIR, 'memory', '_global', 'memes');
const MEMES_FILE = path.join(MEME_DIR, 'memes.json');
const IMPORT_FILE = path.join(MEME_DIR, 'memes.md');
const README_FILE = path.join(MEME_DIR, 'README.md');

/**
 * 把老位置（memory/_global/memes）整个搬到新位置（memory/memes）。
 * 只在"新位置还没有 memes.json"时搬，避免覆盖用户新写的内容；搬不动就原地留着。
 * @returns {boolean} 是否真的搬了
 */
export function migrateLegacyMemeDir() {
  try {
    if (fs.existsSync(path.join(MEME_DIR, 'memes.json'))) return false;
    if (!fs.existsSync(LEGACY_MEME_DIR)) return false;
    fs.mkdirSync(MEME_DIR, { recursive: true });
    let moved = 0;
    for (const f of fs.readdirSync(LEGACY_MEME_DIR)) {
      const from = path.join(LEGACY_MEME_DIR, f);
      const to = path.join(MEME_DIR, f);
      if (fs.existsSync(to)) continue;
      try { fs.renameSync(from, to); moved += 1; } catch { /* 占用就留着 */ }
    }
    if (moved) console.log(`[meme] 梗库已迁到新位置：${LEGACY_MEME_DIR} → ${MEME_DIR}（${moved} 个文件）`);
    return moved > 0;
  } catch {
    return false;
  }
}

// ── 配置 ────────────────────────────────────────────────────────────────

export function memeConfig() {
  const raw = getConfig().meme || {};
  return {
    enabled: raw.enabled !== false,
    injectEnabled: raw.injectEnabled !== false,
    injectMax: Math.max(0, Math.min(30, Number(raw.injectMax) || 8)),
    injectMaxChars: Math.max(200, Number(raw.injectMaxChars) || 1200),
    searchMax: Math.max(1, Math.min(50, Number(raw.searchMax) || 8)),
    autoNote: raw.autoNote !== false,
    recordUsage: raw.recordUsage !== false,
    chatScopeEnabled: raw.chatScopeEnabled !== false
  };
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 中文里的"无信息单字"（虚词/常见动词/常见名词）。
 *
 * 为什么需要它：按字切词时"晚上**吃**啥 我**点**了个外**卖**"会分别撞上
 * "翻车了""关键防御""爆牌"，于是聊吃饭也能捞出 KARDS 梗 —— 实测过，很蠢。
 * 这些字当检索词时几乎没有区分度，全部丢掉；专有名词（跳费、断水、美跳…）
 * 本来就是多字词，不受影响。
 */
const NOISE_CHARS = '的了是我你他她它们在有和就都也还很太要不要会能可能这个那个什么怎么为以及与其但而且所以如果因为被把让给对从到向跟同跟吃喝玩做说想来看去到过着过啊吧呢吗呀哦噢嗯哈呵嘿唉诶咦哇啦咯喔嘛呗了下上中前后点卖买天气时候现在今天明天昨天一天一起一点一个一样一直一下儿自己别人家人东西南北大小多少好坏了完开过来回去出进对错真假新旧快慢高低长短冷热'.split('');

function writeJson(file, value) {
  // 统一走原子写：失败清 tmp + EPERM 翻成人话
  writeJsonAtomic(file, value, 2);
}

let idSeq = 0;
function newId() {
  idSeq = (idSeq + 1) % 100000;
  return `m_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

function oneLine(text, max = 300) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 内容闸门：梗库内容会进提示词，来源可以是群聊（模型用 meme_note 记的）。
 * 和风格学习一样，入库前必须挡掉"指令注入"式的文本 —— 群里有人发
 * "忽略以上所有要求"被模型记进梗库，就等于给了对方一个持久注入点。
 */
const INJECTION_PATTERNS = [
  /忽略(以上|上面|之前|前面|所有)/,
  /(系统|开发)者?提示词?/,
  /你现在是|你从现在开始是|扮演一个/,
  /ignore\s+(all\s+)?(previous|above)/i,
  /system\s*prompt/i,
  /disregard\s+(all\s+)?(previous|prior)/i,
  /<\s*\|?\s*(im_start|system)\s*\|?\s*>/i,
  /\[(system|assistant|tool)\]/i
];

export function sanitizeMemeText(text, max = 300) {
  const s = oneLine(text, max * 2);
  if (!s) return '';
  for (const re of INJECTION_PATTERNS) if (re.test(s)) return '';
  // 大括号会破坏提示词里的 {梗: 例句} 结构，直接抹平
  return s.replace(/[{}]/g, '').slice(0, max);
}

export function sanitizeMemeList(list, max = 6, itemMax = 160) {
  return (Array.isArray(list) ? list : [])
    .map((v) => sanitizeMemeText(v, itemMax))
    .filter(Boolean)
    .slice(0, max);
}

function safeChatKey(value) {
  const s = String(value ?? '').trim();
  return /^(group|private):\d{1,15}$/.test(s) ? s : '';
}

function normKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～…"'“”‘’（）()\[\]【】:：;；\-_/]/g, '')
    .slice(0, 80);
}

/** 中文按字切、英文数字按词切 —— 够用且零依赖。 */
function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const words = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) words.add(w);
  for (const w of s.match(/[\u4e00-\u9fa5]{2,4}/g) || []) words.add(w);
  const chars = new Set();
  for (const ch of s.replace(/[^\u4e00-\u9fa5]/g, '')) chars.add(ch);
  return { words, chars };
}

function normEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = sanitizeMemeText(raw.text ?? raw.meme ?? raw.name ?? '', 80);
  if (!text) return null;
  const kind = ['game', 'net', 'group', 'anime', 'other'].includes(String(raw.kind)) ? String(raw.kind) : 'net';
  const scope = String(raw.scope) === 'chat' ? 'chat' : 'global';
  return {
    id: String(raw.id || '').trim() || newId(),
    text,
    aliases: sanitizeMemeList(raw.aliases, 8, 40),
    kind,
    means: sanitizeMemeText(raw.means ?? raw.meaning ?? raw.desc ?? '', 300),
    source: sanitizeMemeText(raw.source ?? '', 160),
    useCases: sanitizeMemeList(raw.useCases ?? raw.usage ?? raw.scenes, 8, 160),
    examples: sanitizeMemeList(raw.examples ?? raw.example, 6, 160),
    avoid: sanitizeMemeText(raw.avoid ?? raw.warning ?? '', 160),
    tags: sanitizeMemeList(raw.tags, 10, 24).map((t) => t.replace(/^#/, '')),
    // 触发词：**只用于"这句话该不该想起这个梗"的相关度匹配，不会出现在提示词里给模型看**。
    // 专门用来补"意思里有、但字面上对不上"的场景词，例如"关键防御"配 掉线/卡了/动不了。
    triggers: sanitizeMemeList(raw.triggers ?? raw.trigger ?? raw.keywords, 20, 24).map((t) => t.replace(/^#/, '')),
    priority: Math.max(1, Math.min(5, Math.round(Number(raw.priority) || 3))),
    scope,
    chatKey: scope === 'chat' ? safeChatKey(raw.chatKey) : '',
    enabled: raw.enabled !== false,
    pinned: raw.pinned === true,
    useCount: Math.max(0, Number(raw.useCount) || 0),
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    lastContext: sanitizeMemeText(raw.lastContext ?? '', 120),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    origin: ['manual', 'model', 'import'].includes(String(raw.origin)) ? String(raw.origin) : 'manual'
  };
}

/** 一行摘要（提示词/工具返回共用）。 */
export function describeMeme(entry) {
  const alias = entry.aliases?.length ? `（也叫 ${entry.aliases.slice(0, 3).join('/')}）` : '';
  const head = `${entry.text}${alias}：${entry.means || '（没有解释）'}`;
  const use = entry.useCases?.length ? ` 用法：${entry.useCases.join('；')}` : '';
  const ex = entry.examples?.length ? ` 例：${entry.examples.slice(0, 2).join('；')}` : '';
  const avoid = entry.avoid ? ` 别用：${entry.avoid}` : '';
  return `${head}${use}${ex}${avoid}`;
}

// ── 主体 ────────────────────────────────────────────────────────────────

export class MemeStore {
  constructor({ dir = '' } = {}) {
    this.fixedDir = String(dir || '');
    // 自定义目录（测试用）不搬家；只有默认目录才做老位置迁移
    if (!this.fixedDir) migrateLegacyMemeDir();
    this.dir = this.fixedDir || MEME_DIR;
    this.file = path.join(this.dir, 'memes.json');
    this.entries = [];
    this.loaded = false;
    this.load();
  }

  get enabled() {
    return memeConfig().enabled;
  }

  load() {
    try {
      const raw = readJson(this.file, null);
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.memes) ? raw.memes : []);
      this.entries = list.map(normEntry).filter(Boolean);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
    return this.entries;
  }

  save() {
    writeJson(this.file, { version: 1, updatedAt: Date.now(), memes: this.entries });
    return this.entries.length;
  }

  /** 确保目录里有 README（首次使用时自动写一份格式说明）。 */
  ensureDocs() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(README_FILE)) fs.writeFileSync(README_FILE, README_TEMPLATE, 'utf8');
      if (!fs.existsSync(IMPORT_FILE)) fs.writeFileSync(IMPORT_FILE, IMPORT_TEMPLATE, 'utf8');
      if (!fs.existsSync(this.file)) this.save();
    } catch { /* 写不进去不影响使用 */ }
  }

  /** 按会话筛选可见的梗：global 全部可见；chat 只在自己群里可见。 */
  #visible(chatKey = '') {
    const key = safeChatKey(chatKey);
    return this.entries.filter((e) => {
      if (!e.enabled) return false;
      if (e.scope === 'chat') return key && e.chatKey === key;
      return true;
    });
  }

  list({ chatKey = '', query = '', kind = '', tag = '', scope = '', includeDisabled = false, limit = 200 } = {}) {
    let list = includeDisabled ? this.entries.slice() : this.#visible(chatKey);
    if (!chatKey && !includeDisabled) {
      // 没有会话上下文（管理端/统计）时给全部启用条目
      list = this.entries.filter((e) => e.enabled);
    }
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      const bag = tokenize(q);
      list = list.filter((e) => {
        const hay = [e.text, ...e.aliases, e.means, e.source, e.avoid, ...e.tags, ...e.useCases, ...e.examples].join(' ').toLowerCase();
        if (hay.includes(q)) return true;
        // 只有多字词算有效证据（单字噪声太大，"吃"会命中"翻车了"）
        let hit = 0;
        for (const t of bag.words) if (hay.includes(t)) hit += 1;
        return bag.words.size > 0 && hit >= Math.max(1, Math.ceil(bag.words.size * 0.5));
      });
    }
    if (kind) list = list.filter((e) => e.kind === String(kind));
    if (tag) {
      const t = String(tag).replace(/^#/, '').toLowerCase();
      list = list.filter((e) => e.tags.some((x) => x.toLowerCase() === t));
    }
    if (scope) list = list.filter((e) => e.scope === String(scope));
    return list
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        || (b.priority || 0) - (a.priority || 0)
        || (b.useCount || 0) - (a.useCount || 0)
        || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(2000, Number(limit) || 200)));
  }

  get(id) {
    const ref = String(id ?? '').trim();
    if (!ref) return null;
    return this.entries.find((e) => e.id === ref || normKey(e.text) === normKey(ref)) || null;
  }

  /**
   * 相关度打分：名字/别名命中权重最高，其次是标签、解释、用法范例。
   *
   * 权重要点：
   *   - **多字词优先**：一个多字词命中就是强信号（名字 6 分 / 其它 2 分）；
   *   - **单字只算弱信号**，而且直接丢掉"的了是我吃"这类无区分度的字
   *     （否则"晚上吃啥"会撞上"翻车了""关键防御"）；
   *   - 专有名词（跳费/断水/美跳）本来就是多字词，不受影响。
   */
  scoreRelevance(entry, tokens) {
    const bag = tokens && tokens.words ? tokens : { words: new Set(), chars: new Set() };
    if (!bag.words.size && !bag.chars.size) return { score: 0, nameHit: false, triggerHit: false };
    const name = [entry.text, ...entry.aliases].join(' ');
    const nameTokens = tokenize(name);
    const flatName = normKey(name);
    const rest = [entry.means, entry.source, entry.avoid, ...entry.tags, ...entry.useCases, ...entry.examples].join(' ').toLowerCase();
    const triggers = (entry.triggers || []).map((t) => String(t).toLowerCase()).filter(Boolean);
    let score = 0;
    let nameHit = false;
    let triggerHit = false;
    for (const t of bag.words) {
      if (nameTokens.words.has(t)) { score += 8; nameHit = true; }
      else if (flatName.includes(t)) { score += 5; nameHit = true; }
      else if (triggers.some((x) => x.includes(t) || t.includes(x))) { score += 4; triggerHit = true; }
      else if (rest.includes(t)) score += 2;
    }
    for (const ch of bag.chars) {
      if (NOISE_CHARS.includes(ch)) continue;
      if (nameTokens.chars.has(ch)) score += 1.5;
      else if (rest.includes(ch)) score += 0.5;
    }
    return { score, nameHit, triggerHit };
  }

  /**
   * 找梗：既支持关键词检索，也支持"给我这个语境下能用的梗"。
   * @param {string} query 语境文本或关键词
   */
  search(query, { chatKey = '', limit = 8, kind = '', tag = '' } = {}) {
    const cfg = memeConfig();
    const max = Math.max(1, Math.min(50, Number(limit) || cfg.searchMax));
    const q = String(query ?? '').trim();
    const pool = this.list({ chatKey, kind, tag, limit: 500 });
    if (!q) return pool.slice(0, max);
    const tokens = tokenize(q);
    const flat = normKey(q);
    const scored = pool
      .map((e) => {
        const rel = this.scoreRelevance(e, tokens);
        let s = rel.score;
        if (flat && normKey(e.text).includes(flat)) s += 6;
        return { entry: e, score: s };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score
        || (b.entry.pinned ? 1 : 0) - (a.entry.pinned ? 1 : 0)
        || (b.entry.priority || 0) - (a.entry.priority || 0))
      .slice(0, max);
    return scored.map((x) => x.entry);
  }

  add(payload = {}) {
    if (!memeConfig().enabled) return { ok: false, error: '梗知识库未启用（设置 → 梗知识库）' };
    const text = sanitizeMemeText(payload.text ?? payload.meme ?? '', 80);
    if (!text) return { ok: false, error: '梗的名字（text）不能为空，或者内容命中了安全过滤' };
    const exists = this.entries.find((e) => normKey(e.text) === normKey(text)
      && (String(payload.scope) === 'chat' ? e.chatKey === safeChatKey(payload.chatKey) : e.scope === 'global'));
    if (exists) {
      // 同名同作用域 → 视为补充/更新，而不是造出两条重复的梗
      const merged = this.update(exists.id, payload);
      return { ok: true, entry: merged.entry, merged: true };
    }
    const entry = normEntry({
      ...payload,
      id: '',
      text,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin: payload.origin || 'manual'
    });
    if (!entry) return { ok: false, error: '内容不合法' };
    this.entries.push(entry);
    this.save();
    return { ok: true, entry, merged: false };
  }

  update(id, patch = {}) {
    const target = this.get(id);
    if (!target) return { ok: false, error: '找不到这条梗' };
    const idx = this.entries.findIndex((e) => e.id === target.id);
    const next = normEntry({
      ...target,
      ...patch,
      // 数组字段：patch 里给了就整体替换（清空传 []），没给就保留
      aliases: patch.aliases !== undefined ? patch.aliases : target.aliases,
      useCases: patch.useCases !== undefined ? patch.useCases : target.useCases,
      examples: patch.examples !== undefined ? patch.examples : target.examples,
      tags: patch.tags !== undefined ? patch.tags : target.tags,
      id: target.id,
      createdAt: target.createdAt,
      updatedAt: Date.now(),
      useCount: target.useCount,
      lastUsedAt: target.lastUsedAt
    });
    if (!next) return { ok: false, error: '更新后的内容不合法（名字不能为空）' };
    this.entries[idx] = next;
    this.save();
    return { ok: true, entry: next };
  }

  remove(id) {
    const target = this.get(id);
    if (!target) return { ok: false, error: '找不到这条梗' };
    this.entries = this.entries.filter((e) => e.id !== target.id);
    this.save();
    return { ok: true, removed: target };
  }

  /** 记一次使用（用于统计"哪些梗真的在用"）。 */
  markUsed(id, context = '') {
    const cfg = memeConfig();
    if (!cfg.recordUsage) return null;
    const target = this.get(id);
    if (!target) return null;
    const idx = this.entries.findIndex((e) => e.id === target.id);
    this.entries[idx] = {
      ...target,
      useCount: (target.useCount || 0) + 1,
      lastUsedAt: Date.now(),
      lastContext: sanitizeMemeText(context, 120)
    };
    this.save();
    return this.entries[idx];
  }

  stats() {
    const total = this.entries.length;
    const byKind = {};
    let pinned = 0;
    let used = 0;
    for (const e of this.entries) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      if (e.pinned) pinned += 1;
      if (e.useCount > 0) used += 1;
    }
    return { total, enabled: this.entries.filter((e) => e.enabled).length, pinned, used, byKind };
  }

  /**
   * 【梗库】注入文本。
   *
   * 策略（省 token + 不尬用）：
   *   - 先从最近的聊天文本里找"和梗相关的信号"，命中的给**完整信息**（意思+用法+例句）；
   *   - 一条都没命中时**不硬凑**：改为给一份"极简目录"（只有名字+标签），
   *     让模型知道库里有什么、需要时自己用 meme_search 查 ——
   *     这样既不会在聊吃饭时推荐 KARDS 梗，也不会让它以为库里空空如也。
   */
  formatForPrompt(chatKey, { contextText = '', max = 0, maxChars = 0, now = Date.now() } = {}) {
    const cfg = memeConfig();
    if (!cfg.enabled || !cfg.injectEnabled) return '';
    const pool = this.list({ chatKey, limit: 500 });
    if (!pool.length) return '';
    const limit = Math.max(1, Number(max) || cfg.injectMax);
    const budget = Math.max(200, Number(maxChars) || cfg.injectMaxChars);
    const bag = tokenize(contextText);

    const ranked = pool
      .map((e) => {
        const rel = this.scoreRelevance(e, bag);
        // 算"强相关"的规则（实测调出来的，别随便降）：
        //   · 梗名/别名被完整提到（score 8）或部分命中（5/6，nameHit）→ 强
        //   · 命中 triggers 触发词（4）→ 强（触发词就是为"字面对不上、语义相关"准备的）
        //   · 只在解释/标签里撞上一个多字词（2）或单字碎片（<2）→ 不算强，否则
        //     "晚上吃啥"都能捞出 KARDS 梗（"吃/点/天"撞出来的假信号，实测过）
        const strong = rel.nameHit || rel.triggerHit || rel.score >= 6;
        const base = (e.pinned ? 12 : 0) + (strong ? rel.score * 2 : 0) + (e.priority || 3);
        return { e, rel: rel.score, strong, base };
      })
      .sort((a, b) => b.base - a.base || (b.e.useCount || 0) - (a.e.useCount || 0));

    const strongList = ranked.filter((r) => r.strong);
    const hint = '【梗知识库】管理员维护的梗库（不是你的记忆，是查得到的资料）。用法要和语境对得上才用，对不上就别硬套。';

    // 目录（始终给）：没命中时给完整目录，有命中时给"名字+其余梗"的精简目录。
    // 为什么要始终给：模型看不到库里有什么，就只能靠 meme_search 一次次查；
    // 给一份极简目录能让它一眼扫到"有没有相关的"，反而更省 token、更少瞎调工具。
    const idxLines = [];
    let idxChars = 0;
    const idxBudget = Math.max(200, Math.round(budget * (strongList.length ? 0.45 : 1)));
    const buildIndex = (withExtra) => {
      for (const { e } of ranked) {
        const extra = withExtra ? [...(e.aliases || []), ...(e.tags || [])].slice(0, 3).join('/') : '';
        const line = `- ${e.text}${extra ? `（${extra}）` : ''}`;
        if (idxChars + line.length > idxBudget) {
          if (withExtra) return false;   // 装不下 → 退回只写名字再试一次
          idxLines.push('- …（还有更多，用 meme_search 查）');
          return true;
        }
        idxLines.push(line);
        idxChars += line.length;
      }
      return true;
    };
    if (!buildIndex(true)) { idxLines.length = 0; idxChars = 0; buildIndex(false); }
    const indexBlock = `【库内目录】\n${idxLines.join('\n')}`;

    // ① 有命中：命中梗给完整信息（意思+用法+例句），后面附精简目录
    if (strongList.length) {
      const detailBudget = Math.max(200, Math.round(budget * 0.55));
      const picked = [];
      let chars = 0;
      for (const item of strongList) {
        if (picked.length >= limit) break;
        const line = `- ${describeMeme(item.e)}`;
        if (chars + line.length > detailBudget && picked.length > 0) break;
        picked.push(line);
        chars += line.length;
      }
      const head = `${hint}\n（共 ${pool.length} 条；下面 ${picked.length} 条和当前话题对得上号，后面是整个库的目录）`;
      return `${head}\n${picked.join('\n')}\n\n${indexBlock}`;
    }

    // ② 没命中：只给目录，并明确说"这次没有对得上的"
    return `${hint}\n（共 ${pool.length} 条；当前话题没有对得上号的梗，下面是整个库的目录 —— 这次没合适的就别玩梗，需要时用 meme_search 按关键词查）\n${idxLines.join('\n')}`;
  }

  /**
   * 从 memes.md 导入（管理员手写的 markdown）。
   *
   * 支持两种写法，能混着用：
   *   1. 小标题式：## 梗名  /  - 别名：xx  /  - 意思：xx  /  - 用法：xx  /  - 范例：xx
   *   2. 单行式：梗名：意思（后面用 | 分隔别名/用法/范例：梗名 | 别名 | 用法 | 范例）
   */
  importMarkdown(text = '') {
    const src = String(text || '').trim();
    if (!src) return { ok: false, error: '导入内容为空' };
    const blocks = [];
    let cur = null;
    const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
    for (const rawLine of src.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('>') || line.startsWith('<!--')) continue;
      const h = /^#{2,4}\s+(.+)$/.exec(line);
      if (h) {
        flush();
        cur = { text: h[1].trim() };
        continue;
      }
      const bullet = /^[-*]\s*(.+)$/.exec(line);
      if (cur && bullet) {
        const body = bullet[1].trim();
        const kv = /^([^:：]{1,8})[:：]\s*(.*)$/.exec(body);
        if (kv) {
          const key = kv[1].trim();
          const val = kv[2].trim();
          if (/别名|又叫|alias/i.test(key)) cur.aliases = splitList(val);
          else if (/意思|含义|解释|means|desc/i.test(key)) cur.means = val;
          else if (/用法|场景|适用|usage|scene/i.test(key)) cur.useCases = splitList(val);
          else if (/范例|例子|例句|example/i.test(key)) cur.examples = splitList(val);
          else if (/别用|避免|注意|avoid/i.test(key)) cur.avoid = val;
          else if (/来源|出处|source/i.test(key)) cur.source = val;
          else if (/标签|tag/i.test(key)) cur.tags = splitList(val).map((t) => t.replace(/^#/, ''));
          else if (/类型|kind/i.test(key)) cur.kind = val;
          else if (/优先级|priority/i.test(key)) cur.priority = Number(val) || 3;
          else if (/范围|scope/i.test(key)) cur.scope = /chat|群/i.test(val) ? 'chat' : 'global';
          else cur.useCases = [...(cur.useCases || []), `${key}：${val}`];
        } else {
          cur.useCases = [...(cur.useCases || []), body];
        }
        continue;
      }
      // 单行式：梗名 | 意思 | 别名 | 用法 | 范例
      // （放在列表分支之后、且不依赖当前是否有小标题 —— 两种写法可以混着用）
      const inline = line.split('|').map((s) => s.trim());
      if (inline.length >= 2 && inline[0]) {
        flush();
        blocks.push({
          text: inline[0],
          means: inline[1] || '',
          aliases: inline[2] ? splitList(inline[2]) : [],
          useCases: inline[3] ? splitList(inline[3]) : [],
          examples: inline[4] ? splitList(inline[4]) : []
        });
        continue;
      }
      if (!cur) continue;
      cur.means = cur.means ? `${cur.means} ${line}` : line;
    }
    flush();
    if (!blocks.length) return { ok: false, error: '没解析出任何梗（看看 memes/README.md 里的格式模板）' };

    let added = 0;
    let merged = 0;
    const errors = [];
    for (const b of blocks) {
      const r = this.add({ ...b, origin: 'import' });
      if (r.ok) (r.merged ? (merged += 1) : (added += 1));
      else errors.push(`${b.text}：${r.error}`);
    }
    return { ok: added + merged > 0, added, merged, failed: errors.length, errors: errors.slice(0, 5), total: this.entries.length };
  }

  importFromFile(file = '') {
    const target = String(file || '').trim() || IMPORT_FILE;
    if (!fs.existsSync(target)) return { ok: false, error: `找不到导入文件：${target}` };
    return this.importMarkdown(fs.readFileSync(target, 'utf8'));
  }
}

function splitList(text) {
  return String(text ?? '')
    .split(/[；;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const MEME_IMPORT_FILE = IMPORT_FILE;
export const MEME_README_FILE = README_FILE;

/** 模板内容（控制台"重新生成说明文件"用，不必去读磁盘）。 */
export function memeTemplate(name = 'README.md') {
  return String(name).includes('memes.md') ? IMPORT_TEMPLATE : README_TEMPLATE;
}

const README_TEMPLATE = `# 梗知识库使用说明

这个目录属于 QQ Agent 的梗知识库，机器人会按语境挑几条注入提示词，
其余靠 meme_search 工具随时检索。**你可以直接手改 memes.json，也可以在控制台
「设置 → 梗知识库」里编辑。**

- memes.json  梗库本体（机器人只在需要时写它：meme_note 记新梗 / 记录使用次数）
- memes.md    可选导入源：在这里用 markdown 写，然后在设置页点「从 memes.md 导入」
- README.md   本说明

## 每条梗的字段

| 字段 | 说明 |
| --- | --- |
| text | 梗的名字（必填，越短越好，比如"美跳"、"降维打击"） |
| aliases | 别名/别的叫法（数组） |
| kind | 类型：game 游戏 / net 网梗 / group 群内黑话 / anime 二次元 / other |
| means | 这个梗是什么意思（一两句话说清） |
| source | 出处（哪款游戏、哪场比赛、哪个主播） |
| useCases | **适用场景**：什么情况下能用 —— 这是最重要的一栏，越具体越好 |
| examples | **范例句**：直接写你希望她说出口的话 |
| avoid | 什么情况下别用（可选，但很有用：防止在严肃话题乱玩梗） |
| tags | 标签（检索用，比如 kards / 无畏契约 / 电竞 / 阴阳怪气） |
| priority | 1~5，越高越容易被注入提示词（常用的填 4~5，冷门填 2） |
| scope | global 所有会话可用（默认）/ chat 只在某个群可用（要配 chatKey） |
| enabled | false 时忽略这条 |

## 一、小标题式（推荐，好读好改）

## 美跳是区
- 别名：美跳、US jump
- 类型：game
- 意思：KARDS 里美国跳费流派的黑话说法，带点自嘲/阴阳
- 出处：KARDS 天梯圈
- 用法：有人打美跳翻车、或者聊到美跳卡组强度时用来阴阳一句
- 范例：美跳是区 / 又美跳又区 经典
- 别用：新手认真问卡组强度的时候别阴阳，先好好回答
- 标签：kards 卡牌 阴阳
- 优先级：4

## 降维打击
- 别名：康康降维打击
- 类型：game
- 意思：无畏契约职业选手郑永康（ZmjjKK）的名场面/名梗
- 出处：无畏契约 VCT 赛事
- 用法：某人操作明显碾压对手、或者打出离谱发挥时
- 范例：这波属于是降维打击了 / 康康附体？
- 标签：无畏契约 valorant 电竞
- 优先级：4

## 二、单行式（一行一条，适合批量堆）

梗名 | 意思 | 别名（可选）| 用法（可选）| 范例（可选）

## 三、注意

- 机器人自己也可以用 meme_note 工具往库里加梗（origin=model 会标出来）。
- 从群聊学来的内容会过一遍注入过滤（"忽略以上要求"这类会被丢掉）。
- 想让某个梗永远进提示词：把 priority 填 5。
`;

const IMPORT_TEMPLATE = `# 在这里写梗，然后在控制台「设置 → 梗知识库」点「从 memes.md 导入」

## 美跳是区
- 别名：美跳、US jump
- 类型：game
- 意思：KARDS 里美国跳费流派的黑话说法，带点自嘲
- 出处：KARDS 天梯圈
- 用法：有人打美跳翻车、或聊到美跳卡组强度时阴阳一句
- 范例：美跳是区
- 别用：新手认真问卡组强度时别阴阳
- 标签：kards 卡牌
- 优先级：4

## 降维打击
- 别名：康康降维打击
- 类型：game
- 意思：无畏契约职业选手郑永康的名场面梗
- 出处：无畏契约 VCT
- 用法：某人操作明显碾压对手时
- 范例：这波属于是降维打击了
- 标签：无畏契约 电竞
- 优先级：4
`;
