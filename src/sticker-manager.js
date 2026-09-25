// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
// 本地路径 → file URI 的唯一实现（曾在这里手写导致 POSIX 上多一个斜杠，见 util.js 注释）
import { toFileUri } from './util.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed
} from './stickers.js';

// 收藏表情的本地图片目录：收藏时把图片转存到这里（QQ 图床 rkey 会过期，
// 直接存 url 的话过 1 小时左右 send_sticker 就发不出去了 —— 这是"收藏频发故障"的根因）。
// 注意：用函数延迟取 DATA_DIR，而不是模块加载时定死 —— 测试/便携场景会重定向数据目录。
function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * 只允许访问由收藏功能维护的本地图片，拒绝配置/存档中指向目录外的 file URI。
 * 返回绝对路径（存在且是文件）；不合法返回 null。
 */
export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  // ⚠️ 历史数据可能是 file:////opt/…（四个斜杠，成因见 util.js 的 toFileUri 注释），
  // URL 解析出来的 pathname 就是 //opt/…。先收敛前导斜杠，否则下面那句
  // "是否落在受控目录内"会把本来合法的收藏图片误判成目录外、直接拒绝发送。
  pathname = pathname.replace(/^\/+/, '/');
  // file:///C:/... 在 Windows URL pathname 前面多一个斜杠。
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  } catch { return null; }
  return full;
}

// 图片类型嗅探统一在 image-type.js：原先这里是第三份副本，且**漏了 JPEG 分支**
// （靠"默认返回 .jpg"歪打正着），加新格式时要改三处、极易漏。
import { detectImageExt } from './image-type.js';

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * 发送前预检：确保表情有一个"当前可发送"的地址。
   *
   * ── 为什么需要它（"表情包经常发送失败"的第二根因）──────────────────────
   * 表情库里 http 直链的寿命只有 1 小时左右（QQ 图床 rkey 过期）。
   * 同步 TTL 也是 60 秒 —— 但 sync 只在**收消息**的运行里刷新，
   * 一次运行 12 轮工具循环可能跑几分钟，中途直链就会过期；
   * 更糟的是 sync 失败时（协议端断连）库里的 url 全是旧的，
   * 发送必失败。这个方法在**发送前**做一次兜底：
   *   · 本地转存（file:///）→ 永久有效，直接返回
   *   · http 直链 → 尝试下载转存到 data/sticker-images/：
   *       成功 = 库里 url 升级成本地路径（下次发送永久有效，这正是收藏
   *       功能已有的转存逻辑，这里复用同一目录与安全边界）；
   *       失败（直链已过期）= 保持原 url，让 sender 的回退链去试
   *       get_image/base64（那边有完整的三级回退）。
   * 每个条目只试一次（缓存在 entry._persistTried），避免同一轮反复下载。
   *
   * @param {object} sticker 表情条目（原地升级 url 字段）
   * @returns {Promise<object>} 同一引用（方便链式使用）
   */
  async ensureSendable(sticker) {
    if (!sticker?.id || !sticker?.url) return sticker;
    const url = String(sticker.url);
    if (url.toLowerCase().startsWith('file:///')) return sticker;   // 已是本地路径
    if (sticker._persistTried) return sticker;                      // 本轮已试过，别反复下载
    sticker._persistTried = true;
    try {
      const local = await this.#persistImage(`st_${sticker.id}`, { url });
      if (local) {
        sticker.url = local;
        sticker.localFile = local;
        // 升级后的条目写回库里（find() 返回的是 this.entries 里的同一对象引用，
        // 直接 save 即可持久化；失败不影响本次发送）
        try { saveStickerStore(this.entries); } catch { /* 持久化失败不影响本次 */ }
      }
    } catch { /* 转存失败：保持原 url，交给 sender 回退链 */ }
    return sticker;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  async collect(messageId, { url, note = '', file = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url && !file) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }

    // ── 关键修复：把图片转存到本地，避免 QQ 图床 rkey 过期后发送失败 ──
    // 优先用 OneBot get_image 拿 NapCat/SnowLuma 的本地缓存文件（不依赖 url 时效）；
    // 拿不到再直接下载 url（新消息 url 还没过期时有效）。都失败则退回存 url（旧行为）。
    let localFile = '';
    try {
      localFile = await this.#persistImage(id, { url, file });
    } catch (error) {
      console.warn(`[sticker] 收藏图片转存失败，退回存 url（可能 1 小时后失效）: ${error?.message ?? error}`);
    }

    const entry = {
      id,
      resId: id,
      url: localFile || url,          // 优先本地 file:/// 路径（永久有效），否则退回原 url
      sourceUrl: url,                  // 保留原始 url 备查
      localFile: localFile || '',
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    return entry;
  }

  /**
   * 把一张图片持久化到 data/sticker-images/，返回 file:/// 绝对路径。
   * 路径 1：OneBot get_image（消息里的 file id → 本地缓存文件，不依赖 url 时效）
   * 路径 2：直接下载 url（新消息 url 未过期时有效）
   */
  async #persistImage(id, { url, file }) {
    const imgDir = stickerImagesDir();
    fs.mkdirSync(imgDir, { recursive: true });
    // 路径 1：OneBot get_image 拿本地缓存
    if (file) {
      try {
        const ret = await this.onebot.call('get_image', { file: String(file) });
        const srcPath = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (srcPath) {
          const buf = fs.readFileSync(srcPath);
          if (buf.length) {
            const dest = path.join(imgDir, `${id}${detectImageExt(buf)}`);
            fs.writeFileSync(dest, buf);
            return toFileUri(dest);
          }
        }
        // 有的实现返回可下载 url
        if (ret?.url) {
          const buf = await this.#downloadBytes(String(ret.url));
          if (buf) {
            const dest = path.join(imgDir, `${id}${detectImageExt(buf)}`);
            fs.writeFileSync(dest, buf);
            return toFileUri(dest);
          }
        }
      } catch { /* 缓存没有就走下载 */ }
    }
    // 路径 2：直接下载 url
    if (url) {
      const buf = await this.#downloadBytes(url);
      if (buf) {
        const dest = path.join(imgDir, `${id}${detectImageExt(buf)}`);
        fs.writeFileSync(dest, buf);
        return toFileUri(dest);
      }
    }
    throw new Error('图片转存失败（get_image 无缓存且 url 下载失败）');
  }

  async #downloadBytes(url) {
    try {
      // 走 safe-fetch：这里的 url 来自 OneBot 消息段（发送方可影响），
      // 裸 fetch 等于给了一条"让本机去抓内网"的 SSRF 通道。
      const { buffer } = await safeFetchBinary(String(url), 15 * 1024 * 1024);
      return buffer?.length ? buffer : null;
    } catch {
      return null;
    }
  }
}
