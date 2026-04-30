const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const {
  loadWorkspace, saveWorkspace,
  addSession, deleteSession, renameSession, reorderSession, moveSessionToGroup,
  addGroup, deleteGroup, renameGroup, updateGroup,
  ensureLayoutForCount, placeSessionInLayout,
  setLayoutRatios, swapLayoutCells, setLayoutManual, applyResizeHint,
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
} = require('./focusController');
const { focusWindow } = require('./win32/windowOps');
const hoverFocus = require('./hoverFocus');
const { computeAutoGrid, uniformRatios, fillCellMap } = require('../shared/gridLayoutEngine');

// Single instance — two Phayuras would fight over hotkeys
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── Performance switches (must run before app.whenReady) ──
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('disk-cache-size', '52428800'); // 50MB
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
app.commandLine.appendSwitch('force_high_performance_gpu');

const workspace = loadWorkspace();

let dashboard;

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
      () => workspace.hoverFocusDelayMs ?? 120,
    );
  } else {
    hoverFocus.stop();
  }
}

function sendGameUpdate(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  const active = sessionsOfGroup(groupId).filter(s => s.state !== 'idle');
  const N = active.length;
  const gl = group.layout;

  let layout;
  if (N === 0) {
    layout = { cols: 0, rows: 0, colRatios: [], rowRatios: [], cellMap: {}, manual: gl.manual };
  } else if (N === gl.cols * gl.rows) {
    // Exact fit — send layout as-is, filtering cellMap to active only for safety
    const activeIds = new Set(active.map(s => s.id));
    const cellMap = Object.fromEntries(Object.entries(gl.cellMap).filter(([, v]) => activeIds.has(v)));
    layout = { ...gl, cellMap };
  } else {
    // Active count differs from persisted grid — recompute display layout
    const win = BrowserWindow.getAllWindows().find(w => getGroupIdByWebContents(w.webContents) === groupId);
    const { width: W, height: H } = win?.getBounds() ?? { width: 1600, height: 900 };
    const { cols, rows } = computeAutoGrid(N, W, H);
    // Preserve order from existing cellMap
    const activeIds = new Set(active.map(s => s.id));
    const ordered = [];
    for (let r = 0; r < gl.rows; r++) {
      for (let c = 0; c < gl.cols; c++) {
        const id = gl.cellMap[`${r},${c}`];
        if (id && activeIds.has(id)) ordered.push(id);
      }
    }
    for (const s of active) if (!ordered.includes(s.id)) ordered.push(s.id);
    layout = {
      cols, rows,
      colRatios: uniformRatios(cols),
      rowRatios: uniformRatios(rows),
      cellMap: fillCellMap(ordered.slice(0, cols * rows), cols, rows),
      manual: false,
    };
  }

  sendToContainer(groupId, CH.GAME_UPDATE, {
    sessions: active.map(({ id, name, url, accentColor }) => ({ id, name, url, accentColor })),
    layout,
    hoverFocusEnabled: !!workspace.hoverFocusEnabled,
    hoverFocusDelayMs: workspace.hoverFocusDelayMs ?? 120,
  });
}

function rebindGroupHotkeys(groupId) {
  bindHotkeys(
    groupId,
    sessionsOfGroup(groupId),
    (focused) => {
      sessionsOfGroup(groupId).forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
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
  unbindGroup(groupId);
}

function ensureGroupContainer(groupId) {
  const container = ensureContainer(groupId, () => handleContainerClosed(groupId));
  if (!container.__hotkeysWired) {
    container.on('focus', enableContainerHotkeys);
    container.on('blur',  disableContainerHotkeys);
    if (container.isFocused()) enableContainerHotkeys();
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
  if (process.env.NODE_ENV === 'dev') dashboard.webContents.openDevTools();
}

app.whenReady().then(() => {
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

  ipcMain.handle(CH.REORDER_SESSION, (_e, { id, direction }) => {
    if (!reorderSession(workspace, id, direction)) return { error: 'Cannot move' };
    saveWorkspace(workspace);
    workspace.sessions.forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
    const target = workspace.sessions.find(s => s.id === id);
    if (target && isContainerAlive(target.groupId)) sendGameUpdate(target.groupId);
    if (target) rebindGroupHotkeys(target.groupId);
    return { ok: true, sessions: workspace.sessions.map(s => ({ ...s })) };
  });

  ipcMain.handle(CH.MOVE_SESSION_GROUP, (_e, { sessionId, groupId }) => {
    const session = moveSessionToGroup(workspace, sessionId, groupId);
    if (!session) return { error: 'Cannot move (session running or invalid group)' };
    saveWorkspace(workspace);
    safeSend(CH.SESSION_STATE_CHANGED, { ...session });
    return { ok: true, session: { ...session } };
  });

  ipcMain.handle(CH.FOCUS_SESSION, (_e, { id }) => {
    const session = workspace.sessions.find(s => s.id === id);
    if (!session?.hwnd) return { error: 'Session has no tracked window' };
    focusWindow(session.hwnd);
    sendToContainer(session.groupId, CH.GAME_FOCUS_WEBVIEW, { id });
    sessionsOfGroup(session.groupId).forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
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
      s.state = 'arranged';
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
    sessionsOfGroup(groupId).forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
    session.state = 'active';
    sessionsOfGroup(groupId).forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
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
    workspace.hoverFocusDelayMs = delayMs ?? 120;
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

  ipcMain.on(CH.LAYOUT_RESIZE_HINT, (e, { width, height }) => {
    const groupId = getGroupIdByWebContents(e.sender);
    if (!groupId) return;
    const group = findGroup(groupId);
    if (!group) return;
    const ids = groupSessionIds(workspace, groupId).filter(id => {
      const s = workspace.sessions.find(s => s.id === id);
      return s && s.state !== 'idle';
    });
    const changed = applyResizeHint(group, ids, width, height);
    if (changed) {
      saveWorkspace(workspace);
      sendGameUpdate(groupId);
    }
  });

  ipcMain.handle(CH.LAYOUT_TOGGLE_AUTO, (_e, { groupId }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    setLayoutManual(group, false);
    saveWorkspace(workspace);
    if (isContainerAlive(groupId)) sendGameUpdate(groupId);
    return { ok: true, layout: { ...group.layout } };
  });

  ipcMain.handle(CH.LAYOUT_SAVE, (_e, { groupId }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    setLayoutManual(group, true);
    saveWorkspace(workspace);
    return { ok: true, layout: { ...group.layout } };
  });
});

app.on('before-quit', () => { unbindAll(); hoverFocus.stop(); });
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
