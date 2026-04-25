const { randomUUID } = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store').default;
const CH = require('../shared/ipc-channels');
const { launchSession, closeSession } = require('./browserInstanceManager');
const { applyLayout } = require('./windowLayoutEngine');
const { bindHotkeys, unbindAll } = require('./focusController');
const { focusWindow } = require('./win32/windowOps');

// Single instance — two Sunkists would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

app.commandLine.appendSwitch('high-dpi-support', '1');

const store = new Store({ name: 'sunkist' });

// Runtime state (HWNDs are not persisted — they change each launch)
const workspace = loadWorkspace();

function loadWorkspace() {
  const saved = store.get('workspace');
  if (saved) {
    // Strip runtime-only fields
    saved.sessions.forEach(s => { s.hwnd = null; s.pid = null; s.state = 'idle'; });
    return saved;
  }
  return {
    id: randomUUID(),
    name: 'Default',
    sessions: [],
    activePreset: 'split-h-50',
    lockLayout: false,
    overlayVisible: true,
  };
}

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
      preload: path.join(__dirname, '../preload/dashboard.js'),
    },
  });
  dashboard.loadFile(path.join(__dirname, '../renderer/dashboard/index.html'));
  if (process.env.NODE_ENV === 'dev') dashboard.webContents.openDevTools();
}

app.whenReady().then(() => {
  createDashboard();

  ipcMain.handle(CH.GET_WORKSPACE, () => workspace);

  ipcMain.handle(CH.ADD_SESSION, (_e, { name }) => {
    const session = {
      id: randomUUID(),
      name,
      browserPath: null,   // null = auto-detect Chrome
      url: 'https://universe.flyff.com/play',
      hotkey: null,        // null = use index default (Ctrl+Alt+1, Ctrl+Alt+2)
      accentColor: workspace.sessions.length === 0 ? '#F59E0B' : '#06B6D4',
      hwnd: null,
      pid: null,
      state: 'idle',       // idle | launching | tracking | arranged | active
    };
    workspace.sessions.push(session);
    return session;
  });

  ipcMain.handle(CH.SAVE_WORKSPACE, (_e, patch) => {
    Object.assign(workspace, patch);
    const toSave = {
      ...workspace,
      sessions: workspace.sessions.map(({ hwnd, pid, state, ...rest }) => rest),
    };
    store.set('workspace', toSave);
    return true;
  });

  ipcMain.handle(CH.LAUNCH_SESSION, async (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session) return { error: 'Session not found' };
    if (session.state !== 'idle') return { error: 'Session already active' };

    session.state = 'launching';
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });

    try {
      const { pid, hwnd } = await launchSession(session);
      session.pid   = pid;
      session.hwnd  = hwnd;
      session.state = 'tracking';
    } catch (err) {
      session.state = 'idle';
      return { error: err.message };
    }

    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
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
    return { ok: true };
  });

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

  // Remaining handlers added in later tasks
});

app.on('before-quit', () => unbindAll());
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
