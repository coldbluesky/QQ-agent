// 随「功能移植」加入的工具集（来源：AI 群友分支）。
//
// 为什么单独一个文件而不是塞进 tools.js：
//   目标的 tools.js 已经是 1238 行的 registerAllTools()，把 15 个新工具混进去
//   会让"哪些是原版、哪些是后加的"彻底看不出来。这里独立成模块，只在
//   tools.js 末尾调一次 registerPortedTools()。
//
// 与目标原有工具的关系（用户拍板：**保留目标原有实现，只搬目标独有无对应的**）：
//   目标已有且覆盖同一件事的工具一律**不动、不重复注册** ——
//     · send_to / get_chats        ← 用它自己的（我们那份 send_message 的跨会话分支不搬）
//     · set_reminder 系列          ← 用它自己的（我们那份 remind_at 系列合并进去太深，放弃）
//     · search_images / send_image / read_video / check_holiday ← 用它自己的
//   这里只注册目标**完全没有**的 15 个：
//     search_image / reverse_image_search / get_illust_detail   （pixiv 图源 + 以图搜图）
//     meme_search / meme_from_bili / meme_note                  （梗知识库 + B 站找梗）
//     memory_search / memory_note_event / memory_forget /
//     recall_recent / memory_promote                            （跨群长期记忆的读写）
//     set_mood / set_intimacy / style_note / chess              （情绪 / 情爱 / 风格 / 棋局）
//
// 可用性口径：与目标一致 —— 工具**始终注册**，靠 execute() 内部读配置决定
// 是否可用，这样设置页卡片、工具开关、审计表全都自动认得它们。
import { getConfig } from './config.js';
import { registerTool } from './tool-registry.js';

// ── 模块：图搜 ──────────────────────────────────────────────────────────
import {
  imageSearchConfigForChat, searchImages, reverseImageSearch, describeResult,
  describeReverse, pixivIllustDetail, pickBestImage, imageUrlToDataUrl
} from './image-search.js';
// ── 模块：梗库 + B 站 ───────────────────────────────────────────────────
import { lookupMemeOnBili, biliHotVideos } from './bili-meme.js';
import { discoverMemeCandidates } from './bili-discover.js';
// ── 模块：情绪 / 情爱 / 风格 / 棋局 ─────────────────────────────────────
import { setEmotion, emotionNameList } from './emotion.js';
import { setIntimacy, intimacyCfg } from './intimacy.js';
import {
  startGame, playMove, readChess, undoMove, finishGame, listChess,
  renderBoardAscii, renderBoardUnicode, renderMovesText, moveToUci, chessCfg
} from './chess.js';
// ── 模块：验证 ──────────────────────────────────────────────────────────
import { validateImageUrl } from './safe-fetch.js';

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}
function err(message) {
  return { content: `错误：${message}`, isError: true };
}
function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

// ── 已发图历史（按会话，防止同一张图连发两次）──────────────────────────
// 目标是按会话存；这里用一个 Map，进程内有效（与目标 sticker 的 history 同策略）。
const imageHistory = new Map();
function historyOf(chatKey) {
  let h = imageHistory.get(chatKey);
  if (!h) { h = { items: [] }; imageHistory.set(chatKey, h); }
  return h;
}
function pushImageHistory(chatKey, items, query) {
  const h = historyOf(chatKey);
  for (const it of items) {
    h.items.push({ ...it, query, at: Date.now() });
  }
  if (h.items.length > 120) h.items.splice(0, h.items.length - 120);
  return h;
}
function findHistoryItem(chatKey, index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 1) return null;
  return historyOf(chatKey).items[n - 1] || null;
}

/** 注册全部移植工具（幂等由 tool-registry 的 id 覆盖语义保证）。 */
export function registerPortedTools() {
  registerImageSearchTools();
  registerMemeTools();
  registerMemoryTools();
  registerPersonaStateTools();
}

// ══════════════════════════════════════════════════════════════════════════
// 图搜（pixiv / 图库 / 反查）
// ══════════════════════════════════════════════════════════════════════════
function registerImageSearchTools() {
  registerTool({
    id: 'search_image',
    name: '搜图找素材',
    description: '搜图找素材（默认 pixiv）。搜索词用作品/角色原名或标签（"初音ミク""cyberpunk city"），中文口语常常搜不到；一次 1~3 张，先看再发。',
    category: 'media',
    icon: '🖼',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词（作品名/角色名/标签，中英日文都行）' },
        limit: { type: 'integer', description: '想要几张候选，默认 3，最多 10' },
        provider: { type: 'string', description: '可选图源：pixiv（默认）| safebooru | konachan | yandere | custom:<id>' },
        stage: { type: 'string', description: '可选搜索严格度：auto（默认，逐级放宽）| strict | normal | loose' },
        page: { type: 'integer', description: '可选翻页（默认 1），同一关键词想看更多时加' },
        hideAi: { type: 'boolean', description: '临时改变"屏蔽 AI 图"（默认跟随设置）' },
        allowR18: { type: 'boolean', description: '允许 R18 结果（仅在设置里开了总开关后才有效）' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const cfg = imageSearchConfigForChat(ctx.chatKey);
        if (!cfg.enabled) return err('搜图功能已关闭（设置 → 搜图服务）');
        let allowR18 = args.allowR18 === true && cfg.allowR18 === true;
        if (args.allowR18 === true && cfg.allowR18 !== true) {
          allowR18 = false;   // 管理员没开总开关：忽略参数，并在结果里说明
        }
        const res = await searchImages(String(args.query ?? ''), {
          cfg,
          provider: args.provider ? String(args.provider) : cfg.provider,
          limit: Number(args.limit) || cfg.defaultLimit,
          stage: args.stage ? String(args.stage) : 'auto',
          page: Number(args.page) || 1,
          hideAi: args.hideAi === undefined ? cfg.hideAi : args.hideAi !== false,
          allowR18,
          seen: new Set(historyOf(ctx.chatKey).items.map((it) => String(it.id || it.url)))
        });
        if (!res.items.length) return err('没有找到可用的图（可能都被 AI 屏蔽/分级过滤掉了），换个搜索词或把 hideAi 临时关掉试试');

        const picked = res.items.slice(0, Math.min(10, Math.max(1, Number(args.limit) || cfg.defaultLimit)));
        const hist = pushImageHistory(ctx.chatKey, picked, res.query);
        const startIndex = hist.items.length - picked.length + 1;
        const lines = picked.map((it, i) => `[${startIndex + i}] ${describeResult(it)}`);
        const notes = [];
        if (res.degraded) notes.push(res.degraded);
        if (res.dropped?.ai) notes.push(`已屏蔽 ${res.dropped.ai} 张 AI 生成图`);
        if (res.dropped?.r18) notes.push(`已过滤 ${res.dropped.r18} 张 R18`);
        if (res.dropped?.seen) notes.push(`跳过 ${res.dropped.seen} 张刚发过的`);
        if (args.allowR18 === true && cfg.allowR18 !== true) notes.push('管理员未开启 R18，本次按全年龄过滤');
        const canSee = ctx.session?.visionEnabled === true;
        const tail = canSee
          ? '（下面是图片本身，看一下再决定发哪张；不合适就换词重搜）'
          : '（当前模型不能看图，请按上面的编号与标题挑一张发；别声称自己"看过"这些图。不合适就换词重搜）';
        const head = `用「${res.query}」搜到 ${picked.length} 张${notes.length ? `（${notes.join('，')}）` : ''}。发图用 send_image(index=编号)：\n${lines.join('\n')}\n${tail}`;

        const dataUrls = [];
        if (canSee) {
          for (const it of picked.slice(0, 4)) {
            try { dataUrls.push(await imageUrlToDataUrl(it.url, { maxBytes: 4 * 1024 * 1024 })); } catch { /* 单张失败不影响列表 */ }
          }
        }
        if (!dataUrls.length) return ok(head);
        return { content: imageParts(head, dataUrls) };
      } catch (error) {
        return err(`搜图失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'reverse_image_search',
    name: '以图搜图',
    description: '以图搜图：反查出处/找同款。三选一：messageId（带图消息的 #数字）、url、index（search_image 的编号）。结果带相似度，≥85% 才可信。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '带图消息的 QQ 消息 id（聊天记录里的 #数字）' },
        url: { type: 'string', description: '图片直链（http/https）' },
        index: { type: 'integer', description: '前面 search_image 结果里的编号' },
        limit: { type: 'integer', description: '最多返回几条结果，默认 6' }
      }
    },
    async execute(ctx, args) {
      try {
        const cfg = imageSearchConfigForChat(ctx.chatKey);
        if (!cfg.enabled) return err('搜图功能已关闭（设置 → 搜图服务）');
        let url = String(args.url ?? '').trim();
        let fromMessage = null;
        if (!url && args.messageId !== undefined && args.messageId !== null && String(args.messageId).trim() !== '') {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}`);
          const img = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!img) return err(`消息 ${args.messageId} 里没有可用的图片地址（可能是表情或已过期）`);
          url = img.url;
          fromMessage = entry;
        }
        if (!url && args.index !== undefined && args.index !== null && String(args.index).trim() !== '') {
          const item = findHistoryItem(ctx.chatKey, args.index);
          if (!item) return err(`找不到编号 ${args.index} 的图，请先 search_image 或改用 messageId/url`);
          url = item.url;
        }
        if (!url) return err('请给 messageId（群友发的那条图）、url 或 index 之一');

        const safeUrl = await validateImageUrl(url);
        const { buffer } = await (await import('./safe-fetch.js')).safeFetchBinary(safeUrl);
        const rev = await reverseImageSearch(buffer, {
          cfg,
          imageUrl: safeUrl,
          mime: 'image/jpeg',
          timeoutMs: Math.max(20000, Number(cfg.timeoutMs) * 2)
        });

        const limit = Math.min(10, Math.max(1, Number(args.limit) || 6));
        const picked = rev.items
          .filter((it) => !(it.rating === 'r18' && cfg.allowR18 !== true))
          .slice(0, limit);
        const notes = [];
        if (rev.backends?.length) notes.push(`可用后端：${rev.backends.join(' / ')}`);
        if (!cfg.sauceNaoKey) notes.push('未配置 SauceNAO key，无法做"精确反查 pixiv 作品号"（设置 → 搜图服务里可填）');
        if (rev.errors?.length) notes.push(`部分后端失败：${rev.errors.join('；').slice(0, 120)}`);
        if (!picked.length) {
          return ok({
            found: 0,
            note: `没查到匹配的出处${notes.length ? `（${notes.join('，')}）` : ''}。可能这张图不在公开图库里（原创/新图/AI 图/群内自摄），别硬编出处；可以换个说法告诉对方"没查到"。`
          });
        }
        const lines = picked.map((it, i) => describeReverse(it, i + 1));
        return ok({
          found: picked.length,
          from: fromMessage ? `消息 ${fromMessage.mid}（${fromMessage.senderName || '群友'}发的）` : url.slice(0, 80),
          results: lines,
          note: `${notes.join('；')}。相似度 ≥85% 基本可以认定是同一张；只是"同款/相似"的别当成出处。`
        });
      } catch (error) {
        return err(`以图搜图失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'get_illust_detail',
    name: '查 pixiv 作品',
    description: '查 pixiv 作品的人气数据与可用画质（收藏/点赞/浏览/尺寸），用来判断这张图值不值得发。传 pixivId。',
    category: 'media',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        pixivId: { type: ['integer', 'string'], description: 'pixiv 作品号' }
      },
      required: ['pixivId']
    },
    async execute(ctx, args) {
      try {
        const cfg = imageSearchConfigForChat(ctx.chatKey);
        const detail = await pixivIllustDetail(String(args.pixivId ?? ''), { cookie: cfg.cookie, timeoutMs: cfg.timeoutMs });
        if (detail.rating === 'r18' && cfg.allowR18 !== true) {
          return err(`pixiv 作品 ${detail.id} 是 R18，当前不允许查看/发送`);
        }
        const pick = await pickBestImage({ ...detail }, cfg);
        return ok({
          id: detail.id,
          title: detail.title,
          author: detail.author,
          tags: (detail.tags || []).slice(0, 12),
          bookmarkCount: detail.bookmarkCount,
          likeCount: detail.likeCount,
          viewCount: detail.viewCount,
          size: `${detail.width}×${detail.height}`,
          pages: detail.pageCount,
          ai: detail.ai === true ? 'AI 生成' : (detail.ai === false ? '人工绘制' : '未知'),
          hasOriginal: Boolean(detail.original),
          qualityNote: detail.original
            ? `可以发原图（${pick.quality}，约 ${pick.sizeKb ? `${pick.sizeKb}KB` : '体积未知'}）`
            : '拿不到原图地址（多半是 R18 或需要登录）——想发原图要在设置里填 pixiv 登录 Cookie',
          pageUrl: detail.pageUrl,
          note: '收藏数越高说明越受欢迎（同人图里 1000+ 算热门，10000+ 是名作）。'
        });
      } catch (error) {
        return err(`查作品失败：${error?.message ?? error}`);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 梗知识库 + B 站找梗
// ══════════════════════════════════════════════════════════════════════════
function registerMemeTools() {
  registerTool({
    id: 'meme_search',
    name: '查梗知识库',
    description: '查梗知识库（含义/适用场景/范例句）。不确定某个梗怎么用、或想找当前话题能接什么梗时查。',
    category: 'knowledge',
    icon: '🎭',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '梗名或当前话题/语境（留空 = 列出最常用的几条）' },
        tag: { type: 'string', description: '按标签过滤（如 kards / 无畏契约 / 阴阳怪气）' },
        kind: { type: 'string', description: 'game 游戏梗 | net 网梗 | group 群内黑话 | anime 二次元 | other' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' },
        usedText: { type: 'string', description: '如果你确定接下来要用其中某一条，把它的名字填这里（只用于统计）' }
      }
    },
    async execute(ctx, args) {
      try {
        const memes = ctx.memory?.memes;
        if (!memes) return err('梗知识库模块未加载');
        if (memes.enabled === false) return err('梗知识库未启用（设置 → 梗知识库）');
        const found = ctx.memory.searchMemes(String(args.query ?? ''), {
          chatKey: ctx.chatKey,
          tag: String(args.tag ?? ''),
          kind: String(args.kind ?? ''),
          limit: Number(args.limit) || 8
        });
        if (!found.length) {
          return ok({
            found: 0,
            note: '梗库里没有匹配的条目。别硬编一个梗出来 —— 要么换个词再查，要么这次就不玩梗。学到新梗可以用 meme_note 记下来（记之前先确认自己没理解错）。'
          });
        }
        const usedText = String(args.usedText ?? '').trim();
        if (usedText) {
          const hit = found.find((e) => e.text === usedText || (e.aliases || []).includes(usedText));
          if (hit) ctx.memory.markMemeUsed(hit.id, String(ctx.session?.triggerText || '').slice(0, 120));
        }
        return ok({
          found: found.length,
          memes: found.map((e) => ({
            id: e.id, text: e.text, aliases: e.aliases, kind: e.kind, means: e.means,
            source: e.source, useCases: e.useCases, examples: e.examples, avoid: e.avoid,
            tags: e.tags, priority: e.priority, scope: e.scope, used: e.useCount
          })),
          note: '用的时候要贴语境：examples 是范例句，可以改写成你自己的语气，但别把梗用在 avoid 描述的场景里。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'meme_from_bili',
    name: 'B 站找梗',
    description: '去 B 站找梗（免登录）。term=求证一个说法是不是真有人这么说；discover=true（或什么都不传）=捞一批当下流行的候选梗；hot=true=只看热门标题当谈资。',
    category: 'knowledge',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: '要查的梗/说法。传了就查这个说法在 B 站的证据' },
        discover: { type: 'boolean', description: 'true = 主动发现当下的候选梗（从热门标题提炼并用搜索建议验证）' },
        hot: { type: 'boolean', description: 'true = 只拉一批当下热门视频标题（不要提炼梗，纯看谈资）' },
        limit: { type: 'integer', description: 'hot/discover 时看几条，默认 12，最多 30' }
      }
    },
    async execute(ctx, args) {
      try {
        const term = String(args.term ?? '')
          .replace(/\[CQ:[^\]]*\]/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 12));

        // ── 模式 ② 主动发现（无 term，且没显式要 hot）──
        if (!term && args.hot !== true && args.hot !== 'true') {
          if (getConfig().meme?.biliProactive === false) {
            return err('管理员关闭了"主动发现网梗"。要么传 term 求证某个说法，要么用 hot=true 只看热门视频标题。');
          }
          let found;
          try {
            found = await discoverMemeCandidates({ limit, maxProbe: Math.min(8, limit) });
          } catch (error) {
            return err(`B 站检索失败：${error?.message ?? error}`);
          }
          if (!found.length) {
            return ok({
              mode: 'discover', found: 0,
              note: '这批热门标题里没提炼出明确的候选梗（B 站搜索建议没有命中）。不用硬造，正常说话就行。'
            });
          }
          return ok({
            mode: 'discover',
            found: found.length,
            candidates: found.map((c) => ({ term: c.term, evidence: c.evidence, url: c.urls[0] })),
            note: '这些是从当下热门视频标题里提炼、并经 B 站搜索建议验证过"确实有大量人在搜"的说法 —— 是真·在传的梗。挑你确实理解含义的用，不懂的别硬套。'
          });
        }

        // ── 模式 ③ 只看热门视频 ──
        if (args.hot === true || args.hot === 'true') {
          let videos;
          let source = 'ranking';
          try {
            videos = await biliHotVideos({ limit });
          } catch (rankingError) {
            try {
              videos = await biliHotVideos({ kind: 'popular', limit });
              source = 'popular';
            } catch (popularError) {
              return err(`B 站查询失败：排行榜(${rankingError?.message ?? rankingError})；热门(${popularError?.message ?? popularError})`);
            }
          }
          if (!videos.length) return err('B 站榜单接口没有返回任何视频');
          return ok({
            mode: 'hot', source, count: videos.length,
            videos: videos.map((v) => ({ title: v.title, author: v.author, view: v.view, like: v.like, url: v.url })),
            note: '这些是当下 B 站的热门视频标题，可以挑眼熟的当谈资；别硬把不相干的视频扯进话题。'
          });
        }

        // ── 模式 ① 求证某个说法 ──
        const found = await lookupMemeOnBili(term);
        return ok({
          mode: 'lookup',
          term: found.term,
          exists: found.exists,
          evidence: found.evidence,
          suggestions: found.suggestions.map((s) => s.value),
          videos: found.videos.map((v) => ({ title: v.title, author: v.author, view: v.view, like: v.like, url: v.url })),
          urls: found.urls,
          note: `${found.exists
            ? `B 站确实有人这么说（${found.evidence}），可以引用 urls 里的链接当出处。`
            : 'B 站没有找到明确证据。'}exists=false 时不要把这个说法当成已有梗去用；要记进梗库前先确认含义。`
        });
      } catch (error) {
        return err(`B 站查询失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'meme_note',
    name: '记梗',
    description: '把确认搞懂的新梗记进梗库。务必填 useCases（什么场景能用）和 examples（范例句）—— 没有这两样以后没法用。不确定含义的别记。',
    category: 'knowledge',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '梗的名字（简短，如"美跳是区"）' },
        means: { type: 'string', description: '这个梗是什么意思（一两句）' },
        aliases: { type: 'array', items: { type: 'string' }, description: '别名/别的叫法' },
        kind: { type: 'string', description: 'game 游戏梗 | net 网梗 | group 群内黑话 | anime 二次元 | other' },
        source: { type: 'string', description: '出处（哪款游戏/哪场比赛/哪个主播）' },
        useCases: { type: 'array', items: { type: 'string' }, description: '适用场景（最重要的字段）' },
        examples: { type: 'array', items: { type: 'string' }, description: '范例句（希望自己怎么说）' },
        avoid: { type: 'string', description: '什么情况下别用' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签（检索用）' },
        priority: { type: 'integer', description: '1~5，常用梗填 4~5，冷门填 2' },
        scope: { type: 'string', description: 'global = 所有会话都能用（默认）；chat = 只在这个会话用' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        const memes = ctx.memory?.memes;
        if (!memes) return err('梗知识库模块未加载');
        if (memes.enabled === false) return err('梗知识库未启用（设置 → 梗知识库）');
        if (getConfig().meme?.autoNote === false) {
          return err('管理员关闭了"模型自动记梗"（设置 → 梗知识库），这个梗请让管理员手动加');
        }
        const r = ctx.memory.addMeme({
          text: args.text,
          means: args.means,
          aliases: args.aliases,
          kind: args.kind,
          source: args.source,
          useCases: args.useCases,
          examples: args.examples,
          avoid: args.avoid,
          tags: args.tags,
          priority: args.priority,
          scope: args.scope === 'chat' ? 'chat' : 'global',
          chatKey: args.scope === 'chat' ? ctx.chatKey : '',
          origin: 'model'
        });
        if (!r.ok) return err(r.error);
        return ok({
          saved: true,
          merged: r.merged === true,
          id: r.entry.id,
          text: r.entry.text,
          note: r.merged ? '已补充更新这条梗。' : '已记进梗库。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 跨群长期记忆（读写）
// ══════════════════════════════════════════════════════════════════════════
function registerMemoryTools() {
  registerTool({
    id: 'memory_search',
    name: '主动回忆',
    description: '主动回忆：跨群检索长期记忆（人物档案 + 长期事件）。"这人以前是不是见过""上次那个约定是啥"就查它。不传 query 时可按 userId 精确看某个人。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（人名/话题/梗都行）。留空 = 只按 userId 与时间筛选' },
        userId: { type: ['integer', 'string'], description: '只看这个 QQ 号' },
        kind: { type: 'string', description: '只看某类事件（promise / joke / grudge / topic / preference / event）' },
        days: { type: 'integer', description: '只看最近 N 天内产生的记忆' },
        limit: { type: 'integer', description: '返回条数上限（默认 12，最大 50）' }
      }
    },
    async execute(ctx, args) {
      const g = ctx.memory?.global;
      if (g?.enabled === false) return err('长期记忆未启用（设置 → 记忆里可以打开）');
      const found = ctx.memory.searchMemory({
        query: String(args.query ?? '').trim(),
        userId: String(args.userId ?? '').trim(),
        chatKey: ctx.chatKey,
        kinds: args.kind ? [String(args.kind)] : null,
        days: Number(args.days) || 0,
        limit: Number(args.limit) || 12
      });
      if (!found.total) return ok({ found: 0, note: '没有匹配的长期记忆。别硬编，就当没记过。' });
      try {
        g.reinforce({
          factIds: found.people.flatMap((p) => p.facts.map((f) => f.id)),
          eventIds: found.events.map((e) => e.id)
        });
      } catch { /* 强化失败不影响返回 */ }
      return ok({ found: found.total, people: found.people, events: found.events });
    }
  });

  registerTool({
    id: 'memory_note_event',
    name: '记长期事件',
    description: '记一件长期有效的事（约定/梗/恩怨/某人正在长期纠结的事/稳定偏好）。由遗忘曲线管理，importance 越高记得越久（≥4 不会被淘汰）。一次性的临时闲聊别记。',
    category: 'memory',
    icon: '📌',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话说清这件事（≤120 字）' },
        kind: { type: 'string', description: 'promise / joke / grudge / topic / preference / event（默认 event）' },
        scope: { type: 'string', description: 'chat = 只在这个会话有效（默认）；global = 跟人走，跨群都该记得' },
        participants: { type: 'array', items: { type: ['integer', 'string'] }, description: '涉及的 QQ 号（可选）' },
        importance: { type: 'integer', description: '重要度 1~5，默认 3。约定/雷点/恩怨用 4~5；4 及以上不会被淘汰。' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const g = ctx.memory?.global;
      if (g?.enabled === false) return err('长期记忆未启用');
      const text = String(args.text ?? '').trim();
      if (!text) return err('text 不能为空');
      const event = ctx.memory.noteEvent(ctx.chatKey, {
        text,
        kind: String(args.kind ?? 'event'),
        scope: args.scope === 'global' ? 'global' : 'chat',
        participants: Array.isArray(args.participants) ? args.participants : [],
        importance: Number(args.importance) || 3
      });
      if (!event) return err('记录失败（内容为空或长期记忆已被关闭）');
      return ok({ saved: true, id: event.id, kind: event.kind, scope: event.scope, importance: event.importance });
    }
  });

  registerTool({
    id: 'memory_forget',
    name: '忘掉记忆',
    description: '删记错的/过时的长期记忆：事件传 eventId，人物事实传 userId + content。resolve=true 表示"这事翻篇了"——保留记录但不再主动提起。',
    category: 'memory',
    icon: '🗑',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: '要删的事件 id（memory_search 返回过）' },
        userId: { type: ['integer', 'string'], description: '人物事实所属 QQ 号' },
        content: { type: 'string', description: '要删的那条事实原文（配合 userId 使用）' },
        resolve: { type: 'boolean', description: 'true = 不删除，只标记为已了结/翻篇' }
      }
    },
    async execute(ctx, args) {
      const g = ctx.memory?.global;
      if (g?.enabled === false) return err('长期记忆未启用');
      const eventId = String(args.eventId ?? '').trim();
      if (eventId) {
        const done = args.resolve === true ? g.resolveEvent(eventId) : g.forgetEvent(eventId);
        return ok({ ok: done, eventId, resolved: args.resolve === true });
      }
      const userId = String(args.userId ?? '').trim();
      const content = String(args.content ?? '').trim();
      if (!userId || !content) return err('请传 eventId，或同时传 userId 与 content');
      const removed = g.forgetFact(userId, { content });
      return ok({ ok: removed > 0, removed });
    }
  });

  registerTool({
    id: 'recall_recent',
    name: '回忆近况',
    description: '查"这个人最近在别的地方说过什么"（默认最近 10 分钟的原话）。想复述/接上某人在私聊或别的群刚说过的话时用它。',
    category: 'memory',
    icon: '💭',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '要查的 QQ 号。留空 = 本次对话里涉及的成员' },
        query: { type: 'string', description: '关键词。留空 = 只要"最近说的原话"' },
        includeLongTerm: { type: 'boolean', description: '是否同时查长期记忆（默认 true）' },
        limit: { type: 'integer', description: '返回条数上限（默认 8，最大 30）' }
      }
    },
    async execute(ctx, args) {
      const g = ctx.memory?.global;
      if (g?.enabled === false) return err('跨群记忆未启用（设置 → 记忆里可以打开）');
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
      const uid = String(args.userId ?? '').trim();
      let targets = [];
      if (uid) {
        targets = [uid];
      } else if (typeof ctx.relevantUserIds === 'function') {
        targets = [...ctx.relevantUserIds()].map(String).filter(Boolean).slice(0, 6);
      }
      const recent = [];
      const seen = new Set();
      const pushRecent = (list) => {
        for (const s of list) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          recent.push(s);
        }
      };
      if (targets.length) {
        for (const t of targets) pushRecent(ctx.memory.listSurface({ userId: t, chatKey: ctx.chatKey, limit }));
      } else {
        pushRecent(ctx.memory.listSurface({ chatKey: ctx.chatKey, limit }));
      }
      recent.sort((a, b) => (b.at || 0) - (a.at || 0));

      const out = {
        recent: recent.slice(0, limit).map((s) => ({
          id: s.id,
          userId: s.userId,
          name: s.name || s.userId,
          from: s.chatKey === ctx.chatKey ? '本会话' : s.chatKey,
          text: s.text,
          minutesAgo: Math.max(0, Math.round((Date.now() - (s.at || Date.now())) / 60000)),
          note: '表层记忆，会过期。要长期留着就调 memory_promote'
        }))
      };
      if (args.includeLongTerm !== false) {
        const found = ctx.memory.searchMemory({
          query: String(args.query ?? '').trim(),
          userId: uid,
          chatKey: ctx.chatKey,
          limit
        });
        out.longTerm = { people: found.people, events: found.events, total: found.total };
      }
      if (!out.recent.length && !(out.longTerm?.total)) {
        return ok({ found: 0, note: '没查到最近说过的话。别硬编，就当不知道。' });
      }
      return ok({ found: (out.recent?.length || 0) + (out.longTerm?.total || 0), ...out });
    }
  });

  registerTool({
    id: 'memory_promote',
    name: '沉淀记忆',
    description: '把一条表层记忆（recall_recent 返回的原话）沉淀成长期记忆，免得 10 分钟后就过期。约定、长期偏好、要长期记住的梗用这个。',
    category: 'memory',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        surfaceId: { type: 'string', description: '表层记忆 id' },
        text: { type: 'string', description: '沉淀时的措辞（整理成一句话）。留空 = 用原话' },
        kind: { type: 'string', description: 'promise / joke / grudge / topic / preference / event（默认 event）' },
        importance: { type: 'integer', description: '重要度 1~5，默认 3。约定/雷点用 4~5。' },
        as: { type: 'string', description: 'event = 存成长期事件（默认）；fact = 存成那个人的长期事实' }
      },
      required: ['surfaceId']
    },
    async execute(ctx, args) {
      const g = ctx.memory?.global;
      if (g?.enabled === false) return err('跨群记忆未启用');
      const id = String(args.surfaceId ?? '').trim();
      if (!id) return err('surfaceId 不能为空');
      const item = ctx.memory.getSurface(id);
      if (!item) return err('没有找到这条表层记忆（可能已过期）');
      const rewritten = String(args.text ?? '').trim();
      if (rewritten && rewritten !== item.text) {
        const updated = g.addSurface({
          userId: item.userId, name: item.name, chatKey: item.chatKey, text: rewritten
        });
        if (updated) item.id = updated.id;
      }
      const r = ctx.memory.promoteSurface(item.id, {
        kind: String(args.kind ?? 'event'),
        importance: Number(args.importance) || 3,
        as: args.as === 'fact' ? 'fact' : 'event'
      });
      if (!r.ok) return err(`沉淀失败（${r.reason || '未知原因'}）`);
      return ok({ saved: true, as: r.kind, userId: item.userId, text: rewritten || item.text });
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 情绪 / 情爱 / 风格 / 棋局
// ══════════════════════════════════════════════════════════════════════════
function registerPersonaStateTools() {
  registerTool({
    id: 'set_mood',
    name: '记录心情',
    description: '记录你此刻的心情（会一直影响你之后说话的语气，控制台也看得到）。只在情绪真的被改变时调 —— 每轮都调等于没有情绪。别告诉对方你调了，也别报情绪名。',
    category: 'system',
    icon: '🎈',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: `情绪名，只能填：${(() => { try { return emotionNameList('、'); } catch { return '开心、难过、生气 等'; } })()}` },
        intensity: { type: ['integer', 'number'], description: '强度 1~5：1=很淡、3=明显、5=强烈（很少用）。别动不动就 5。' },
        reason: { type: 'string', description: '一句话原因，给自己和控制台看' }
      },
      required: ['mood']
    },
    async execute(ctx, args) {
      try {
        const r = setEmotion(ctx.chatKey, {
          mood: args.mood,
          intensity: args.intensity,
          reason: args.reason,
          by: 'model'
        });
        if (!r.ok) return err(r.error);
        if (ctx.session) {
          ctx.session.emotion = {
            key: r.key, name: r.name, emoji: r.emoji, intensity: r.intensity, reason: r.reason, by: 'model'
          };
        }
        return ok({
          saved: true,
          mood: r.name,
          intensity: r.intensity,
          note: '记下了。别告诉对方这件事，也别报你的情绪 —— 直接按这个状态说话就行。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'set_intimacy',
    name: '微调情爱值',
    description: '微调你此刻"想要"的程度（系统本来就会按你们的互动自己累积，只在你自己觉得该多一分或少一分时才用）。正数=更想要，负数=缓下来。别每轮都调，也别告诉对方你调了。',
    category: 'system',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        delta: { type: ['integer', 'number'], description: '变化量，如 +8 / -10。一次别超过 ±20。' },
        reason: { type: 'string', description: '一句话原因，给自己和控制台看' }
      },
      required: ['delta']
    },
    async execute(ctx, args) {
      try {
        const c = intimacyCfg();
        // 夹一层：模型很容易一激动给 ±50，那等于一轮拉满，量级就废了。
        const raw = Number(args.delta) || 0;
        if (!raw) return err('delta 不能是 0 或空');
        const delta = Math.max(-20, Math.min(20, raw));
        const r = setIntimacy(ctx.chatKey, { delta, reason: args.reason, by: 'model' }, { cfg: c });
        if (!r.ok) return err(r.error);
        if (ctx.session) {
          ctx.session.intimacy = {
            ...(ctx.session.intimacy || {}),
            value: r.value,
            gained: (Number(ctx.session.intimacy?.gained) || 0) + delta,
            stage: r.stage,
            by: 'model'
          };
        }
        return ok({ saved: true, note: '记下了。别告诉对方这件事，也别报数值 —— 按这个状态继续就行。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'style_note',
    name: '记说话风格',
    description: '记一条"这个群里的人是怎么说话的"观察（如"他们夸人爱说 6"），用于让自己的说话方式更像他们。只在确实观察到稳定规律时用，别记具体八卦。',
    category: 'memory',
    icon: '🗣',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'speech 说话逻辑 | reaction 图片/表情反应' },
        text: { type: 'string', description: '一句话规律（≤40字，写"怎么说"而不是"说了什么"）' },
        confidence: { type: 'number', description: '把握程度 0~1，默认 0.7' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        const style = ctx.memory?.style;
        if (!style || !style.enabled) return err('风格学习未开启（设置 → 记忆 → 真人说话风格学习）');
        const kind = String(args.kind ?? 'speech') === 'reaction' ? 'reactions' : 'speech';
        const r = style.addItem(kind, String(args.text ?? ''), {
          confidence: Number(args.confidence) || 0.7,
          source: 'model'
        });
        if (!r.ok) return err(r.error);
        return ok({ saved: true, kind: r.kind, result: r.result });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'chess',
    name: '下国际象棋',
    description: '下国际象棋。局面由本程序管着，走子只能用返回的合法着法。',
    category: 'system',
    icon: '♟',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'new 开局 / move 走一步(也记对方报的着法) / board 看局面 / undo 悔棋 / resign 认输 / end 不下了 / list 历史棋路' },
        move: { type: 'string', description: 'move 用：UCI 如 e2e4、e7e8q；也认 SAN(e4/Nf3/O-O) 与中文(马g1到f3)' },
        botSide: { type: 'string', description: 'new 用：white 你先走 / black 对方先走(默认)' },
        plies: { type: ['integer', 'string'], description: 'undo 用：回退几步，默认 2' },
        force: { type: 'boolean', description: 'new 用：已有对局时强制重开(旧棋路会归档)' },
        who: { type: 'string', description: 'resign 用：me 你认输 / you 对方认输' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      const cfg = getConfig();
      if (cfg.chess?.enabled === false) return err('棋局功能已被管理员关闭');
      const c = chessCfg(cfg.chess);
      const chatKey = ctx.chatKey;
      if (!chatKey) return err('拿不到当前会话');
      const action = String(args.action ?? '').trim().toLowerCase();
      // 给模型看的局面摘要（纯文本，比 JSON 省一大截 token）。
      // tail：贴在**最末尾**的一句即时指令 —— 工具结果是"她写下一句之前最后看到的东西"。
      const summary = (st, { header = '', display = false, tail = '' } = {}) => {
        const lines = [];
        if (header) lines.push(header);
        lines.push(`你执${st.botSide === 'w' ? '白' : '黑'}，对方执${st.botSide === 'w' ? '黑' : '白'}；已走 ${st.ply} 步；状态：${st.statusText}`);
        lines.push(renderBoardAscii(st.pos));
        lines.push(`棋路：${renderMovesText(st.moves, { max: c.kifuMax })}`);
        if (st.replayError) lines.push(`⚠️ 存档回放出过错：${st.replayError}`);
        if (st.status === 'playing') {
          if (st.check) lines.push('⚠️ 轮到走的一方正在被将军，必须应将。');
          if (st.botTurn) {
            lines.push('现在轮到你走。合法着法（照抄其中一条，别自己编）：');
            lines.push(st.legal.slice(0, c.legalMovesMax).map((m) => moveToUci(m)).join(' '));
            lines.push('这一次回复里把两件事一起做完：chess(action:"move") 走你的这一步 + send_message 告诉他你走了哪（哪个子、走到哪一格）。');
          } else {
            lines.push(`现在轮到对方走（${st.turn === 'w' ? '白方' : '黑方'}）—— 等他把着法报过来，用 action:"move" 记下来。`);
          }
        } else {
          lines.push(`这盘已经结束了：${st.statusText}${st.winner ? `，${st.winner === st.botSide ? '你' : '对方'}赢了` : ''}。想再来一盘用 action:"new"。`);
        }
        if (display) {
          lines.push('下面这张给他看，可以直接原样复制发出去：');
          lines.push('');
          lines.push(renderBoardUnicode(st.pos));
        }
        if (tail) lines.push(tail);
        return lines.join('\n');
      };

      try {
        if (action === 'new' || action === 'start' || action === '开局' || action === '新局') {
          const r = startGame(chatKey, { botSide: args.botSide, force: args.force === true, cfg: c });
          if (!r.ok) return err(r.error);
          if (r.existing) {
            return ok(summary(r.state, { header: '这个会话已经有一盘没下完的棋（下面是当前局面）。要重开一局就 action:"new", force:true —— 现在这盘的棋路会被归档，不会丢。' }));
          }
          return ok(summary(r.state, { header: '新开了一局。', display: true }));
        }

        if (action === 'move' || action === '走子' || action === '走棋') {
          const r = playMove(chatKey, { move: args.move, as: args.as, cfg: c });
          if (!r.ok) {
            const st = r.state;
            const hint = st && st.status === 'playing'
              ? `\n当前合法着法（${st.legal.length} 条）：${st.legal.slice(0, c.legalMovesMax).map((m) => moveToUci(m)).join(' ')}`
              : '';
            // 给 send_message 留个记号：这一批里那步**没走成**（防止发出一个不存在的着法）
            if (ctx.session) ctx.session.chessMoveFailedAt = Number(ctx.session.rounds) || 0;
            return err(`${r.error}${hint}`);
          }
          if (ctx.session) ctx.session.chessMoveFailedAt = 0;
          const who = r.actor === 'bot' ? '你' : '对方';
          const head = `${who}走 ${r.uci}（${r.san}${r.cn ? ' / ' + r.cn : ''}）${r.captured ? '，吃子' : ''}${r.check ? '，将军！' : ''}`;
          let tail = '';
          if (r.ended) {
            tail = `⚠️ 这盘棋到这里结束了（${r.state.statusText}）—— 必须用 send_message 把结果告诉他，别不吭声。`;
          } else if (r.actor === 'bot') {
            tail = '⚠️ 要是这一步还没说给他听，这一次回复必须说清"哪个子、走到哪一格"（吃子/将军一并说）。已经说过了就直接结束。';
          } else {
            tail = '现在轮到你走 —— 这一次回复里一次做完：chess(move) 走你的步 + send_message 告诉他你走了哪，别拆两次、别漏说。';
          }
          return ok(summary(r.state, { header: head + '。', tail }));
        }

        if (action === 'board' || action === '看棋盘' || action === '局面' || action === '复盘') {
          const st = readChess(chatKey, { cfg: c });
          if (!st) return ok('这个会话现在没有棋局。要下一盘就 action:"new"。');
          return ok(summary(st, { header: '当前局面：', display: true }));
        }

        if (action === 'undo' || action === '悔棋') {
          const r = undoMove(chatKey, { plies: args.plies, cfg: c });
          if (!r.ok) return err(r.error);
          return ok(summary(r.state, { header: `悔棋：退回了 ${r.undone} 步（${r.removed.join(' ')}）。`, display: true }));
        }

        if (action === 'resign' || action === '认输' || action === '投降') {
          const r = finishGame(chatKey, { kind: 'resign', who: args.who, cfg: c });
          if (!r.ok) return err(r.error);
          return ok(`这盘结束了：${r.result}（共 ${r.plies} 步）。棋路已存进历史，想交给对方看可以用 action:"list"。`);
        }

        if (action === 'end' || action === '结束' || action === '不下了') {
          const r = finishGame(chatKey, { kind: 'abort', cfg: c });
          if (!r.ok) return err(r.error);
          return ok(`不下了，这盘的 ${r.plies} 步棋路已经存进历史（不会丢）。`);
        }

        if (action === 'list' || action === '棋路' || action === '历史' || action === '复盘列表') {
          const all = listChess({ cfg: c });
          const rows = [];
          if (all.playing.length) rows.push(`进行中 ${all.playing.length} 盘`);
          const doneRows = [...all.finished, ...all.done].filter((g) => (g.moves || []).length);
          if (!doneRows.length && !all.playing.length) return ok('还没有任何棋路记录。要下一盘就 action:"new"。');
          const text = doneRows.slice(0, 10).map((g, i) => {
            const moves = (g.moves || []).map((m) => m.san || m.uci).join(' ');
            return `${i + 1}. ${g.result || g.statusText || ''}（${(g.moves || []).length} 步）\n   ${moves.slice(0, 400)}`;
          }).join('\n');
          return ok([...rows, text].filter(Boolean).join('\n'));
        }

        return err(`不认识的 action："${action}"。只能用 new / move / board / undo / resign / end / list`);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
}
