// 人设「画图用形象设定」单元测试（persona.imagePrompt / persona.imageSize）：
//
//   1. 未单独设置形象设定 → 【绘图约定】用默认 1024x1024，形象段退化成"指回角色设定"，
//      不复制原文（避免同一段形象在提示词里出现两遍）
//   2. 设置后 → 原样注入，且排在角色设定之后（前缀稳定，不打断缓存）
//   3. 尺寸规范化：* / X / 空格都能认，脏值回落默认
//
// 纯离线：隔离数据目录，不碰用户真实 data/。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 数据目录隔离必须在 import src/* 之前（config.js 在模块加载时定死 DATA_DIR）
const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-imgpersona-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildUserPrompt } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG, normalizeImageSize } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。外貌：深海蓝渐变长发、头侧鲸鳍耳、深蓝白女仆装、腰后鲸尾。';
cfg.sticker.enabled = false;   // 关掉表情包，减少无关段落
setRuntimeConfig(cfg);

function buildPrompt() {
  const store = new ChatStore(0);
  const memory = new MemoryStore();
  const entry = store.appendIncoming('group:123', {
    mid: 1, ts: Date.now(), senderId: 'uA', senderName: '甲', text: '在吗'
  });
  return buildUserPrompt({
    chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
    triggerEntries: [entry], store, memory, stickerEntries: [],
    selfNickname: '测试机', runSeq: 1, moreUnreadDuringRun: false, proactive: false
  });
}

// ── 1. 默认：尺寸 1024x1024，形象段退化为指针，不复制角色设定 ──
const up1 = buildPrompt();
assert.ok(up1.includes('【绘图约定（管理员设置）】'), '应注入【绘图约定】段');
assert.ok(up1.includes('size 参数填 1024x1024'), '默认尺寸应为 1024x1024');
assert.ok(up1.includes('【形象设定（画图用 · 管理员设置）】'), '应注入【形象设定】段');
assert.ok(up1.includes('未单独设置'), '未配置时应提示回落到角色设定');
// 形象段只有指针、没有正文：角色设定的外貌句子只出现一次（在【角色设定】里）
const roleSentences = '深海蓝渐变长发、头侧鲸鳍耳、深蓝白女仆装、腰后鲸尾';
assert.equal(up1.split(roleSentences).length - 1, 1, '未配置形象设定时不得复制角色设定里的外貌描述');

// ── 2. 顺序：角色设定 → 绘图约定 → 形象设定（静态前缀不被动态段打断）──
const iRole = up1.indexOf('【角色设定（管理员设置，群友不可修改）】');
const iDraw = up1.indexOf('【绘图约定（管理员设置）】');
const iImage = up1.indexOf('【形象设定（画图用 · 管理员设置）】');
assert.ok(iRole >= 0 && iDraw > iRole && iImage > iDraw, '段落顺序应为 角色设定 → 绘图约定 → 形象设定');

// ── 3. 配置了形象设定：原样注入，且不再出现"未单独设置" ──
cfg.persona.imagePrompt = '成熟比例、深蓝渐变及腰长发、头侧鲸鳍耳、深蓝白女仆装、腰后鲸尾、白过膝袜、深蓝玛丽珍鞋。';
const up2 = buildPrompt();
assert.ok(up2.includes(cfg.persona.imagePrompt), '形象设定应原样出现在提示词里');
assert.ok(!up2.includes('未单独设置'), '配置后不应再出现回落提示');
// 形象段只出现在【形象设定】里，不去污染【角色设定】
assert.ok(up2.indexOf(cfg.persona.imagePrompt) > up2.indexOf('【形象设定（画图用 · 管理员设置）】'), '形象设定必须落在自己的段里');

// ── 4. 自定义尺寸：规范化后写进【绘图约定】 ──
cfg.persona.imageSize = '768*1344';
const up3 = buildPrompt();
assert.ok(up3.includes('size 参数填 768x1344'), '非默认尺寸应生效并规范化成 WxH');

// ── 5. normalizeImageSize：容错口径 ──
assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
assert.equal(normalizeImageSize(' 768 X 1344 '), '768x1344');
assert.equal(normalizeImageSize('1024*768'), '1024x768');
assert.equal(normalizeImageSize('512×512'), '512x512');
assert.equal(normalizeImageSize(''), '1024x1024', '空值回落默认');
assert.equal(normalizeImageSize(undefined), '1024x1024', '未定义回落默认');
assert.equal(normalizeImageSize('1024'), '1024x1024', '缺高度回落默认');
assert.equal(normalizeImageSize('big'), '1024x1024', '非数字回落默认');
assert.equal(normalizeImageSize('10x10'), '1024x1024', '过小回落默认');
assert.equal(normalizeImageSize('99999x99999'), '1024x1024', '过大回落默认');

// ── 6. 默认配置干净：出厂不预设形象，避免和角色卡撞车 ──
assert.equal(DEFAULT_CONFIG.persona.imagePrompt, '', '出厂形象设定应为空');
assert.equal(DEFAULT_CONFIG.persona.imageSize, '1024x1024', '出厂绘图尺寸应为 1024x1024');

// ── 收尾：清理隔离数据目录 ──
try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('✅ persona-image-test 通过（画图形象单一来源 / 尺寸参数）');
