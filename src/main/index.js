const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const { loadWorkspace, saveWorkspace, addSession } = require('./workspaceController');
const { ensureContainer, sendToContainer, getContainerHwnd, destroyContainer, isContainerAlive } = require('./browserInstanceManager');
const { bindHotkeys, unbindAll } = require('./focusController');
const { focusWindow, placeWindow } = require('./win32/windowOps');
const { stopTracking } = require('./overlayManager');
const hoverFocus = require('./hoverFocus');

// Single instance — two Citras would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.commandLine.appendSwitch('high-dpi-support', '1');

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
      },
      () => BrowserWindow.getFocusedWindow() !== null,
    );
  }

  function sendGameUpdate(applyRatio = false) {
    const active = workspace.sessions.filter(s => s.state !== 'idle');
    sendToContainer(CH.GAME_UPDATE, {
      sessions:   active.map(({ id, name, url, accentColor }) => ({ id, name, url, accentColor })),
      preset:     workspace.activePreset || 'split-h-50',
      applyRatio,
    });
  }

  ipcMain.handle(CH.GET_WORKSPACE, () => workspace);

  ipcMain.handle(CH.ADD_SESSION, (_e, { name }) => {
    return addSession(workspace, name);
  });

  ipcMain.handle(CH.SAVE_WORKSPACE, (_e, patch) => {
    saveWorkspace(workspace, patch);
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

    if (!workspace.sessions.some(s => s.state !== 'idle')) destroyContainer();

    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.APPLY_LAYOUT, (_e, { preset }) => {
    workspace.activePreset = preset || workspace.activePreset;
    if (!isContainerAlive()) return { error: 'No active game window' };

    // Maximize container to fill primary display work area
    const display = screen.getPrimaryDisplay();
    const sf = display.scaleFactor;
    const wa = display.workArea;
    const hwnd = getContainerHwnd();
    if (hwnd) {
      placeWindow(hwnd, {
        x:      Math.round(wa.x      * sf),
        y:      Math.round(wa.y      * sf),
        width:  Math.round(wa.width  * sf),
        height: Math.round(wa.height * sf),
      });
    }

    // Tell game window to apply new preset ratio/direction
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
    workspace.sessions.forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
    session.state = 'active';
    workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    return { ok: true };
  });

  // Game container signals readiness — send current session state
  ipcMain.on(CH.GAME_READY, () => sendGameUpdate());

  // Only activate if user has explicitly enabled it in settings
  if (workspace.hoverFocusEnabled) {
    hoverFocus.start(() => workspace.sessions, {
      delayMs: workspace.hoverFocusDelayMs || 400,
    });
  }

  ipcMain.handle(CH.SET_HOVER_FOCUS, (_e, { enabled, delayMs }) => {
    workspace.hoverFocusEnabled = enabled;
    workspace.hoverFocusDelayMs = delayMs || 400;
    saveWorkspace(workspace);
    if (enabled) hoverFocus.start(() => workspace.sessions, { delayMs });
    else hoverFocus.stop();
    return { ok: true };
  });
});

app.on('before-quit', () => { stopTracking(); hoverFocus.stop(); unbindAll(); });
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
