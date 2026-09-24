// 技能/插件管理的 HTTP 路由（自包含模块，挂在 app.js 的 handleHttp 前面）。
//
// 为什么单独成文件：A 版的路由都写死在 app.js 的 handleHttp 里，整体抽成路由表
// 是另一件事；这里只把"技能系统"这一组聚成一个模块，保持对 app.js 的最小侵入。
//
// 路由一览：
//   GET  /api/skills                技能/插件列表 + 汇总 + 能力表 + 未安装残留
//   POST /api/skills/reload         重扫磁盘（重扫 + 激活 + 刷工具 + 重建 watcher）
//   POST /api/skills/cleanup        清理"已配置但未安装"的残留配置段
//   GET  /api/skills/capabilities   能力表（含可用性与原因）
//   POST /api/skills/upload         上传 zip 安装包（原始二进制 body，装完自动重扫）
//   POST /api/skills/:id            切开关 / 改设置（设置只允许 manifest 声明过的键）
//   GET  /api/tools                 工具清单
//   GET  /api/tools/availability    工具可用性（含被排除的原因，UI 排障用）
import path from 'node:path';
import { ROOT } from './config.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { modelImageVerdict } from './vision-scan.js';
// zip 解压安装（含路径穿越 / 可执行后缀 / zip 炸弹防护）—— 与市场口令安装共用同一份实现
import { unzipToModuleDir, validateZipStructure } from './zip-install.js';

// 上传包大小上限，与市场下载的 MAX_ZIP_BYTES（market.js）保持一致 ——
// 两条安装路径（口令下载 / 本地上传）对同一个东西不该有不同尺度。
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * 读取**原始二进制**请求体（上传 zip 用）。
 *
 * 不能复用 app.js 的 readBody：那个按 UTF-8 解成字符串再 JSON.parse，
 * 二进制 zip 经它一转就废了；而且它的上限只有 2MB。
 * 边读边计数，超限立即抛错 —— 不先攒满再判断，否则大文件还是会占满内存。
 */
async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new Error(`安装包超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 检查上传的 zip 是不是一个合法的技能/插件包，并推断它该装到哪个目录。
 *
 * 类型判据与 `plugin-loader.readManifest`、`market.installByCode` 完全一致：
 * **skill.json → skills/、plugin.json → plugins/**（两者都有时 skill.json 优先）。
 * 这样"上传"和"口令安装"两条路不会把同一个包装到不同目录。
 *
 * 这里做的是**写盘之前**的校验：清单不在包根就直接拒绝，避免留下一个
 * 加载不起来的垃圾目录让用户去手动删。
 *
 * @returns {{ type: 'skill'|'plugin', manifestId: string }}
 */
function inspectUploadPackage(buffer) {
  const entries = validateZipStructure(buffer);   // 结构非法（路径穿越/可执行后缀/超量）会抛错
  if (!entries.length) throw new Error('安装包是空的');

  // 剥根目录的判断必须与 zip-install.unzipToModuleDir 一致（否则会"这里说没有、那边装成功"）
  const names = entries.map((e) => e.name);
  const firstSeg = String(names[0] || '').split('/')[0];
  const strip = firstSeg && names.every((n) => n.startsWith(firstSeg + '/')) ? firstSeg.length + 1 : 0;
  const top = new Set(names.map((n) => n.slice(strip)));

  const hasSkill = top.has('skill.json');
  const hasPlugin = top.has('plugin.json');
  if (!hasSkill && !hasPlugin) {
    throw new Error('zip 里没有 skill.json 或 plugin.json（清单必须放在包根目录；如果压缩时套了两层文件夹，请重新打包）');
  }
  const manifestName = hasSkill ? 'skill.json' : 'plugin.json';
  const entry = entries.find((e) => e.name.slice(strip) === manifestName);

  // 包内声明的 id：没有统一根目录时用它当落地目录名（否则只能叫 'module'，很难看）。
  // 解析失败不拦 —— 让加载器去报"清单解析失败"，那段文案比这里更准确。
  let manifestId = '';
  try {
    manifestId = String(JSON.parse(String(entry.data.toString('utf8')).replace(/^\uFEFF/, '')).id || '').trim();
  } catch { /* 清单不是合法 JSON，交给加载器报错 */ }

  return { type: hasSkill ? 'skill' : 'plugin', manifestId };
}

export function createSkillRoutes({
  getConfig,
  updateConfig,
  emit = () => {},
  json,
  readBody,
  sanitizeConfig = (c) => c,
  reloadSkills = null,
  // 装配根目录：默认项目根（其下有 skills/ 与 plugins/）。留成参数是为了让测试
  // 能把包装进临时目录，不必往真实仓库里写文件再清理。
  moduleRoot = ROOT
}) {
  /** 与 orchestrator 同款的运行期上下文（UI 判可用性与运行时必须一致）。 */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  return async function handleSkillRoute({ pathname, method, req, res }) {
    if (pathname === '/api/skills' && method === 'GET') {
      const context = skillRuntimeContext();
      // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
      // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
      const installedIds = new Set(skillManager.list(context).map((s) => s.id));
      const uninstalled = listConfiguredSkillIds()
        .filter((id) => !installedIds.has(id))
        .map((id) => {
          const c = getConfig()?.skills?.[id] || {};
          return {
            id,
            enabled: c.enabled !== false,
            hasSettings: Object.keys(c).some((k) => k !== 'enabled')
          };
        });
      json(res, 200, {
        skills: skillManager.list(context),
        summary: skillManager.summary(context),
        capabilities: skillManager.capabilities.list().sort(),
        uninstalled
      });
      return true;
    }

    if (pathname === '/api/skills/reload' && method === 'POST') {
      if (typeof reloadSkills !== 'function') {
        json(res, 500, { ok: false, error: '核心未提供 reloadSkills' });
        return true;
      }
      try {
        const result = await reloadSkills('manual');
        const context = skillRuntimeContext();
        json(res, 200, {
          ok: true,
          loaded: (result.loaded || []).map((r) => r.id),
          failed: (result.failed || []).map((r) => ({ id: r.id, error: r.error })),
          pruned: result.pruned,
          toolCount: result.toolCount,
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort()
        });
      } catch (error) {
        json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
      }
      return true;
    }

    // ── 上传 zip 安装（界面直传）──
    // body 是**原始 zip 字节**，不是 JSON —— 所以这里不能走 readBody。
    // 装完立刻重扫：用户的预期是"传完就能用"，不该还要再点一次「重扫磁盘」。
    if (pathname === '/api/skills/upload' && method === 'POST') {
      if (typeof reloadSkills !== 'function') {
        json(res, 500, { ok: false, error: '核心未提供 reloadSkills' });
        return true;
      }
      let buffer;
      try {
        buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
      } catch (error) {
        // 413：体太大。不先攒满再判断，否则大文件照样把内存吃满
        json(res, 413, { ok: false, error: String(error?.message ?? error) });
        return true;
      }
      if (!buffer.length) { json(res, 400, { ok: false, error: '上传内容为空' }); return true; }

      // 写盘**之前**先判"是不是合法技能包、该装到哪" —— 否则会留下一个
      // 加载不起来的目录，用户还得自己去 skills/ 里删。
      let info;
      try {
        info = inspectUploadPackage(buffer);
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) });
        return true;
      }

      let dirName;
      try {
        dirName = await unzipToModuleDir(buffer, {
          root: moduleRoot, type: info.type, preferId: info.manifestId
        });
      } catch (error) {
        json(res, 500, { ok: false, error: `解压安装失败：${String(error?.message ?? error)}` });
        return true;
      }

      let reload = null;
      let reloadError = '';
      try {
        reload = await reloadSkills('upload');
      } catch (error) {
        reloadError = String(error?.message ?? error);
      }

      const context = skillRuntimeContext();
      const skills = skillManager.list(context);
      // 找刚装的那条：按**包内声明的 id** 找，不能按目录名 ——
      // 重名时 unzipToModuleDir 会给目录加 _1 后缀，但 manifest.id 不变。
      const installed = skills.find((s) => s.id && s.id === info.manifestId)
        || skills.find((s) => s.id === dirName)
        || null;
      const failHit = (reload?.failed || []).find((f) => f.id === info.manifestId || f.id === dirName);
      // 加载失败要如实回给界面：文件确实写进去了，但用户得知道它没跑起来
      const loadError = installed?.loadError || failHit?.error || reloadError || '';

      json(res, 200, {
        ok: true,
        type: info.type,
        dirName,
        dir: path.join(moduleRoot, info.type === 'plugin' ? 'plugins' : 'skills', dirName),
        id: installed?.id || info.manifestId || dirName,
        installed: installed
          ? {
            id: installed.id,
            name: installed.name,
            enabled: installed.enabled,
            active: installed.active,
            reason: installed.reason
          }
          : null,
        loadError,
        skills,
        summary: skillManager.summary(context),
        capabilities: skillManager.capabilities.list().sort(),
        toolCount: reload?.toolCount
      });
      return true;
    }

    if (pathname === '/api/skills/cleanup' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { json(res, 400, { ok: false, error: '缺少 ids' }); return true; }
      const installed = new Set(skillManager.list().map((s) => s.id));
      const removable = ids.filter((id) => !installed.has(id));
      if (!removable.length) {
        json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        return true;
      }
      const skillsCfg = getConfig()?.skills || {};
      const next = { ...skillsCfg };
      for (const id of removable) delete next[id];
      // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
      updateConfig({ skills: { __replace__: next } });
      emit('status', { configUpdated: true });
      json(res, 200, {
        ok: true,
        removed: removable,
        skipped: ids.filter((id) => installed.has(id)),
        config: sanitizeConfig(getConfig())
      });
      return true;
    }

    if (pathname === '/api/skills/capabilities' && method === 'GET') {
      const context = skillRuntimeContext();
      const caps = skillManager.capabilities.list().sort();
      json(res, 200, {
        capabilities: caps.map((c) => ({ name: c, ...skillManager.explainCapability(c, context) }))
      });
      return true;
    }

    if (pathname === '/api/tools' && method === 'GET') {
      json(res, 200, {
        tools: listTools().map((t) => ({
          id: t.id, name: t.name, category: t.category, icon: t.icon, skillId: t.skillId ?? null
        }))
      });
      return true;
    }

    if (pathname === '/api/tools/availability' && method === 'GET') {
      const context = skillRuntimeContext();
      const availability = availabilityOf(context);
      const defs = new Map(listTools().map((t) => [t.id, t]));
      json(res, 200, {
        categories: CATEGORY_META,
        tools: availability.map((a) => ({
          id: a.id,
          category: defs.get(a.id)?.category || 'system',
          skillId: a.skillId,
          enabled: a.enabled,
          code: a.code,
          reason: a.reason
        }))
      });
      return true;
    }

    const m = /^\/api\/skills\/([^/]+)$/.exec(pathname);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req).catch(() => ({}));
      const context = skillRuntimeContext();
      const skill = skillManager.registry.get(id);
      if (!skill) { json(res, 404, { ok: false, error: `Skill 不存在：${id}` }); return true; }

      // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
      //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
      if (body.enabled !== undefined) {
        setSkillEnabled(id, !!body.enabled);
        if (body.enabled) skillManager.activate(id, context);
        else skillManager.deactivate(id, context);
      }

      // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
      if (body.settings && typeof body.settings === 'object') {
        const allowed = new Set([
          ...Object.keys(skill.manifest.settings || {}),
          ...Object.keys(skill.manifest.configSchema || {})
        ]);
        const schema = skill.manifest.configSchema || {};
        const patch = {};
        for (const [k, v] of Object.entries(body.settings)) {
          if (!allowed.has(k)) continue;
          // 密文字段：收到脱敏占位符或空串 = "不修改"。
          // 不这么做的话，用户只是打开表单点了保存，Cookie/Key 就被覆盖成 '******'。
          if (schema[k]?.secret && (v === '******' || String(v ?? '').trim() === '')) continue;
          patch[k] = v;
        }
        if (Object.keys(patch).length) setSkillConfig(id, patch);
      }

      emit('status', { configUpdated: true });
      json(res, 200, {
        ok: true,
        skill: skillManager.status(id, context),
        // 响应里的 settings 必须用脱敏视图，别把 apiKey / Cookie 原文发回浏览器
        settings: skillManager.settingsView(id),
        config: sanitizeConfig(getConfig())
      });
      return true;
    }

    return false;
  };
}
