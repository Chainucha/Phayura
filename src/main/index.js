const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const { loadWorkspace, saveWorkspace, addSession } = require('./workspaceController');
const { launchSession, closeSession } = require('./browserInstanceManager');
const { applyLayout } = require('./windowLayoutEngine');
const { bindHotkeys, unbindAll } = require('./focusController');
const { focusWindow } = require('./win32/windowOps');
const { createBadge, destroyBadge, startTracking, stopTracking, overlays } = require('./overlayManager');
const hoverFocus = require('./hoverFocus');

// Single instance — two Sunkists would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.commandLine.appendSwitch('high-dpi-support', '1');

// Runtime state (HWNDs are not persisted — they change each launch)
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
    bindHotkeys(workspace.sessions, (focused) => {
      workspace.sessions.forEach(s => {
        if (s.state === 'active') s.state = 'arranged';
      });
      focused.state = 'active';
      workspace.sessions.forEach(s =>
        safeSend(CH.SESSION_STATE_CHANGED, { ...s })
      );
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

    try {
      const { pid, hwnd } = launchSession(session, (closedId) => {
        const s = workspace.sessions.find(s => s.id === closedId);
        if (!s) return;
        s.hwnd = null; s.pid = null; s.state = 'idle';
        destroyBadge(closedId);
        safeSend(CH.SESSION_STATE_CHANGED, { ...s });
        rebindHotkeys();
      });
      session.pid   = pid;
      session.hwnd  = hwnd;
      session.state = 'tracking';
      saveWorkspace(workspace);
    } catch (err) {
      session.state = 'idle';
      return { error: err.message };
    }

    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    if (workspace.overlayVisible) createBadge(session);
    startTracking(() => workspace.sessions, 250);
    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.CLOSE_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session || session.state === 'idle') return { ok: true };
    closeSession(session);
    session.hwnd  = null;
    session.pid   = null;
    session.state = 'idle';
    destroyBadge(id);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    rebindHotkeys();
    return { ok: true };
  });

  ipcMain.handle(CH.APPLY_LAYOUT, (_e, { preset }) => {
    workspace.activePreset = preset || workspace.activePreset;
    const active = workspace.sessions.filter(s => s.hwnd);
    if (active.length === 0) return { error: 'No tracked windows to arrange' };
    try {
      applyLayout(workspace.activePreset, active);
      active.forEach(s => { s.state = 'arranged'; });
      active.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle(CH.FOCUS_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session?.hwnd) return { error: 'Session has no tracked window' };
    focusWindow(session.hwnd);
    workspace.sessions.forEach(s => {
      if (s.state === 'active') s.state = 'arranged';
    });
    session.state = 'active';
    workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    return { ok: true };
  });

  ipcMain.on(CH.OVERLAY_INTERACTIVE, (_e, { sessionId, on }) => {
    const win = overlays.get(sessionId);
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
  });

  ipcMain.on(CH.OVERLAY_FOCUS, (_e, { sessionId }) => {
    const session = workspace.sessions.find(s => s.id === sessionId);
    if (session?.hwnd) focusWindow(session.hwnd);
  });

  // Only activate if user has explicitly enabled it in settings
  if (workspace.hoverFocusEnabled) {
    hoverFocus.start(() => workspace.sessions, {
      delayMs: workspace.hoverFocusDelayMs || 400,
    });
  }

  // IPC to toggle from settings UI
  ipcMain.handle(CH.SET_HOVER_FOCUS, (_e, { enabled, delayMs }) => {
    workspace.hoverFocusEnabled = enabled;
    workspace.hoverFocusDelayMs = delayMs || 400;
    saveWorkspace(workspace);
    if (enabled) hoverFocus.start(() => workspace.sessions, { delayMs });
    else hoverFocus.stop();
    return { ok: true };
  });

  // Remaining handlers added in later tasks
});

app.on('before-quit', () => { stopTracking(); hoverFocus.stop(); unbindAll(); });
// Overlay BrowserWindows keep the app alive between dashboard closes.
// Explicit quit is triggered by before-quit or OS session end.
app.on('window-all-closed', () => {});

module.exports = { workspace };
