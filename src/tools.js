// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import { getConfig } from './config.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { localStickerPath } from './sticker-manager.js';
import { formatSongList, findSong, clipSong } from './songs.js';
import { validateImageUrl, safeFetchBinary, browseLockState, checkBrowseLock } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { holidayOn, upcomingHoliday } from './holidays.js';
import { skillManager } from './skills/manager.js';
import { expandForwardNodes } from './onebot.js';
import { registerTool, listTools } from './tool-registry.js';
import { registerPortedTools } from './tools-ported.js';

async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   tts,  语音合成器（未启用语音时为 null —— send_voice 届时不会注册）
 *   songs 曲库快照（空数组或未就绪时 sing / list_songs 不会注册）
 *   emit  (事件上报给 UI/日志)
 * }
 */
/** 解析 "HH:MM" 或 "YYYY-MM-DD HH:MM" 为时间戳；解析不了返回 null。 */
function parseAtTime(raw) {
  const s = String(raw || '').trim();
  // YYYY-MM-DD HH:MM；严格校验边界，避免 Date 把 2 月 31 日归一化成 3 月 3 日
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59
      || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) return null;
    return d.getTime();
  }
  // HH:MM（今天；若已过则明天）
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 今天已过 → 明天
    return d.getTime();
  }
  return null;
}

const BUILTIN_TOOL_DEFS = [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          let sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          // 发送前预检：http 直链（QQ 图床 rkey ~1 小时过期）尽量升级成本地转存，
          // 失败则交给 sender 的三级回退链。本地转存过的条目直通。
          if (typeof ctx.stickers.ensureSendable === 'function') {
            sticker = await ctx.stickers.ensureSendable(sticker);
          }
          // 本地收藏图片（file:/// 路径，收藏时已转存）不走公网 URL 校验，
          // 但必须落在受控的 data/sticker-images/ 目录内 —— 本地库条目若被污染
          // 指向任意本地文件（配置、密钥），不设闸就会被 OneBot 发出去。
          const isLocalFile = String(sticker.url).startsWith('file:///');
          if (isLocalFile) {
            if (!localStickerPath(sticker.url)) {
              return err(`表情 ${sticker.id} 的本地图片路径不在受控收藏目录内，已拒绝发送`);
            }
          } else {
            try {
              await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
            } catch (error) {
              return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
            }
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_voice',
      description: '发一条语音（把你的话用语音合成读出来，一条消息只有语音、不能附带文字）。适合：撒娇/叹气/喊人/一句带情绪的口语短句，或群友明确说"你发个语音""你说话呀"时。text 只写【要读出来的话本身】，是口语短句，不要写"（小声）""*笑*"这类舞台提示、表情符号或 Markdown，否则会被原样念出来。语音比打字打扰得多：一次最多一条，不要连发，不要拿它念长文或讲道理。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要读出来的话（简短口语，建议 ≤40 字）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          if (!ctx.tts) return err('语音功能未启用：请在「设置 → 语音输出」里开启并填好语音配置');
          const raw = String(args.text ?? '').trim();
          if (!raw) return err('语音内容为空');
          const maxChars = Math.max(1, Number(getConfig().voice?.maxChars) || 200);
          const spoken = raw.slice(0, maxChars);
          const clip = await ctx.tts.speak(spoken);
          const result = await ctx.sender.sendVoice(ctx.chatKey, { file: clip.file, text: spoken }, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push({ type: 'voice', text: `[语音] ${spoken}`, at: result.at });
          ctx.emit('session-update', ctx.session.id);
          const note = ['语音已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (raw.length > maxChars) note.push(`（内容超过 ${maxChars} 字，已截断到「${spoken}」）`);
          return ok({
            sent: true,
            spoken,
            format: clip.format,
            bytes: clip.bytes,
            note: note.join('')
          });
        } catch (error) {
          return err(`发语音失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'list_songs',
      description: '看看你的曲库里有哪些歌（可按关键词搜）。被点歌、或聊天正好聊到某首歌时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配歌名 / 别名 / 歌手 / 标签' },
          limit: { type: 'integer', description: '最多返回几首，默认 50' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = formatSongList(
            ctx.songs || [],
            String(args.query ?? ''),
            Math.min(200, Math.max(1, Number(args.limit) || 50))
          );
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sing',
      description: '唱一段歌：把曲库里某首歌的片段当语音消息发出去（片段只有几十秒，这是正常的，别当成没唱完）。被明确点歌、或聊天正好聊到某首歌时才唱；不要主动连唱，也不要用唱歌回应每句话。song 填歌名或关键词，不确定有什么歌就先 list_songs。',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '要唱哪首歌（歌名或关键词，可先 list_songs 查）' },
          start: { type: 'number', description: '可选：从第几秒开始唱。默认从这首歌最抓耳的一段开始，一般不用填' }
        },
        required: ['song']
      },
      async execute(ctx, args) {
        try {
          if (!Array.isArray(ctx.songs) || !ctx.songs.length) {
            return err('曲库是空的。需要先把歌放进 data/songs/ 并写好 manifest.json，再在设置里开启唱歌功能');
          }
          const want = String(args.song ?? '').trim();
          if (!want) return err('要唱哪首歌？可以先用 list_songs 看看曲库');
          const song = findSong(ctx.songs, want);
          if (!song) {
            const titles = ctx.songs.slice(0, 8).map((s) => s.title).join('、');
            return err(`曲库里没有「${want}」。现有的是：${titles}${ctx.songs.length > 8 ? ' 等' : ''}（可用 list_songs 看全部）`);
          }
          const startArg = Number(args.start);
          const clip = await clipSong(song, {
            start: Number.isFinite(startArg) && startArg >= 0 ? startArg : null,
            maxSeconds: Math.max(5, Number(getConfig().song?.maxSeconds) || 30)
          });
          const result = await ctx.sender.sendSong(ctx.chatKey, { file: clip.file, title: song.title });
          ctx.session.sent.push({ type: 'voice', text: `[唱歌] ${song.title}`, at: result.at });
          ctx.emit('session-update', ctx.session.id);
          return ok({
            sung: song.title,
            from: clip.startSec,
            durationSec: clip.durationSec,
            note: '已经唱出去了。不要输出"已发送/我唱了"这类汇报，继续下一步或直接结束。'
          });
        } catch (error) {
          return err(`唱歌失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情 ${args.stickerId}`);
          if (!sticker.url) return err('该表情没有图片地址');
          const dataUrl = await downloadImageAsDataUrl(sticker.url);
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && (m.url || m.file));
          if (!imageMedia) return err('该消息没有可收藏的图片');
          // collect 现在会把图片转存到本地（防 QQ 图床 rkey 过期导致发送失败），是异步的
          const saved = await ctx.stickers.collect(args.messageId, {
            url: imageMedia.url || '',
            file: imageMedia.file || '',
            note: String(args.note ?? '')
          });
          return ok({ collected: true, id: saved.id, note: saved.localNote });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            text: m.text
          }))
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（千万别用方括号里那串长 id，会过期报错）。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
          }
          const r = await ctx.onebot.call('get_forward_msg', { message_id: Number(entry.mid) });
          const nodes = Array.isArray(r?.messages) ? r.messages : [];
          const ex = await expandForwardNodes(nodes);
          if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
          // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
          return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          const dataUrls = [];
          const failed = [];
          for (const url of urls) {
            try { dataUrls.push(await downloadImageAsDataUrl(url)); } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；')}`);
          const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
          target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
          content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
          userId,
          target: String(args.target ?? '').trim()
        });
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId)
          : mem.memberImpression;
        return ok({ memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''));
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          // 浏览锁定开启时逐跳校验白名单（与图片下载同一口径；
          // 曾经漏传导致锁定形同虚设）
          const result = await webFetch(String(args.url ?? ''), { browseLocked: browseLockState().enabled });
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    },
    // ── 跨会话发送 / 会话枚举 ──
    {
      name: 'send_to',
      category: 'messaging',
      icon: '📨',
      // 描述动态化：开关关闭时明确说"没权限"，避免模型白试一次
      get description() {
        const cross = getConfig().tools?.crossChatSend === true;
        const base = '把消息发送到另一个群/私聊（不在当前会话里说，而是去别处说）。适用于：有人明确让你转告某人/某群、你主动去私聊某人。';
        return cross
          ? `${base}先用 get_chats 查可用的 chatKey，再传 targetChatKey（形如 group:123 / private:456）。只在有明确理由时使用，不要骚扰别人。`
          : `${base}（当前未开启：管理员可在 设置 → 工具与技能 打开「允许跨会话发送」。）`;
      },
      parameters: {
        type: 'object',
        properties: {
          targetChatKey: { type: 'string', description: '目标会话：group:群号 / private:QQ号（用 get_chats 查，不要自己编）' },
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
        },
        required: ['targetChatKey', 'messages']
      },
      async execute(ctx, args) {
        try {
          // 硬校验三连：开关 → 格式 → 白名单。描述里的引导不是安全边界。
          if (getConfig().tools?.crossChatSend !== true) {
            return err('跨会话发送未开启（管理员可在 设置 → 工具与技能 里打开）。');
          }
          const wantTarget = String(args.targetChatKey ?? '').trim();
          if (!/^(group|private):\d+$/.test(wantTarget)) {
            return err('targetChatKey 格式应为 group:群号 或 private:QQ号');
          }
          if (wantTarget === ctx.chatKey) {
            return err(`目标 ${wantTarget} 就是当前会话，直接用 send_message 即可。`);
          }
          const [tKind, tId] = wantTarget.split(':');
          const allow = getConfig().allow || {};
          const allowList = (tKind === 'group' ? allow.groups : allow.private) || [];
          const allowedAll = tKind === 'group' ? (allowList.length === 0 && getConfig().allowAllWhenEmpty === true) : (allowList.length === 0);
          if (!(allowList.map(String).includes(tId) || allowedAll)) {
            return err(`目标 ${wantTarget} 不在白名单内，不能发送。`);
          }
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(wantTarget, messages, {});
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, to: wantTarget })));
          ctx.emit('session-update', ctx.session.id);
          const note = [`已发送到 ${wantTarget}。不要输出汇报。`];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_chats',
      category: 'query',
      icon: '📋',
      description: '列出机器人参与的会话（chatKey、名字、最近消息时间）。跨会话发送（send_to 的 targetChatKey）前用它查目标。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 20，最大 50' } }
      },
      async execute(ctx, args) {
        const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
        const chats = ctx.store.listChats()
          .map((key) => ({ key, ...(ctx.store.getChatMeta(key) || {}) }))
          .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
          .slice(0, limit);
        return ok({
          count: chats.length,
          chats: chats.map((c) => ({
            chatKey: c.key,
            lastActive: c.lastTs ? new Date(c.lastTs).toLocaleString('zh-CN', {
              hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            }) : '',
            recentText: String(c.lastText || '').slice(0, 30)
          }))
        });
      }
    },
    // ── 提醒（闹钟/计时）──
    {
      name: 'set_reminder',
      category: 'system',
      icon: '⏰',
      description: '设置一个定时提醒（闹钟）。到点后机器人会在当前群里主动发一条提醒消息。适用：群友说"X分钟后提醒我"、"明天早上叫我"、"X点提醒我吃饭"。delayMinutes（多少分钟后）和 atTime（具体时间，如"18:30"或"2026-09-12 08:00"）二选一。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '提醒内容（到点要发的话，如"该吃饭了"）' },
          delayMinutes: { type: 'number', description: '多少分钟后提醒（与 atTime 二选一）' },
          atTime: { type: 'string', description: '具体时间提醒，格式 "HH:MM"（今天/明天）或 "YYYY-MM-DD HH:MM"（与 delayMinutes 二选一）' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        const text = String(args.text ?? '').trim();
        if (!text) return err('提醒内容为空');
        let dueAt = null;
        if (args.delayMinutes != null && Number(args.delayMinutes) > 0) {
          dueAt = Date.now() + Number(args.delayMinutes) * 60000;
        } else if (args.atTime) {
          dueAt = parseAtTime(String(args.atTime));
          if (!dueAt) return err('时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"');
          if (dueAt <= Date.now()) return err('这个时间已经过了，请给个未来的时间');
        } else {
          return err('请提供 delayMinutes（多少分钟后）或 atTime（具体时间）之一');
        }
        if (!ctx.reminders) return err('提醒服务未启用');
        const entry = ctx.reminders.add({ chatKey: ctx.chatKey, text, dueAt, createdBy: String(ctx.selfId || '') });
        const when = new Date(dueAt);
        const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
        return ok({ set: true, id: entry.id, dueAt, note: `已设置提醒：${whenStr} 到点我会在本群说「${text}」。` });
      }
    },
    {
      name: 'list_reminders',
      category: 'system',
      icon: '📋',
      description: '查看当前会话里还没触发的所有提醒（闹钟）。适用：群友问"我设了什么提醒"、"还有哪些闹钟"。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        if (!ctx.reminders) return err('提醒服务未启用');
        const list = ctx.reminders.pending(ctx.chatKey);
        if (!list.length) return ok({ count: 0, note: '当前没有待触发的提醒。' });
        const lines = list.map((r) => {
          const d = new Date(r.dueAt);
          const whenStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `- [${r.id}] ${whenStr}：${r.text}`;
        });
        return ok({ count: list.length, reminders: lines.join('\n') });
      }
    },
    {
      name: 'cancel_reminder',
      category: 'system',
      icon: '🗑️',
      description: '取消一个还没触发的提醒（闹钟）。id 从 list_reminders 获取。适用：群友说"取消那个提醒"、"别提醒我了"。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要取消的提醒 id（list_reminders 里 [r_xxx] 那个）' } },
        required: ['id']
      },
      async execute(ctx, args) {
        if (!ctx.reminders) return err('提醒服务未启用');
        const id = String(args.id ?? '').trim();
        if (!id) return err('请提供提醒 id');
        const done = ctx.reminders.cancel(id);
        return done ? ok({ cancelled: true, id }) : err(`没找到提醒 ${id}（可能已触发或 id 不对，用 list_reminders 查一下）`);
      }
    },
    // ── 节假日问候 ──
    {
      name: 'check_holiday',
      category: 'system',
      icon: '🎉',
      description: '查询今天或最近有什么节日（春节/中秋/端午/元旦/国庆等中国法定与常见节日）。用于在节日时主动向群友送上问候。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '往后查几天内的最近节日（默认 7 天；0 表示只查今天）' }
        }
      },
      async execute(ctx, args) {
        const today = holidayOn(new Date());
        const days = args.days != null ? Math.max(0, Number(args.days) || 0) : 7;
        const upcoming = upcomingHoliday(days);
        const out = {
          today: today ? { name: today.name, greeting: today.greeting, type: today.type } : null,
          upcoming: upcoming ? { name: upcoming.name, date: upcoming.date, daysAway: upcoming.daysAway, greeting: upcoming.greeting } : null
        };
        let note;
        if (today) {
          note = `今天是${today.name}！可以自然地送上祝福（参考：${today.greeting}）。`;
        } else if (upcoming) {
          note = upcoming.daysAway === 0
            ? `今天是${upcoming.name}。`
            : `今天不是节日。最近的是 ${upcoming.daysAway} 天后的${upcoming.name}（${upcoming.date}）。`;
        } else {
          note = `今天不是节日，未来 ${days} 天内也没有常见节日。`;
        }
        return ok({ ...out, note });
      }
    },
    // ── 发网图 / 搜网图 ──
    {
      name: 'send_image',
      category: 'media',
      icon: '🖼️',
      defaultEnabled: true,
      description: '把一张网上找到的图片发到当前聊天。默认需要先预览确认（send_image(url, preview=true) 看一眼，再 send_image(url) 发出）。只支持 png/jpg/gif/webp 直链；网页地址不是图片。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片直链（要整条照抄，不要改动路径字符）' },
          preview: { type: 'boolean', description: 'true = 先只给自己看一眼、不发送' },
          note: { type: 'string', description: '可选：配一句话一起发' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
          atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填 QQ 号）' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig();
          const opt = cfg.security?.imageSend || {};
          if (opt.enabled !== true) {
            return err('发网图功能未开启。想让机器人能发网图，请在设置页「聊天设置 → 发网图」里打开。');
          }
          const url = String(args.url ?? '').trim();
          if (!url) return err('url 不能为空');
          if (!/^https?:\/\//i.test(url)) {
            return err('只支持 http(s) 图片直链。本地文件路径不能发（那会暴露宿主文件系统）。');
          }
          // 每次运行的状态挂在 ctx 上（ctx 每次运行新建，天然隔离、不用持久化）
          ctx.sendImageState = ctx.sendImageState || { previewed: [], previews: 0, sent: 0 };
          const st = ctx.sendImageState;

          const isPreview = args.preview === true;
          const lock = cfg.security?.browseLock || {};
          // 浏览锁定站点内的图可跳过预览：站内图源可信，省一轮
          const lockCheck = checkBrowseLock(url, browseLockState());
          const trusted = lockCheck.enabled && lockCheck.allowed && opt.skipPreviewForLockedHosts !== false;

          if (!isPreview) {
            if (opt.requirePreview !== false && !trusted && !st.previewed.includes(url)) {
              return err('发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。');
            }
            if (st.sent >= Math.max(1, Number(opt.maxPerRun) || 3)) {
              return err(`本次运行已经发了 ${st.sent} 张图，达到上限（设置里可调）。`);
            }
          } else if (st.previews >= Math.max(1, Number(opt.maxPreviewsPerRun) || 5)) {
            return err(`本次运行预览次数已达上限（${st.previews} 次）。挑最有把握的一张直接发。`);
          }

          // 下载：safe-fetch 全套防护（DNS 固定、逐跳校验、限量、浏览锁定）
          const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
          let buffer;
          let contentType;
          try {
            ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: !!lock.enabled }));
          } catch (error) {
            const msg = String(error?.message ?? error);
            const hint = /HTTP 404/.test(msg)
              ? '（地址可能抄错了：请从 web_fetch / search_images 返回的 images 里原样复制，不要改动路径字符；也可能是图已删除）'
              : '';
            return err(`图片下载失败：${msg}${hint}`);
          }
          if (!buffer || !buffer.length) return err('图片内容为空');

          // 魔数校验：只认真图。很多"图片链接"其实返回 HTML（防盗链页/错误页）
          const mime = detectMime(buffer);
          if (!mime) {
            const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
            if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
              return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
            }
            return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
          }

          const b64 = buffer.toString('base64');
          if (isPreview) {
            st.previews += 1;
            if (!st.previewed.includes(url)) st.previewed.push(url);
            // 问图片格式兼容 Skill：这种格式能不能喂给当前模型（webp/avif 在部分接口会直接 400）
            let supported = true;
            try {
              for (const p of skillManager.getCapabilityProviders('image.mime-support', {})) {
                const r = p.fn({ mime });
                if (r && r.supported === false) supported = false;
                break;
              }
            } catch { /* 能力坏了不影响预览 */ }

            if (!supported) {
              return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。当前视觉接口不支持 ${mime}，看不到画面内容，但字节已校验过是真图、QQ 里能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
            }
            return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——觉得合适就立刻调 send_image(url) 发出去：`, [`data:${mime};base64,${b64}`]) };
          }

          // 传 url 而不是只传 base64：OneBot 的 image 段原生支持 http 直链，让**协议端
          // 自己去下载**，body 从 MB 级降到几十字节。保留 dataUrl 作回退（防盗链/协议端异机）。
          const result = await ctx.sender.sendImage(ctx.chatKey, { url, dataUrl: `base64://${b64}` }, {
            note: args.note,
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          st.sent += 1;
          ctx.session.sent.push({
            type: 'image',
            text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'search_images',
      category: 'web',
      icon: '🔎',
      requiresSearch: true,
      description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑一条用 send_image(url) 发出去。被要求"发张图/来点表情/找张照片"时用它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（越具体越准）' },
          limit: { type: 'integer', description: '最多返回几条，默认 8' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig();
          if (cfg.security?.imageSend?.enabled !== true) {
            return err('搜图功能未开启。请在设置页「聊天设置 → 发网图」里打开。');
          }
          const query = String(args.query ?? '').trim();
          if (!query) return err('query 不能为空');
          const limit = Math.min(12, Math.max(1, Number(args.limit) || 8));

          // 动态取图搜能力：特性检测，避免 web-search 缺这个函数时整个注册就崩
          let searchImagesFn = null;
          try {
            const mod = await import('./web-search.js');
            searchImagesFn = typeof mod.searchImages === 'function' ? mod.searchImages : null;
          } catch { /* 下面统一报错 */ }
          if (!searchImagesFn) {
            return err('图搜能力不可用（web-search 里没有 searchImages）。请用 web_search 找图片页面，再用 web_fetch 拿 images。');
          }

          const list = await searchImagesFn(query, { limit, browseLocked: browseLockState().enabled });
          if (!Array.isArray(list) || !list.length) {
            return ok({ query, results: [], note: '没搜到图。换个更具体的关键词再试一次（最多搜 3 次）。' });
          }
          return ok({
            query,
            results: list.slice(0, limit).map((r) => ({ title: String(r?.title ?? '').slice(0, 60), url: String(r?.url ?? '') })),
            note: '挑一条用 send_image(url) 发出去；url 要整条照抄，不要改。都不贴切就换个更具体的词再搜一次（最多搜 3 次）。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    // ── 视频读取 ──
    {
      name: 'read_video',
      category: 'query',
      icon: '🎬',
      description: '读取消息里的视频。会返回时长/分辨率等元信息，并根据设置页的「视频模式」把画面交给模型：原生视频输入（全模态模型）或抽帧截图（普通视觉模型）。适用：群友发了一个视频，你想"看看"里面是什么。需要消息 id（聊天记录里的 #数字）。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条带视频的消息的 QQ 消息 id（聊天记录里的 #数字）' },
          frames: { type: ['integer', 'string'], description: '可选：本次要抽几帧（1~12）。不传用设置页的默认值。' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const videoMedia = (entry.media || []).find((m) => m.kind === 'video');
          if (!videoMedia) return err('该消息没有视频（媒体里没有 video 段）');
          if (!ctx.videoReader) return err('视频读取服务未启用');
          const info = await ctx.videoReader.probe(videoMedia, { count: Number(args.frames) || 0 });

          // 元信息（不含画面）单独作为文本返回。
          // ⚠️ 必须把画面字段剥掉再序列化：把 base64 图当**文本**送进上下文，
          //    模型既看不到图，又要为几十万 token 付钱。画面一律走下面的 parts。
          const metaOut = {
            messageId: entry.mid,
            durationSec: info.durationSec,
            width: info.width,
            height: info.height,
            sizeBytes: info.sizeBytes,
            format: info.format,
            route: info.route,
            routeReason: info.routeReason,
            frameCount: Array.isArray(info.frames) ? info.frames.length : 0,
            frameTimes: info.frameTimes,
            note: info.note || '已读取视频信息。'
          };
          const metaText = JSON.stringify(metaOut, null, 1);

          // 原生视频输入：把视频地址作为 video 部分交给模型（由 llm.js 换成 videoModel）
          if (info.route === 'native' && info.nativeUrl) {
            return {
              content: [
                { type: 'text', text: `${metaText}\n\n（画面已作为视频输入发送）` },
                { type: 'video_url', video_url: { url: info.nativeUrl } }
              ]
            };
          }

          // 抽帧：每一帧作为一个 image 部分交给模型
          if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
            return {
              content: [
                { type: 'text', text: `${metaText}\n\n（以下 ${info.frames.length} 张是抽帧截图，不是连续视频）` },
                ...info.frames.map((url) => ({ type: 'image_url', image_url: { url } }))
              ]
            };
          }

          // 只给元信息（off / 抽帧不可用 / 全模态模型没配）
          return ok(metaOut);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    }
];

// 内置工具一次性注册进工具注册表：id = name（A 版历史上用 name 当函数名，
// 这样旧调用方按 name 查找、orchestrator 按 name 过滤都仍然成立）。
// 注册之后，技能/插件注册进来的工具会自动出现在 listTools() 里。
let builtinsReady = false;

// 运行期依赖标记：让 getToolAvailability 的统一口径也能正确判定内置工具
// （A 的 orchestrator 里另有一份硬编码过滤，两边口径保持一致）。
const VISION_TOOL_NAMES = new Set(['get_message_images', 'get_sticker_image']);
const SEARCH_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'search_images']);

function ensureBuiltinsRegistered() {
  if (builtinsReady) return;
  builtinsReady = true;
  // 随「功能移植」加入的工具（图搜 / 梗库 / 跨群记忆读写 / 情绪 / 情爱 / 风格 / 棋局）。
  // 先注册它：内部只调 registerTool、不依赖本文件的任何局部函数，顺序无关。
  registerPortedTools();
  for (const d of BUILTIN_TOOL_DEFS) {
    registerTool({
      ...d,
      id: d.name,
      name: d.name,
      requiresVision: d.requiresVision ?? VISION_TOOL_NAMES.has(d.name),
      requiresSearch: d.requiresSearch ?? SEARCH_TOOL_NAMES.has(d.name)
    });
  }
}

/** 全部工具定义（内置 + 由 Skill/插件注册的）。 */
export function buildToolDefs() {
  ensureBuiltinsRegistered();
  return listTools();
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      // 技能工具的 id 带 `skillId__` 前缀（OpenAI 函数名规范），优先用它
      name: d.id ?? d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => (d.id ?? d.name) === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
