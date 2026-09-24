// 把随「功能移植」加入的记忆子系统挂到目标的 MemoryStore 实例上。
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────────
// 移植过来的工具（memory_search / recall_recent / meme_search / style_note …）
// 统一通过 `ctx.memory.global` / `ctx.memory.style` / `ctx.memory.memes` 取能力
// —— 那是原项目的口径：MemoryStore 是"记忆"的统一门面，三层记忆（印象 /
// 跨群档案 / 表层）与梗库、风格库都挂在它下面。
//
// 目标的 MemoryStore 只有第一层（群友印象）。直接改它的 class 定义是最省事的，
// 但那样移植产物的痕迹会和原版代码混在一起，以后想对比升级就分不清。
// 所以这里用**非侵入式挂载**：在 app.js 里 new 完 MemoryStore 之后调一次
// attachPortedMemory(memory)，把四个子系统挂上去。
//
// 挂载后 memory 上多出：
//   memory.global  GlobalMemoryStore —— 跨群档案 + 长期事件 + 表层记忆
//   memory.memes   MemeStore         —— 梗知识库（含 B 站找梗的落库）
//   memory.style   StyleStore        —— 真人说话风格学习
//
// 并补齐移植工具用到的**门面方法**（searchMemory / noteEvent / listSurface /
// getSurface / promoteSurface / searchMemes / addMeme / markMemeUsed）——
// 它们只是把参数翻译成上面四个子系统的调用，不放任何业务逻辑。
import { GlobalMemoryStore } from './memory-global.js';
import { MemeStore } from './meme-store.js';
import { StyleStore } from './style-learn.js';
import { getConfig } from './config.js';

/**
 * 把移植的记忆子系统挂到 MemoryStore 实例。
 *
 * 幂等：重复调用只会复用已经挂好的实例（热重载 / 多次初始化都安全）。
 * 任何子系统构造失败都**不抛** —— 挂不上就是"这个功能不可用"，
 * 不该让整个机器人起不来（与 skillManager 对可插拔扩展的容错口径一致）。
 *
 * @param {object} memory  MemoryStore 实例（会被就地扩展）
 * @param {{ chat?: Function|null, log?: Function }} [opts]
 *   chat —— 风格蒸馏用的模型入口；不传则风格学习只采集、不自动蒸馏
 * @returns {object} 同一个 memory 实例
 */
export function attachPortedMemory(memory, { chat = null, log = () => {} } = {}) {
  if (!memory || typeof memory !== 'object') return memory;
  if (memory.__portedAttached) return memory;

  const safe = (label, fn, fallback = null) => {
    try {
      return fn();
    } catch (error) {
      log(`[memory-ported] ${label} 初始化失败，该功能本次不可用：${error?.message ?? error}`);
      return fallback;
    }
  };

  // ── 三个子系统（各自 load() 会按当前人设解析目录）──
  const globalStore = safe('跨群长期记忆', () => new GlobalMemoryStore());
  const memeStore = safe('梗知识库', () => new MemeStore());
  const styleStore = safe('说话风格学习', () => new StyleStore({ chat }));

  // ── 门面方法：移植工具的调用口径 → 子系统方法 ─────────────────────────
  // 全部用 defineProperty 挂成不可枚举的，避免 JSON.stringify(memory) 时炸掉
  // （routes 的 /api/status 会把 memory 相关状态序列化给前端）。
  const def = (name, fn) => {
    if (typeof memory[name] === 'function') return;   // 目标已有同名方法 → 保留目标的
    Object.defineProperty(memory, name, {
      value: fn, enumerable: false, writable: true, configurable: true
    });
  };

  // ── 跨群长期记忆 ──
  def('searchMemory', ({ query = '', userId = '', chatKey = '', kinds = null, days = 0, limit = 12 } = {}) => {
    if (!globalStore) return { people: [], events: [], total: 0 };
    const r = globalStore.search({ query, userId, chatKey, kinds, days, limit });
    return {
      people: (r.people || []).map((p) => ({
        userId: p.userId,
        name: p.name || p.userId,
        facts: (p.facts || []).map((f) => ({
          id: f.id, content: f.content, importance: f.importance,
          at: f.at, age: safeAge(f.at)
        }))
      })),
      events: (r.events || []).map((e) => ({
        id: e.id, text: e.text, kind: e.kind, scope: e.scope,
        importance: e.importance, at: e.at, resolved: e.resolved === true,
        participants: e.participants || []
      })),
      total: Number(r.total) || ((r.people?.length || 0) + (r.events?.length || 0))
    };
  });

  def('noteEvent', (chatKey, payload = {}) => {
    if (!globalStore) return null;
    const { text, kind = 'event', scope = 'chat', participants = [], importance = 3 } = payload;
    if (!String(text ?? '').trim()) return null;
    return globalStore.noteEvent({
      text: String(text),
      kind,
      scope,
      // scope='chat' 时钉在当前会话；'global' 时不带 chatKey（跟人走）
      chatKey: scope === 'chat' ? String(chatKey || '') : '',
      participants: Array.isArray(participants) ? participants.map(String) : [],
      importance: Number(importance) || 3
    });
  });

  def('listSurface', ({ userId = '', chatKey = '', limit = 50 } = {}) => {
    if (!globalStore) return [];
    return globalStore.listSurface({ userId, chatKey, limit });
  });

  def('getSurface', (id) => (globalStore ? globalStore.getSurface(String(id)) : null));

  def('promoteSurface', (id, opts = {}) => {
    if (!globalStore) return { ok: false, reason: '长期记忆未启用' };
    return globalStore.promoteSurface(String(id), opts);
  });

  // ── 梗知识库 ──
  def('searchMemes', (query, { chatKey = '', tag = '', kind = '', limit = 8 } = {}) => {
    if (!memeStore) return [];
    return memeStore.search(String(query ?? ''), { chatKey, tag, kind, limit });
  });

  def('addMeme', (payload = {}) => {
    if (!memeStore) return { ok: false, error: '梗知识库未加载' };
    return memeStore.add(payload);
  });

  def('markMemeUsed', (id, context = '') => {
    if (!memeStore) return null;
    return memeStore.markUsed(String(id), String(context ?? ''));
  });

  // style / memes / global 三个子对象直接挂上（工具读 ctx.memory.style.enabled 等）
  Object.defineProperty(memory, 'global', {
    value: globalStore, enumerable: false, writable: true, configurable: true
  });
  Object.defineProperty(memory, 'memes', {
    value: memeStore, enumerable: false, writable: true, configurable: true
  });
  Object.defineProperty(memory, 'style', {
    value: styleStore, enumerable: false, writable: true, configurable: true
  });

  Object.defineProperty(memory, '__portedAttached', {
    value: true, enumerable: false, writable: false, configurable: false
  });

  return memory;
}

// ── 内部小工具 ──────────────────────────────────────────────────────────
function safeAge(at) {
  const n = Number(at) || 0;
  if (!n) return '';
  const days = (Date.now() - n) / 86400000;
  if (days < 1 / 24) return '刚刚';
  if (days < 1) return `${Math.round(days * 24)} 小时前`;
  if (days < 30) return `${Math.round(days)} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

/** 配置里长期记忆总开关（供 routes / 状态页查询）。 */
export function portedMemoryStatus(memory) {
  const cfg = getConfig();
  return {
    globalEnabled: cfg.memory?.globalEnabled !== false,
    memesEnabled: cfg.meme?.enabled !== false,
    styleEnabled: cfg.styleLearn?.enabled !== false,
    attached: memory?.__portedAttached === true
  };
}
