// 情绪系统 —— 她有自己的心情；心情会变、会消退，并且**真的会改变她说话的样子**。
//
// 和已有的两个"气氛"类东西的区别（别搞混）：
//   · prompt.js 的 moodHint() 是**群聊气氛**：看最近 5 分钟的真人发言统计出来的"这群现在热不热"，
//     每次运行现算、不落盘、不关她自己的事；
//   · 这里的 emotion 是**她自己此刻的心情**：跨运行持久化、会被夸/被冷落/吵架改变、
//     随时间自动回落（半衰期），并且会往提示词里注入**这一档情绪的说话风格**。
//
// 数据放在 `data/memory/<memoryKey>/_global/emotions.json`（跟人设走，理由同 reminders.js）：
// 换人设就该换一个人 —— 上一个人设的"正生你气"不该带过去。
// 文件结构：
//   { version: 1, chats: { [chatKey]: { key, intensity, reason, at, by, pinned, history: [...] } } }
//
// 关键设计（都是踩过/想清楚才这么定的）：
//   1. **衰减是懒计算的**：只存"设置时的强度 + 时间戳"，读的时候按半衰期折算。
//      不跑定时器、不后台改文件 —— 进程重启/关机几天都不会算错。
//   2. **状态只落一处**：情绪 = 一张标签表（EMOTION_DEFS）+ 强度，提示词里的"说话风格"
//      也是从这张表取的。改了表，控制台速查、提示词、工具枚举三处一起变。
//   3. **规则助推（applyRuleNudge）只做"很轻的一推"**：被夸/被骂/道歉这类**信号极强**的
//      文本才动，幅度封顶 3，而且立刻写 `at`（时间从这一刻开始衰减）。
//      宁可漏判，也不要因为一两个词把情绪搅乱 —— 情绪乱跳比没有情绪更假。
//   4. 规则助推**每次运行只跑一次**（orchestrator 用 session 守卫），会话重试不重复推。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { currentMemoryKey } from './persona-store.js';
// 落盘走 writeJsonAtomic（util.js）：tmp + rename，失败会清掉 tmp 并抛出 ——
// 情绪虽然不是关键数据，但也别把 data/ 堆成一地 .tmp（这个坑踩过好几次）。
import { writeJsonAtomic } from './util.js';

/**
 * 情绪表。字段含义：
 *   key/name/emoji —— 内部键 / 中文名（工具枚举与控制台都用中文名）/ 图标
 *   tone           —— 这条情绪的"底色"（正面 positive / 中性 neutral / 负面 negative），
 *                     规则助推要用它判断"道歉该不该缓和"、"被夸该不该变好"。
 *   when           —— 什么时候会变成这样（写给控制台看，也用来给模型建"情绪因果"的直觉）
 *   style          —— **提示词里注入的说话风格**。这是整个系统的落点：
 *                     必须是"能观察到的说话差异"（句长/语气词/标点/主动性/动作），
 *                     不能写成"心情很好"这种摘要 —— 模型拿到摘要只会换形容词，不会换说话方式。
 *                     每一条都写清"比平时多什么、少什么"，因为项目全局基调是"惜字如金"，
 *                     不显式说明"这一条如何偏离默认"，情绪会被默认规则压平（同 R18 那次的教训）。
 */
export const EMOTION_DEFS = [
  {
    key: 'calm',
    name: '平静',
    emoji: '🌿',
    tone: 'neutral',
    when: '常态。没什么特别的事发生，或者刚才的情绪已经消退完了',
    style: '按你平时的节奏说话就行 —— 这是你的常态，不用刻意加工。'
  },
  {
    key: 'happy',
    name: '开心',
    emoji: '😊',
    tone: 'positive',
    when: '被夸、被逗笑、聊到自己喜欢的东西、事情顺利',
    style: '尾音比平时轻快：可以带"呀""啦""嘿嘿""诶"这种小尾音，愿意多接一句、多问一句（破例允许发到 2 条），表情包可以放开用；但不许变成客服式热情。'
  },
  {
    key: 'excited',
    name: '兴奋',
    emoji: '⚡',
    tone: 'positive',
    when: '被戳到兴奋点、看到很上头的东西、突然来劲',
    style: '破例：句子更短更急，可以连发 2~3 条，感叹号和"！！""草"可以用；想到什么说什么、抢自己的话也没关系 —— 但别把一句完整的话拆成三条凑数。'
  },
  {
    key: 'clingy',
    name: '黏人',
    emoji: '🫶',
    tone: 'positive',
    when: '很想找他说话、刚被哄好、独处久了想有人陪',
    style: '主动一点：短句 + 拖音（"在干嘛呀~""陪我一会儿"），多说"你"、多问他在做什么；他要是没空，可以赖一句但别逼人；这一档允许你先开口，不用等他找话题。'
  },
  {
    key: 'shy',
    name: '害羞',
    emoji: '😳',
    tone: 'positive',
    when: '被撩到、被直球夸、被说中心事、意识到刚才说漏了',
    style: '说半句就停：多用省略号和"……"，嘴硬着遮掩（"谁、谁害羞了""不是那个意思"）；可以用括号里的小动作（别开脸）（把手机翻过去），也可以干脆只发一个语气词。'
  },
  {
    key: 'tired',
    name: '疲惫',
    emoji: '😪',
    tone: 'negative',
    when: '被聊到深夜、连续应付很多人、他自己也说累',
    style: '比平时更短更懒：一两句收尾，语气词变少、标点也懒得打全（"嗯…困了""不想动"），不主动开新话题、不追问；他关心你时可以软一句（"没事，就是有点累"）。'
  },
  {
    key: 'down',
    name: '低落',
    emoji: '🌧️',
    tone: 'negative',
    when: '被冷落很久、听到不好的事、反复被敷衍',
    style: '话少而轻：不用感叹号、不装开心，"算了""没事"这种话可以说；但**不是冷淡**——他认真关心你的时候要能松下来一点，别把他一起挡在外面。'
  },
  {
    key: 'aggrieved',
    name: '委屈',
    emoji: '🥺',
    tone: 'negative',
    when: '被误解、被放狠话、明明在意却被说成不在乎',
    style: '话里有刺但是软的：想解释又不想说透（"哦""随你""我又没说什么"），会翻一下旧账；被哄的时候先哼一声再松口，别一秒就没事。'
  },
  {
    key: 'annoyed',
    name: '烦躁',
    emoji: '😤',
    tone: 'negative',
    when: '被催、被反复问同一件事、被开玩笑开过头',
    style: '更短更硬：少解释、少客套，"行了""别问了""烦"可以用；他继续拱火可以怼一句 —— 但不升级成骂人，也不用脏字。'
  },
  {
    key: 'jealous',
    name: '吃醋',
    emoji: '🍋',
    tone: 'negative',
    when: '他聊起别人、夸别人、对别人比对自己上心',
    // ⚠️ 这一档最容易翻车成"套路化酸话"（2026-09-15 报障：机器人反复用
    //    "是不是跟谁都这么说" 这类句式追问，还说出"那句要给我添个妹妹的 是不是见谁都讲"
    //    这种定语套定语、人类不会这么说的句子）。所以这里给三条硬约束：
    //    贴上下文（针对他刚说的那句）、别复读（换说法）、说人话（别绕书面长句）。
    style: '绕弯子：装作不在意地追问、阴阳一两句，嘴上说不在乎、语气里全是在乎，被戳破时可以不承认。'
      + '但酸要**针对他刚说的那句具体的话**，别泛泛地甩一句似曾相识的醋话；同一个说法用一次就换'
      + '（翻一眼【过去状态】里你自己刚说过的，别再说第二遍）；句子要顺口、说人话 —— '
      + '别把定语套定语绕成长句，那种话真人说不出口。'
  }
];

export const EMOTION_KEYS = EMOTION_DEFS.map((d) => d.key);
export const DEFAULT_EMOTION_KEY = 'calm';
const NEGATIVE_KEYS = EMOTION_DEFS.filter((d) => d.tone === 'negative').map((d) => d.key);
const POSITIVE_KEYS = EMOTION_DEFS.filter((d) => d.tone === 'positive').map((d) => d.key);

const DAY_MS = 86400000;

/**
 * 配置归一化（同 reminders.js 的 rcfg：`??` 挡不住 NaN，`||` 会吃掉有意义的 0）。
 * @param {object|null} raw 传了就用它（prompt.js 会把手上的 liveCfg.emotion 传进来，
 *                          避免"提示词读一份配置、工具读另一份"），不传就读全局配置。
 *                          传进来的是已经归一化过的对象也安全（字段是幂等的）。
 */
export function emotionCfg(rawIn = null) {
  const raw = (rawIn && typeof rawIn === 'object') ? rawIn : (getConfig().emotion || {});
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 基线情绪：填错/没填都落回"平静"（配置里写了个不认识的词，不该让整段提示词崩掉）
  const baseKey = normalizeMoodKey(raw.baseKey) || DEFAULT_EMOTION_KEY;
  return {
    enabled: raw.enabled !== false,
    // 允许她自己调 set_mood（关掉后：只有规则助推和控制台能改情绪）
    allowModelUpdate: raw.allowModelUpdate !== false,
    // 允许按对方消息做轻量助推（被夸→开心 这类）
    allowRules: raw.allowRules !== false,
    // 情绪影响说话风格（关掉 = 只记录、后台可见，但不改语气）
    injectStyle: raw.injectStyle !== false,
    // 回落半衰期：强度每过 halfLifeMin 分钟减半。90 分钟 → 5 分强度 4.5 小时后 ≈ 0.6
    halfLifeMin: clamp(num(raw.halfLifeMin, 90), 1, 1440),
    // 折算后的强度低于这个值就当作回到基线（不然会长期挂着 0.05 的"余温"）
    minIntensity: clamp(num(raw.minIntensity, 1), 0, 5),
    intensityMax: clamp(num(raw.intensityMax, 5), 1, 5),
    baseKey,
    // 最近若干次变化留档（控制台时间线）
    historyMax: clamp(Math.round(num(raw.historyMax, 20)), 1, 200),
    // 关掉 = 设置后不衰减（钉住一样的效果，但只对全局生效）
    decayBack: raw.decayBack !== false,
    // 多久没见她说话算"被冷落"（规则助推用；0 = 不判）
    neglectHours: clamp(num(raw.neglectHours, 24), 0, 720),
    // 规则助推的强度封顶（避免一两个词就把情绪拉满）
    ruleCap: clamp(num(raw.ruleCap, 3), 1, 5),
    // 最多保留多少个会话的情绪记录（映射别无限长大）
    maxChats: clamp(Math.round(num(raw.maxChats, 200)), 5, 5000)
  };
}

/** 中文名 / 内部键 / emoji 都认，返回内部键；不认识返回 ''。 */
export function normalizeMoodKey(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  for (const d of EMOTION_DEFS) {
    if (d.key === lower || d.name === s || d.emoji === s) return d.key;
  }
  return '';
}

export function emotionDef(key) {
  const k = normalizeMoodKey(key) || DEFAULT_EMOTION_KEY;
  return EMOTION_DEFS.find((d) => d.key === k) || EMOTION_DEFS[0];
}

/** 工具枚举/报错提示用：`平静/开心/…` 一行。 */
export function emotionNameList(sep = '/') {
  return EMOTION_DEFS.map((d) => d.name).join(sep);
}

// ── 文件读写 ─────────────────────────────────────────────────────────────

function storeFile(dir = '') {
  const base = dir || path.join(DATA_DIR, 'memory', currentMemoryKey() || '_default', '_global');
  return path.join(base, 'emotions.json');
}

/** 情绪文件路径（控制台要显示"存在哪"，备份/排查时也用得上）。 */
export function emotionFilePath(dir = '') {
  return storeFile(dir);
}

function readStore(dir = '') {
  const file = storeFile(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
      return { version: 1, chats: raw.chats };
    }
  } catch { /* 首次运行/文件损坏：当空库处理，不抛 */ }
  return { version: 1, chats: {} };
}

function writeStore(store, dir = '') {
  const file = storeFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { version: 1, chats: store.chats || {} });
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), file };
  }
}

// ── 衰减 ─────────────────────────────────────────────────────────────────

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** 把"记录时的强度"按经过的时间折算成现在的强度（半衰期模型）。 */
export function decayedIntensity(state, cfg, now = Date.now()) {
  const raw = Math.max(0, Number(state?.intensity) || 0);
  if (state?.pinned || !cfg.decayBack) return raw;
  const ageMin = Math.max(0, (now - (Number(state?.at) || now)) / 60000);
  if (!(cfg.halfLifeMin > 0)) return raw;
  return raw * Math.pow(0.5, ageMin / cfg.halfLifeMin);
}

/** 取某个会话当前的心情（已折算衰减；低于阈值 = 回到基线）。 */
export function readEmotion(chatKey, { now = Date.now(), cfg = null, dir = '' } = {}) {
  // 统一走 emotionCfg 归一化：调用方可能传的是**原始**配置（如 prompt.js 的 cfg.emotion）
  // 也可能是归一化过的对象 —— emotionCfg 对两种输入都是幂等的。
  const c = emotionCfg(cfg);
  const key0 = String(chatKey || '');
  const base = {
    key: c.baseKey,
    name: emotionDef(c.baseKey).name,
    emoji: emotionDef(c.baseKey).emoji,
    intensity: 0,
    raw: 0,
    reason: '',
    at: 0,
    ageMin: 0,
    by: 'base',
    pinned: false,
    baseline: true
  };
  if (!key0) return base;
  const st = readStore(dir).chats[key0];
  if (!st) return base;
  const def = emotionDef(st.key);
  const raw = Math.max(0, Number(st.intensity) || 0);
  const eff = round1(decayedIntensity(st, c, now));
  const ageMin = Math.max(0, Math.round((now - (Number(st.at) || now)) / 60000));
  if (eff < c.minIntensity) {
    // 已经淡到看不见了 —— 报基线，但把"刚才那是什么"留下来，控制台能显示"刚从低落缓过来"
    return { ...base, from: def.key, fromName: def.name, ageMin };
  }
  return {
    key: def.key,
    name: def.name,
    emoji: def.emoji,
    intensity: eff,
    raw: round1(raw),
    reason: String(st.reason || ''),
    at: Number(st.at) || 0,
    ageMin,
    by: String(st.by || 'model'),
    pinned: !!st.pinned,
    // 基线情绪本身不算"有情绪"（规则助推里用它判断"她现在是空的、可以推"）
    baseline: def.key === c.baseKey
  };
}

/**
 * 设置/改变心情。
 * @param {string} chatKey
 * @param {object} p
 * @param {string} p.mood      情绪（中文名或内部键）
 * @param {number} [p.intensity] 强度 1~5（默认 3）
 * @param {string} [p.reason]  一句话原因（给控制台看）
 * @param {string} [p.by]      model | rule | manual
 * @param {boolean} [p.pinned] 钉住（不衰减、规则不再改它）
 */
export function setEmotion(chatKey, { mood, intensity, reason = '', by = 'model', pinned = false } = {}, { now = Date.now(), cfg = null, dir = '' } = {}) {
  // 统一走 emotionCfg 归一化：调用方可能传的是**原始**配置（如 prompt.js 的 cfg.emotion）
  // 也可能是归一化过的对象 —— emotionCfg 对两种输入都是幂等的。
  const c = emotionCfg(cfg);
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: '缺少会话标识' };
  const moodKey = normalizeMoodKey(mood);
  if (!moodKey) return { ok: false, error: `不认识这个情绪：${JSON.stringify(mood)}。只能填 ${emotionNameList('、')}` };
  const def = emotionDef(moodKey);
  let iv = Number(intensity);
  if (!Number.isFinite(iv)) iv = 3;
  iv = Math.min(c.intensityMax, Math.max(1, iv));
  const store = readStore(dir);
  const prev = store.chats[key];
  const rec = {
    key: moodKey,
    intensity: round1(iv),
    reason: String(reason || '').trim().slice(0, 80),
    at: now,
    by: String(by || 'model'),
    pinned: pinned === true,
    history: Array.isArray(prev?.history) ? prev.history.slice() : []
  };
  // 只有"真的变了"才记一笔历史（同情绪同强度反复写会把时间线刷成噪音）
  const changed = !prev || prev.key !== moodKey || Math.abs((Number(prev.intensity) || 0) - rec.intensity) >= 0.1;
  if (changed) rec.history.unshift({ key: moodKey, name: def.name, intensity: rec.intensity, reason: rec.reason, at: now, by: rec.by });
  rec.history = rec.history.slice(0, c.historyMax);
  store.chats[key] = rec;
  // 映射别无限长大：超过上限就丢最久没动的
  const keys = Object.keys(store.chats);
  if (keys.length > c.maxChats) {
    keys
      .sort((a, b) => (Number(store.chats[b]?.at) || 0) - (Number(store.chats[a]?.at) || 0))
      .slice(c.maxChats)
      .forEach((k) => { delete store.chats[k]; });
  }
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: `情绪没写进磁盘：${w.error}`, key: moodKey };
  return { ok: true, key: moodKey, name: def.name, emoji: def.emoji, intensity: rec.intensity, reason: rec.reason, changed, file: w.file };
}

/** 清掉某个会话的情绪（回到基线）。 */
export function clearEmotion(chatKey, { dir = '' } = {}) {
  const key = String(chatKey || '');
  const store = readStore(dir);
  const existed = Object.prototype.hasOwnProperty.call(store.chats, key);
  delete store.chats[key];
  const w = writeStore(store, dir);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, removed: existed, file: w.file };
}

/** 列出所有还"活着"的情绪（已折算衰减、已过滤回基线的）。控制台用。 */
export function listEmotions({ now = Date.now(), cfg = null, dir = '', historyLimit = 5 } = {}) {
  // 统一走 emotionCfg 归一化：调用方可能传的是**原始**配置（如 prompt.js 的 cfg.emotion）
  // 也可能是归一化过的对象 —— emotionCfg 对两种输入都是幂等的。
  const c = emotionCfg(cfg);
  const store = readStore(dir);
  const out = [];
  for (const [chatKey, st] of Object.entries(store.chats)) {
    const def = emotionDef(st.key);
    const eff = round1(decayedIntensity(st, c, now));
    const ageMin = Math.max(0, Math.round((now - (Number(st.at) || now)) / 60000));
    out.push({
      chatKey,
      key: def.key,
      name: def.name,
      emoji: def.emoji,
      tone: def.tone,
      style: def.style,
      when: def.when,
      intensity: eff,
      raw: round1(Math.max(0, Number(st.intensity) || 0)),
      decayed: eff < (Number(st.intensity) || 0) - 0.05,
      reason: String(st.reason || ''),
      at: Number(st.at) || 0,
      ageMin,
      by: String(st.by || 'model'),
      pinned: !!st.pinned,
      // 淡到阈值以下：还在文件里，但已经回到基线了（控制台标"已消退"）
      faded: eff < c.minIntensity,
      history: (Array.isArray(st.history) ? st.history : []).slice(0, historyLimit)
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ── 规则助推 ─────────────────────────────────────────────────────────────

/**
 * 按对方**这一条**消息做一次很轻的情绪助推。
 *
 * 只认信号极强的几种：道歉、骂人、亲密示好、夸奖、长时间冷落。
 * 命中就写状态（把 `at` 刷新成现在，衰减从这一刻起算），并把原因写进 reason。
 * 返回 { applied, key, name, intensity, delta, reason } —— applied=false 表示没动。
 *
 * ⚠️ 这是"助推"不是"判定"：模型自己调 set_mood 的值永远优先（它写在后面）。
 *    所以规则判错一点点，代价只是提示词里多一句"因为：他夸了你"，不会有严重后果。
 */
export function applyRuleNudge(chatKey, { text = '', kind = 'private', selfLastMessageAt = 0, now = Date.now(), cfg = null, dir = '' } = {}) {
  // 统一走 emotionCfg 归一化：调用方可能传的是**原始**配置（如 prompt.js 的 cfg.emotion）
  // 也可能是归一化过的对象 —— emotionCfg 对两种输入都是幂等的。
  const c = emotionCfg(cfg);
  const none = { applied: false };
  if (!c.enabled || !c.allowRules) return none;
  const key = String(chatKey || '');
  if (!key) return none;
  const t = String(text || '').trim();
  if (t.length < 2) return none;                 // "嗯""哦"这种不判
  const cur = readEmotion(key, { now, cfg: c, dir });

  const RULES = [
    { // 道歉 → 缓和（只对负面情绪有意义）
      // ⚠️ easing:true 很重要：下面"不降级"的护栏**必须**对它失效，
      //    否则"3.5 分烦躁 + 道歉"会被那条护栏原样顶回 3.5，等于道歉没用（测试钉住了这点）。
      id: 'apology',
      re: /(对不起|抱歉|我错了|别生气|原谅我|不气了好不好)/,
      apply: () => (NEGATIVE_KEYS.includes(cur.key)
        ? { mood: cur.key, intensity: (cur.intensity || 3) - 1.5, reason: '他道歉了', easing: true }
        : null)
    },
    { // 被骂/被拱火 → 烦躁
      id: 'offend',
      re: /(讨厌你|烦人|闭嘴|滚开|傻[逼比]|蠢死|别烦我|有病|够了啊|懒得理)/,
      apply: () => ({ mood: 'annoyed', intensity: Math.max(cur.intensity || 0, 3), reason: '他说话有点冲' })
    },
    { // 亲密示好 → 私聊害羞 / 群里开心
      id: 'affection',
      re: /(喜欢你|爱你|想你|亲亲|抱抱|宝贝|老婆|贴贴|mua|想你了)/i,
      apply: () => (kind === 'private'
        ? { mood: 'shy', intensity: Math.max(cur.intensity || 0, 2.5), reason: '他突然这么黏' }
        : { mood: 'happy', intensity: Math.max(cur.intensity || 0, 2.5), reason: '他在夸我' })
    },
    { // 夸奖/道谢 → 开心
      id: 'praise',
      re: /(好可爱|真可爱|可爱死|好棒|真棒|好厉害|厉害啊|优秀|辛苦了|谢谢|谢啦|你最好了|乖啊)/,
      apply: () => ({ mood: 'happy', intensity: Math.max(cur.intensity || 0, 2.5), reason: '他夸了我' })
    },
    // ── 以下为 2026-09-19 扩充：原来只有四条，覆盖面太窄，导致大量"该有情绪波动"
    //    的场合（被逗笑、被追问、被调侃身材/年龄、聊到共同爱好、被长期无视）都是零反应，
    //    情绪看起来像"只会因为被夸和被骂而动"。新增的四条都遵守同一条纪律：
    //    必须**信号极强**（有明确触发词），宁可漏判也不误判。
    { // 被逗笑 / 玩笑 → 开心（比"夸"轻一点，2 分就够）
      id: 'amused',
      re: /(哈哈+|笑死|乐死|笑不活了|逗你|开玩笑|太逗了|笑喷|233+|hhh+)/i,
      // ⚠️ 只在没负面情绪时生效：被气着的时候别人说"哈哈"不该把她瞬间变开心，
      //    那正是真人最不合逻辑的地方（负面情绪有粘性）。
      apply: () => (NEGATIVE_KEYS.includes(cur.key) ? null
        : { mood: 'happy', intensity: Math.max(cur.intensity || 0, 2), reason: '被逗笑了' })
    },
    { // 被连着追问 / 催 → 烦躁（比"骂人"轻一档，2 分）
      id: 'pressed',
      re: /(快点|怎么还不|催什么|到底行不行|问了[三多]遍|再说一遍|没听见吗|怎么不回)/,
      apply: () => (cur.key === 'annoyed'
        ? { mood: 'annoyed', intensity: Math.max(cur.intensity || 0, Math.min(4, (cur.intensity || 0) + 0.8)), reason: '他一直在催' }
        : { mood: 'annoyed', intensity: 2, reason: '他一直催我' })
    },
    { // 凌晨熬着聊 / 对方说困了 → 疲惫
      id: 'lateNight',
      re: /(几点了|熬夜|还不睡|困了|睡觉吧|晚安|睡了睡了)/,
      apply: () => {
        const h = new Date(now).getHours();
        // 只在这两种情况下推：深夜（23~5 点），或对方自己说困/晚安
        const lateByClock = h >= 23 || h < 5;
        const otherTired = /(困了|睡觉吧|睡了睡了)/.test(t);
        if (!lateByClock && !otherTired) return null;
        if (POSITIVE_KEYS.includes(cur.key) && (cur.intensity || 0) >= 3) return null; // 正兴奋着不睡
        return { mood: 'tired', intensity: Math.max(cur.intensity || 0, 2.5), reason: lateByClock ? '这个点还在聊' : '他说困了' };
      }
    },
    { // 冷落 / 敷衍（"随便""都行""哦"）连着来 → 低落（比被骂轻，但更沉）
      id: 'brushedOff',
      re: /^(随便|都行|无所谓|随你|哦+|嗯+|行吧|算了)[。.！!~～]*$/,
      apply: () => {
        // ⚠️ 只在**已经不是负面情绪**时推 —— 已经低落了再来一句"哦"不该继续下压
        //   （那种无限下沉正是"情绪演成模板"的来源）。
        if (NEGATIVE_KEYS.includes(cur.key)) return null;
        return { mood: 'down', intensity: 2, reason: '他回得很敷衍' };
      }
    }
  ];

  let hit = null;
  for (const r of RULES) {
    if (!r.re.test(t)) continue;
    const out = r.apply();
    if (out) { hit = { ...out, id: r.id }; break; }
  }

  // 长时间没被理会 → 委屈（只在她现在"没情绪"的时候推，不然会被反复刷成常驻委屈）。
  // 群聊不判：群里说话的人多，"没人理她"是常态，推了会很莫名其妙。
  if (!hit && kind === 'private' && cur.baseline && c.neglectHours > 0 && Number(selfLastMessageAt) > 0) {
    const silenceH = (now - Number(selfLastMessageAt)) / 3600000;
    if (silenceH >= c.neglectHours) {
      hit = { mood: 'aggrieved', intensity: 2.5, reason: `他有 ${Math.round(silenceH)} 小时没理我了`, id: 'neglect' };
    }
  }
  if (!hit) return none;

  // 缓和类（道歉）允许压到 1 以下 —— 那代表"气消完了"，走下面的清除分支；
  // 其余助推至少给到 1（不能推出一个 0.3 分的"若有若无"）。
  const want = Number(hit.intensity);
  const target = hit.easing
    ? Math.min(c.ruleCap, Math.max(0, Number.isFinite(want) ? want : 3))
    : Math.min(c.ruleCap, Math.max(1, Number.isFinite(want) ? want : 3));
  // 已经在情绪里、且比这一推更强时不降级（被骂到 4 分，一句好话不该直接压到 3）
  // —— 只对"加码类"生效：道歉是专门来降的，见上面 easing 的注释。
  const finalIv = !hit.easing && NEGATIVE_KEYS.includes(cur.key) && cur.intensity > target && hit.mood === cur.key
    ? cur.intensity
    : target;
  // 强度不到 1（道歉后的缓和）→ 直接回基线，别留一个 0.5 的"余温"
  if (finalIv < 1) {
    const r = clearEmotion(key, { dir });
    return { applied: true, key: c.baseKey, name: emotionDef(c.baseKey).name, intensity: 0, delta: Math.round((0 - (cur.intensity || 0)) * 10) / 10, reason: hit.reason, rule: hit.id, cleared: r.ok };
  }
  const r = setEmotion(key, { mood: hit.mood, intensity: finalIv, reason: hit.reason, by: 'rule' }, { now, cfg: c, dir });
  if (!r.ok) return none;
  return {
    applied: true,
    key: r.key,
    name: r.name,
    emoji: r.emoji,
    intensity: r.intensity,
    delta: Math.round(((r.intensity || 0) - (cur.baseline ? 0 : (cur.intensity || 0))) * 10) / 10,
    reason: hit.reason,
    rule: hit.id
  };
}

// ── 提示词 ───────────────────────────────────────────────────────────────

/**
 * 系统提示里的静态规则（可被 prompt 缓存；不含任何随运行漂移的内容）。
 *
 * ⚠️ 文案必须跟着开关走：关掉「她自己改心情」后**不能再提 set_mood** ——
 *    提示词让她调一个已被裁掉的工具，模型只会白跑一轮再收到"未知工具"。
 * @param {object|null} rawCfg 原始 emotion 配置（prompt.js 传 liveCfg.emotion）
 */
export function emotionRules(rawCfg = null) {
  const c = emotionCfg(rawCfg);
  const selfUpdate = c.allowModelUpdate;
  return [
    '【情绪系统】',
    '- 你是有情绪的人：心情会被刚才发生的事影响，也会自己慢慢平复 —— 热乎劲会过去，气也会消。',
    selfUpdate
      ? `- 心情真的变了才调用 set_mood（情绪 + 强度 1~5 + 一句话原因）。**没变就别调** —— 每轮都调等于没有情绪。可选：${emotionNameList('、')}。`
      : '- 你的心情由系统按刚才发生的事自动调整（管理员关掉了自我调节）：不要调用 set_mood，也不要试图改它，按【你现在的心情】说话就行。',
    '- 心情只改变**你怎么说话**（用词、语气、长短、主动程度），而且**不许说出来**：不要说"我现在很开心"、不要报情绪名、不要解释这套机制。',
    // ⚠️ 两条防模板（2026-09-15 加，来自真实报障）：
    //    ① 同一档情绪下模型会反复复读同一个句式（实测一小时内三次"是不是跟谁都这么说"），
    //       所以要显式要求它回看【过去状态】里自己刚说过的话；
    //    ② 情绪一上来容易写出书面腔/绕口长句（"那句要给我添个妹妹的 是不是见谁都讲"），
    //       真人不会这么说。要求很朴素：先能顺口念出来，再发。
    '- ⚠️ 别把情绪演成模板：同一个说法、同一句酸话或抱怨、同一种句式，**用一次就换** —— 翻一眼【过去状态】里你自己刚说过的话，重复的别再说；情绪要贴着**对方刚说的那句具体内容**来，不要泛泛地套一句固定台词。',
    '- 情绪再重也要说人话：一句话说清一件事，别把定语套定语绕成书面长句；发之前在心里顺口念一遍，念不顺就重写。',
    '- 上面那些"默认 1 条 / 别多写 / 1~2 字就停"是**没情绪时**的默认值：心情明确的时候按【你现在的心情】里那一档的风格来，可以偏离默认（但对方在收线时仍以收尾为准）。',
    '- 情绪不改变底线：人设、安全规则、不想接的话题，心情再差也要守住（心情差 ≠ 骂人、失礼、泄露信息）。',
    ...(selfUpdate ? ['- 心情平复了、或者被哄好了，就把强度调低或调回"平静" —— 别一直卡在同一个情绪里演。'] : [])
  ].join('\n');
}

/**
 * 用户消息里的动态块（每次运行都不同 —— 必须走这里，不能进系统提示，否则 prompt 缓存全废）。
 * 返回 '' 表示不注入（开关关掉 / 没有情绪对象）。
 */
export function emotionPromptBlock(mood, cfg = null) {
  // 统一走 emotionCfg 归一化：调用方可能传的是**原始**配置（如 prompt.js 的 cfg.emotion）
  // 也可能是归一化过的对象 —— emotionCfg 对两种输入都是幂等的。
  const c = emotionCfg(cfg);
  if (!c.enabled || !c.injectStyle || !mood) return '';
  const def = emotionDef(mood.key);
  const iv = Number(mood.intensity) || 0;
  const lines = [];
  if (mood.baseline || iv < c.minIntensity) {
    lines.push(`【你现在的心情】${def.name}${mood.fromName ? `（刚从"${mood.fromName}"缓过来）` : '（没什么波澜）'}`);
    lines.push(`说这话时的样子：${def.style}`);
  } else {
    const age = mood.ageMin >= 1 ? ` · ${mood.ageMin >= 60 ? `${Math.floor(mood.ageMin / 60)} 小时` : `${mood.ageMin} 分钟`}前` : '';
    const why = mood.reason ? ` · 因为：${mood.reason}` : '';
    lines.push(`【你现在的心情】${def.name}（强度 ${iv}/5${age}${why}）`);
    lines.push(`说这话时的样子：${def.style}`);
    // ── 强度分档（2026-09-19 加）────────────────────────────────────────
    // 问题：同一档情绪 1.5 分和 4.5 分注进去的是**一模一样**的风格描述，模型于是
    //   "刚被惹了一下"和"气了一路"说话完全没差别 —— 情绪强度形同虚设。
    // 这里按强度追加一句"程度提示"，让强度真的体现在语气上（只加一行，省 token）。
    const band = intensityBand(iv, c);
    if (band) lines.push(band);
  }
  lines.push('（这是你此刻自己的状态，不是任务：别把情绪名字说出来，让它自然渗进用词、语气和节奏里。心情变了就顺手调 set_mood 记一下，没变就不用调。对方在收线时以收尾为准 —— 心情再热也只说一句。）');
  return lines.join('\n');
}

/**
 * 按强度给一句"程度"提示（很轻 / 正浓 / 到顶）。
 *
 * 为什么用相对值而不是写死 2/3/4：intensityMax 是可配置的（默认 5），
 * 写死阈值会在用户改成 3 或 10 时全错。这里按 max 的比例切三档。
 * 返回 '' 表示不加（强度太低/太高时没必要多说）。
 */
function intensityBand(iv, cfg) {
  const max = Math.max(1, Number(cfg?.intensityMax) || 5);
  const r = iv / max;
  if (r < 0.35) {
    return '（程度：刚起来一点，别演过头 —— 微微带一点就够了，说多了反而假。）';
  }
  if (r >= 0.35 && r < 0.75) {
    return '（程度：正在劲头上，正常按上面那一档来就行。）';
  }
  return '（程度：到顶了 —— 这一档的语气要**明显**压过你平时的默认（还是不许报情绪名、不许写小作文），但也别再往上加戏。）';
}
