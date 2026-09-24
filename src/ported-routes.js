// 移植层 + 实例管理的 HTTP 路由（自包含模块，挂在 app.js 的 handleHttp 前面）。
//
// 为什么单独成文件：与 skill-routes.js 同样的理由 —— A 版的路由都写死在
// app.js 的 handleHttp 里，整体抽成路由表是另一件事；这里把"移植层管理"和
// "多实例"两组聚成一个模块，保持对 app.js 的最小侵入。
//
// 路由一览：
//   GET  /api/ported/status            情绪/情爱/棋局/临时设定/梗库/风格库/活动账本 总览
//   POST /api/ported/emotion           手工设置或清除某会话的情绪
//   POST /api/ported/intimacy          手工设置或清除某会话的情爱等级
//   POST /api/ported/chess             棋局操作（start/move/undo/finish/clear）
//   POST /api/ported/temp-setting      临时设定（set/remove/clear）
//   POST /api/ported/meme              梗库（add/remove）
//   GET  /api/ported/admin             群管理员指令配置 + 当前禁言群
//   POST /api/ported/admin             改开关/固定话术/管理员/解除禁言
//   POST /api/ported/persona-distill   角色蒸馏（会话记录 / 粘贴文本 → 角色卡草稿）
//   GET  /api/instances                实例快照（多开）
//   POST /api/instances/launch         启动某个实例
//   POST /api/instances/launch-all     全部启动
//   POST /api/instances/create         新建实例
import { listEmotions, setEmotion, clearEmotion } from './emotion.js';
import { listIntimacy, setIntimacy, clearIntimacy } from './intimacy.js';
import { listChess, startGame, playMove, undoMove, finishGame, clearChess } from './chess.js';
import { listTempSettings, setTempSetting, removeTempSettingAny, clearTempSettingsAny } from './temp-settings.js';
import { listAdmins, setAdmin } from './admin.js';
import { listMuted, unmuteGroup } from './mute.js';
import { collectChatSamples, collectTextSamples, distillPersona } from './persona-distill.js';
import { readActivity } from './bus.js';
import { portedHooksStatus } from './agent-hooks.js';
import { instancesSnapshot, listInstances, launchInstance, launchAll, createInstance } from './instances-hub.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { getGlobalBlocklist, updateGlobalBlocklist } from './community.js';

export function createPortedRoutes({
  getConfig,
  updateConfig,
  emit = () => {},
  json,
  readBody,
  log = () => {},
  memory = null,
  store = null,
  reloadSkills = null
}) {
  /** 任何子系统出错都不该让整个状态页 500 —— 逐项兜底成空数组。 */
  const safeList = (fn, fallback = []) => {
    try { return fn() ?? fallback; } catch { return fallback; }
  };

  return async function handlePortedRoute({ pathname, method, req, res }) {
    // ── 移植层状态总览 ──
    if (pathname === '/api/ported/status' && method === 'GET') {
      json(res, 200, {
        ok: true,
        hooks: portedHooksStatus(),
        emotions: safeList(() => listEmotions({}), []),
        intimacy: safeList(() => listIntimacy({}), []),
        chess: safeList(() => listChess({}), []),
        tempSettings: safeList(() => listTempSettings({}), []),
        memes: safeList(() => (memory?.memes?.list ? memory.memes.list({ limit: 200 }) : []), []),
        styles: safeList(() => (memory?.style?.list ? memory.style.list() : []), []),
        activity: safeList(() => readActivity({ limit: 60 }), [])
      });
      return true;
    }

    if (pathname === '/api/ported/emotion' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const chatKey = String(body.chatKey || '').trim();
      if (!chatKey) { json(res, 400, { ok: false, error: '缺少 chatKey' }); return true; }
      if (body.clear === true) {
        const r = clearEmotion(chatKey);
        if (r && r.ok === false) { json(res, 400, { ok: false, error: r.error }); return true; }
        json(res, 200, { ok: true, cleared: !!r?.removed });
        return true;
      }
      // ⚠️ setEmotion 一律返回 { ok, error?, key?, name? }，不是情绪状态对象本身。
      //    必须显式判 ok，否则 mood 写错时会 200 + 静默不生效。
      const r = setEmotion(chatKey, {
        mood: body.mood,
        intensity: body.intensity,
        reason: body.reason ?? '手工设置',
        by: 'manual',
        pinned: body.pinned === true
      });
      if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '情绪值不合法' }); return true; }
      log(`[ported] 情绪已设置 ${chatKey} -> ${r.key}(${r.intensity})`);
      json(res, 200, { ok: true, state: r });
      return true;
    }

    if (pathname === '/api/ported/intimacy' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const chatKey = String(body.chatKey || '').trim();
      if (!chatKey) { json(res, 400, { ok: false, error: '缺少 chatKey' }); return true; }
      if (body.clear === true) {
        const r = clearIntimacy(chatKey);
        if (r && r.ok === false) { json(res, 400, { ok: false, error: r.error }); return true; }
        json(res, 200, { ok: true, cleared: !!r?.removed });
        return true;
      }
      const r = setIntimacy(chatKey, {
        value: body.value, delta: body.delta,
        reason: body.reason ?? '手工设置', by: 'manual'
      });
      if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '情爱值不合法' }); return true; }
      log(`[ported] 情爱等级已设置 ${chatKey} -> ${r.value}`);
      json(res, 200, { ok: true, state: r });
      return true;
    }

    if (pathname === '/api/ported/chess' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const chatKey = String(body.chatKey || '').trim();
      if (!chatKey) { json(res, 400, { ok: false, error: '缺少 chatKey' }); return true; }
      const action = String(body.action || 'start').trim();
      if (action === 'clear') {
        const r = clearChess(chatKey);
        if (r && r.ok === false) { json(res, 400, { ok: false, error: r.error }); return true; }
        json(res, 200, { ok: true, cleared: !!r?.removed });
        return true;
      }
      let r = null;
      if (action === 'start') r = startGame(chatKey, { botSide: body.botSide || '', force: body.force === true });
      else if (action === 'move') r = playMove(chatKey, { move: body.move, as: body.as || '', by: 'manual' });
      else if (action === 'undo') r = undoMove(chatKey, { plies: Number(body.plies) || 2 });
      else if (action === 'finish') r = finishGame(chatKey, { kind: body.kind || 'abort', who: body.who || '' });
      else { json(res, 400, { ok: false, error: `未知 action「${action}」` }); return true; }
      if (!r || r.ok === false) {
        // 棋局的错误信息对用户很有价值（列出可行着法），原样透传
        json(res, 400, { ok: false, error: r?.error || '操作失败', candidates: r?.candidates });
        return true;
      }
      json(res, 200, { ok: true, state: r.state ?? r });
      return true;
    }

    if (pathname === '/api/ported/temp-setting' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const groupId = String(body.groupId || '').trim();
      if (!groupId) { json(res, 400, { ok: false, error: '缺少 groupId' }); return true; }
      const action = String(body.action || 'set').trim();
      if (action === 'set') {
        const r = setTempSetting(groupId, {
          text: body.text, ttlMin: body.ttlMin, summary: body.summary,
          by: 'manual', note: body.note
        });
        if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '设置失败' }); return true; }
        json(res, 200, { ok: true, item: r.item ?? r });
        return true;
      }
      if (action === 'remove') {
        const r = removeTempSettingAny(groupId, body.id);
        if (r && r.ok === false) { json(res, 404, { ok: false, error: r.error }); return true; }
        json(res, 200, { ok: true, removed: !!r?.removed });
        return true;
      }
      if (action === 'clear') {
        const r = clearTempSettingsAny(groupId);
        if (r && r.ok === false) { json(res, 400, { ok: false, error: r.error }); return true; }
        json(res, 200, { ok: true, cleared: true, removed: r?.removed ?? 0 });
        return true;
      }
      json(res, 400, { ok: false, error: `未知 action「${action}」` });
      return true;
    }

    if (pathname === '/api/ported/meme' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || 'add').trim();
      if (!memory?.memes) { json(res, 503, { ok: false, error: '梗库子系统未挂载' }); return true; }
      if (action === 'add') {
        // ⚠️ MemeStore.add 一律返回 { ok, error?, entry? } —— 不是条目本身。
        //    早期写成"有返回就算成功"，空文本走 ok:false 却回了 200，UI 以为加成功了。
        const r = memory.memes.add({
          text: body.text, source: body.source || 'manual',
          tags: body.tags || [], chat: body.chat || ''
        });
        if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '添加失败' }); return true; }
        json(res, 200, { ok: true, entry: r.entry, merged: !!r.merged });
        return true;
      }
      if (action === 'remove') {
        const r = typeof memory.memes.remove === 'function'
          ? memory.memes.remove(body.id)
          : { ok: false, error: '梗库不支持删除' };
        json(res, r?.ok === false ? 404 : 200, { ok: r?.ok !== false, error: r?.error });
        return true;
      }
      json(res, 400, { ok: false, error: `未知 action「${action}」` });
      return true;
    }

    // ── 群管理员指令配置 ──
    if (pathname === '/api/ported/admin' && method === 'GET') {
      const c = getConfig().admin || {};
      json(res, 200, {
        ok: true,
        enabled: c.enabled !== false,
        admins: safeList(() => listAdmins(), []),
        muteReply: String(c.muteReply ?? ''),
        mutedGroups: safeList(() => listMuted(), [])
      });
      return true;
    }
    if (pathname === '/api/ported/admin' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || '').trim();
      if (action === 'enabled') {
        updateConfig({ admin: { enabled: body.enabled !== false } });
        json(res, 200, { ok: true });
        return true;
      }
      if (action === 'muteReply') {
        updateConfig({ admin: { muteReply: String(body.muteReply ?? '').slice(0, 200) } });
        json(res, 200, { ok: true });
        return true;
      }
      if (action === 'setAdmin') {
        // userId 为空 = 清除该群管理员；groupId='*' = 全局管理员
        const r = setAdmin(body.groupId, body.userId ?? '');
        if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '设置失败' }); return true; }
        json(res, 200, { ok: true, ...r, admins: listAdmins() });
        return true;
      }
      if (action === 'unmute') {
        const r = unmuteGroup(body.groupId);
        if (!r || r.ok === false) { json(res, 400, { ok: false, error: r?.error || '解除失败' }); return true; }
        json(res, 200, { ok: true, groupId: r.groupId, wasMuted: r.wasMuted });
        return true;
      }
      json(res, 400, { ok: false, error: `未知 action「${action}」` });
      return true;
    }

    // ── 角色蒸馏 ──
    if (pathname === '/api/ported/persona-distill' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      if (!store) { json(res, 503, { ok: false, error: '核心未提供消息存档' }); return true; }
      const source = body.source === 'chats' ? 'chats' : 'text';
      let samples = [];
      try {
        if (source === 'chats') {
          const chatKeys = Array.isArray(body.chatKeys) ? body.chatKeys : [];
          if (!chatKeys.length) { json(res, 400, { ok: false, error: '请选择至少一个会话' }); return true; }
          const picked = collectChatSamples(store, {
            chatKeys,
            speaker: String(body.speaker || 'self'),
            maxLines: Math.min(1500, Math.max(20, Number(body.maxLines) || 400))
          });
          samples = picked.lines;
        } else {
          const picked = collectTextSamples(String(body.text ?? ''), {
            maxLines: Math.min(2000, Math.max(20, Number(body.maxLines) || 600)),
            speaker: String(body.speakerLabel || '')
          });
          samples = picked.lines;
        }
      } catch (error) {
        json(res, 400, { ok: false, error: `样本抽取失败：${error?.message ?? error}` });
        return true;
      }
      if (samples.length < 5) {
        json(res, 400, { ok: false, error: `有效样本太少（${samples.length} 条），至少需要 5 条才谈得上蒸馏` });
        return true;
      }
      try {
        const r = await distillPersona({
          source, samples,
          hint: String(body.hint ?? ''),
          name: String(body.name ?? ''),
          speakerLabel: String(body.speakerLabel ?? '')
        });
        log(`[ported] 角色蒸馏完成：${r.name}（${r.sampleCount} 条样本，置信度 ${r.confidence}）`);
        json(res, 200, { ok: true, ...r });
      } catch (error) {
        json(res, 502, { ok: false, error: error?.message ?? String(error) });
      }
      return true;
    }

    // ── 实例管理（多开）──
    // 磁盘真值枚举（src/instances-hub.js），不设注册表 —— 目录就是真相。
    if (pathname === '/api/instances' && method === 'GET') {
      const cfg = getConfig();
      const snap = instancesSnapshot();
      // autoStartPeers 由 UI 在这页读写，跟快照一起回（省一次 /api/config 请求）
      json(res, 200, { ...snap, autoStartPeers: !!cfg.server?.autoStartPeers });
      return true;
    }
    if (pathname === '/api/instances/launch' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const id = String(body.id ?? '').trim();
      const inst = listInstances().find((x) => String(x.id) === id || String(x.profileId) === id);
      if (!inst) { json(res, 404, { ok: false, error: `找不到实例「${id}」` }); return true; }
      const r = launchInstance(inst);
      json(res, r.ok ? 200 : 400, { ok: r.ok, id: inst.id, error: r.error, reason: r.reason });
      return true;
    }
    if (pathname === '/api/instances/launch-all' && method === 'POST') {
      const r = launchAll();
      json(res, 200, { ok: r.failed.length === 0, started: r.started, skipped: r.skipped, failed: r.failed });
      return true;
    }
    if (pathname === '/api/instances/create' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const r = createInstance({ profile: body.profileId ?? body.profile, name: body.name });
      if (!r.ok) { json(res, 400, { ok: false, error: r.error }); return true; }
      log(`[instances] 已新建实例 ${r.profile}（${r.dataDir}，控制台 ${r.port}）`);
      json(res, 200, r);
      return true;
    }

    // ── 社区云端屏蔽名单（所有群共享；删除/覆盖需要管理密钥）──
    if (pathname === '/api/community/blocklist' && method === 'GET') {
      json(res, 200, { ok: true, ids: safeList(() => getGlobalBlocklist(), []) });
      return true;
    }
    if (pathname === '/api/community/blocklist' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      try {
        const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
        emit('status', { communityBlocklistUpdated: true });
        json(res, 200, { ok: true, ids: actual, warning: warning || '' });
      } catch (error) {
        json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
      }
      return true;
    }

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    if (pathname === '/api/market/accounts' && method === 'GET') {
      const accounts = safeList(() => listAccounts(), []).map((a) => ({ username: a.username, savedAt: a.savedAt }));
      json(res, 200, { ok: true, accounts });
      return true;
    }
    if (pathname === '/api/market/login' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const r = await loginAccount({
          loginId: String(body?.loginId || ''),
          displayName: String(body?.displayName || ''),
          password: String(body?.password || ''),
          mode: body?.mode === 'register' ? 'register' : 'login'
        });
        json(res, 200, {
          ok: true,
          account: r.account,
          accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt }))
        });
      } catch (error) {
        json(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return true;
    }
    if (pathname === '/api/market/logout' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const username = String(body?.username || '');
      if (!username) { json(res, 400, { ok: false, error: '缺少 username' }); return true; }
      const accounts = await removeAccount(username);
      json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      return true;
    }
    if (pathname === '/api/market/publish' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
      const id = String(body?.id || '');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
        json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        return true;
      }
      const acc = safeList(() => listAccounts(), []).find((a) => a.username === String(body?.accountUsername || ''));
      if (!acc) { json(res, 401, { ok: false, error: '请先选择一个已登录的账号' }); return true; }
      try {
        const r = await publishModule({
          kind, id,
          displayName: String(body?.displayName || ''),
          description: String(body?.description || ''),
          token: acc.token
        });
        json(res, 200, { ok: true, item: r.item || null, renamedTo: r.renamedTo || null, note: r.note || '' });
      } catch (error) {
        json(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return true;
    }
    if (pathname === '/api/market/verify' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
        .map((c) => String(c ?? '').trim().toUpperCase())
        .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
        .slice(0, 30);
      if (!codes.length) { json(res, 400, { ok: false, error: '没有有效的口令' }); return true; }
      try {
        const results = await verifyInstallCodes(codes);
        json(res, 200, { ok: true, results });
      } catch (error) {
        json(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return true;
    }
    if (pathname === '/api/market/install' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const code = String(body?.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) { json(res, 400, { ok: false, error: '口令格式无效' }); return true; }
      try {
        const r = await installByCode({ code, verified: body?.entry || null });
        // 安装完立即重扫，让新模块马上出现在页签里（目录删除重建的场景 watcher 会丢事件）
        if (typeof reloadSkills === 'function') {
          try { await reloadSkills('market-install'); } catch { /* 重扫失败不影响安装结果 */ }
        }
        json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
      } catch (error) {
        json(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return true;
    }

    return false;
  };
}
