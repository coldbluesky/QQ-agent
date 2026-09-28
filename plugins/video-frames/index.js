// 视频抽帧 Skill 入口。
//
// 只提供一个能力：`video.frames`
//   输入  { filePath, count?, maxWidth?, quality?, durationSec?, ffmpegPath? }
//   输出  { frames: string[], times: number[], error? }
//
// 核心模块（video-reader / tools）通过能力名取用它，**不 import 本文件**：
// 这样关掉这个 Skill 就退回"只给元信息"，换实现也不用改核心代码。
//
// 为什么抽帧要单独做成 Skill 而不是写死在核心：
//   · ffmpeg 是**外部可执行文件**，装没装、装在哪、能不能用都是环境相关的
//   · 抽几帧、多大尺寸、什么质量是**口味问题**，不同机器/不同模型差别很大
//   · 有些模型（Gemini、Qwen-VL 等）能原生读视频，那就完全不需要抽帧 ——
//     这时把 Skill 关掉即可，核心会走"原生视频输入"那条路
//   这三件事都符合"可插拔能力"的定位，而"决定走哪条路"是核心的职责。

import { extractFrames, findFfmpeg, probeDuration } from './frames.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // 抽帧：参数优先级 调用方传入 > 用户在设置页配的 > 默认值
  'video.frames': async ({ filePath, count, maxWidth, quality, durationSec, ffmpegPath } = {}) => {
    const c = cfg();
    const want = Math.max(1, Math.min(12, Math.round(Number(count) || Number(c.count) || 4)));
    const result = await extractFrames({
      filePath,
      count: want,
      maxWidth: Number(maxWidth) || Number(c.maxWidth) || 768,
      quality: Number(quality) || Number(c.quality) || 4,
      durationSec,
      ffmpegPath: ffmpegPath || null
    });
    if (result.error) log(`抽帧未成功：${result.error}`);
    return result;
  },

  // 让核心能问"现在这条路走得通吗"，用于 auto 模式的降级判断
  'video.frames.available': async ({ ffmpegPath } = {}) => {
    const ff = ffmpegPath || await findFfmpeg();
    return { ok: Boolean(ff), reason: ff ? '' : '未找到 ffmpeg（抽帧需要它）' };
  }
};

/**
 * 自检：没有 ffmpeg 时标为"依赖不满足"，UI 会直接显示原因。
 *
 * ⚠️ 这个函数**必须是同步的** —— SkillManager 的可用性判定（以及工具可用性判定）
 * 是同步调用链，`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy）。
 * 但探测 ffmpeg 要 spawn 进程，只能异步。
 * 折中：后台探测 + 缓存结果；"还没探测出来"按**不可用**处理（不是乐观放行）。
 * 不这么做的话有两个后果：
 *   1) 明明没装 ffmpeg，设置页却显示"生效中"，真正抽帧时又失败；
 *   2) 可用性在"乐观可用 / 探测失败"之间周期翻转 → 本 Skill 的提示词段与工具
 *      跟着增删 → 系统提示字节抖动 → 服务商整段前缀缓存失效。
 */
let ffmpegKnown = null;   // null = 还没探测出来
let probing = false;
let probeAt = 0;          // 上次探测时间：失败结果最多缓存 60 秒，之后允许重探
const PROBE_RETRY_MS = 60000;
// 未知 / 失败共用同一条 reason：状态文本也必须逐字节稳定（见 available 的说明）
const FFMPEG_MISSING_REASON = '未找到 ffmpeg，无法抽帧（装好 ffmpeg 后约 1 分钟内自动恢复）';
function probeFfmpegInBackground() {
  if (probing) return;
  if (ffmpegKnown) return;                                     // 成功结果长期有效
  if (ffmpegKnown !== null && Date.now() - probeAt < PROBE_RETRY_MS) return;
  probing = true;
  findFfmpeg()
    .then((p) => { ffmpegKnown = p || ''; probeAt = Date.now(); })
    .catch(() => { ffmpegKnown = ''; probeAt = Date.now(); })
    .finally(() => { probing = false; });
}

export function available() {
  // 失败结果超 60 秒自动重探：用户后来装好 ffmpeg 不需要重启就能恢复
  if (ffmpegKnown === '' && Date.now() - probeAt > PROBE_RETRY_MS) ffmpegKnown = null;
  if (ffmpegKnown === null) {
    probeFfmpegInBackground();
    // ⚠️ "探测中"一律按**不可用**处理，不要乐观放行。
    // 原因（2026-09-20 实测）：本 Skill 的 promptSections() 会跟着可用性增删
    // 【视频理解】段，而可用性又决定工具是否进 function 列表 —— 只要状态会翻转，
    // 系统提示与工具集的字节就会翻转，服务商侧**整段前缀缓存失效**。
    // 曾经这里是 `return { ok: true }`，配合"失败结果 60 秒后置回 null 重探"，
    // 形成 60 秒一轮的循环：探测失败(不可用) → 60s 后置 null → 乐观放行(可用)
    // → 再探测失败… 实测系统提示在 4531/4598 两个字节版本间跳，每次跳都让缓存归零。
    // 现在状态字节恒定：未知/失败都是同一条 reason，只有真的探测到 ffmpeg 才转可用。
    return { ok: false, reason: FFMPEG_MISSING_REASON };
  }
  if (!ffmpegKnown) return { ok: false, reason: FFMPEG_MISSING_REASON };
  return { ok: true };
}

/**
 * 提示词片段：**只在这里声明一次**。
 * 曾经 plugin.json 里还有一份 id 不同、标题同为「视频理解」的静态片段，两份内容
 * 七成重复、每次都一起进系统提示（SkillManager 只按 id 去重，不同 id 就都留下）。
 * 合成一份之后：措辞建议（"看起来""某一帧里"）与帧数一起由这里给出，既省 token，
 * 也不会出现"两段说法不一致"。
 */
export function promptSections() {
  const c = cfg();
  return [{
    id: 'video-frames-active',
    title: '视频理解',
    priority: 35,
    content: `你看到的视频画面是从视频里抽出的 ${Number(c.count) || 4} 张截图，不是连续视频：帧与帧之间发生的事你看不到。描述时用"看起来""某一帧里"这类措辞，不要断言中间的连续过程。`
  }];
}

export const internals = {
  extractFrames, findFfmpeg, probeDuration,
  FFMPEG_MISSING_REASON,
  // 测试用：重置 ffmpeg 探测缓存
  __resetFfmpegCache: () => { ffmpegKnown = null; probing = false; probeAt = 0; },
  // 测试用：直接设定探测结果与探测时刻（用来复现"失败 60 秒后重探"那个窗口）
  __setFfmpegKnown: (v, at = Date.now()) => { ffmpegKnown = v; probeAt = at; probing = false; }
};
