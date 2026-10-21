// 自建文生图（image-gen）纯函数单测：
//   - 尺寸规范化（容错口径 / 越界回落）
//   - 请求体构造（可选字段不发，避免中转站 400）
//   - 响应解析（b64_json / url 两种都认）
//   - prompt 拼接（self=true 时形象由代码垫在前面，模型只补镜头）
//   - 出厂配置齐全（漏了字段会让设置页读 undefined 崩掉）
//
// 不联网：只测纯函数，真实出图由设置页「测试出图」验证。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 数据目录隔离必须在 import src/* 之前（config.js 加载时就定死 DATA_DIR）
const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-imagegen-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const {
  DEFAULT_IMAGE_SIZE,
  normalizeImageSize,
  composeImagePrompt,
  buildImageRequestBody,
  extractImagePayloads
} = await import('../src/image-gen.js');
const { DEFAULT_CONFIG } = await import('../src/config.js');

// ── 1. 尺寸规范化：能认的写法都要认 ──
assert.equal(normalizeImageSize('1024x1024'), '1024x1024');
assert.equal(normalizeImageSize(' 768 X 1344 '), '768x1344', '大写 X + 空格');
assert.equal(normalizeImageSize('1024*768'), '1024x768', '* 当分隔符');
assert.equal(normalizeImageSize('512×512'), '512x512', '全角 ×');

// 脏值一律回落默认，不做"猜测式修正"（配置里允许存脏值，手改 JSON 不能炸）
assert.equal(normalizeImageSize(''), DEFAULT_IMAGE_SIZE);
assert.equal(normalizeImageSize(undefined), DEFAULT_IMAGE_SIZE);
assert.equal(normalizeImageSize('1024'), DEFAULT_IMAGE_SIZE, '缺高度');
assert.equal(normalizeImageSize('big'), DEFAULT_IMAGE_SIZE, '非数字');
assert.equal(normalizeImageSize('10x10'), DEFAULT_IMAGE_SIZE, '过小');
assert.equal(normalizeImageSize('99999x99999'), DEFAULT_IMAGE_SIZE, '过大');

// ── 2. 请求体：可选字段留空就不发 ──
const minimal = buildImageRequestBody({ model: 'gpt-image-1', prompt: '海边', size: '768*1344' });
assert.deepEqual(minimal, { model: 'gpt-image-1', prompt: '海边', size: '768x1344', n: 1 });
assert.ok(!('quality' in minimal) && !('style' in minimal) && !('response_format' in minimal), '可选字段不应出现');

const full = buildImageRequestBody({
  model: 'm', prompt: 'p', size: '1024x1024', count: 3, quality: 'high', style: 'vivid', responseFormat: 'b64_json'
});
assert.equal(full.n, 3);
assert.equal(full.quality, 'high');
assert.equal(full.style, 'vivid');
assert.equal(full.response_format, 'b64_json');

// 张数钳在 1~4：多数接口超过 4 直接 400
assert.equal(buildImageRequestBody({ model: 'm', prompt: 'p', count: 99 }).n, 4);
assert.equal(buildImageRequestBody({ model: 'm', prompt: 'p', count: 0 }).n, 1);

// ── 3. 响应解析：b64_json 与 url 两种都要认，坏数据跳过 ──
const payloads = extractImagePayloads({
  data: [{ b64_json: 'AAA' }, { url: 'https://cdn.example.com/a.png' }, { nothing: 1 }]
});
assert.equal(payloads.length, 2);
assert.equal(payloads[0].b64, 'AAA');
assert.equal(payloads[1].url, 'https://cdn.example.com/a.png');
assert.deepEqual(extractImagePayloads({}), [], '没有 data 时返回空数组');
assert.deepEqual(extractImagePayloads({ data: [] }), []);

// ── 4. prompt 拼接：这是"角色不走形"的关键，顺序不能变 ──
const char = '深海蓝渐变及腰长发、头侧鲸鳍耳、深蓝白女仆装、腰后鲸尾。';
const composed = composeImagePrompt({ prompt: '手机自拍视角，海边房间', self: true, characterPrompt: char });
assert.ok(composed.startsWith(char), '外貌必须垫在前面（生图模型对前置描述权重更高）');
assert.ok(composed.endsWith('手机自拍视角，海边房间'), '镜头描述在后面');
// self=false 或没有形象设定时原样返回 —— 画别人不该掺入自己的外貌
assert.equal(composeImagePrompt({ prompt: '一只猫', self: false, characterPrompt: char }), '一只猫');
assert.equal(composeImagePrompt({ prompt: '一只猫', self: true, characterPrompt: '' }), '一只猫');
assert.equal(composeImagePrompt({ prompt: '  一只猫  ', self: false, characterPrompt: char }), '一只猫', '首尾空白要清掉');

// ── 5. 出厂配置：字段一个都不能少（设置页直接读这些键）──
const g = DEFAULT_CONFIG.imageGen;
for (const key of ['enabled', 'provider', 'baseUrl', 'apiKey', 'model', 'size', 'count', 'quality', 'style', 'responseFormat', 'timeoutMs', 'keepFiles', 'characterPrompt']) {
  assert.ok(g && Object.prototype.hasOwnProperty.call(g, key), `imageGen.${key} 缺失`);
}
assert.equal(g.enabled, false, '出厂默认关闭');
assert.equal(g.size, '1024x1024');
assert.equal(g.characterPrompt, '', '出厂不预设形象，避免和角色卡撞车');

try { fs.rmSync(__testDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log('✅ image-gen-test 通过（尺寸规范化 / 请求体 / 响应解析 / 形象拼接）');
