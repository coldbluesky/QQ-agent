// zip 上传安装的落盘行为测试。
//
// 起因（真实部署）：`/opt/qq-agent` 由 root 创建、机器人以普通用户运行，界面里只显示
//   `上传失败：解压安装失败：EACCES: permission denied, mkdir '/opt/qq-agent/plugins/sillytavern-cards'`
// —— 用户既不知道是谁没权限，也不知道该改哪里；更糟的是"解压到一半失败"会在 skills/ 里
// 留一个半成品目录（热重载 watcher 还会把半截代码当成一次变更加载进来）。
//
// 这里断言的就是这两件事：装前先判可写、报错能照着做、失败不留任何残留。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-zip-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { unzipToModuleDir } = await import('../src/zip-install.js');
const { loadPlugins, unloadSkill } = await import('../src/plugin-loader.js');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}

/** 最小 zip 构造（stored，不压缩）：只为走通安装解析，不追求压缩率。 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.text, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);              // method = 0（stored）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    chunks.push(local, data);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10);                // method = 0
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const manifest = (id) => JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, enabledByDefault: false }, null, 2);

// ── 1. 正常安装：剥包内根目录、落地目录名、嵌套内容逐字节一致、不留临时目录 ──
const root = fs.mkdtempSync(path.join(TMP, 'app-'));
const zip = makeZip([
  { name: 'sillytavern-cards/plugin.json', text: manifest('sillytavern-cards') },
  { name: 'sillytavern-cards/index.js', text: 'export function setup() {}\n' },
  { name: 'sillytavern-cards/lib/a.js', text: 'export const a = 1;\n' }
]);
{
  const name = await unzipToModuleDir(zip, { root, type: 'plugin', preferId: 'sillytavern-cards' });
  ok(name === 'sillytavern-cards', `按包内根目录名落地：${name}`);
  const dir = path.join(root, 'plugins', 'sillytavern-cards');
  ok(fs.existsSync(path.join(dir, 'plugin.json')), '清单落在 plugins/<id>/ 下');
  ok(fs.readFileSync(path.join(dir, 'lib', 'a.js'), 'utf8') === 'export const a = 1;\n', '嵌套目录与内容逐字节一致');
  ok(fs.readdirSync(path.join(root, 'plugins')).every((n) => !n.startsWith('.install-')),
    '安装成功后不留临时目录（改名是原子的，没有中间态）');
}

// ── 2. 重名 → 自动加后缀（覆盖会把用户的改动写没）──
{
  const name2 = await unzipToModuleDir(zip, { root, type: 'plugin', preferId: 'sillytavern-cards' });
  ok(name2 === 'sillytavern-cards_1', `重名自动加 _1 后缀：${name2}`);
}

// ── 3. 中途失败（包内"把文件当目录用"）→ 不留半成品、也不留临时目录 ──
{
  const badRoot = fs.mkdtempSync(path.join(TMP, 'app-bad-'));
  const bad = makeZip([
    { name: 'broken/plugin.json', text: manifest('broken') },
    { name: 'broken/sub', text: '这不是目录，是文件' },
    { name: 'broken/sub/a.js', text: 'export const a = 1;\n' }   // 把 sub 当目录用 → 解压中途报错
  ]);
  await assert.rejects(() => unzipToModuleDir(bad, { root: badRoot, type: 'plugin' }), () => true);
  const pluginsDir = path.join(badRoot, 'plugins');
  ok(!fs.existsSync(path.join(pluginsDir, 'broken')), '失败后不留半成品目录（加载器不会读到半截代码）');
  ok(fs.readdirSync(pluginsDir).length === 0, `失败后 plugins/ 完全干净（临时目录也清掉了）：${fs.readdirSync(pluginsDir).join(',') || '空'}`);
}

// ── 4. 目录不可写 → 装之前就报错，且报错能照着做（Windows / root 下构造不出只读目录，跳过）──
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const roRoot = fs.mkdtempSync(path.join(TMP, 'app-ro-'));
  const roPlugins = path.join(roRoot, 'plugins');
  fs.mkdirSync(roPlugins);
  fs.chmodSync(roPlugins, 0o500);            // r-x：能进不能写
  try {
    await assert.rejects(
      () => unzipToModuleDir(zip, { root: roRoot, type: 'plugin' }),
      (error) => {
        ok(/不可写/.test(error.message), `权限错误翻成了人话：${error.message.slice(0, 48)}…`);
        ok(/chown|管理员/.test(error.message), '给出可照抄的处置办法（chown / 管理员身份）');
        ok(error.message.includes(roPlugins), '报错里带着不可写的具体目录');
        return true;
      }
    );
    ok(fs.readdirSync(roPlugins).length === 0, '预检失败时**没有开始解压**（目录里什么也没留下）');
  } finally {
    fs.chmodSync(roPlugins, 0o700);
  }
} else {
  console.log('  · 跳过权限用例（Windows 或 root 运行，构造不出不可写目录）');
}

// ── 5. 安装临时目录（.install-*）不会被加载器当成模块（进程被 kill 的残留也不该报错）──
{
  const loadRoot = fs.mkdtempSync(path.join(TMP, 'loadroot-'));
  const pluginsDir = path.join(loadRoot, 'plugins');
  const skillsDir = path.join(loadRoot, 'skills');
  // 造一个"看起来完全合法"的插件放进隐藏目录：真被扫到就会加载成功/失败各留一条，
  // 所以两种结果都要断言 —— 只看 loaded 的话，被扫到但加载失败也会让测试通过。
  const put = (dirName, id) => {
    fs.mkdirSync(path.join(pluginsDir, dirName), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, dirName, 'plugin.json'), manifest(id));
    fs.writeFileSync(path.join(pluginsDir, dirName, 'index.js'), 'export function setup() {}\n');
  };
  put('.install-tmp-x-999-abc', 'install-tmp-x');
  put('real-one', 'real-one');
  fs.mkdirSync(skillsDir, { recursive: true });

  const res = await loadPlugins({ log: () => {}, roots: { plugins: pluginsDir, skills: skillsDir } });
  const ids = res.loaded.map((s) => s.id);
  const failedIds = res.failed.map((f) => f.id);
  ok(!ids.includes('install-tmp-x') && !failedIds.includes('install-tmp-x'),
    `隐藏的临时目录完全没被扫到：loaded=${ids.join(',') || '（无）'} failed=${failedIds.join(',') || '（无）'}`);
  ok(ids.includes('real-one'), '同一个根下的正常插件照常加载');
  unloadSkill('real-one');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✓ zip 上传安装全部通过（${passed} 项断言）`);
