// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖
import { profileSuffix, portOffset } from './profile.js';   // 多实例：实例号决定数据目录/端口

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录；多实例（QQ_AGENT_PROFILE=2）用 data-2 / data-3 …
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, `data${profileSuffix()}`);
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// 官方固定价格表地址（社区分发的只读价格表）。
export const FIXED_PRICE_REMOTE_URL = 'https://kondius.cn/qq-agent/model-prices.json';

/**
 * 程序根 —— "同一台机器上所有实例都看得见的那一层"。
 * 与 ROOT 的区别只在多开时体现（打包部署时 ROOT 是 <程序根>/resources/app）。
 * 本版本未启用多实例，二者等价。
 */
export function instanceRoot() { return ROOT; }

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 备选模型：主模型重试仍失败时逐个降级重试。
    // 每项 { provider?, model }；provider 为空则沿用主模型的 baseUrl + Key。
    fallbackModels: [],
    visionModel: '',            // 图片输入专用模型（留空 = 用主模型）
    videoModel: '',             // 视频输入专用模型（留空 = 用主模型）
    // 视频读取选路：auto = 配了 videoModel 就原生读视频、否则抽帧；
    // native = 强制原生视频输入；frames = 强制抽帧；off = 关掉 read_video 的画面部分。
    videoMode: 'auto',
    // 模型能不能吃 video 部分（与 vision 相互独立）。默认关 —— 猜错"支持视频"的代价是请求 400。
    video: false,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向一个自托管的 JSON（格式见 scripts/export-prices.mjs 产物）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 语音输出（TTS）。两种服务类型，由 type 切换：
  //   openai  = OpenAI 兼容的 POST {baseUrl}/audio/speech（官方 / 硅基流动 / Groq / 中转站…）
  //   tencent = 腾讯云语音合成 TextToVoice（TC3-HMAC-SHA256 签名，音频以 base64 返回）
  // 开启后模型才会拿到 send_voice 工具（见 orchestrator 的工具过滤）。
  voice: {
    enabled: false,          // 关 = 移除 send_voice 工具，模型完全不知道有语音这回事
    type: 'openai',          // 'openai' | 'tencent'
    // ── OpenAI 兼容模式 ──
    provider: '',            // 复用「模型目录」里的提供商 id；留空则退回聊天模型的地址与 Key
    baseUrl: '',             // 留空 = 用 provider 的地址，再退回 api.baseUrl
    apiKey: '',              // 留空 = 用 provider 的 Key，再退回当前聊天模型的 Key
    model: '',               // 语音模型 id，如 gpt-4o-mini-tts / tts-1（必填才会启用）
    voice: 'alloy',          // 音色名（各厂商取值不同）
    instructions: '',        // 可选：风格指令（gpt-4o-mini-tts 这类模型支持）
    // ── 两种模式共用 ──
    format: 'mp3',           // 输出格式：mp3 | opus | aac | flac | wav | pcm（腾讯云只支持 mp3/wav/pcm）
    // 语音文件以什么形式交给协议端（OneBot record 段的 file 字段）。
    //   file-uri = file:///opt/... 形式的本地路径 URI（默认；NapCat 系只认带协议头的形式，
    //              裸绝对路径会被当成 URL 解析，报 "识别URL失败"）
    //   path     = 裸绝对路径（个别老实现只认这个）
    //   base64   = base64:// 内联音频（协议端在 Docker 里、或与机器人不同机时最稳：
    //              不依赖双方能看到同一个文件路径，代价是消息体积变大）
    fileMode: 'file-uri',
    maxChars: 200,           // 单条语音最长字符数，超出截断（防止模型念长文）
    timeoutMs: 60000,
    keepFiles: 100,          // data/voice/ 本地语音文件保留个数；**0 = 不限制**
    // ── 腾讯云语音合成（type='tencent' 时生效）──
    tencent: {
      secretId: '',          // 访问密钥 SecretId（建议用子账号）
      secretKey: '',         // 访问密钥 SecretKey
      region: 'ap-guangzhou',
      // 音色 ID。默认取「超自然大模型音色」里的聊天女声（603007 邻家女孩）——
      // 自然度远高于 101001（智瑜）那批精品音色，后者是标准 TTS 腔。
      // 完整列表见腾讯云《音色列表》：超自然大模型音色 > 大模型音色 > 精品音色。
      voiceType: 603007,
      // 采样率：8000 | 16000 | 24000。
      // 默认取 16000：这是腾讯云自己的默认值，也是 QQ 语音的常规档位。
      // 别为了"更清晰"默认上 24000 —— QQ 语音链路本身工作在 16k，24k 不会更清晰，
      // 只会让文件更大、多一层重采样，还要求音色支持（精品音色 10xxxx 最高只到 16k，
      // 配错会报 InvalidParameterValue.SampleRate）。
      sampleRate: 16000,
      volume: 0,             // 音量，范围 [-10, 10]，0 = 正常
      modelType: 1,          // 模型类型，1 = 默认模型
      primaryLanguage: 1,    // 主语言：1 中文 | 2 英文
      endpoint: ''           // 留空 = https://tts.tencentcloudapi.com（一般不用改）
    }
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    // ── 发网图（send_image）──
    // 机器人主动往群里发网上找的图。默认关闭：它是"让机器人把任意图片发进群"的能力，
    // 应当由用户显式打开，而不是默认就有。
    imageSend: {
      enabled: false,
      // 是否强制"先看一眼再发"：模型必须先 send_image(url, preview=true) 确认合适才能真发。
      // 这是防"模型随手发一张不合适的图"的主要闸门。
      requirePreview: true,
      maxPerRun: 3,              // 单次运行最多发几张（防刷屏）
      maxPreviewsPerRun: 5,      // 单次运行最多预览几张（防反复下载烧流量）
      maxBytesMB: 5,             // 单图体积上限（MB）
      skipPreviewForLockedHosts: true   // 浏览锁定站点内的图可跳过预览（站内图源可信）
    },
    // 浏览锁定：只允许机器人访问白名单内的域名（家长/老师/自用场景的硬边界）。
    // 逐跳校验（每次重定向都重新查），子域自动放行（配 example.com 则 img.example.com 也过）。
    browseLock: {
      enabled: false,
      hosts: [],                 // 白名单域名，如 ['example.com', 'wikipedia.org']
      siteSearchUrl: ''          // 可选：站内搜索模板，用 {query} 占位
    }
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    // 第二实例默认连自己的 OneBot 端口（3001/3000 + 偏移），
    // 否则两个实例会同时连到主实例的 SnowLuma，消息被处理两遍（群里重复回复）。
    wsUrl: `ws://127.0.0.1:${3001 + portOffset()}`,
    httpUrl: `http://127.0.0.1:${3000 + portOffset()}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: ''                         // 追加自定义规则（可选）
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 扩展（技能/插件）
  extensions: {
    // 监听 skills/ 与 plugins/ 目录，改动后自动重载。
    // ⚠️ 含义：落地的 JS 会被执行 —— 只放你信任的代码进去。
    hotReload: true
  },
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    dedupeWindowMs: 8000    // 同一会话内相同文本的去重窗口（0 = 关闭）
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 唱歌 / 曲库：把 data/songs/ 里的歌切片后当作语音消息发出去。
  // 与语音输出（TTS）是两条独立的链路，但共用发送方式（record 段 + fileMode）。
  song: {
    // 默认关：它要求用户自己准备素材（data/songs/ 放歌 + 写 manifest.json）
    // 并且装 ffmpeg，出厂就开着只会让模型拿到一个必然失败的工具。
    enabled: false,
    promptMaxSongs: 10,      // 提示词里列几首（其余可用 list_songs 查）
    maxSeconds: 30,          // 单次唱多长；硬上限 60（QQ 语音普通账号的上限）
    prompt: true             // 是否在系统提示里加【唱歌】策略段
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    keepSessionFiles: 0         // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）
    // 无印象的活跃群友也纳入整理（新建印象）。
    // 关掉的话，只有"印象数已超阈值"才会整理，而整理模式只合并/删减、不新增 ——
    // 于是新群/冷群永远攒不出第一条印象（实测有群聊了 200+ 条却零印象）。
    discoverActiveMembers: true,
    discoverMaxMembers: 6                 // 单次最多为几位活跃群友新建印象（控制单次成本）
  },
  // 前情摘要：跨会话的对话记忆。
  // 每次运行结束后，把"这次没看到原文的旧消息"折叠进一份持久化摘要，
  // 下次唤醒时连同【过去状态】的最近原文一起注入。
  // 摘要正文有固定字数上限 → 注入成本有界，不会随聊天量膨胀（保住"单次成本恒定"）。
  summary: {
    enabled: true,
    // 最近多少条**不进摘要**、始终以原文出现在【过去状态】里。
    // 实际保留数还会与本次读取窗口取较小值，避免出现"既没进摘要、也没被原文带进提示词"
    // 的盲区（读取条数按上下文档位是 8~80 不等）。
    keepRaw: 60,
    maxChars: 1200,          // 摘要正文字数上限（注入成本上限）
    minFold: 5,              // 至少积攒这么多条旧消息才折叠一次（1 = 每轮运行后都折叠）
    maxInputMsgs: 200,       // 单次折叠最多喂多少条新滑出的消息
    useChatModel: true,      // 折叠模型跟随聊天模型；false = 用下方专用模型
    provider: '',
    model: '',
    timeoutMs: 120000
  },
  // 桌面端/控制台
  server: {
    // 端口：QQ_AGENT_PORT 显式覆盖 > 默认 3210 + 实例号 ×100（多开时避免撞端口）
    port: Number(process.env.QQ_AGENT_PORT) || (3210 + portOffset()),
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true,        // 点关闭 = 最小化到托盘
    autoStartPeers: false     // 启动主实例时自动带起其它实例（多开）
  },
  // ── 工具开关（唯一口径由 tool-registry.getToolAvailability() 计算）──
  // ⚠️ 边界：tools.* = **工具**层开关（全局/分类/单个工具）；
  //          skills.* = **能力**层开关（每个 Skill 一个命名空间）。
  // 最终"能不能用"顺序：tools.enabled → skill 生效 → requires 能力 → 分类 → 单工具 → 运行期依赖。
  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    overrides: {},              // { [toolId]: boolean } 单个工具的启用状态
    crossChatSend: false,      // 跨会话发送（默认关）：开启后 send_to 才能用
    categories: {
      messaging: true,          // 消息发送
      sticker: true,            // 表情管理
      query: true,              // 消息查询
      memory: true,             // 记忆系统
      web: true,                // 联网搜索
      knowledge: true,          // 知识库
      media: true,              // 媒体理解
      utility: true,            // 实用工具
      system: true              // 系统反馈
    }
  },
  // Skill 统一开关：唯一的"能力启停"来源。
  // 形状：{ [skillId]: { enabled: boolean, ...该 Skill 自己的设置 } }
  // 这里只存用户改过的值；默认值来自各 Skill 的 skill.json → settings。
  skills: {},

  // ══════════════════════════════════════════════════════════════════════
  // 以下配置块随"功能移植"一并加入。与原有同名能力不重复，只补移植模块
  // 所需的默认值。每个键都有默认值 —— deepMerge 靠它兜底。
  // ══════════════════════════════════════════════════════════════════════

  // ── 图片搜索（pixiv / 图库 / 反向搜图）──
  imageSearch: {
    enabled: true,
    provider: 'pixiv',            // pixiv | safebooru | konachan | yandere | custom:<id>
    providers: [],                // 自定义图源：{ id, name, type:'custom', baseUrl, apiKey, cookie, timeoutMs }
    cookie: '',                   // pixiv 登录 Cookie（可选）：填了能搜到更多、能取原图
    hideAi: true,                 // 屏蔽 AI 生成图（pixiv 按官方 aiType，图库按标签）
    aiBlockTags: [],
    allowR18: false,
    defaultLimit: 3,
    maxDownloadMb: 8,
    sendMode: 'auto',             // auto = 先试直链、失败改内嵌；url 只发直链；base64 一律内嵌
    timeoutMs: 15000,
    sortBy: 'popular',            // popular = 按收藏数排序；newest = 按发布时间
    minBookmarks: 0,
    rankPool: 24,                 // 按人气排时查多少个候选（每个一次请求；太大会被 pixiv 限流）
    preferOriginal: true,
    maxImageMb: 12,
    minPixels: 0,
    sauceNaoKey: '',              // SauceNAO API Key（反向搜图用；留空则该源跳过）
    perChat: {}                   // 按会话覆盖：{ "group:123": { hideAi:false } }
  },

  // ── 梗知识库（网梗/游戏梗/群内黑话）──
  meme: {
    enabled: true,
    injectEnabled: true,          // 是否把挑出来的梗注入提示词
    injectMax: 8,
    injectMaxChars: 1200,
    searchMax: 8,
    autoNote: true,
    recordUsage: true,
    chatScopeEnabled: true,
    biliEnabled: true,            // B 站找梗总开关（免登录接口）
    biliProactive: true,
    biliHotLimit: 12
  },

  // ── 实例总线（同机多实例的动态账本）──
  bus: {
    enabled: false,               // 总开关：关掉后既不写也不读（单实例用不上）
    readLimit: 12,
    windowMin: 180,
    reportEvents: true
  },

  // ── 人设蒸馏（从聊天记录/文本反推人物设定）──
  distill: {
    maxChatLines: 400,
    maxPerChat: 200,
    maxTextLines: 600,
    autoSwitch: false
  },

  // ── 情绪系统 ──
  // 她有持续的情绪状态，会随时间半衰、会被夸奖/冷落推动，也会影响说话风格。
  emotion: {
    enabled: false,
    allowModelUpdate: true,       // 允许她自己通过 set_mood 改情绪
    allowRules: true,             // 允许按对方消息做轻量助推（被夸→开心、被冷落→委屈…）
    injectStyle: true,            // 情绪影响说话风格（关掉 = 只记录、不改语气）
    halfLifeMin: 90,              // 强度半衰期（分钟）
    minIntensity: 1,
    intensityMax: 5,
    baseKey: 'calm',              // 基线情绪
    decayBack: true,
    neglectHours: 24,
    ruleCap: 3,
    historyMax: 20,
    maxChats: 200
  },

  // ── 姐妹系统（同机多实例互相接话）──
  sister: {
    enabled: false,
    followPercent: 35,            // 姐妹开口后我接茬的概率（%）。0 = 从不主动接茬
    followCooldownSec: 90,
    windowMin: 10,
    readLimit: 3,
    injectRelation: true,
    shareNotes: true,
    notesReadLimit: 8,
    rank: 0                       // 本实例的排行（1=大姐 2=二姐…；0 = 不排辈分）
  },

  // ── 临时设定（只在某一个群、某一段时间内有效的临时交代）──
  tempSettings: {
    enabled: false,
    defaultTtlMin: 720,           // 不填 ttlMin 时的默认有效期（分钟）＝ 12 小时
    maxPerGroup: 5,
    maxGroups: 100,
    keepBrief: true,              // 过期后是否把"概述"当背景注入
    briefMaxChars: 60,
    keepDays: 30,
    maxChars: 1000,
    reactWindowMin: 30,           // 「开场反应只做一次」的时限（分钟）；0 = 关掉
    crossInstance: true,
    allowCommand: true,           // 群里发「临时设定：…」直接生效
    commandAllowEveryone: false   // 默认仅管理员可发（防任意群友塞设定）
  },

  // ── R18 内容许可 + 模型尺度适配 ──
  // ⚠️ enabled 是管理员总开关，默认关；还要同时满足人设的 nsfw 属性且只在私聊生效。
  nsfwAdapt: {
    enabled: false,
    tier: 'auto',                 // auto = 按模型自动挑；strict/balanced/open = 强制档位
    softRetry: true               // 软拒绝时按 strict 档换写法重试一次（红线场景永不重试）
  },

  // ── 情爱值（R18 场景内的欲望累积）──
  intimacy: {
    enabled: false,
    requireNsfw: true,
    max: 100,
    baseGain: 4,
    lightFactor: 1,
    deepFactor: 1.8,
    paceSample: 6,
    paceFastSec: 60,
    paceSlowSec: 900,
    paceMax: 1.8,
    paceMin: 0.7,
    comboMin: 3,
    comboWindowSec: 300,
    comboBoost: 1.25,
    kinkBoost: 1.8,
    kinkStackCap: 2.4,
    idleHalfLifeMin: 240,
    decayBack: true,
    activeThreshold: 65,
    initiateBoost: true,
    initiateBoostMax: 70,
    releaseKeepDefault: 0.15,
    releaseKeepLongGap: 0.35,
    releaseKeepMany: 0,
    releaseManyCount: 3,
    releaseManyWindowMin: 360,
    releaseLongGapHours: 24,
    aftermathMin: 20,
    injectStyle: true,
    allowModelUpdate: true,
    lightWords: [],
    deepWords: [],
    kinkKeywords: [],
    kinkKeywordsByPersona: {},
    historyMax: 20,
    maxChats: 200
  },

  // ── 棋局（国际象棋 / 棋路记录）──
  // 局面不靠她"记"，而是程序存一份权威局面（起始 FEN + 着法序列），每次唤醒回放重算。
  chess: {
    enabled: false,
    showLegalMoves: true,         // ★ 强烈建议开着：模型只需照抄其中一条
    legalMovesMax: 80,
    kifuMax: 60,
    defaultBotSide: 'black',      // 'black' = 对方先走、她陪着下；'white' = 她先走
    maxGames: 200,
    archiveMax: 50,
    undoMax: 10,
    quietMemory: false
  },

  // ── 群管理员指令（群内说「禁言 / 解除」）──
  admin: {
    enabled: true,
    admins: {},                   // { [群号]: 管理员QQ号 }；键 '*' = 全局管理员
    muteReply: ''                 // 禁言期间被 @ 时回的固定话术（留空用内置默认）
  },

  // ── 说话风格学习（学群友怎么说话，再像他们那样说）──
  styleLearn: {
    enabled: false,
    learnSpeech: true,
    learnImageReaction: true,
    learnSticker: true,
    learnEmoji: true,
    collectEnabled: true,
    autoDistill: true,            // 后台自动蒸馏（要花 token，可关掉只手动点）
    distillMinSamples: 80,
    distillIntervalMs: 21600000,
    maxSamples: 3000,
    maxSpeechItems: 18,
    maxReactionItems: 18,
    reactionWindowSec: 180,
    minTextLen: 2,
    injectMaxItems: 8,
    injectMaxChars: 900,
    captionImages: false,
    captionMaxPerDay: 30,
    chatExclude: []
  },

  // ── 昵称历史（自动维护）：{ [QQ号]: [{ name, at }, ...] }，用来认出"这个人改过名" ──
  memberAliases: {},
  // ── 群禁言：{ [群号]: { at, reason, until } }。命中的群完全不触发 AI 运行 ──
  mutedGroups: {},
  // ── 主动示好的冷却记录（运行期状态，不是用户配置）──
  nsfwInitiateState: {},

  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  if (store.unifiedTier !== false) return store;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return store;
  const pos = store.groupSliderPos?.[id];
  if (pos === undefined || pos === null) return store;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  return { ...store, contextTier: tier, randomPercent };
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}
