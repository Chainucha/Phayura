const { app, BrowserWindow, Menu, ipcMain, session: electronSession, shell } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const {
  loadWorkspace, saveWorkspace,
  addSession, deleteSession, renameSession, moveSessionToGroup, setSessionMuted,
  addGroup, deleteGroup, renameGroup, updateGroup,
  recomputeLayoutForActive,
  setLayoutRatios, swapLayoutCells,
  groupSessionIds,
} = require('./workspaceController');
const {
  ensureContainer, sendToContainer, getContainerHwnd, destroyContainer,
  isContainerAlive, maximizeContainer, toggleFullscreenContainer,
  getGroupIdByWebContents, isAnyContainerAlive,
} = require('./browserInstanceManager');
const {
  bindHotkeys, unbindGroup, unbindAll,
  enableContainerHotkeys, disableContainerHotkeys, setPaneZoomHandler,
  enableSessionHotkeys, disableSessionHotkeys,
} = require('./focusController');
const { focusWindow } = require('./win32/windowOps');
const hoverFocus = require('./hoverFocus');

// Single instance — two Citras would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── Performance switches (must run before app.whenReady) ──
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('disk-cache-size', '20971520'); // 20MB per partition
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=64');
// Same-site (universe.flyff.com) collapse: drop strict origin isolation so all
// Flyff webviews can share one renderer process. Cookies stay isolated by
// StoragePartition (cookie store is independent of process).
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('renderer-process-limit', '1');
// Shared V8 bytecode cache across partitions — Flyff JS compiled once, reused
// across sessions. Saves cold-start CPU; small RAM benefit.
app.commandLine.appendSwitch('code-cache-dir', path.join(app.getPath('userData'), 'CodeCache'));

const workspace = loadWorkspace();

let dashboard;

// Explicit focus tracking. Electron's per-window `isFocused()` can lag after
// 'blur' fires (OS focus event hasn't propagated yet), so we maintain our own
// Set updated synchronously by per-window focus/blur listeners. Disarm only when
// no Phayura window is in the Set.
const focusedWindows = new Set();

function attachFocusTracking(win) {
  win.on('focus', () => {
    focusedWindows.add(win);
    enableSessionHotkeys();
  });
  win.on('blur', () => {
    focusedWindows.delete(win);
    setImmediate(() => {
      if (focusedWindows.size === 0) disableSessionHotkeys();
    });
  });
  win.on('closed', () => {
    focusedWindows.delete(win);
    if (focusedWindows.size === 0) disableSessionHotkeys();
  });
  // Bootstrap: catch initial focus that may have fired before the listener attached.
  if (win.isFocused()) {
    focusedWindows.add(win);
    enableSessionHotkeys();
  }
}

function safeSend(channel, payload) {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send(channel, payload);
  }
}

function sessionsOfGroup(groupId) {
  return workspace.sessions.filter(s => s.groupId === groupId);
}

function findGroup(groupId) {
  return workspace.groups.find(g => g.id === groupId);
}

function applyHoverFocus() {
  if (workspace.hoverFocusEnabled) {
    hoverFocus.start(
      () => workspace.sessions,
      () => workspace.hoverFocusDelayMs ?? 30,
    );
  } else {
    hoverFocus.stop();
  }
}

function sendGameUpdate(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  const active = sessionsOfGroup(groupId).filter(s => s.state !== 'idle');
  const activeIds = new Set(active.map(s => s.id));
  const gl = group.layout;

  // Persisted layout is source of truth. Filter cellMap to active sessions only;
  // idle/closed sessions leave empty cells in the grid.
  const cellMap = Object.fromEntries(
    Object.entries(gl.cellMap).filter(([, v]) => activeIds.has(v))
  );
  const layout = {
    cols: gl.cols,
    rows: gl.rows,
    colRatios: gl.colRatios.slice(),
    rowRatios: gl.rowRatios.slice(),
    cellMap,
  };

  sendToContainer(groupId, CH.GAME_UPDATE, {
    sessions: active.map(({ id, name, url, accentColor, muted }) => ({ id, name, url, accentColor, muted: !!muted })),
    layout,
    hoverFocusEnabled: !!workspace.hoverFocusEnabled,
    hoverFocusDelayMs: workspace.hoverFocusDelayMs ?? 30,
  });
}

function rebindGroupHotkeys(groupId) {
  bindHotkeys(
    groupId,
    sessionsOfGroup(groupId),
    (focused) => {
      sessionsOfGroup(groupId).forEach(s => { if (s.state === 'active') s.state = 'tracking'; });
      focused.state = 'active';
      sessionsOfGroup(groupId).forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
      sendToContainer(groupId, CH.GAME_FOCUS_WEBVIEW, { id: focused.id });
    },
    () => BrowserWindow.getFocusedWindow() !== null,
    (gid) => toggleFullscreenContainer(gid),
    () => {
      const g = findGroup(groupId);
      if (!g || !g.layout) return [];
      const out = [];
      for (let r = 0; r < g.layout.rows; r++) {
        for (let c = 0; c < g.layout.cols; c++) {
          const id = g.layout.cellMap[`${r},${c}`];
          if (id) out.push(id);
        }
      }
      return out;
    },
  );
}

function handleContainerClosed(groupId) {
  // Container window closed by user — reset all non-idle sessions of this group
  sessionsOfGroup(groupId).forEach(s => {
    if (s.state !== 'idle') {
      s.hwnd = null; s.pid = null; s.state = 'idle';
      safeSend(CH.SESSION_STATE_CHANGED, { ...s });
    }
  });
  const group = findGroup(groupId);
  if (group) recomputeLayoutForActive(group, []);
  saveWorkspace(workspace);
  unbindGroup(groupId);
}

function ensureGroupContainer(groupId) {
  const container = ensureContainer(groupId, () => handleContainerClosed(groupId));
  if (!container.__hotkeysWired) {
    container.on('focus', enableContainerHotkeys);
    container.on('blur',  disableContainerHotkeys);
    if (container.isFocused()) enableContainerHotkeys();
    attachFocusTracking(container);
    container.__hotkeysWired = true;
  }
  return container;
}

function launchSessionInternal(session) {
  if (session.state !== 'idle') return { error: 'Session already active' };
  const group = findGroup(session.groupId);
  if (!group) return { error: 'Session has no group' };

  const container = ensureGroupContainer(group.id);
  session.hwnd  = getContainerHwnd(group.id);
  session.pid   = container.webContents.getOSProcessId();
  session.state = 'tracking';
  safeSend(CH.SESSION_STATE_CHANGED, { ...session });

  const activeIds = sessionsOfGroup(group.id).filter(s => s.state !== 'idle').map(s => s.id);
  const { width, height } = container.getBounds();
  recomputeLayoutForActive(group, activeIds, width, height);

  if (container.webContents.isLoading()) {
    container.webContents.once('did-finish-load', () => sendGameUpdate(group.id));
  } else {
    sendGameUpdate(group.id);
  }
  rebindGroupHotkeys(group.id);
  return { ok: true };
}

function closeSessionInternal(session) {
  if (session.state === 'idle') return { ok: true };
  const groupId = session.groupId;
  session.hwnd = null; session.pid = null; session.state = 'idle';
  safeSend(CH.SESSION_STATE_CHANGED, { ...session });

  const group = findGroup(groupId);
  const activeIds = sessionsOfGroup(groupId).filter(s => s.state !== 'idle').map(s => s.id);
  if (group) {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && getGroupIdByWebContents(w.webContents) === groupId);
    const { width, height } = win ? win.getBounds() : { width: 1600, height: 900 };
    recomputeLayoutForActive(group, activeIds, width, height);
    saveWorkspace(workspace);
  }

  if (isContainerAlive(groupId)) sendGameUpdate(groupId);

  // If no sessions of this group remain active, tear down its container
  const stillActive = sessionsOfGroup(groupId).some(s => s.state !== 'idle');
  if (!stillActive) {
    destroyContainer(groupId);
    unbindGroup(groupId);
    sessionsOfGroup(groupId).forEach(s => {
      electronSession.fromPartition(`persist:${s.id}`)
        .clearStorageData({ storages: ['serviceworkers', 'shadercache', 'cachestorage'] })
        .catch(() => {});
    });
  } else {
    rebindGroupHotkeys(groupId);
  }
  return { ok: true };
}

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 980, height: 640,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '../preload/dashboard.js'),
    },
  });
  dashboard.loadFile(path.join(__dirname, '../renderer/dashboard/index.html'));
  // Dashboard does NOT arm session hotkeys: globalShortcut intercepts at OS level
  // and would block keystrokes in input fields (add/rename dialogs). Session
  // hotkeys are only meaningful when a container window is focused.
  if (!app.isPackaged) dashboard.webContents.openDevTools();
}

app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null);

  createDashboard();
  applyHoverFocus();
  setPaneZoomHandler((groupId) => sendToContainer(groupId, CH.GAME_PANE_ZOOM, {}));

  ipcMain.handle(CH.GET_WORKSPACE, () => workspace);

  // ── Sessions ──────────────────────────────────────────────────────────────
  ipcMain.handle(CH.ADD_SESSION, (_e, { name, groupId }) => {
    const session = addSession(workspace, name, groupId);
    saveWorkspace(workspace);
    return session;
  });

  ipcMain.handle(CH.SAVE_WORKSPACE, (_e, patch) => {
    saveWorkspace(workspace, patch);
    return true;
  });

  ipcMain.handle(CH.LAUNCH_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session) return { error: 'Session not found' };
    const r = launchSessionInternal(session);
    if (!r.error) saveWorkspace(workspace);
    return r;
  });

  ipcMain.handle(CH.CLOSE_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session) return { error: 'Session not found' };
    return closeSessionInternal(session);
  });

  ipcMain.handle(CH.DELETE_SESSION, async (_e, { id }) => {
    const target = workspace.sessions.find(s => s.id === id);
    if (!target) return { error: 'Session not found' };
    if (target.state !== 'idle') return { error: 'Close session before deleting' };
    if (!deleteSession(workspace, id)) return { error: 'Delete failed' };
    saveWorkspace(workspace);
    try { await electronSession.fromPartition(`persist:${id}`).clearStorageData(); } catch {}
    rebindGroupHotkeys(target.groupId);
    if (isContainerAlive(target.groupId)) sendGameUpdate(target.groupId);
    return { ok: true };
  });

  ipcMain.handle(CH.RENAME_SESSION, (_e, { id, name }) => {
    const session = renameSession(workspace, id, name);
    if (!session) return { error: 'Invalid name or session not found' };
    saveWorkspace(workspace);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    if (session.state !== 'idle' && isContainerAlive(session.groupId)) sendGameUpdate(session.groupId);
    return { ok: true, session: { ...session } };
  });

  ipcMain.handle(CH.SESSION_SET_MUTED, (_e, { id, muted }) => {
    const session = setSessionMuted(workspace, id, muted);
    if (!session) return { error: 'Session not found' };
    saveWorkspace(workspace);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    if (isContainerAlive(session.groupId)) {
      sendToContainer(session.groupId, CH.GAME_SET_MUTED, { id: session.id, muted: session.muted });
    }
    return { ok: true, session: { ...session } };
  });

  ipcMain.handle(CH.MOVE_SESSION_GROUP, (_e, { sessionId, groupId, beforeId }) => {
    const before = workspace.sessions.find(s => s.id === sessionId);
    const fromGroupId = before?.groupId ?? null;
    const session = moveSessionToGroup(workspace, sessionId, groupId, beforeId);
    if (!session) return { error: 'Cannot move (session running or invalid group)' };
    saveWorkspace(workspace);
    workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    // Reorder/cross-group affects Tab cycle order + per-group hotkey list.
    const groupsToUpdate = new Set([fromGroupId, groupId].filter(Boolean));
    groupsToUpdate.forEach(gid => {
      rebindGroupHotkeys(gid);
      if (isContainerAlive(gid)) sendGameUpdate(gid);
    });
    return { ok: true, session: { ...session }, sessions: workspace.sessions.map(s => ({ ...s })) };
  });

  ipcMain.handle(CH.FOCUS_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session?.hwnd) return { error: 'Session has no tracked window' };
    focusWindow(session.hwnd);
    sendToContainer(session.groupId, CH.GAME_FOCUS_WEBVIEW, { id });
    sessionsOfGroup(session.groupId).forEach(s => { if (s.state === 'active') s.state = 'tracking'; });
    session.state = 'active';
    sessionsOfGroup(session.groupId).forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    return { ok: true };
  });

  // ── Groups ────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.ADD_GROUP, (_e, { name }) => {
    const group = addGroup(workspace, name);
    saveWorkspace(workspace);
    return { ok: true, group };
  });

  ipcMain.handle(CH.RENAME_GROUP, (_e, { id, name }) => {
    const group = renameGroup(workspace, id, name);
    if (!group) return { error: 'Invalid name or group not found' };
    saveWorkspace(workspace);
    return { ok: true, group: { ...group } };
  });

  ipcMain.handle(CH.DELETE_GROUP, (_e, { id }) => {
    if (!deleteGroup(workspace, id)) return { error: 'Cannot delete (last group, or sessions still running)' };
    saveWorkspace(workspace);
    unbindGroup(id);
    return { ok: true, workspace };
  });

  ipcMain.handle(CH.UPDATE_GROUP, (_e, { id, patch }) => {
    const group = updateGroup(workspace, id, patch || {});
    if (!group) return { error: 'Group not found' };
    saveWorkspace(workspace);
    return { ok: true, group: { ...group } };
  });

  ipcMain.handle(CH.LAUNCH_GROUP, (_e, { id }) => {
    const group = findGroup(id);
    if (!group) return { error: 'Group not found' };
    const idle = sessionsOfGroup(id).filter(s => s.state === 'idle');
    if (idle.length === 0) return { error: 'No idle sessions in this group' };
    const errors = [];
    idle.forEach(s => {
      const r = launchSessionInternal(s);
      if (r.error) errors.push(r.error);
    });
    saveWorkspace(workspace);
    // Keep manager in foreground after spawning the container window
    if (dashboard && !dashboard.isDestroyed()) {
      setImmediate(() => {
        if (dashboard && !dashboard.isDestroyed()) dashboard.focus();
      });
    }
    return errors.length ? { error: errors.join('; ') } : { ok: true };
  });

  ipcMain.handle(CH.CLOSE_GROUP, (_e, { id }) => {
    const group = findGroup(id);
    if (!group) return { error: 'Group not found' };
    sessionsOfGroup(id).filter(s => s.state !== 'idle').forEach(s => closeSessionInternal(s));
    return { ok: true };
  });

  ipcMain.handle(CH.APPLY_LAYOUT, (_e, { groupId }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    if (!isContainerAlive(groupId)) return { error: 'No active game window' };
    maximizeContainer(groupId);
    sendGameUpdate(groupId);
    sessionsOfGroup(groupId).filter(s => s.state !== 'idle').forEach(s => {
      s.state = 'tracking';
      safeSend(CH.SESSION_STATE_CHANGED, { ...s });
    });
    return { ok: true };
  });

  // Game container ready — identify by sender, push current state
  ipcMain.on(CH.GAME_READY, (e) => {
    const groupId = getGroupIdByWebContents(e.sender);
    if (groupId) sendGameUpdate(groupId);
  });

  // Container reports webview focus changes (user click, programmatic focus).
  // Keeps session.state in sync so cycleFocus picks the correct "current".
  ipcMain.on(CH.GAME_REPORT_FOCUS, (_e, { groupId, id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session || session.groupId !== groupId) return;
    if (session.state === 'active') return;
    sessionsOfGroup(groupId).forEach(s => { if (s.state === 'active') s.state = 'tracking'; });
    session.state = 'active';
    sessionsOfGroup(groupId).forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
  });

  ipcMain.on(CH.OPEN_KOFI, () => {
    shell.openExternal('https://ko-fi.com/chainucha').catch(() => {});
  });

  ipcMain.on(CH.OPEN_DASHBOARD, () => {
    if (!dashboard || dashboard.isDestroyed()) {
      createDashboard();
      return;
    }
    if (dashboard.isMinimized()) dashboard.restore();
    dashboard.show();
    dashboard.focus();
  });

  ipcMain.handle(CH.SET_HOVER_FOCUS, (_e, { enabled, delayMs }) => {
    workspace.hoverFocusEnabled = !!enabled;
    workspace.hoverFocusDelayMs = delayMs ?? 30;
    saveWorkspace(workspace);
    applyHoverFocus();
    workspace.groups.forEach(g => { if (isContainerAlive(g.id)) sendGameUpdate(g.id); });
    return { ok: true };
  });

  ipcMain.handle(CH.LAYOUT_UPDATE_RATIOS, (_e, { groupId, colRatios, rowRatios }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    setLayoutRatios(group, colRatios, rowRatios);
    saveWorkspace(workspace);
    if (isContainerAlive(groupId)) sendGameUpdate(groupId);
    return { ok: true };
  });

  ipcMain.handle(CH.LAYOUT_SWAP_CELLS, (_e, { groupId, fromCell, toCell }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    if (!swapLayoutCells(group, fromCell, toCell)) return { error: 'Swap failed' };
    saveWorkspace(workspace);
    if (isContainerAlive(groupId)) sendGameUpdate(groupId);
    return { ok: true };
  });

});

app.on('before-quit', () => { unbindAll(); hoverFocus.stop(); });
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
