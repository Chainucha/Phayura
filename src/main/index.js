const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const { loadWorkspace, saveWorkspace, addSession, deleteSession, renameSession } = require('./workspaceController');
const { ensureContainer, sendToContainer, getContainerHwnd, destroyContainer, isContainerAlive, maximizeContainer, toggleFullscreenContainer } = require('./browserInstanceManager');
const { bindHotkeys, unbindAll, enableContainerHotkeys, disableContainerHotkeys } = require('./focusController');
const { focusWindow } = require('./win32/windowOps');
const { stopTracking } = require('./overlayManager');

// Single instance — two Citras would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── Performance switches (must run before app.whenReady) ──
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('disk-cache-size', '52428800'); // 50MB
// Stop Chromium throttling timers/raf/JS in unfocused game panes
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Force GPU compositor + canvas/raster accel — Electron is more conservative than Chrome by default
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
// Hybrid-GPU laptops: prefer discrete GPU for WebGL (Flyff uses Three.js/WebGL)
app.commandLine.appendSwitch('force_high_performance_gpu');

const workspace = loadWorkspace();

let dashboard;

function safeSend(channel, payload) {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send(channel, payload);
  }
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 980, height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '../preload/dashboard.js'),
    },
  });
  dashboard.loadFile(path.join(__dirname, '../renderer/dashboard/index.html'));
  if (process.env.NODE_ENV === 'dev') dashboard.webContents.openDevTools();
}


app.whenReady().then(() => {
  createDashboard();

  function rebindHotkeys() {
    bindHotkeys(
      workspace.sessions,
      (focused) => {
        workspace.sessions.forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
        focused.state = 'active';
        workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
        sendToContainer(CH.GAME_FOCUS_WEBVIEW, { id: focused.id });
      },
      () => BrowserWindow.getFocusedWindow() !== null,
      toggleFullscreenContainer,
    );
  }

  function sendGameUpdate(applyRatio = false) {
    const active = workspace.sessions.filter(s => s.state !== 'idle');
    sendToContainer(CH.GAME_UPDATE, {
      sessions:   active.map(({ id, name, url, accentColor }) => ({ id, name, url, accentColor })),
      preset:     workspace.activePreset || 'split-h-50',
      lockLayout: !!workspace.lockLayout,
      hoverFocusEnabled: !!workspace.hoverFocusEnabled,
      hoverFocusDelayMs: workspace.hoverFocusDelayMs || 400,
      applyRatio,
    });
  }

  ipcMain.handle(CH.GET_WORKSPACE, () => workspace);

  ipcMain.handle(CH.ADD_SESSION, (_e, { name }) => {
    const session = addSession(workspace, name);
    saveWorkspace(workspace);
    return session;
  });

  ipcMain.handle(CH.SAVE_WORKSPACE, (_e, patch) => {
    saveWorkspace(workspace, patch);
    if (patch && 'lockLayout' in patch && isContainerAlive()) sendGameUpdate();
    return true;
  });

  ipcMain.handle(CH.LAUNCH_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session) return { error: 'Session not found' };
    if (session.state !== 'idle') return { error: 'Session already active' };

    const container = ensureContainer(() => {
      // Game window closed by user — reset all active sessions
      workspace.sessions.forEach(s => {
        if (s.state !== 'idle') {
          s.hwnd = null; s.pid = null; s.state = 'idle';
          safeSend(CH.SESSION_STATE_CHANGED, { ...s });
        }
      });
      rebindHotkeys();
    });
    if (!container.__hotkeysWired) {
      container.on('focus', enableContainerHotkeys);
      container.on('blur',  disableContainerHotkeys);
      if (container.isFocused()) enableContainerHotkeys();
      container.__hotkeysWired = true;
    }

    session.hwnd  = getContainerHwnd();
    session.pid   = container.webContents.getOSProcessId();
    session.state = 'tracking';
    saveWorkspace(workspace);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });

    if (container.webContents.isLoading()) {
      container.webContents.once('did-finish-load', () => sendGameUpdate());
    } else {
      sendGameUpdate();
    }

    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.CLOSE_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session || session.state === 'idle') return { ok: true };

    session.hwnd = null; session.pid = null; session.state = 'idle';
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    sendGameUpdate();

    if (!workspace.sessions.some(s => s.state !== 'idle')) {
      destroyContainer();
      // Free per-session GPU/SW caches on full shutdown — keep cookies/localStorage for re-login
      workspace.sessions.forEach(s => {
        electronSession.fromPartition(`persist:${s.id}`)
          .clearStorageData({ storages: ['serviceworkers', 'shadercache', 'cachestorage'] })
          .catch(() => {});
      });
    }

    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.RENAME_SESSION, (_e, { id, name }) => {
    const session = renameSession(workspace, id, name);
    if (!session) return { error: 'Invalid name or session not found' };
    saveWorkspace(workspace);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    if (session.state !== 'idle' && isContainerAlive()) sendGameUpdate();
    return { ok: true, session: { ...session } };
  });

  ipcMain.handle(CH.DELETE_SESSION, async (_e, { id }) => {
    const target = workspace.sessions.find(s => s.id === id);
    if (!target) return { error: 'Session not found' };
    if (target.state !== 'idle') return { error: 'Close session before deleting' };
    if (!deleteSession(workspace, id)) return { error: 'Delete failed' };
    saveWorkspace(workspace);
    try { await electronSession.fromPartition(`persist:${id}`).clearStorageData(); } catch {}
    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.APPLY_LAYOUT, (_e, { preset }) => {
    workspace.activePreset = preset || workspace.activePreset;
    if (!isContainerAlive()) return { error: 'No active game window' };

    // Use Electron's maximize — correct DPI scaling, window-relative
    maximizeContainer();
    sendGameUpdate(true);

    const active = workspace.sessions.filter(s => s.state !== 'idle');
    active.forEach(s => { s.state = 'arranged'; });
    active.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    return { ok: true };
  });

  ipcMain.handle(CH.FOCUS_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session?.hwnd) return { error: 'Session has no tracked window' };
    focusWindow(session.hwnd);
    sendToContainer(CH.GAME_FOCUS_WEBVIEW, { id });
    workspace.sessions.forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
    session.state = 'active';
    workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    return { ok: true };
  });

  // Game container signals readiness — send current session state
  ipcMain.on(CH.GAME_READY, () => sendGameUpdate());


  ipcMain.handle(CH.SET_HOVER_FOCUS, (_e, { enabled, delayMs }) => {
    workspace.hoverFocusEnabled = !!enabled;
    workspace.hoverFocusDelayMs = delayMs || 400;
    saveWorkspace(workspace);
    if (isContainerAlive()) sendGameUpdate();
    return { ok: true };
  });
});

app.on('before-quit', () => { stopTracking(); unbindAll(); });
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
