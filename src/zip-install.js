// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;

/** 安装中途用的临时目录前缀：解压完再原子改名，见 unzipToModuleDir。 */
const TMP_PREFIX = '.install-';

/** 当前进程的运行身份（报错里要说清"是谁没权限"）。 */
function runnerName() {
  return process.env.USER || process.env.USERNAME || (typeof process.getuid === 'function' ? `uid=${process.getuid()}` : '当前用户');
}

/**
 * 把 fs 的裸 errno 翻成"用户能照着做"的话。
 *
 * 起因（真实部署）：`/opt/qq-agent` 由 root 创建、机器人以普通用户跑，界面只显示
 * `解压安装失败：EACCES: permission denied, mkdir '/opt/qq-agent/plugins/xxx'` ——
 * 用户既不知道是谁没权限、也不知道该改哪里。这里把「运行身份 + 目录 + 可照抄的命令」
 * 直接写进报错（含 systemd / 容器两种最常见的成因）。
 */
function explainFsError(error, target) {
  const code = String(error?.code || '');
  if (!code) return error;
  const dir = path.dirname(String(target));
  const parent = path.dirname(dir);       // 一般是程序根（/opt/qq-agent）
  const user = runnerName();
  const posix = process.platform !== 'win32';
  if (code === 'EACCES' || code === 'EPERM') {
    const how = posix
      ? `把目录交给运行用户：sudo chown -R ${user} ${parent}（或 sudo chmod -R u+w ${parent}）；`
        + `若用 systemd 且开了 ProtectSystem/ReadOnlyPaths，还要补 ReadWritePaths=${parent}；`
        + `容器部署请确认 ${parent} 不是 :ro 挂载`
      : `以管理员身份启动，或把程序目录换到当前用户可写的位置（程序根：${parent}）`;
    return new Error(
      `${dir} 不可写 —— 机器人以「${user}」运行，${code}。`
      + `上传安装需要在 skills/ 与 plugins/ 下建目录：${how}。`
    );
  }
  if (code === 'EROFS') {
    return new Error(`${parent} 所在文件系统是只读挂载（EROFS）：容器去掉 :ro，或改挂可写卷。`);
  }
  if (code === 'ENOSPC') {
    return new Error(`磁盘空间不足（ENOSPC）：写入 ${target} 时失败，请先清理磁盘。`);
  }
  return error;
}

/**
 * 装之前先确认"这个目录能不能写"：不能写就**别开始解压**。
 *
 * 为什么不让它自然失败：mkdirSync 抛的是裸 EACCES（见 explainFsError 的起因），
 * 而且半途失败会在 skills/ 里留一个加载不起来的半成品目录 —— 插件目录还被热重载
 * watcher 盯着，半截代码会被当成一次"重载"读进去。
 */
function assertWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    throw explainFsError(error, path.join(dir, 'probe'));
  }
}

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀
 *   · 文件数与解压总量上限（zip 炸弹防护）
 * 返回 [{ name, data }]（仅文件条目，目录跳过）。
 */
export function validateZipStructure(buffer) {
  const entries = parseZip(buffer);
  if (entries.length > MAX_FILES) throw new Error(`文件数量过多（${entries.length} > ${MAX_FILES}）`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
  return entries;
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · zip 里通常有一层与包同名的根目录（服务端打包格式 `<id>/...`），剥掉它
 *   · 没有统一根目录时用 preferId（服务器告知的 id）
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景：同 id 覆盖会丢用户改动，
 *     而且插件热重载正在 watch 旧目录，覆盖写一半会加载出半截代码）
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');

  // 写权限预检：不可写就立刻给出"谁没权限、该改哪个目录"，而不是解压到一半抛 EACCES
  assertWritableDir(baseDir);

  // 剥统一根目录：所有条目都共享同一个第一段时去掉它
  let names = entries.map((e) => e.name);
  let strip = 0;
  const firstSeg = names[0].split('/')[0];
  if (firstSeg && names.every((n) => n.startsWith(firstSeg + '/'))) strip = firstSeg.length + 1;
  const relNames = names.map((n) => n.slice(strip));
  if (relNames.some((n) => !n)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');

  // 落地目录名：优先 zip 根目录名，其次 preferId
  let dirName = strip ? firstSeg : (preferId || 'module');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dirName)) dirName = preferId || 'module';
  // 冲突递增
  let finalName = dirName;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${dirName}_${n}`;
  }
  const target = path.join(baseDir, finalName);

  // ── 先解压到同目录下的临时目录，全部写完再原子改名 ──────────────────────
  // 为什么不能直接往 target 里写：中途失败（权限、磁盘满、包内路径冲突）会留下一个
  // **半成品目录** —— 它既不像"装好了"也不像"没装"，加载器会去读它并报一堆错，
  // 而热重载 watcher 还会把半截代码当成一次正常变更加载进来。
  // 临时目录必须与 target 同一个父目录（同一文件系统），rename 才是原子的；
  // 前缀带点号，配合 plugin-loader 跳过隐藏目录，残留物不会被当成模块扫描。
  const tmpDir = path.join(baseDir, `${TMP_PREFIX}${finalName}-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (let i = 0; i < entries.length; i++) {
      const rel = relNames[i];
      // 二次防线：拼接结果必须仍在临时目录内（解析后 path.relative 检查）
      const dest = path.join(tmpDir, ...rel.split('/'));
      const relCheck = path.relative(tmpDir, dest);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new Error(`安装包包含非法路径：${entries[i].name}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entries[i].data);
    }
    fs.renameSync(tmpDir, target);
  } catch (error) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力而为：删不掉也不能盖住原始错误 */ }
    throw explainFsError(error, target);
  }
  return finalName;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。 */
function parseZip(buffer) {
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // 目录条目（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 本地头：定位到实际数据
      if (sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      out.push({ name: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  // 安全规则（与后端一致）
  for (const e of out) {
    const parts = e.name.split('/');
    if (e.name.startsWith('/') || parts.includes('..')) throw new Error(`安装包包含非法路径：${e.name}`);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}
