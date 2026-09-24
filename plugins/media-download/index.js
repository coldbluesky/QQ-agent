// B站 / 抖音视频下载（确定性型插件）
//
// ── 提供的能力 ────────────────────────────────────────────────────────────
//   media.download
//     入参 { url, onebot, sender, kind, chatId }
//     出参三种之一：
//       { ok: true,  platform, kind:'video'|'images', title, durationSec, count }
//       { ok: false, skip: true }                       ← 这条链接不归我管，交给下一个提供者
//       { ok: false, error, friendly }                  ← 归我管但下载/发送失败
//
// ── 为什么是"一个能力 + 自己认平台"而不是 B站/抖音 两个能力 ──────────────────
// 触发条件（消息里出现了本平台链接）只有本模块判断得准：它手里有 extractBvid /
// looksLikeDouyinShare / resolveB23 这些精确解析器。若把平台正则搬到核心里，
// 核心就要同时维护"哪些平台""每个平台的链接长什么样"，加一个平台就得改核心 ——
// 与"插件放进去就生效"直接冲突。
// 现在核心只做一件事：把消息里的候选链接喂给所有 media.download 提供者，
// 谁认领谁处理（skip 表示不认领）。新增平台 = 新插件再提供一次 media.download。
//
// ── 发送必须走 sender ─────────────────────────────────────────────────────
// provider 拿到的 sender 是核心的发送队列。直连 onebot.sendSegments 会跳过
// 限频与留档：媒体把配额吃光后文字突然发不出，且下一次运行不知道自己发过。
// 直发分支只保留给"本模块被独立复用"的场景。

import {
  resolveBvid, extractBvid, downloadAndSend as downloadBilibili, briefFailure as biliFailure
} from './bili.js';
import {
  resolveAwemeId, looksLikeDouyinShare, downloadAndSend as downloadDouyin, briefFailure as dyFailure
} from './douyin.js';

let config = () => ({});
let log = () => {};

export function setup(api) {
  config = api.config;
  log = api.log || (() => {});
}

function settings() {
  const c = config() || {};
  return {
    sessdata: String(c.bilibiliCookie || '').trim(),
    cookie: String(c.douyinCookie || '').trim(),
    maxDurationMin: Math.max(1, Number(c.maxDurationMin) || 10),
    maxBytes: Math.max(1, Number(c.maxSizeMB) || 100) * 1024 * 1024,
    preferQuality: String(c.quality || 'low').toLowerCase() === 'high' ? 'high' : 'low'
  };
}

/**
 * 判断一条链接归哪个平台。
 * 只做"是不是本平台"的粗判，精确解析（b23 重定向 / av→BV / 短链跟跳）交给
 * resolveBvid / resolveAwemeId —— 这里只负责决定"要不要接手"。
 */
export function detectPlatform(url) {
  const s = String(url || '');
  if (!s) return null;
  if (/bilibili\.com\//i.test(s) || /b23\.tv\//i.test(s) || extractBvid(s)) return 'bilibili';
  if (looksLikeDouyinShare(s)) return 'douyin';
  return null;
}

function briefFailure(platform, error) {
  const m = String(error?.message ?? error ?? '');
  if (m.includes('时长') && m.includes('上限')) return `这个视频太长了，超过设置里的时长上限，跳过`;
  if (m.includes('大小上限') || m.includes('超过上限')) return '这个视频太大了，超出下载大小上限，下不了';
  return platform === 'douyin' ? dyFailure(error) : biliFailure(error);
}

export const providers = {
  'media.download': async ({ url, onebot, sender = null, kind = '', chatId = '' } = {}) => {
    const link = String(url || '').trim();
    if (!link) return { ok: false, skip: true };

    const platform = detectPlatform(link);
    // 不认领：让同一个能力下的其它提供者（其它平台的插件）拿到这次机会
    if (!platform) return { ok: false, skip: true };

    try {
      if (platform === 'bilibili') {
        const bvid = await resolveBvid({ url: link }, { onebot });
        const r = await downloadBilibili(bvid, { onebot, sender, kind, chatId, params: settings() });
        return {
          ok: true, platform, kind: 'video', title: r.title, durationSec: r.dur, filePath: r.filePath
        };
      }
      const awemeId = await resolveAwemeId({ url: link }, { onebot });
      const r = await downloadDouyin(awemeId, { onebot, sender, kind, chatId, params: settings() });
      return {
        ok: true,
        platform,
        kind: r.kind,
        title: r.title,
        durationSec: r.dur ?? null,
        count: r.count ?? null,
        filePath: r.filePath ?? null
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      log(`${platform} 下载失败: ${message}`);
      return { ok: false, platform, error: message, friendly: briefFailure(platform, error) };
    }
  }
};

export function available() { return { ok: true }; }

export const internals = { detectPlatform, settings, briefFailure };
