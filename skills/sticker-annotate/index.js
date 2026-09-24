// 表情批量标注（LLM 型 / skills/）。
//
// ── 为什么放在 skills/ 而不是 plugins/ ────────────────────────────────────
// 见 src/skills/manifest.js 的 DIR_KIND：skills/（LLM 型）必须 registerTool ——
// 工具会进模型的 function 列表，**用不用、什么时候用由模型决定**。
// 这个功能恰好就是这样：什么时候该整理表情库，只有模型看得到上下文才会知道
// （群里刚刷了一波新表情？还是在闲聊？），核心代码无法预先排程。
// 对比：plugins/sticker-* 那些确定性动作（发送前预检、收藏转存）就属于 plugins/。
//
// ── 它解决什么问题 ───────────────────────────────────────────────────────
// 表情库里的条目默认只有 QQ 给的 resId，没有含义。于是模型每次想发表情都要先
// get_sticker_image 认图 —— 一张一次调用，纯烧钱。批量标注把这个成本前置：
// 一次看几张，把含义/标签写进本地备注（sticker_note 存的同一份数据），
// 以后 list_stickers 直接就能按含义筛。
//
// ── 边界（它不做什么）────────────────────────────────────────────────────
//   · **不做图像识别**：本模块不下载图片、不调视觉模型。它只负责"挑哪些还没标注"
//     "把模型给出的结果落库"。看图那步由模型自己用 get_sticker_image 完成 ——
//     因为视觉能力属于**会话运行期上下文**（模型是否支持图片、图片怎么编码），
//     技能模块在加载期拿不到，硬做会变成第二套视觉管线。
//   · 不发送任何消息：只写本地备注数据。
//   · 不改已有备注（除非设置里显式打开 overwriteExisting）。
//
// ── 一次典型调用 ─────────────────────────────────────────────────────────
//   1. 模型调 sticker_annotate_plan → 拿到一批"待标注"的表情 id（最多 batchSize 个）
//   2. 模型对每个 id 调 get_sticker_image 看图
//   3. 模型调 sticker_annotate_apply 一次性写回 { id, note, tags[] }
// 分两步是刻意的：一次调用不能既"看图"又"写备注"，否则模型会在没看图的情况下
// 凭 resId 猜含义 —— 那写进去的备注比没有更糟（会污染后续选表情的判断）。

let cfg = () => ({});
let api = null;

const DEFAULTS = { batchSize: 6, overwriteExisting: false, maxTags: 5 };

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  const b = Number(out.batchSize);
  out.batchSize = Number.isFinite(b) ? Math.min(12, Math.max(1, Math.trunc(b))) : 6;
  const t = Number(out.maxTags);
  out.maxTags = Number.isFinite(t) ? Math.min(20, Math.max(1, Math.trunc(t))) : 5;
  out.overwriteExisting = out.overwriteExisting === true;
  return out;
}

/** 一条表情是不是"已经有认知"。desc 与 localNote 都算 —— 前者来自收藏时的引语。 */
export function hasNote(entry) {
  return Boolean(String(entry?.localNote ?? '').trim() || String(entry?.desc ?? '').trim());
}

/**
 * 挑出待标注的表情。
 *
 * 排序理由：**先用过的先标注**。使用次数高说明模型以前真会用它们，
 * 标注收益最大；从没用过的冷门表情标了也可能永远用不上，排在后面。
 * 同频次时按 id 排，保证结果稳定（同样的库跑两次得到同一批，便于断点续做）。
 */
export function pickPending(entries, { limit = 6, overwriteExisting = false } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id);
  const pending = overwriteExisting ? list : list.filter((e) => !hasNote(e));
  return [...pending].sort((a, b) =>
    (b.useCount || 0) - (a.useCount || 0) || String(a.id).localeCompare(String(b.id))
  ).slice(0, Math.max(1, limit));
}

/** 把模型给的标签清成可入库的形状：去空、去重、截长度、限量。 */
export function cleanTags(tags, max = 5) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    const s = String(t ?? '').trim().slice(0, 12);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 备注正文：截到 120 字 —— 它是给模型看的提示，不是文章。 */
export function cleanNote(note) {
  return String(note ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 汇总一次写回的结果。
 * 抽成纯函数是为了能单测"部分 id 不存在时怎么报告"，不必起一个真的 StickerManager。
 */
export function summarizeApply(applied, failed) {
  const parts = [];
  if (applied.length) parts.push(`已标注 ${applied.length} 个：${applied.join('、')}`);
  if (failed.length) parts.push(`${failed.length} 个没写成：${failed.join('；')}`);
  return parts.join('；') || '没有需要写入的条目';
}

/**
 * 技能入口。
 *
 * ⚠️ 名字必须叫 `setup`（或旧的 `register`）。加载器的判定是：
 *     const setupFn = typeof mod.setup === 'function' ? mod.setup
 *       : (typeof mod.register === 'function' ? mod.register : null);
 * —— **`setup` 优先**。所以"先导出一个只存配置的 setup、再导出 register 去注册工具"
 * 这种写法会让 register 永远不被调用：技能显示加载成功，工具列表却是空的
 * （lintKindPlacement 会警告"在 skills/ 却没注册任何工具"，但不会阻断）。
 * 这个坑很难从"加载成功"的日志里看出来，所以只保留一个入口。
 */
export function setup(a) {
  api = a;
  cfg = a.config;

  // ── 工具 1：领一批待标注的表情 ──
  api.registerTool({
    id: 'plan',
    name: '列出待标注表情',
    description: '领一批还没写过含义的表情（按用过的次数从多到少）。拿到 id 后请对每个 id 调 get_sticker_image 看图，再用 sticker_annotate_apply 写回。没看图不要猜含义。',
    category: 'media',
    icon: '🏷️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '这一批要几个（默认取设置里的「每批看几张」）' }
      }
    },
    async execute(ctx, args) {
      const s = settings();
      if (!ctx?.stickers) return { content: '当前没有可用的表情库。', isError: true };
      const limit = Math.min(12, Math.max(1, Number(args?.limit) || s.batchSize));
      // 走 list 会触发一次同步（TTL 60s 内是缓存），确保拿到的是最新库
      const listed = await ctx.stickers.list('', 500);
      const entries = (listed?.stickers || []).map((e) => ({
        id: e.id, desc: e.desc, localNote: e.localNote, tags: e.tags, useCount: e.useCount
      }));
      const picked = pickPending(entries, { limit, overwriteExisting: s.overwriteExisting });
      if (!picked.length) {
        return {
          content: s.overwriteExisting
            ? '表情库里没有可标注的条目。'
            : '表情库里所有表情都已有备注，没有需要补的。' + '（想全部重标请在设置里打开「覆盖已有备注」）'
        };
      }
      const lines = picked.map((e, i) =>
        `${i + 1}. id=${e.id}${e.useCount ? `（用过 ${e.useCount} 次）` : '（没用过）'}`
      );
      const total = entries.length;
      const pendingAll = pickPending(entries, { limit: 9999, overwriteExisting: s.overwriteExisting }).length;
      return {
        content: [
          `待标注 ${picked.length}/${pendingAll} 个（表情库共 ${total} 个）：`,
          ...lines,
          '',
          '下一步：对上面每个 id 调 get_sticker_image 看图，然后调 sticker_annotate_apply 一次性写回。'
        ].join('\n')
      };
    }
  });

  // ── 工具 2：把模型看图后的结论写回 ──
  api.registerTool({
    id: 'apply',
    name: '写入表情标注',
    description: '把你看完图后总结的含义写进表情库（等同逐个调 sticker_note，但一次能写多个）。items 里每项要有 id 和 note，可带 tags。',
    category: 'media',
    icon: '💾',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要写入的标注列表',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '表情 id（sticker_annotate_plan 给的那个，照抄）' },
              note: { type: 'string', description: '这个表情表达什么 / 什么场合用（一句话，别超过 120 字）' },
              tags: { type: 'array', items: { type: 'string' }, description: '少量标签（可选）' }
            },
            required: ['id', 'note']
          }
        }
      },
      required: ['items']
    },
    async execute(ctx, args) {
      const s = settings();
      if (!ctx?.stickers) return { content: '当前没有可用的表情库。', isError: true };
      const items = Array.isArray(args?.items) ? args.items : [];
      if (!items.length) return { content: 'items 不能为空。', isError: true };

      const applied = [];
      const failed = [];
      for (const item of items.slice(0, 24)) {
        const id = String(item?.id ?? '').trim();
        const note = cleanNote(item?.note);
        if (!id) { failed.push('（缺少 id）'); continue; }
        if (!note) { failed.push(`${id}：note 是空的`); continue; }
        try {
          const entry = ctx.stickers.note(id, { note, tags: cleanTags(item?.tags, s.maxTags) });
          if (entry) applied.push(id);
          else failed.push(`${id}：库里找不到这个 id`);
        } catch (error) {
          failed.push(`${id}：${error?.message ?? error}`);
        }
      }
      const summary = summarizeApply(applied, failed);
      return { content: summary, isError: applied.length === 0 && failed.length > 0 };
    }
  });
}

export function available() { return { ok: true }; }

export const internals = { pickPending, hasNote, cleanTags, cleanNote, summarizeApply, settings };
