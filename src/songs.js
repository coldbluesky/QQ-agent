// 曲库：本地歌曲片段库 —— 清单加载 + 搜索 + 提示词摘要 + ffmpeg 切片。
//
// 与表情包体系的异同：
//   同：都是"本地文件库 + 清单 + 搜索 + 注进提示词 + 一个发送工具"，所以结构照抄 stickers.js。
//   异：曲库不需要和 QQ 同步（纯本地文件），但多了一步"从完整歌里切出片段"，
//       而那一步依赖 ffmpeg —— 一个**可选**的系统依赖。没装不是错误，只是这个功能不可用，
//       调用时给一条能照着做的提示就够了（voiceReady 那套思路）。
//
// 为什么切片要重新编码而不是 -c copy：copy 只能在帧边界切（±26ms 误差）且输出参数
// 完全跟着源文件走；重新编码 30 秒音频在 2C/4G 上也就一两秒，换来输出参数可控。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR, getConfig } from './config.js';
import { VOICE_DIR, pruneVoiceFiles } from './tts.js';

export const SONGS_DIR = path.join(DATA_DIR, 'songs');
export const MANIFEST_FILE = path.join(SONGS_DIR, 'manifest.json');

// QQ 语音消息的硬上限：普通账号 60 秒（会员的长语音是手机端特性，协议端吃不到）。
// 所以片段一律不超过这个值，否则发出去会失败。
const HARD_MAX_SECONDS = 60;
const MIN_SECONDS = 5;
const CLIP_TIMEOUT_MS = 60000;

let ffmpegProbe = null;

/**
 * 探测 ffmpeg（结果缓存，避免每次发歌都 spawn 一次）。
 * 返回可执行名或空串。装没装都不影响其它功能，所以这里不抛错。
 */
export function ffmpegPath() {
  if (ffmpegProbe !== null) return ffmpegProbe;
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10000 });
    ffmpegProbe = probe.status === 0 ? 'ffmpeg' : '';
  } catch {
    ffmpegProbe = '';
  }
  return ffmpegProbe;
}

/** 单测用：清掉 ffmpeg 探测缓存。 */
export function resetFfmpegProbe() {
  ffmpegProbe = null;
}

/** 规范化一条清单条目；缺歌名或文件不存在返回 null（宁可不收录，也不要发不出去）。 */
export function normalizeSongEntry(raw, index = 0, songsDir = SONGS_DIR) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const file = String(entry.file || '').trim();
  if (!file || file.includes('..') || path.isAbsolute(file)) return null;
  const title = String(entry.title ?? '').trim();
  if (!title) return null;
  // 只认相对路径下的真实文件：清单写错时早暴露，别等到发歌才报错
  let stat = null;
  try {
    stat = fs.statSync(path.join(songsDir, file));
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const toStrList = (v, max) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max) : []);
  const chorusRaw = Number(entry.chorusAt);
  const secondsRaw = Number(entry.seconds);
  return {
    id: String(entry.id || file.replace(/\.[^.]+$/, '') || `song_${index}`).trim(),
    file,
    title,
    artist: String(entry.artist ?? '').trim(),
    // 点歌时用来匹配的别名（歌名之外的叫法：简称、歌手名、梗）
    aliases: toStrList(entry.aliases, 10),
    tags: toStrList(entry.tags, 10),
    note: String(entry.note ?? '').trim().slice(0, 200),
    // 副歌起点：人工标注，比让模型猜准得多
    chorusAt: Number.isFinite(chorusRaw) && chorusRaw >= 0 ? chorusRaw : null,
    seconds: Number.isFinite(secondsRaw) ? secondsRaw : null,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

let libraryCache = { key: '', entries: [] };

// 直接丢进目录也能用：没有清单时按文件名收录（ffmpeg 能读的都认）
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma']);

/**
 * 没有 manifest.json 时的兜底：扫目录，用文件名当歌名。
 * 这样"丢一首歌进去就能试"，不用先学会写清单；想要副歌起点/别名再补清单。
 */
function scanAudioFiles(songsDir) {
  let names = [];
  try {
    names = fs.readdirSync(songsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => AUDIO_EXT.has(path.extname(n).toLowerCase()))
    .sort()
    .map((file, i) => normalizeSongEntry({ file, title: file.replace(/\.[^.]+$/, '') }, i, songsDir))
    .filter(Boolean);
}

/**
 * 读曲库（带 mtime 缓存：用户丢新歌进目录后不用重启，下次运行就生效）。
 * 清单存在 → 以清单为准；清单缺失 → 扫描目录，用文件名当歌名。
 * 清单写坏（JSON 语法错）也退回扫描，避免一个手误让整个曲库消失。
 *
 * 缓存键必须带上路径 —— 只按 mtime 的话，换一个目录读会命中上一个目录的结果。
 */
export function loadSongLibrary({ songsDir = SONGS_DIR, manifestFile = MANIFEST_FILE } = {}) {
  let manifestMtime = -1;
  try {
    manifestMtime = fs.statSync(manifestFile).mtimeMs;
  } catch {
    manifestMtime = -1;
  }

  if (manifestMtime < 0) {
    // 没有清单：扫描目录（缓存跟着目录 mtime 走，新丢进来的文件下次就能看到）
    let dirMtime = -1;
    try { dirMtime = fs.statSync(songsDir).mtimeMs; } catch { dirMtime = -1; }
    const scanKey = `${songsDir}|scan|${dirMtime}`;
    if (scanKey === libraryCache.key) return libraryCache.entries;
    const scanned = scanAudioFiles(songsDir);
    libraryCache = { key: scanKey, entries: scanned };
    return scanned;
  }

  const key = `${manifestFile}|${manifestMtime}`;
  if (key === libraryCache.key) return libraryCache.entries;

  let entries = null;
  try {
    let text = fs.readFileSync(manifestFile, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.songs) ? parsed.songs : []);
    entries = list.map((raw, i) => normalizeSongEntry(raw, i, songsDir)).filter(Boolean);
  } catch {
    // 清单读不了/JSON 坏了：退回扫描目录。宁可少了个性化字段，
    // 也不要因为一处笔误让整个曲库变成空的。
    entries = null;
  }
  if (entries === null) entries = scanAudioFiles(songsDir);

  libraryCache = { key, entries };
  return entries;
}

/** 按关键词找歌：歌名/别名/歌手/标签/备注都能命中；空查询返回第一首。 */
export function findSong(entries, ref) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(ref ?? '').trim().toLowerCase();
  if (!q) return list[0] || null;
  const hit = (s, needle) => String(s || '').toLowerCase().includes(needle);
  // 先精确匹配歌名/别名，再退到模糊匹配 —— 避免"稻香"被"稻香 remix"抢先
  return list.find((e) => e.title.toLowerCase() === q || e.aliases.some((a) => a.toLowerCase() === q))
    || list.find((e) => hit(e.title, q) || e.aliases.some((a) => hit(a, q)))
    || list.find((e) => hit(e.artist, q) || e.tags.some((t) => hit(t, q)) || hit(e.note, q))
    || null;
}

export function formatSongList(entries, query = '', limit = 50) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query ?? '').trim().toLowerCase();
  const matched = q
    ? list.filter((e) => [e.title, e.artist, e.note, ...e.aliases, ...e.tags].join(' ').toLowerCase().includes(q))
    : list;
  const max = Math.max(1, Math.min(200, Number(limit) || 50));
  return {
    total: list.length,
    matched: matched.length,
    truncated: matched.length > max,
    songs: matched.slice(0, max).map((e) => ({
      title: e.title,
      artist: e.artist || undefined,
      aliases: e.aliases.length ? e.aliases : undefined,
      chorusAt: e.chorusAt ?? undefined,
      note: e.note || undefined
    }))
  };
}

/** 提示词里的【可唱的歌】摘要（不算时长/体积，只给歌名与点歌线索）。 */
export function buildSongContext(entries, max = 10) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return '';
  const top = list.slice(0, Math.max(1, Math.min(50, Number(max) || 10)));
  const lines = top.map((e) => {
    const bits = [];
    if (e.artist) bits.push(e.artist);
    if (e.aliases.length) bits.push(`也叫 ${e.aliases.join('/')}`);
    if (e.note) bits.push(e.note);
    return `- ${e.title}${bits.length ? `（${bits.join('；')}）` : ''}`;
  });
  const more = list.length > top.length ? `（曲库共 ${list.length} 首，其余可用 list_songs 查）` : '';
  return `【可唱的歌】${more}\n${lines.join('\n')}`;
}

/** 决定这次从哪切、切多久。 */
export function resolveClipPlan(song, { start = null, maxSeconds = 30 } = {}) {
  const src = song && typeof song === 'object' ? song : {};
  // ⚠️ 不能直接 Number(start)：Number(null) === 0 且是有限数，会把"没指定起点"误判成
  // "从第 0 秒开始"，于是人工标好的 chorusAt 永远不生效。空值必须先排除。
  const startNum = (start === null || start === undefined || start === '') ? NaN : Number(start);
  const startSec = Number.isFinite(startNum) && startNum >= 0
    ? startNum
    : (src.chorusAt ?? 0);                       // 没人指定就从人工标好的副歌起点开始
  const wantRaw = Number(src.seconds);
  const want = Number.isFinite(wantRaw) && wantRaw > 0 ? wantRaw : Number(maxSeconds) || 30;
  const durationSec = Math.min(HARD_MAX_SECONDS, Math.max(MIN_SECONDS, want));
  return { startSec: Math.max(0, startSec), durationSec };
}

function runFfmpeg(args, timeoutMs = CLIP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);   // 只留尾部，够定位就行
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ffmpeg：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}：${stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 400)}`));
    });
  });
}

// 同一首歌同一个区间没必要反复切（重复点歌很常见）
const clipCache = new Map();

/**
 * 从完整歌里切一段出来，返回可直接发送的本地文件路径。
 * 输出固定 mp3/64k：音乐用单声道 16k 会很难听，而 64k 立体声对 30 秒片段足够，
 * base64 之后体积也可控（约 240KB）。
 */
export async function clipSong(song, { start = null, maxSeconds = 30, songsDir = SONGS_DIR } = {}) {
  if (!song?.file) throw new Error('歌曲信息不完整');
  if (!ffmpegPath()) {
    throw new Error('未安装 ffmpeg，无法切歌片段。请在运行机器人的机器上执行：sudo apt install -y ffmpeg（或对应系统的等价命令）');
  }
  const srcFile = path.join(songsDir, song.file);
  try {
    fs.accessSync(srcFile, fs.constants.R_OK);
  } catch {
    throw new Error(`找不到歌曲文件：${song.file}（曲库目录：${songsDir}）`);
  }

  const { startSec, durationSec } = resolveClipPlan(song, { start, maxSeconds });
  const cacheKey = `${song.file}|${startSec}|${durationSec}|${song.mtimeMs}`;
  const cached = clipCache.get(cacheKey);
  if (cached && fs.existsSync(cached)) return { file: cached, startSec, durationSec, cached: true };

  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const outFile = path.join(VOICE_DIR, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.mp3`);
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-y',
    '-ss', String(startSec),          // 放 -i 前面：ffmpeg 走快速定位
    '-i', srcFile,
    '-t', String(durationSec),
    '-vn',                            // 丢掉封面图之类的视频流
    '-c:a', 'libmp3lame',
    '-b:a', '64k',
    outFile
  ]);

  let size = 0;
  try { size = fs.statSync(outFile).size; } catch { size = 0; }
  if (!size) {
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    throw new Error('切片结果为空，请检查歌曲文件是否完整');
  }

  clipCache.set(cacheKey, outFile);
  // 切片产物和 TTS 语音共用 data/voice/，用同一套清理策略
  pruneVoiceFiles(getConfig().voice?.keepFiles);
  return { file: outFile, startSec, durationSec, bytes: size, cached: false };
}

/** 曲库是否可用（决定 sing 工具要不要注册给模型）。 */
export function songsStatus(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const enabled = getConfig().song?.enabled !== false;
  const hasFfmpeg = Boolean(ffmpegPath());
  const missing = [];
  if (!enabled) missing.push('功能未开启');
  if (!list.length) missing.push('曲库为空（把歌放进 data/songs/ 并写好 manifest.json）');
  if (!hasFfmpeg) missing.push('未安装 ffmpeg（切歌片段要用）');
  return { ok: missing.length === 0, enabled, total: list.length, ffmpeg: hasFfmpeg, missing };
}
