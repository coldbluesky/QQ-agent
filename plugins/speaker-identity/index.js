// 发言人身份标注 Skill。
//
// 解决的问题（每一条都来自真实群聊里的误判）：
//   1. 同一个人改群名片 → 历史里前后两条消息看起来像两个人说的
//   2. 两个不同的人恰好同名（实测群里有撞名的 bot）→ 两个人的发言被当成一个人，
//      还会连带把"@那个人"误判成"@我"而抢话
//   3. 模型把正文里的 @昵称 当成"真的提醒了对方"，其实 OneBot 的 at 段才有效
//   4. 模型输出的工具参数 JSON 被截断（数组只写了一半）→ 整次调用失败
//
// 因此传给模型的每条消息都带稳定 QQ 号，让模型自己能判断"是不是同一个人"。
//
// ── Skill 边界（为什么这些函数在这里而不是 onebot.js）────────────────────
// 这里是**纯函数**：不碰网络、不碰文件、不改全局状态。
// OneBot 的连接与重连、消息存档、发送队列仍然由核心模块负责。
// 本 Skill 只提供"格式化与规范化"能力，通过：
//   capability  message.speaker-format / message.inline-at-normalize
//   providers   供核心模块（prompt/tools）按能力名取用
//   prompt       向系统提示词追加"身份以 QQ 号为准"的规则

export const UNKNOWN_SENDER = '未知发送者';

/** 稳定 ID 的展示后缀。QQ 号是数字串，包在括号里不会和正文括号混淆。 */
export function idTag(userId) {
  const id = String(userId ?? '').trim();
  if (!id || id === 'self' || id === 'unknown') return '';
  return `(QQ:${id})`;
}

/**
 * 发言人标签：名字 + 稳定 ID。
 * @param {object} o { name, userId, self, selfLabel, notes }
 *   notes: { [userId]: 备注名 } —— 管理员给的备注优先于群名片
 */
export function speakerTag({ name = '', userId = '', self = false, selfLabel = '我', notes = null } = {}) {
  if (self) return selfLabel;
  const id = String(userId ?? '').trim();
  const note = notes && id ? String(notes[id] ?? '').trim() : '';
  const label = note || String(name ?? '').trim() || id || UNKNOWN_SENDER;
  return `${label}${idTag(id)}`;
}

/** 从一条消息对象里取标签。 */
export function speakerLabel(m, { notes = null, selfLabel = '我' } = {}) {
  if (!m || typeof m !== 'object') return UNKNOWN_SENDER;
  return speakerTag({
    name: m.senderName || m.name || '',
    userId: m.senderId || m.userId || '',
    self: !!m.self,
    selfLabel,
    notes
  });
}

/** 引用消息的发送者标签（引用块里通常只有名字，没有 QQ 号）。 */
export function replySpeakerTag(reply, { notes = null } = {}) {
  if (!reply || typeof reply !== 'object') return '';
  const id = String(reply.senderId ?? reply.userId ?? '').trim();
  // 引用块里有 id 才加后缀；只有名字时不要编一个 id 出来
  return speakerTag({ name: reply.sender || reply.senderName || '', userId: id, notes });
}

/** 去掉文本里已存在的 (QQ:xxx) 标记（避免重复拼接）。 */
export function stripSpeakerTags(text) {
  return String(text ?? '').replace(/\s*\(QQ:\d{1,15}\)/g, '');
}

/**
 * 正文 @ 规范化：把 `@昵称` 换成 `@昵称(QQ:xxx)`。
 *
 * 只在**能唯一确定对象**时替换：
 *   - 有 atUserId 且能在成员表里找到 → 用它
 *   - 名字在成员表里唯一命中 → 用它
 *   - 命中多个同名成员 → 不动（宁可保留歧义，也不要指错人）
 */
export function normalizeInlineAt(text, { members = [], atUserId = '', allowConvert = true } = {}) {
  const src = String(text ?? '');
  if (!allowConvert || !src.includes('@')) return src;

  const list = Array.isArray(members) ? members : [];
  const byId = new Map();
  for (const m of list) {
    const id = String(m?.userId ?? '').trim();
    if (id) byId.set(id, m);
  }

  return src.replace(/@([^\s@()，。！？、,]{1,24})/g, (whole, rawName, offset) => {
    const name = String(rawName).trim();
    if (!name) return whole;
    // 已经带 QQ 后缀的跳过。
    // ⚠️ 必须用 replace 回调给的 offset —— 早先用 src.indexOf(whole) 永远定位到**第一处**，
    // 于是"@A(QQ:1) 和 @A"这种文本里第二处也会被误判成已带后缀而跳过。
    const after = src.slice(offset + whole.length);
    if (/^\s*\(QQ:\d+\)/.test(after)) return whole;

    // 1) 显式 at 目标优先
    if (atUserId) {
      const hit = byId.get(String(atUserId));
      if (hit) {
        const label = String(hit.card || hit.nickname || hit.name || name).trim();
        if (label === name) return `@${name}(QQ:${atUserId})`;
      }
    }

    // 2) 名字唯一命中才替换
    const matches = list.filter((m) => {
      const cands = [m?.card, m?.nickname, m?.name].map((x) => String(x ?? '').trim()).filter(Boolean);
      return cands.includes(name);
    });
    if (matches.length === 1) {
      const id = String(matches[0].userId ?? '').trim();
      if (id) return `@${name}(QQ:${id})`;
    }
    return whole;
  });
}

/**
 * 修复被截断的 JSON 数组参数。
 *
 * 现象：模型输出 `["在的","咋了` 这种半截 JSON（达到 token 上限被切断），
 * JSON.parse 直接抛错，整次工具调用失败——但其实前几条消息是好的，完全可以发出去。
 * 策略：从右往左逐步丢弃最后一个不完整的元素，补齐 `]`，返回能解析出的最后一个前缀。
 *
 * ⚠️ 只在"看起来像数组"时才尝试，且最多尝试 4 次，避免把畸形输入变成误发消息。
 */
export function splitFragmentedArgs(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { /* 下面尝试修补 */ }

  let candidate = raw;
  for (let i = 0; i < 4; i++) {
    // 砍掉最后一个逗号之后的内容（即最后一个不完整元素）
    const cut = candidate.lastIndexOf(',');
    if (cut < 0) break;
    candidate = `${candidate.slice(0, cut)}]`;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* 继续往前砍 */ }
  }
  return null;
}

/** 身份相关规则（供 core 直接取用；与 skill.json 的 prompt.sections 保持一份内容）。 */
export function speakerIdentificationRules() {
  return '消息里的 QQ 号是稳定身份标识，昵称/群名片随时可能改。判断"是不是同一个人"一律看 QQ 号，不要只看名字。两个人名字相同不等于同一个人。';
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

let cfg = () => ({});
let log = () => {};
let askCapability = () => undefined;

export function setup(api) {
  cfg = api.config;
  log = api.log;
  // 软依赖：owner-identity 装了就用，没装就静默跳过。
  // 为什么不用 manifest.requires —— 那是**硬依赖**，缺了会把本 Skill 判定为不可用，
  // 而"没装主人模块就不能标注发言人"显然不合理。
  askCapability = api.capability || (() => undefined);
}

/** 这个号码是不是主人（没装主人模块时恒为空串）。 */
function ownerMark(userId) {
  const id = String(userId ?? '').trim();
  if (!id || id === 'self') return '';
  try {
    const r = askCapability('message.owner-check', { userId: id });
    return r?.isOwner ? '〔主人〕' : '';
  } catch { return ''; }
}

/** 带主人标注的完整标签：〔主人〕名字(QQ:123)。 */
export function labeledSpeaker(msg, opts = {}) {
  const base = speakerLabel(msg, opts);
  const id = String(msg?.senderId ?? msg?.userId ?? '').trim();
  const mark = ownerMark(id);
  return mark ? `${mark}${base}` : base;
}

/** 能力提供者：核心模块按能力名取用，不 import 本文件。 */
export const providers = {
  'message.speaker-format': ({ message, notes, selfLabel } = {}) =>
    labeledSpeaker(message, { notes, selfLabel }),
  'message.inline-at-normalize': ({ text, members, atUserId } = {}) =>
    normalizeInlineAt(text, { members, atUserId, allowConvert: cfg().normalizeInlineAt !== false })
};

/** 动态提示词片段：只有开启"历史带 QQ 号"时才强调这个规则。 */
export function promptSections() {
  if (cfg().includeInHistory === false) return [];
  return [{
    id: 'speaker-stable-id-dynamic',
    title: '发言人身份',
    priority: 80,
    content: speakerIdentificationRules()
  }];
}

export function available() {
  return { ok: true };
}
