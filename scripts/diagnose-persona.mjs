// 人设 / 记忆体检（只读，绝不修改任何文件）。
//
// 用途：换过人设之后，机器人在某些会话里还在用旧称呼/旧身份时，
// 用它一次性看清"旧名字到底藏在哪"：
//   1) config.persona 里现行的人设字段（activeId / botName / selfNickname / roleText）
//   2) 人设库里每个人设的 id / memoryKey（决定读哪棵记忆树）
//   3) data/memory 下所有记忆文件里命中关键词的条目（含文件路径与字段路径）
//
// 用法：
//   node scripts/diagnose-persona.mjs
//   node scripts/diagnose-persona.mjs 大肥鱼,小鲸鱼,旧名
//
// 关键词默认 大肥鱼,小鲸鱼。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../src/config.js';

const keywords = (process.argv[2] || '大肥鱼,小鲸鱼')
  .split(',').map((s) => s.trim()).filter(Boolean);

const cfg = getConfig();
const persona = cfg.persona || {};
const MEM_ROOT = path.join(DATA_DIR, 'memory');

function hit(text) {
  const s = String(text || '');
  return keywords.find((k) => s.includes(k)) || '';
}

function rel(p) {
  return path.relative(DATA_DIR, p).replace(/\\/g, '/');
}

// ── 1. 当前人设 ──
console.log('='.repeat(64));
console.log('1. 当前生效的人设（config.persona）');
console.log('='.repeat(64));
console.log('数据目录      :', DATA_DIR);
console.log('activeId      :', JSON.stringify(persona.activeId || ''));
console.log('botName       :', JSON.stringify(persona.botName || ''), '  ← 系统提示第一行「你是「…」」');
console.log('selfNickname  :', JSON.stringify(persona.selfNickname || ''), '  ← 群聊【此刻状态】里"你在群里的名字"');
console.log('customRules   :', String(persona.customRules || '').length, '字');
console.log('roleText      :', String(persona.roleText || '').length, '字');
const roleHead = String(persona.roleText || '').split('\n').slice(0, 2).join(' / ');
console.log('roleText 开头 :', roleHead);
for (const [label, val] of [['botName', persona.botName], ['selfNickname', persona.selfNickname],
  ['customRules', persona.customRules], ['roleText', persona.roleText]]) {
  const k = hit(val);
  if (k) console.log(`  ⚠ ${label} 里仍含「${k}」`);
}

// ── 2. 人设库 ──
console.log('');
console.log('='.repeat(64));
console.log('2. 人设库（决定记忆目录 memoryKey）');
console.log('='.repeat(64));
const customs = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
console.log('内置 builtin:xiaojingyu 的 memoryKey 固定为 b_xiaojingyu');
if (!customs.length) console.log('（没有任何自定义人设 —— 说明你是在内置卡上直接改了文本）');
for (const p of customs) {
  const active = p.id === persona.activeId ? '  ← 当前激活' : '';
  console.log(`- ${p.id} | ${p.name} | memoryKey=${p.memoryKey} | ${String(p.text || '').length} 字${active}`);
}

// 推断当前读哪棵记忆树
let activeKey = '';
if (persona.activeId === 'builtin:xiaojingyu') activeKey = 'b_xiaojingyu';
else activeKey = (customs.find((p) => p.id === persona.activeId) || {}).memoryKey || '';
console.log('');
console.log('当前读的记忆目录:', activeKey ? `data/memory/${activeKey}/` : '（无法确定，程序会按角色卡内容自动认领）');

// ── 3/4. 记忆扫描 ──
console.log('');
console.log('='.repeat(64));
console.log(`3. 记忆文件里命中关键词（${keywords.join(' / ')}）的条目`);
console.log('='.repeat(64));

const collect = (obj, prefix, out) => {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (hit(obj)) out.push([prefix, obj]);
    return;
  }
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collect(v, `${prefix}[${i}]`, out));
    return;
  }
  for (const [k, v] of Object.entries(obj)) collect(v, prefix ? `${prefix}.${k}` : k, out);
};

let fileCount = 0;
let hitCount = 0;
const perKey = new Map();

(function walk(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.json')) continue;
    fileCount += 1;
    let obj = null;
    try {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      obj = JSON.parse(raw);
    } catch { continue; }
    const found = [];
    collect(obj, '', found);
    if (!found.length) continue;
    hitCount += found.length;
    const tree = rel(p).split('/')[1] || '?';
    perKey.set(tree, (perKey.get(tree) || 0) + found.length);
    console.log('');
    console.log(`▶ ${rel(p)}`);
    for (const [field, text] of found.slice(0, 12)) {
      console.log(`   · [${field || '(根)'}] ${String(text).slice(0, 160)}`);
    }
    if (found.length > 12) console.log(`   … 另外 ${found.length - 12} 条`);
  }
})(MEM_ROOT);

console.log('');
console.log('='.repeat(64));
console.log('4. 汇总');
console.log('='.repeat(64));
console.log(`扫描 ${fileCount} 个记忆文件，命中 ${hitCount} 条。`);
if (perKey.size) {
  for (const [tree, n] of perKey) console.log(`  data/memory/${tree}/ → ${n} 条`);
} else {
  console.log('  记忆里没有任何旧称呼 —— 那问题不在记忆。');
}

console.log('');
console.log('该怎么读这份报告：');
console.log('  · 第 1 段 botName/selfNickname 命中 → 改 data/config.json 里这两个字段，别删记忆；');
console.log('  · 第 4 段 group_xxxxx/ 命中      → 群聊记忆带旧称呼，清理对应条目的 impressions/facts；');
console.log('  · 第 4 段 _global/ 命中          → 跨群档案/长期事件里带旧称呼，清理 facts/events；');
console.log('  · 一句话都没命中                 → 旧称呼来自聊天记录本身（群友这么叫），');
console.log('                                     只能靠角色卡里写死"禁止自称/被叫要纠正"。');
