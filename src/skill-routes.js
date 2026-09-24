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
//   POST /api/skills/:id            切开关 / 改设置（设置只允许 manifest 声明过的键）
//   GET  /api/tools                 工具清单
//   GET  /api/tools/availability    工具可用性（含被排除的原因，UI 排障用）
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { modelImageVerdict } from './vision-scan.js';

export function createSkillRoutes({
  getConfig,
  updateConfig,
  emit = () => {},
  json,
  readBody,
  sanitizeConfig = (c) => c,
  reloadSkills = null
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
