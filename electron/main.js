// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDirName, describeInstance } from '../src/profile.js';


// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();

// 主进程兜底：未捕获异常不应静默吞掉。
// headless 入口（src/server.js）exit(1) 的理由在那里不成立 —— 那个有外层
// 守护重启。Electron 没有外层守护，进程挂掉后用户只能看到"托盘图标消失"。
// 折衷：拉起一个可见的错误对话框把异常亮给用户（至少知道为什么挂了），
// 确认后再退出 —— "半死不活地挂着"（定时器丢失/连接悬空但窗口还在）
// 是最难排查的状态，宁可死得明明白白。
process.on('unhandledRejection', (error) => {
  console.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  try {
    // dialog 在 app ready 前也允许调用（Electron 文档保证）。
    dialog.showErrorBox(
      'QQ Agent 发生未捕获错误',
      '程序遇到无法恢复的错误，即将退出。\n\n' +
      String(error?.stack ?? error?.message ?? error) +
      '\n\n完整日志见 data/logs/ 下的当日日志文件。'
    );
  } catch { /* 弹窗失败不拦截退出 */ }
  app.exit(1);
});

// AppUserModelID：让 Windows 把窗口归到「QQ Agent」身份下（任务栏分组/图标/通知），
// 否则 dev 模式下会被当成裸 electron.exe，钉任务栏变成 electron 图标
app.setAppUserModelId('cn.kondius.qq-agent');

// ── 数据目录：始终固定在「应用根目录/data」──
// Kondius 钦定：所有数据都存在安装目录下，不往 %APPDATA% 塞。
//   压缩包用户：data 本来就在压缩包目录里，直接用（项目内 data/）；
//   安装版用户：安装目录/exe 旁边的 data/。选压缩包目录当安装目录时
//   天然接管里面的 data/（config、记忆、聊天记录、telemetry id 全保留），零迁移零 bug。
// NSIS 覆盖安装只替换它自己装的文件，运行时生成的 data/ 不在清单里 → 升级不丢数据。
// 兼容兜底：外置 %APPDATA% 时期（2026-09-06 短命版本）的数据自动搬回安装目录。
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  // 开发模式（.bat 直起 node_modules 里的 electron.exe + 项目目录）：项目内 data/
  if (!app.isPackaged) return path.resolve(fileURLToPath(import.meta.url), '..', '..', dataDirName());
  const portable = path.join(path.dirname(app.getPath('exe')), dataDirName());
  try {
    if (!fs.existsSync(portable)) {
      // 仅主实例接管旧版遗留；第二实例绝不能把主实例旧数据复制进 data-2。
      if (dataDirName() !== 'data') return portable;
      // 接管旧版遗留：%APPDATA%/qq-agent/data（外置期版本）→ 搬回安装目录
      const legacy = path.join(app.getPath('userData'), 'data');
      if (fs.existsSync(legacy) && fs.readdirSync(legacy).length > 0) {
        fs.cpSync(legacy, portable, { recursive: true });
        console.log('[data] 已从 %APPDATA% 迁回安装目录:', legacy, '→', portable);
      }
    }
  } catch (error) {
    console.error('[data] 旧数据迁移失败（不影响启动，将从空数据开始）:', error?.message ?? error);
  }
  return portable;
}
process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow = null;
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(describeInstance());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core.getConfig().server?.autoStart,
      click: (item) => {
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showWindow());
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: describeInstance(),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  Menu.setApplicationMenu(null);
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程崩溃:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => console.error('[window] loadURL 失败:', error));
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器，不在应用内弹新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 主窗口只应停留在本机控制台。没有这道拦截时，页面里一个普通 <a href> 或
  // location.href=... 就能把主窗口导航到外部站点（脱离 127.0.0.1 源、
  // 控制台也不再指向本机）。外链改走系统浏览器。
  const isLocalConsole = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));
  const guardNavigation = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  try {
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    await createWindow(port);
    applyAutoStart();
    createTray();
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    app.quit();
  }
});

// 退出清理：core.stop() 是 async（要 abortAll / 关 SSE / 关 server / 释放单实例锁），
// 而 before-quit 是同步事件 —— 直接调它会让进程在 await 让出后就被销毁，
// 清理链跑一半：锁文件可能残留、会话最后一次进度可能丢、SnowLuma 子进程可能变孤儿。
// 正确做法：拦下这次退出，等 stop() 真正跑完再 app.quit()。
let shuttingDown = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shuttingDown || !core) return;      // 第二次进入（自己触发的 quit）直接放行
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve()
    .then(() => core.stop())
    .catch((error) => console.error('[electron] 退出清理失败:', error?.message ?? error))
    .finally(() => app.quit());
});
