// 角色蒸馏：把"一堆原始语料"变成一张能直接当人设用的角色卡。
//
// 两种来源：
//   chats —— 从几个已有会话里抽取某个人（默认机器人自己）的发言，汇总蒸馏；
//   text  —— 导入现成的角色对话文本（游戏文案、小说对话、剧本、聊天导出）。
//
// 设计原则：
//   * 只依据给定材料，不脑补。材料不够就让模型在 warnings 里明说，而不是编一个角色出来。
//   * 产出的卡片格式与内置角色卡（personas.js / roles/*.md）保持一致，
//     因为它会被整段塞进系统提示的【角色设定】里。
//   * 卡片必须"适配本程序的机制"：分条用 send_message 数组、不用括号写内心戏等，
//     否则蒸馏出来的角色会跟平台打架（这是内置卡片里踩过的坑）。
import { memoryChat, extractJsonObject } from './memory-llm.js';

/** 平台机制说明：固定拼在提示里，保证生成的角色卡不与程序机制冲突。 */
const PLATFORM_NOTES = [
  '【本程序的机制，卡片必须与之兼容】',
  '- 你的普通文本输出不会发到 QQ，只有调用 send_message 才会。想分多条发就传数组，每个元素一条。',
  '- 绝对不要用空格假装分条，也不要用括号写"（不说话）"这类内心戏；不想说话就直接安静结束本轮。',
  '- 可用工具：get_recent_messages / get_active_members / send_message / send_poke / web_search / memory_append / memory_search 等。',
  '- 场景是 QQ 群聊为主、私聊为辅：打字感、口语、碎片句、少标点、不写小作文。'
].join('\n');

const CARD_SCHEMA = [
  '# 角色卡：<角色名>',
  '',
  '## 一、你是谁',
  '（身份、背景、自我认知；别人怎么称呼你；你的雷点是什么）',
  '',
  '## 二、说话方式',
  '（句子长度、标点习惯、口头禅/语气词、称呼别人的方式、表情与语气助词的使用频率）',
  '',
  '## 三、性格与反应模式',
  '（被夸时、被怼时、被质疑身份时、被冷落时分别怎么反应）',
  '',
  '## 四、节奏与消息习惯',
  '（一句话一条还是成段；会不会连发；没话说时会怎样）',
  '',
  '## 五、禁忌与边界',
  '（绝不会说的话、绝不会做的事）',
  '',
  '## 六、示例台词',
  '- （从材料里摘录 5~10 条最能代表这个角色的原话，保留原始语气）'
].join('\n');

/** 从聊天记录里抽取样本行。speaker='self' 取机器人自己的发言，否则取指定 QQ 号。 */
export function collectChatSamples(store, { chatKeys = [], speaker = 'self', maxLines = 400, perChat = 200 } = {}) {
  const keys = (Array.isArray(chatKeys) ? chatKeys : [chatKeys])
    .map((k) => String(k || '').trim())
    .filter((k) => /^(group|private):\d+$/.test(k));
  const lines = [];
  const used = {};
  for (const chatKey of keys) {
    let msgs = [];
    try { msgs = store.recent(chatKey, { limit: 2000 }) || []; } catch { msgs = []; }
    const picked = [];
    for (const m of msgs) {
      if (!m || !m.text) continue;
      const isSelf = !!m.self;
      const want = speaker === 'self' ? isSelf : (!isSelf && String(m.senderId) === String(speaker));
      if (!want) continue;
      const text = String(m.text).trim();
      // 跳过纯图片/表情/拍一拍这类没有语言信息的行
      if (!text || /^\[(图片|表情|视频|语音|拍一拍|转发|文件|音乐)/.test(text)) continue;
      picked.push(text.slice(0, 200));
    }
    const tail = picked.slice(-perChat);
    used[chatKey] = tail.length;
    for (const t of tail) lines.push(t);
  }
  const out = lines.slice(-maxLines);
  return { lines: out, count: out.length, perChatCount: used, chats: keys };
}

/** 从导入的文本里抽取样本行（容忍 "名字：内容" / "名字: 内容" / 纯行）。 */
export function collectTextSamples(text, { maxLines = 600, speaker = '' } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const line of raw) {
    const t = line.trim();
    if (!t) continue;
    // 明显是元信息/时间戳的行丢掉
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t) && t.length < 30) continue;
    if (/^[-=*_#]{3,}$/.test(t)) continue;
    lines.push(t.slice(0, 300));
  }
  let out = lines;
  if (speaker) {
    const re = new RegExp(`^\\s*${speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`);
    const filtered = lines.filter((l) => re.test(l)).map((l) => l.replace(re, ''));
    // 认得出说话人（至少 3 句）就只留他的台词：蒸馏别人时，
    // 把对手戏的台词混进去会把语气带跑偏。
    if (filtered.length >= 3) out = filtered;
  }
  out = out.slice(-maxLines);
  return { lines: out, count: out.length };
}

/**
 * 卡片标题兜底。
 *
 * 材料里没有自称/他称时，模型会把标题留成占位 —— 而且用词每次都不同
 * （实测见过"未命名""无名氏""未具名"），靠占位词表枚举永远追不上。
 * 所以这里用确定性规则：
 *   - 标题里的名字**确实出现在材料里** → 那是模型从原文认出来的真名，保留；
 *   - 其它情况（占位词、或与用户填的名字不一致）→ 用用户填的人设名。
 *
 * 单独导出是为了能脱离模型做单测：远端模型的行为不可控，但这条规则必须可控。
 */
export function applyTitleName(card, name, lines = []) {
  const src = String(card ?? '');
  const userNamed = String(name ?? '').trim().slice(0, 60);
  if (!userNamed || !src) return src;
  const titleName = (src.split('\n')[0] || '')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^角色卡\s*[:：]?\s*/, '')
    .trim();
  if (titleName.includes(userNamed)) return src;
  const fromMaterial = titleName.length >= 1
    && (Array.isArray(lines) ? lines : []).some((l) => String(l).includes(titleName));
  if (fromMaterial) return src;
  return src.replace(/^#.*$/m, `# 角色卡：${userNamed}`);
}

/**
 * 蒸馏：把样本交给模型，产出一张角色卡草稿。
 * @returns {Promise<object>} { name, summary, card, styleTags, catchphrases, samples, confidence, warnings, sampleCount, source }
 */
export async function distillPersona({ source = 'text', samples = [], hint = '', name = '', speakerLabel = '' } = {}) {
  const lines = (Array.isArray(samples) ? samples : []).filter(Boolean);
  if (lines.length < 5) {
    throw new Error(`样本太少（只有 ${lines.length} 条有内容的发言），至少需要 5 条才谈得上蒸馏`);
  }
  const sourceDesc = source === 'chats'
    ? '这是某个 QQ 会话里某个人的真实发言记录（一行一条，没有编号）。'
    : '这是从外部导入的角色对话文本（一行一条，可能带"角色名："前缀，也可能只是纯文本）。';

  const user = [
    sourceDesc,
    speakerLabel ? `要蒸馏的对象：${speakerLabel}。` : '',
    hint ? `用户额外说明（优先满足）：${hint}` : '',
    '',
    '请把这些材料蒸馏成一份可以直接当"QQ 群友角色卡"用的设定。要求：',
    '1. 只能依据材料里真实出现过的语言特征；不要脑补身份、背景、剧情。',
    '2. 说话方式要具体到可执行：句子多长、爱用什么标点、有哪些口头禅、怎么称呼别人。',
    '3. 示例台词必须从材料里原样摘录，不要改写、不要自己编。',
    '4. 材料不足以判断的维度，就在 warnings 里说明"样本不足，未能判断 X"，不要硬写。',
    '5. card 字段是一整张 Markdown 角色卡，严格按下面的骨架写（标题层级与章节名保持一致）：',
    '',
    CARD_SCHEMA,
    '',
    PLATFORM_NOTES,
    '',
    '输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：',
    '{"name":"角色名(2~8字)","summary":"一句话概括","card":"# 角色卡：…（完整 Markdown，用 \\n 换行）","styleTags":["短句","爱用问号"],"catchphrases":["口头禅"],"samples":["原文摘录"],"confidence":0.8,"warnings":["…"]}',
    '',
    `材料共 ${lines.length} 条：`,
    '----- 材料开始 -----',
    ...lines,
    '----- 材料结束 -----'
  ].filter((x) => x !== '').join('\n');

  const res = await memoryChat([
    {
      role: 'system',
      content: '你是角色蒸馏器：从给定的语料里提炼出一个可扮演角色的说话方式与性格，产出结构化的角色卡。你只做归纳与摘录，绝不虚构。输出严格 JSON。'
    },
    { role: 'user', content: user }
  ]);

  const parsed = extractJsonObject(String(res?.message?.content ?? ''));
  if (!parsed) throw new Error('模型返回无法解析为 JSON，蒸馏失败（可重试或换模型）');

  const cut = (s, n) => String(s ?? '').trim().slice(0, n);
  const list = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => cut(x, len)).filter(Boolean).slice(0, n);

  let card = cut(parsed.card, 20000);
  if (!card || card.length < 80) throw new Error('模型没有产出有效的角色卡内容，蒸馏失败');
  card = applyTitleName(card, name, lines);

  return {
    source,
    name: cut(name || parsed.name || '蒸馏人设', 60),
    summary: cut(parsed.summary, 200),
    card,
    styleTags: list(parsed.styleTags, 12, 20),
    catchphrases: list(parsed.catchphrases, 15, 40),
    samples: list(parsed.samples, 15, 200),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    warnings: list(parsed.warnings, 8, 200),
    sampleCount: lines.length
  };
}
