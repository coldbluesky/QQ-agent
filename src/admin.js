// 群管理员指令：管理员在群里发「禁言 / 解除」，机器人就地静默或恢复。
//
// 为什么需要它（用户原始需求）：
//   用户希望"像人一样"地被喊停：管理员在群里说一句「禁言」，机器人就闭嘴；
//   说「解除」就恢复正常。区别于群禁言（mutedGroups，控制台开关、整群硬禁），
//   这套是**群内指令式**的，而且禁言期间**被 @ 时仍要回一句固定话术**——
//   不能装死（群友会以为号被踢了）。
//
// 与 mutedGroups 的关系：
//   · 管理员指令禁言 → 写入同一个 mutedGroups（复用"绝不触发运行"的硬闸门），
//     但额外打上 `by: 'admin'` 与 `admin: true` 标记，并带上 manageUntil / 固定话术。
//   · 控制台禁言 → by: 'console'，不带 admin 标记（不触发固定话术）。
//   这样"省 token 的闸门"只有一处，语义差异靠标记区分。
//
// 存储：config.admin = { enabled, admins: { [群号]: 管理员QQ号 }, muteReply: 固定话术 }
//       config.mutedGroups[群号] = { at, until, reason, by, admin }
import { getConfig, updateConfig } from './config.js';

/** 归一化群号 / QQ 号：只接受数字。 */
function normId(id) {
  const s = String(id ?? '').trim();
  return /^\d{1,15}$/.test(s) ? s : '';
}

/** 默认固定话术（管理员没自定义时用）。 */
export const DEFAULT_MUTE_REPLY = '（已禁言，暂时不说话啦，等管理员喊解除～）';

/** 指令词表：宽容一点，允许带标点/语气词，但仍要求"整句就是在下指令"。 */
const MUTE_WORDS = ['禁言', '闭嘴', '别说话', '安静', '静默'];
const UNMUTE_WORDS = ['解除', '解除禁言', '解禁', '解除静默', '可以说话了', '恢复'];

/**
 * 自称/被动标记 —— 出现在指令词附近就说明**是在说自己的状态**，不是在命令。
 *
 *     "我刚才被禁言了"   ← 陈述自己刚被禁言
 *     "我禁言了"         ← 同上
 *     "我这号禁言了"     ← 说明账号状态
 *
 * 判据见 parseAdminCommand 里的 isStatement。只有"禁言"那一侧做这个判定 ——
 * "解除/恢复"没有被动语义，套上去反而会误杀"我这号该解除禁言了"这类正当请求。
 */
const SELF_MARKERS = ['我', '自己', '这号', '这个号', '本号'];
const PASSIVE_MARKERS = ['被', '挨', '遭', '给'];

/**
 * 命令对象词 —— 紧跟在指令词**后面**的这类词，说明是在拿"禁言"当宾语说事：
 *
 *     "这个禁言功能好像没生效"   ← "功能"，在聊功能
 *     "禁言是什么意思"           ← "意思"，在问含义
 *     "禁言没用/不生效/好像没…"   ← 在反馈 bug
 *
 * 真下命令时后面接的是语气词（禁言吧/禁言一下）或句尾，不会是名词。
 */
const TOPIC_FOLLOWERS = ['功能', '意思', '问题', '机制', '系统', '开关', '效果', '权限', '作用'];
/** 表示"这功能不灵"的后续词 —— 是反馈，不是命令。 */
const TOPIC_FOLLOWERS_LOOSE = ['没用', '无效', '不生效', '没生效', '不管用', '不好使', '失效'];
/** 允许出现在指令词**之后**的尾巴（同 tail 的展开，用于"后面有没有杂物"判定）。 */
const TAIL_RE = /^(?:吧|啊|呀|哈|呗|哦|了|一下|下|啦|嘛|点){0,2}$/;

/**
 * "看起来像在叫对象"的前缀。
 *
 * ⚠️ 这里只能放宽到"任何一个汉字"，因为群友喊的对象五花八门：人名、昵称、群名片、
 *    "你们""小丝""两个bot"…。靠词表列举一定漏，漏了就等于"发禁言不生效"。
 *
 * 代价是"我/你/他"这类代词也会被当成称呼。所以放行前先挡一道被动陈述
 * （见 SELF_MARKERS × PASSIVE_MARKERS），挡住"我刚才被禁言了"这种。
 *
 * 例：
 *   「笙丝笙，禁言」   → head="笙丝笙"      ✓ 称呼
 *   「我刚才被禁言了」 → head="我刚才被"     ✗ 我 + 被 → 陈述
 *   「群主说要禁言你」 → head="群主说要"     ✗ 长度 4 > 3
 *   「你说禁言…」     → head="你说"        ✗ 长度 2，后被"意思"挡掉
 *   「我刚刚在别的群看到有人说禁言」→ head 长度 13 > 12 ✗
 */
const MAX_VOCATIVE = 12;      // 最长称呼（"笙丝笙""你们两个bot"都在内）
const MAX_PROSE_HEAD = 3;     // 超过这个长度且含"说话/说/要/看到"这类叙述词 = 一句话

/** 叙述词：出现在前缀里说明这是**一句话**，不是在点名。 */
const PROSE_MARKERS = ['说', '讲', '提', '聊', '问', '看到', '觉得', '认为', '希望', '建议', '讨论'];

/** 空串（光喊指令）或 ≤12 字的称呼。 */
const isVocativeShape = (head) => !!head && head.length <= MAX_VOCATIVE;

/**
 * 前缀是不是"在叙述一件事"（而不是在叫对象）。
 * 只用于 head 比 MAX_PROSE_HEAD 长的情况 —— 短前缀（"笙丝笙""你们""小丝"）
 * 不可能承载叙述，直接放行，免得误伤。
 */
const isProse = (head) => head.length > MAX_PROSE_HEAD
  && PROSE_MARKERS.some((w) => head.includes(w));

/**
 * 指令词附近是不是"在陈述/讨论禁言这件事"。
 * @param {string} s  已去标点的整句
 * @param {number} at 指令词起始下标
 * @param {number} len 指令词长度
 * @param {string} head 指令词之前的那截
 */
function isStatement(s, at, len, head) {
  // ① 被动 + 自称（"我刚才被禁言了"）：自称必须在被动词之前
  for (const p of PASSIVE_MARKERS) {
    const pi = head.lastIndexOf(p);
    if (pi < 0) continue;
    if (SELF_MARKERS.some((m) => head.slice(0, pi).includes(m))) return true;
  }
  // ② 指令词后面跟着名词性话题词（"禁言功能""禁言是什么意思"）
  const after = s.slice(at + len);
  if (TOPIC_FOLLOWERS.some((w) => after.startsWith(w))) return true;
  if (TOPIC_FOLLOWERS_LOOSE.some((w) => after.startsWith(w))) return true;
  // ③ 指令词后面还有尾巴之外的杂物 = 这句话不止"下命令"这一个意图
  if (after && !TAIL_RE.test(after)) return true;
  return false;
}

/**
 * 从一句话里识别是不是"禁言 / 解除"指令。
 *
 * 判定原则：**整句就是在下指令**（不是在讨论/引用禁言这件事），但必须容忍
 * 群友**把对象喊出来**——这是实战里最常见的写法：
 *
 *     萧：笙丝笙，禁言          ← 点了名再下令（真实语料，2026-09-20 日志）
 *     萧：笙丝笙，可以说话了
 *     萧：笙，禁言 / 你们禁言 / 小丝禁言
 *
 * 老实现要求"整句去掉标点后**等于**指令词"（最多再挂两个字语气词），于是
 * 上面几种全被判成普通聊天 → `handleAdminCommand` 不拦 → 消息照常进未读批
 * → 模型把"禁言"当成一句聊天接了下茬（真实日志里回的是"？我刚都没说话"）。
 * 这就是"发完禁言一点都不禁言"的根因。
 *
 * 现在的规则（按顺序）：
 *   ① 带问号 = 在追问/讨论，直接判否（感叹号不判否：真实语料「禁言！！！」是命令）；
 *   ② 去掉 @占位符 / CQ 码 / 空白 / 标点；
 *   ③ 拆出**指令词**与它**前面**那截（称呼/点名），前缀必须是"像在叫人"的一小截
 *      —— 太长、含叙述词、或残留句读，都判否（见 isVocative / isProse）；
 *   ④ 指令词后面不能跟着名词性话题词或多余内容，否则说明在聊这件事而非下命令
 *      （见 isStatement —— 只对"禁言"一侧生效）。
 *
 * @returns {{cmd:'mute'|'unmute'}|null}
 */
export function parseAdminCommand(text) {
  const raw = String(text ?? '');
  const stripped = raw
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\[@[^\]]*\]/g, ' ')
    .replace(/\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件\]|\[卡片消息\]/g, ' ');

  // ── 疑问语气 = 在讨论/追问"禁言"这件事，绝不是在命令 ──
  // ⚠️ 只看问号。**不能**把感叹号一起判掉：真实语料里「禁言！！！」就是
  //    在强调式地下命令（既有 test-admin-mute 明确要求它命中）。
  //    "禁言！" 与 "禁言！！！" 无法从标点区分意图，宁可按命令处理。
  if (/[?？]/.test(stripped)) return null;

  // 去所有空白与常见标点/语气标点
  const s = stripped.replace(/[\s，。！？!?~～、,.：:；;"'“”‘’()（）]/g, '');
  if (!s) return null;

  const tail = /^(?:吧|啊|呀|哈|呗|哦|了|一下|下|啦|嘛|点){0,2}$/;   // 允许的尾巴（最多两段）
  /**
   * 前缀判定：空串（光喊指令）或"像在叫人的一小截"都可以。
   */
  const isVocative = (head) => {
    if (!head) return true;                                  // 「禁言」= 不带对象直接下令
    if (!isVocativeShape(head)) return false;                // 太长，像一整句话
    if (isProse(head)) return false;                         // 含叙述词 = 在讲一件事
    return !/[\s，。！？!?~～、,.：:；;]/.test(head);           // 残留句读 = 不是称呼
  };
  /**
   * 命中判定：`呼叫前缀 + 指令词 + 语气尾巴`，且不在陈述/讨论这件事。
   * 返回命中的指令词起始下标（没命中 = -1），供两套词表按"最靠左的指令词"排序。
   */
  const indexOfCmd = (words, { statementGuard = false } = {}) => {
    for (const w of words) {
      const at = s.indexOf(w);
      if (at < 0) continue;
      const head = s.slice(0, at);
      if (!isVocative(head)) continue;
      if (!tail.test(s.slice(at + w.length))) continue;
      if (statementGuard && isStatement(s, at, w.length, head)) continue;
      return at;
    }
    return -1;
  };

  // ⚠️ 顺序要紧：「解除禁言」既以"解除"开头，也不含"禁言"在句首。必须先判解除，
  //    否则「解除禁言」里的"禁言"会被当成禁言指令（把已经解除的又禁上）。
  // statementGuard 只挂给"禁言"这一侧：解除/恢复没有被动语义，套上去会误杀
  // "我这号该解除禁言了"这类正当请求（见 SELF_MARKERS 的说明）。
  const unmuteAt = indexOfCmd(UNMUTE_WORDS);
  const muteAt = indexOfCmd(MUTE_WORDS, { statementGuard: true });
  if (unmuteAt >= 0 && (muteAt < 0 || unmuteAt <= muteAt)) return { cmd: 'unmute' };
  if (muteAt >= 0) return { cmd: 'mute' };
  // 前面那截不像称呼（比如一句完整的话里夹着"禁言"）→ 不是指令，当普通聊天
  return null;
}

/** 该群设定的管理员 QQ（没设返回空串）。 */
export function adminOf(groupId) {
  const gid = normId(groupId);
  if (!gid) return '';
  const admins = getConfig().admin?.admins || {};
  return normId(admins[gid]) || '';
}

/** 管理员功能是否启用（默认启用）。 */
export function adminEnabled() {
  return getConfig().admin?.enabled !== false;
}

/** 某人是不是该群的管理员（未配置管理员时一律不是）。 */
export function isAdmin(groupId, userId) {
  if (!adminEnabled()) return false;
  const gid = normId(groupId);
  const uid = normId(userId);
  if (!gid || !uid) return false;
  const admins = getConfig().admin?.admins || {};
  if (normId(admins[gid]) === uid) return true;
  // 全局管理员（admins['*']）对所有群生效
  return normId(admins['*']) === uid;
}

/** 禁言期间被 @ 时回复的固定话术。 */
export function muteReplyText() {
  const t = String(getConfig().admin?.muteReply ?? '').trim();
  return t || DEFAULT_MUTE_REPLY;
}

/** 设置/清除某群管理员（userId 为空 = 清除）。groupId 传 '*' = 全局管理员。 */
export function setAdmin(groupId, userId) {
  const rawGid = String(groupId ?? '').trim();
  // '*' 是"全局管理员"约定的键，不是群号；其余必须归一化成数字群号。
  const gid = rawGid === '*' ? '*' : normId(rawGid);
  if (!gid) return { ok: false, error: '群号必须是数字（或 * 表示全局）' };
  const uid = String(userId ?? '').trim();
  const all = { ...(getConfig().admin?.admins || {}) };
  if (!uid) delete all[gid];
  else {
    if (!normId(uid)) return { ok: false, error: 'QQ 号必须是数字' };
    all[gid] = uid;
  }
  // deepMerge 只增不删 → 映射型字段必须整体替换（见 config.js 的 __replace__ 约定）
  updateConfig({ admin: { admins: { __replace__: all } } });
  return { ok: true, groupId: gid, admin: all[gid] || '' };
}

/** 列出所有群管理员。 */
export function listAdmins() {
  const admins = getConfig().admin?.admins || {};
  return Object.entries(admins)
    .map(([groupId, userId]) => ({ groupId, userId: String(userId) }))
    .sort((a, b) => a.groupId.localeCompare(b.groupId));
}
