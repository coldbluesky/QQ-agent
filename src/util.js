// 通用小工具：无业务逻辑。
import fs from 'node:fs';
import * as nodePath from 'node:path';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 带抖动的均匀随机区间。 */
export function randRange([min, max]) {
  return randInt(min, max);
}

export function nowMs() {
  return Date.now();
}

// ── 时间格式化（全部走本地时区，给模型/界面看） ─────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 2026-08-30 21:33:05（周六） */
export function formatFullTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}（${WEEKDAYS[d.getDay()]}）`;
}

/** 08-30 21:33 */
export function formatShortTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 21:33:05 */
export function formatClockTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ── 文本处理 ─────────────────────────────────────────────────────────────

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 防提示注入/泄露：把用户昵称、消息文本里的“指令式方括号标记”弱化，
 * 避免群友伪装成系统段（如【本次唤醒】）骗模型。只处理外观，不改变语义。
 */
export function sanitizeUserText(text) {
  let s = String(text ?? '');
  // 全角化方括号包裹的疑似系统标记：【xxx】→【xxx】保留，但 [xxx] 中含中文关键词的换成（xxx）
  s = s.replace(/\[(本次唤醒|系统|管理员|owner| Owner|OWNER|角色扮演|会话令牌|当前时间)[^\]]*\]/gi, '($1)');
  return s;
}

/** 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/**
 * 把弱模型常见的"对象形态"消息解包回纯文本：
 *   {"text":"..."} / {"content":"..."} / {"message":"..."} → 取第一个字符串值
 *   content-parts（OpenAI 视觉格式 [{type:'text',text:...}]）→ 取 text 段拼接
 *   嵌套数组 → 拍平拼接
 * 返回 null = 解不出来（调用方应报错回模型，而不是把 "[object Object]" 发出去）。
 */
function unwrapMessage(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(unwrapMessage).filter((x) => x !== null).join('\n');
  if (typeof m === 'object') {
    // content-parts：{type:'text', text:'...'} 或 {content:[{type:'text',...}]}
    if (m.type === 'text' && typeof m.text === 'string') return m.text;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    }
    const v = m.text ?? m.content ?? m.message;
    if (typeof v === 'string') return v;
    return null;
  }
  return String(m);
}

/**
 * 把 messages 参数统一成字符串数组。兼容：
 *  - 字符串 / 字符串数组（正常路径）
 *  - JSON 字符串形态的数组、带引号的字符串（老兼容）
 *  - 双重编码的 JSON 对象字符串 "{\"text\":\"...\"}"（弱模型高发）
 *  - 对象 / 对象数组（弱模型高发，逐一解包）
 *  salvage 规则：能解出文本的条目照发；一条都解不出来才抛错 ——
 *  错误会作为工具结果回给模型，它在同一会话里可以自我纠正重发。
 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) value = parsed;
      } catch { /* 保持字符串 */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === 'string') value = unquoted;
    }
  }
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const bad = [];
  for (const m of arr) {
    const unwrapped = unwrapMessage(m);
    if (unwrapped === null) { bad.push(m); continue; }
    const s = String(unwrapped).trim();
    if (s) out.push(s);
  }
  if (!out.length && bad.length) {
    throw new Error(`messages 必须是字符串或字符串数组，收到的是对象形态：${JSON.stringify(bad[0])?.slice(0, 120)}——请把消息文本直接作为字符串传入`);
  }
  return out;
}

/** 简单串行队列：保证发送按顺序、带间隔执行。 */
export function createSendChain() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    const next = chain.then(task, task);
    // 防止单次失败中断整条链
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/** 简易事件总线。 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (error) { console.error(`[bus] ${type} 监听器出错:`, error); }
      }
    }
  };
}

/** 截断长文本（日志/会话记录展示用）。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…(共${s.length}字)`;
}

// ── 发消息前的文本清洗 ────────────────────────────────────────────────────
//
// 这三个是"直接减少群里出现乱码"的小补丁 —— 模型偶尔会：
//   · 在开头多写一段"回复 @某某："（那不是要说的话）
//   · 把内容写成 `["在的"]` 整串发出去（方括号和引号都进了群）
//   · 或者混进一堆 emoji（某些场景要纯文字）
// 放在发送前统一清洗，比在提示词里反复叮嘱可靠。

/**
 * 去掉开头的"回复 @某某："前缀。
 *
 * 模型引用某人说话时，有时会把"回复 @张三："当成正文的一部分写进来，
 * 而真正的引用已经由 replyToMessageId 表达过了 —— 于是群里出现重复的"回复 @"。
 * 只在**开头**匹配，且必须是"回复/@ 目标：内容"这种明确形态，
 * 不会误伤正文里正常出现的 @（那是真的想 @ 人）。
 */
export function stripLeadingReplyPrefix(text) {
  const s = String(text ?? '');
  // 形态：可选"回复"，@某名字（不含空格/冒号），可选"："或"，"，然后是正文
  return s.replace(/^\s*(?:回复|reply)?\s*@[^\s:：,，]{1,24}\s*[:：,，]\s*/i, '').trim();
}

/**
 * 收拾方括号噪音。
 *
 * 现象（实测）：模型想发一条"在的"，却输出成 `["在的"]`，
 * 于是群里收到的字面就是 `["在的"]` —— 用户看到一串符号。
 * 做法：如果**整串**就是一个"方括号包着的单个字符串"，剥掉外壳；
 * 不做更激进的清理（比如删掉句中所有方括号），那会误伤正常内容。
 */
export function tidyBrackets(text) {
  const s = String(text ?? '');
  const m = /^\s*\[\s*(["'“”])([\s\S]*?)\1\s*\]\s*$/.exec(s);
  if (m) return m[2].trim();
  return s;
}

/**
 * 去 emoji（含常见符号与变体选择符）。
 *
 * 用途：需要"纯文字"判定的场景（如关键词匹配、日志展示）。
 * **不要在正常发送路径上用它** —— 那会把用户/模型有意发的表情全删掉。
 */
export function stripEmoji(text) {
  return String(text ?? '')
    // 表情符号区 + 杂项符号 + 装饰符号 + 变体选择符 + 零宽连接符
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 原子写盘（被十余个数据模块共用）─────────────────────────────────────
// 为什么单独抽出来：emotion / intimacy / chess / meme-store / style-learn /
// temp-settings / memory-global 都要往 data/ 下写状态文件。直接 writeFileSync
// 会在写一半时被读到半个文件（进程崩溃、断电、两个实例同时读写）。
// 统一走"写临时文件 + rename 覆盖"，rename 在同一文件系统内是原子的。

/**
 * 把文件系统写错误翻译成"用户能照着做"的提示（其它错误原样返回）。
 *
 * 起因：Windows 上目标文件被 ACL 改成"当前用户只读"、或被别的进程占着时，
 * `renameSync(tmp, file)` 会报 `EPERM: operation not permitted`。
 * 这句原文丢给用户等于没说 —— 他不知道是权限问题，也不知道怎么办。
 */
export function describeFsWriteError(error, file = '') {
  const code = String(error?.code || '');
  if (!['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'EISDIR'].includes(code)) return error;
  const name = file ? nodePath.basename(String(file)) : '数据文件';
  const wrapped = new Error(
    `写入 ${name} 失败（${code}）：该文件被系统锁定，或当前用户没有写权限。`
    + '请用管理员身份运行「修复数据权限」脚本，或把它的所有者改回当前用户后重试。'
  );
  wrapped.code = code;
  wrapped.cause = error;
  return wrapped;
}

let tmpSeq = 0;

/**
 * 原子写文本：先写 `<file>.<pid>.<n>.tmp` 再 rename 覆盖，避免读到半个文件。
 *
 * ⚠️ 三个必须做对的细节（都真实踩过）：
 *   1. **rename 覆盖只读文件会 EPERM**（Windows/Node 实测）：
 *      `writeFileSync(tmp)` 能成功（tmp 是新文件），但 `renameSync(tmp, 目标)`
 *      替换一个带只读属性(+R)的目标时被系统拒绝，报
 *      `EPERM: operation not permitted, rename ...`。
 *      而失败的后果最讨嫌 —— 内存里改好的内容没落盘，用户看到"删了又回来"。
 *      所以这里**先试着把只读位清掉再 rename 一次**（自愈）；只有连 chmod
 *      都做不到（真的是 ACL 只读）才认输。
 *   2. **rename 失败要把 tmp 删掉**。旧写法失败时直接把 tmp 留在原地，
 *      于是 data/ 下越攒越多 `xxx.json.12345.tmp` 垃圾（实测堆了十几个）——
 *      每个都是"某次写盘失败"的证据，但看上去像数据文件损坏。
 *   3. **失败要抛人话**，见 describeFsWriteError。
 *
 * @param {string} file 目标文件绝对路径
 * @param {string} text 写完的内容
 */
export function writeTextAtomic(file, text) {
  tmpSeq = (tmpSeq + 1) % 1e6;
  const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
      // 目标带只读属性时 rename 被拒：清掉只读位再试一次（文件所有权还在，通常能成功）
      let healed = false;
      try {
        const mode = fs.statSync(file).mode;
        fs.chmodSync(file, mode | 0o200);
        healed = true;
      } catch { /* 连 stat/chmod 都不行，说明是真的没权限，往下抛人话 */ }
      if (healed) fs.renameSync(tmp, file);
      else throw error;
    }
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw describeFsWriteError(error, file);
  }
}

/** 原子写 JSON（写盘格式统一走这里，便于以后换序列化方式）。 */
export function writeJsonAtomic(file, value, indent = 1) {
  writeTextAtomic(file, JSON.stringify(value, null, indent));
}
