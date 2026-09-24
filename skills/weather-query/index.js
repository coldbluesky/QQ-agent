// 天气查询技能（旧格式兼容形态：plugin.json + register(api)，与 calculator/text-tools 同代）。
//
// coverage-e2e 第 10 节把它列为"项目内 3 个旧插件"之一，用来守住旧格式兼容线，
// 所以必须保持 plugin.json + register 入口不动。它注册工具（挂 weather-query 前缀），
// 按两型归位语义属 LLM 型，因此目录在 skills/（审计第 15 节：skills/ 条目必须有工具）。
//
// 数据源：Open-Meteo（https://open-meteo.com）—— 免费、无需 API Key。
// 因此本技能没有任何必填配置：available() 恒 ok:true（审计第 8 节要求
// "技能启用时工具必须可用"，resting state 不允许报不可用）。
//
// 网络必须走 api.fetch（manifest 声明 permissions: ["web_fetch"] 才拿得到，
// 见 src/plugin-loader.js 的 createSkillApi），不直接摸 globalThis.fetch ——
// 绕过权限白名单等于让权限系统形同虚设。

const MAX_DAYS = 7;

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = Object.freeze({
  forecastUrl: 'https://api.open-meteo.com/v1/forecast',
  geocodeUrl: 'https://geocoding-api.open-meteo.com/v1/search',
  defaultDays: 3,
  timeoutMs: 8000
});

let cfg = () => ({});

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 当前设置（出厂默认 ← 用户在设置页改过的值），全部钳制到安全区间。 */
function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const out = { ...DEFAULTS };
  for (const k of ['forecastUrl', 'geocodeUrl']) {
    if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim();
  }
  out.defaultDays = clampInt(raw.defaultDays, 1, MAX_DAYS, DEFAULTS.defaultDays);
  out.timeoutMs = clampInt(raw.timeoutMs, 2000, 30000, DEFAULTS.timeoutMs);
  return out;
}

// WMO 天气代码 → 中文（Open-Meteo 官方解释表）
const WMO_TEXT = Object.freeze({
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨（弱）',
  53: '毛毛雨',
  55: '毛毛雨（强）',
  56: '冻毛毛雨（弱）',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨（弱）',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨（弱）',
  81: '阵雨',
  82: '阵雨（强）',
  85: '阵雪（弱）',
  86: '阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '雷阵雨伴大冰雹'
});

function wmoText(code) {
  const n = Number(code);
  return WMO_TEXT[n] || `天气代码 ${n}`;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function fmtDay(iso) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

function num(value, digits = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '?';
}

/** 把 Open-Meteo 的 daily 块拼成人话。单独导出便于测试。 */
export function formatDaily(place, daily, days) {
  const count = Math.min(Number(days) || 1, daily.time.length);
  const lines = [`${place} 未来 ${count} 天：`];
  for (let i = 0; i < count; i++) {
    const parts = [
      wmoText(daily.weather_code?.[i]),
      `${num(daily.temperature_2m_min?.[i])}~${num(daily.temperature_2m_max?.[i])}°C`
    ];
    const pp = Number(daily.precipitation_probability_max?.[i]);
    if (Number.isFinite(pp) && pp > 0) parts.push(`降水概率 ${Math.round(pp)}%`);
    lines.push(`${fmtDay(daily.time[i])}：${parts.join('，')}`);
  }
  return lines.join('\n');
}

/**
 * 带超时的 JSON GET。超时与网络故障给出不同的可读文案，
 * 让模型能向用户解释"服务太慢"和"根本连不上"是两回事。
 */
async function fetchJson(fetchFn, url, { timeoutMs, label }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(url, { signal: ctrl.signal });
  } catch (error) {
    throw new Error(ctrl.signal.aborted
      ? `${label}超时：${timeoutMs} 毫秒内没有响应（网络可能不通，或服务被墙）`
      : `${label}请求失败：${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const hint = res.status === 404 ? '接口地址可能配错了' : '服务暂时不可用，稍后再试';
    throw new Error(`${label}返回 HTTP ${res.status}（${hint}）`);
  }
  try {
    return JSON.parse(await res.text());
  } catch (error) {
    throw new Error(`${label}返回的不是有效 JSON`);
  }
}

/** 查天气主流程：地理编码 → 预报 → 拼文本。所有失败都转成 isError 的可读文案。 */
async function queryWeather(fetchFn, args, s) {
  const city = String(args?.city ?? '').trim();
  if (!city) return { content: '要查天气得先告诉我是哪个城市。', isError: true };
  if (city.length > 80) return { content: '城市名太长了，请给一个正常的地名。', isError: true };

  let hit;
  try {
    const geo = await fetchJson(
      fetchFn,
      `${s.geocodeUrl}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`,
      { timeoutMs: s.timeoutMs, label: '地理编码' }
    );
    hit = geo?.results?.[0];
  } catch (error) {
    return { content: String(error?.message ?? error), isError: true };
  }
  if (!hit) {
    return {
      content: `没有查到叫「${city}」的地方。可以换个更正式的城市名，或者加上省份再试（例如「苏州」可以写「江苏苏州」）。`,
      isError: true
    };
  }

  let forecast;
  try {
    forecast = await fetchJson(
      fetchFn,
      `${s.forecastUrl}?latitude=${hit.latitude}&longitude=${hit.longitude}`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
        + `&timezone=auto&forecast_days=${Math.min(MAX_DAYS, clampInt(args?.days, 1, MAX_DAYS, s.defaultDays))}`,
      { timeoutMs: s.timeoutMs, label: '天气服务' }
    );
  } catch (error) {
    return { content: String(error?.message ?? error), isError: true };
  }

  const daily = forecast?.daily;
  if (!daily || !Array.isArray(daily.time) || !daily.time.length) {
    return { content: '天气服务没有返回预报数据，稍后再试。', isError: true };
  }

  const place = hit.name
    + (hit.admin1 && hit.admin1 !== hit.name ? `（${hit.admin1}）` : '')
    + (hit.country ? ` · ${hit.country}` : '');
  return { content: formatDaily(place, daily, clampInt(args?.days, 1, MAX_DAYS, s.defaultDays)) };
}

// ── 插件生命周期（旧入口 register）─────────────────────────────────────────

export function register(api) {
  cfg = api.config;
  const log = api.log || (() => {});
  log('天气查询已就绪（数据源 Open-Meteo）');

  api.registerTool({
    id: 'weather',
    name: '查天气',
    description: '查询一个城市未来几天的天气预报（温度区间、天气现象、降水概率）。用户问天气时用它查，不要凭空编造。',
    category: 'query',
    icon: '🌤️',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，例如「广州」或「湖北荆州」' },
        days: { type: 'integer', description: `要几天的预报（1~${MAX_DAYS}，默认 3）` }
      },
      required: ['city']
    },
    async execute(_ctx, args) {
      return queryWeather(api.fetch, args, settings());
    }
  });
}

/** 无必填配置 → 恒可用（见文件头说明）。 */
export function available() { return { ok: true }; }

export const internals = {
  settings, wmoText, WMO_TEXT, clampInt, fetchJson, queryWeather, formatDaily,
  DEFAULTS, MAX_DAYS
};
