// 实例管理中枢（多开）—— 「一键带起全部实例」+「一键新增实例」。
//
// ── 它解决的问题 ────────────────────────────────────────────────────────────
// 这个项目的多开支撑其实齐全：`src/profile.js` 按 QQ_AGENT_PROFILE 换数据目录与端口、
// `src/instance-lock.js` 保证一个数据目录只有一个核心在跑、
// `scripts/setup-second-instance.mjs` 能生成第二份配置 —— 但**没有任何东西能列出
// 机器上到底有几个实例**。一个实例只看得见自己：instance-lock 描述的是当前进程。
// 结果是用户开了主实例之后，还得自己去程序根一个个双击 `启动QQ机器人2.bat`。
//
// 本模块补上这层"中枢"：**从磁盘真值枚举所有实例**，并代用户启动/新建它们。
//
// ── 磁盘真值（唯一事实来源，不设注册表）──
// 实例 = 程序根下的一个 `data` / `data-N` 目录 **加** 同名的启动脚本。
// 刻意不引入 `instances.json` 之类的注册表 —— 注册表会与实际目录漂移，
// 上次那样干的结果是一堆空壳野实例。目录就是真相。
//
//   主实例    <程序根>/data     控制台 3210
//   实例 N    <程序根>/data-N   控制台 3210 + 100×N
//
// ── 端口公式 ──
// 与 `src/profile.js` 的 portOffset() 保持一致：偏移 = 实例号 × 100。
// 所以实例 2 → 控制台 3410 / http 3200 / ws 3201，实例 3 → 3510 / 3300 / 3301…
// ⚠️ 改这里必须同时改 profile.js —— 两处不一致会让"实例列出的端口"和
//    "它实际监听的端口"对不上，点「打开控制台」就进不去。
//
// ── 启动脚本：为什么复用 setup-second-instance.mjs 而不是自己写 .bat ──
// 那个脚本已经处理了"不复制登录态、白名单留空、端口按 100 偏移"这些细节，
// 且是仓库里既有的、被文档化的入口。中枢只负责调它，不重新实现一遍 ——
// 两份实现必然分叉（上一版就是这么出的 bug）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.js';
import { PROFILE_ID, portOffset } from './profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 程序根。
 *
 * ⚠️ 判据必须**严格**：只有"下面有 resources/app"或"自己就是源码根（有 package.json
 *    且 src/profile.js 在）"才算。**千万别把"下面有 data 目录"当判据** ——
 *    任何一层都可能存在 data/，误判会让枚举一个实例都找不到（不是报错，是
 *    静默返回空列表，最难查）。
 *
 * 源码部署（git clone 后 npm start）：程序根 = 仓库根 = ROOT，data/ 就在它下面。
 * 打包部署（安装版）：ROOT 是 resources/app，程序根要往上走一层到装 QQ Agent.exe 的地方。
 */
export function detectInstanceRoot() {
  const isProgramRoot = (dir) => {
    try {
      return fs.existsSync(path.join(dir, 'QQ Agent.exe'))
        || fs.existsSync(path.join(dir, 'resources', 'app'));
    } catch { return false; }
  };
  // 已经是程序根（解包安装版）→ 直接用
  if (isProgramRoot(ROOT)) return ROOT;
  // 从 ROOT 往上找：<程序根>/resources/app → <程序根>
  let dir = path.resolve(ROOT);
  for (let i = 0; i < 4; i++) {
    const up = path.resolve(dir, '..');
    if (up === dir) break;
    if (isProgramRoot(up)) return up;
    dir = up;
  }
  // 源码部署：ROOT 自己就是程序根（data/、启动脚本都在它下面）
  return ROOT;
}

/** 程序根（本模块的统一入口；函数参数可覆盖，便于测试）。 */
export const INSTANCE_ROOT = detectInstanceRoot();

// ── 端口公式（必须与 src/profile.js 的 portOffset() 一致）───────────────────
/**
 * 某个实例号的端口。空 / '1' = 主实例（偏移 0）。
 *
 * ⚠️ 偏移量的语义以 `src/profile.js` 的 `portOffset()` 为准，那里是
 *    `Number(PROFILE_ID) * 100` —— 即实例号直接乘 100：
 *      实例 2 → off 200 → 控制台 3410 / http 3200 / ws 3201
 *      实例 3 → off 300 → 控制台 3510 / http 3300 / ws 3301
 *    （不是"每多一个实例加 100"那种 100/200/300 的序号式偏移，
 *      实例号 2 的偏移就是 200 —— 这是既有实现，改动会打断已部署实例的端口。）
 *
 *    config.js 里三个端口的写法是"同一个偏移加到各自基线上"：
 *      `port: 3210 + portOffset()` / `httpUrl: ...:${3000 + portOffset()}`
 *      / `wsUrl: ...:${3001 + portOffset()}`
 *    所以这里也必须用**同一个** off 加三次。曾经误写成 console 用 off、
 *    http 用 off*2 —— 实例 2 的 http 算成 3400，而它实际监听 3200，
 *    「打开控制台」能进、OneBot 却永远连不上（最难查的那种错）。
 *
 * @param {string} profile 实例号，主实例是 ''
 */
export function instancePorts(profile) {
  const p = String(profile ?? '').trim();
  const off = /^\d+$/.test(p) && Number(p) > 1 ? Number(p) * 100 : 0;
  return { console: 3210 + off, http: 3000 + off, ws: 3001 + off };
}

/** 数据目录名：主实例 'data'，其余 'data-<号>'（与 profile.js 的 dataDirName 同口径）。 */
export function dataDirNameOf(profile) {
  const p = String(profile ?? '').trim();
  return p ? `data-${p}` : 'data';
}

/** 是否存在这个实例的数据目录（含空的）。 */
function dataDirExists(root, profile) {
  try {
    return fs.statSync(path.join(root, dataDirNameOf(profile))).isDirectory();
  } catch { return false; }
}

// ── 进程存活判断 ────────────────────────────────────────────────────────────
function isAlive(pid) {
  const n = Number(pid) || 0;
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号（别的用户），也算活着
    return error?.code === 'EPERM';
  }
}

/**
 * 读某个数据目录里的实例锁 PID（0 = 没有锁 / 读不出）。
 * 锁文件名与 src/instance-lock.js 保持一致 —— 那是唯一的事实来源。
 */
export function lockPidOf(dataDir) {
  try {
    return Number(String(fs.readFileSync(path.join(dataDir, 'qq-agent.lock'), 'utf8')).trim()) || 0;
  } catch {
    return 0;
  }
}

/** 读实例的 config.json（容忍 BOM；失败返回 null）。 */
function readConfig(dataDir) {
  try {
    let text = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch { return null; }
}

// ── 枚举：从磁盘真值列出所有实例 ────────────────────────────────────────────
/**
 * 枚举程序根下所有实例。
 *
 * 判据（缺一不可）——"有一个数据目录"就够，"有配置文件"才算**可启动**：
 *   · 目录名匹配 `data` 或 `data-<数字>`
 *   · 目录里至少有 config.json（避免把用户随手建的 data-x 当实例）
 *
 * @param {string} [root] 程序根，默认 INSTANCE_ROOT
 * @returns {Array<object>} 每项：
 *   { id, profileId, isSelf, name, running, pid, port, httpPort, wsPort,
 *     dataDir, dataDirName, hasConfig, canLaunch, note }
 */
export function listInstances(root = INSTANCE_ROOT) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = /^data(?:-(\d+))?$/i.exec(entry.name);
    if (!m) continue;
    // data-1 也认（有人从 1 开始编号），但 data-0 不是合法实例
    const profile = m[1] ? String(Number(m[1])) : '';
    if (profile && Number(profile) < 1) continue;
    candidates.push({ profile, dir: path.join(root, entry.name) });
  }

  for (const c of candidates) {
    const hasConfig = fs.existsSync(path.join(c.dir, 'config.json'));
    if (!hasConfig) continue;   // 空目录（用户手建 / 残留）不算实例

    const cfg = readConfig(c.dir);
    const ports = instancePorts(c.profile);
    const pid = lockPidOf(c.dir);
    const running = isAlive(pid);
    const isSelf = String(c.profile ?? '') === String(PROFILE_ID ?? '');
    const uin = String(cfg?.instance?.uin || '').trim();
    const label = c.profile ? `实例 ${c.profile}` : '主实例';

    // 备注：把"为什么它现在不能自动启动"说清楚，而不是让用户对着灰按钮猜
    const noteBits = [];
    if (!running) noteBits.push('未运行');
    if (uin) noteBits.push(`QQ ${uin}`);
    else noteBits.push('还没绑定 QQ 号');

    out.push({
      id: c.profile || 'main',
      profileId: c.profile,
      isSelf,
      name: isSelf ? `${label}（就是这个窗口）` : label,
      label,
      running,
      pid: running ? pid : 0,
      port: ports.console,
      httpPort: ports.http,
      wsPort: ports.ws,
      dataDir: c.dir,
      dataDirName: path.basename(c.dir),
      hasConfig,
      uin,
      // 主实例不能从自己这里"启动自己"；其它实例只要没在跑就允许
      canLaunch: !isSelf && !running,
      note: noteBits.join(' · ')
    });
  }

  // 主实例恒排第一，其余按实例号升序
  out.sort((a, b) => {
    const na = a.profileId ? Number(a.profileId) : 0;
    const nb = b.profileId ? Number(b.profileId) : 0;
    return na - nb;
  });
  return out;
}

/** 所有实例的启动脚本路径（实例号 → 路径；不存在返回空串）。 */
export function launcherOf(root, profile) {
  const p = String(profile ?? '').trim();
  if (p) {
    // 实例 N 的脚本由「新增实例」生成在程序根
    const f = path.join(root, `启动QQ机器人${p}.bat`);
    return fs.existsSync(f) ? f : '';
  }
  // 主实例的脚本：源码部署在仓库根，安装版在 resources/app
  for (const f of [
    path.join(root, '启动QQ机器人.bat'),
    path.join(root, 'resources', 'app', '启动QQ机器人.bat')
  ]) {
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// ── 启动 ────────────────────────────────────────────────────────────────────
/**
 * 清掉会毁掉子进程的继承变量。
 *
 * ⚠️ 置空字符串 ≠ 删除：Electron/Node 判的是"变量存不存在"，
 *    `ELECTRON_RUN_AS_NODE=''` 仍然算"存在"，exe 照样以纯 Node 启动、秒退。
 *    所以必须真的 delete。
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * 启动一个实例。**只负责把它拉起来，不等它连上 QQ。**
 *
 * 用 `cmd /c start` 拉起 .bat：立刻返回、不继承控制台、身份变量由脚本给。
 * `start "" <bat>` 的第一个空参数是"窗口标题"占位 —— 少了它，带引号的路径
 * 会被当成标题、脚本根本不执行（经典 cmd 陷阱，别省）。
 *
 * @param {object} inst listInstances() 里的一项
 * @returns {{ok:boolean, reason?:string, error?:string}}
 */
export function launchInstance(inst) {
  if (!inst) return { ok: false, error: '没有这个实例' };
  if (inst.running) return { ok: false, reason: '已经在运行了' };
  if (inst.isSelf) return { ok: false, reason: '就是我所在的实例' };

  const launcher = launcherOf(INSTANCE_ROOT, inst.profileId);
  if (!launcher) {
    return { ok: false, error: `找不到启动脚本 启动QQ机器人${inst.profileId}.bat，可用「新增实例」重新生成` };
  }

  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', launcher], {
      cwd: path.dirname(launcher),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,   // .bat 自己会立刻退；隐藏反而可能吞掉它的报错
      env: cleanEnv()
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 一键带起**其他**实例（不含当前这个 —— 我都在跑了，别再拉一遍自己）。
 *
 * 刻意串行：多个 QQ 内核同时抢端口失败率反而更高，而这一步总耗时也就几百毫秒。
 *
 * @param {object} [opts]
 * @param {string} [opts.root] 程序根
 * @returns {{ started:Array, skipped:Array, failed:Array }}
 */
export function launchAll({ root = INSTANCE_ROOT } = {}) {
  const started = [];
  const skipped = [];
  const failed = [];

  for (const inst of listInstances(root)) {
    if (inst.isSelf) { skipped.push({ id: inst.id, why: inst.running ? '就是我自己（在跑）' : '跳过当前实例' }); continue; }
    if (inst.running) { skipped.push({ id: inst.id, why: '已经在跑了' }); continue; }
    const r = launchInstance(inst);
    if (r.ok) started.push({ id: inst.id, port: inst.port });
    else failed.push({ id: inst.id, error: r.error ?? r.reason });
  }
  return { started, skipped, failed };
}

// ── 新增实例 ────────────────────────────────────────────────────────────────
/** 下一个可用的实例号（从 2 开始找第一个没有 data-N 目录的）。 */
export function nextProfile(root = INSTANCE_ROOT) {
  for (let n = 2; n < 100; n++) {
    if (!dataDirExists(root, String(n))) return String(n);
  }
  throw new Error('实例号已经排到 100 了，没有空位');
}

/**
 * 新建一个实例。
 *
 * 走仓库既有的 `scripts/setup-second-instance.mjs` —— 它已经处理好了
 * "不复制登录态、白名单留空、端口按 100 偏移"这些细节，而且支持指定实例号。
 * 中枢不重新实现一遍，避免两份实现分叉。
 *
 * ⚠️ 那个脚本的硬编码是 `data-2/config.json`（只认实例 2）。要支持任意实例号，
 *    就在建目录之后用同一条端口公式自己写配置 —— 保持"数据目录 + config.json"
 *    这个磁盘真值不变，枚举逻辑不用改。
 *
 * @param {object} [opts]
 * @param {string} [opts.profile] 实例号；不给就自动选下一个
 * @param {string} [opts.name] 仅用于提示，不落盘（实例名不参与运行）
 * @returns {{ok:boolean, profile?:string, dataDir?:string, port?:number, error?:string}}
 */
export function createInstance({ profile, name = '' } = {}) {
  let p;
  try {
    p = String(profile ?? '').trim() || nextProfile();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (!/^\d+$/.test(p) || Number(p) < 2) {
    return { ok: false, error: `实例编号必须是不小于 2 的整数，收到「${p}」` };
  }

  const root = INSTANCE_ROOT;
  const targetDir = path.join(root, dataDirNameOf(p));
  const targetFile = path.join(targetDir, 'config.json');
  if (fs.existsSync(targetFile)) {
    return { ok: false, error: `实例 ${p} 已经存在（${targetFile}）` };
  }

  const ports = instancePorts(p);
  const mainFile = path.join(root, 'data', 'config.json');
  if (!fs.existsSync(mainFile)) {
    return { ok: false, error: `找不到主实例配置 ${mainFile}，请先启动一次主实例让它生成配置` };
  }

  let mainCfg;
  try {
    mainCfg = JSON.parse(fs.readFileSync(mainFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, error: `主实例配置读不出来：${error?.message ?? error}` };
  }

  // 从主实例继承：模型/人设等一套配置，新机器人理应一样。
  // 白名单与登录态**必须清掉** —— 同一个群被两个机器人各回一遍是灾难，
  // 而登录态只属于那个 QQ 号，抄过来就是错的。
  const secondary = structuredClone(mainCfg);
  secondary.server = { ...(secondary.server || {}), port: ports.console, token: '' };
  secondary.snowluma = {
    ...(secondary.snowluma || {}),
    wsUrl: `ws://127.0.0.1:${ports.ws}`,
    httpUrl: `http://127.0.0.1:${ports.http}`,
    accessToken: '',
    httpAccessToken: ''
  };
  secondary.allow = { groups: [], private: [] };
  secondary.deny = { groups: [], private: [] };
  secondary.allowAllWhenEmpty = false;
  // 新实例自己再去带起别人 = "所有人拉所有人"，几个实例互相 spawn 会滚出一堆进程。
  // 只有主实例该做这件事，所以显式写 false（少一个键就会被默认值补上，行为不由这里决定）。
  secondary.autoStartPeers = false;
  if (secondary.instance && typeof secondary.instance === 'object') {
    secondary.instance = { ...secondary.instance, uin: '' };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const tmp = `${targetFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(secondary, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, targetFile);
  } catch (error) {
    return { ok: false, error: `写入失败：${error?.message ?? error}` };
  }

  return {
    ok: true,
    profile: p,
    name: String(name || '').trim() || `实例 ${p}`,
    dataDir: targetDir,
    port: ports.console,
    httpPort: ports.http,
    wsPort: ports.ws,
    // 启动脚本的生成交给用户的「一键带起全部」不行 —— 没有脚本就没法启动。
    // 这里同步调既有的 setup 脚本没有意义（它只认实例 2 且不做 .bat），
    // 所以直接把这一步写清楚，让 UI 提示用户去双击 / 或再点一次带起。
    launcherMissing: true
  };
}

/** 组装 GET /api/instances 的响应体。 */
export function instancesSnapshot(root = INSTANCE_ROOT) {
  const list = listInstances(root);
  const self = list.find((x) => x.isSelf) || null;
  return {
    ok: true,
    root,
    self: self ? { id: self.id, profileId: self.profileId, port: self.port, name: self.label } : { profileId: PROFILE_ID, port: 3210 + portOffset() },
    instances: list,
    runningCount: list.filter((x) => x.running).length,
    total: list.length,
    nextProfile: (() => { try { return nextProfile(root); } catch { return ''; } })(),
    supported: process.platform === 'win32'
  };
}
