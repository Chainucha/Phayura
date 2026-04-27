const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const CH = require('../shared/ipc-channels');
const {
  loadWorkspace, saveWorkspace,
  addSession, deleteSession, renameSession, reorderSession, moveSessionToGroup,
  addGroup, deleteGroup, renameGroup, updateGroup,
} = require('./workspaceController');
const {
  ensureContainer, sendToContainer, getContainerHwnd, destroyContainer,
  isContainerAlive, maximizeContainer, toggleFullscreenContainer,
  getGroupIdByWebContents, isAnyContainerAlive,
} = require('./browserInstanceManager');
const {
  bindHotkeys, unbindGroup, unbindAll,
  enableContainerHotkeys, disableContainerHotkeys,
} = require('./focusController');
const { focusWindow } = require('./win32/windowOps');
const { stopTracking } = require('./overlayManager');

// Single instance — two Citras would fight over hotkeys
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

function sendGameUpdate(groupId, applyRatio = false) {
  const group = findGroup(groupId);
  if (!group) return;
  const active = sessionsOfGroup(groupId).filter(s => s.state !== 'idle');
  sendToContainer(groupId, CH.GAME_UPDATE, {
    sessions:   active.map(({ id, name, url, accentColor }) => ({ id, name, url, accentColor })),
    preset:     group.activePreset || 'split-h-50',
    lockLayout: !!group.lockLayout,
    hoverFocusEnabled: !!workspace.hoverFocusEnabled,
    hoverFocusDelayMs: workspace.hoverFocusDelayMs || 400,
    applyRatio,
  });
}

function rebindGroupHotkeys(groupId) {
  bindHotkeys(
    groupId,
    sessionsOfGroup(groupId),
    (focused) => {
      // Drop active state on every session in this group; promote focused
      sessionsOfGroup(groupId).forEach(s => { if (s.state === 'active') s.state = 'arranged'; });
      focused.state = 'active';
      sessionsOfGroup(groupId).forEach(s => safeSend(CH.SESSION_STATE_CHANGED, { ...s }));
      sendToContainer(groupId, CH.GAME_FOCUS_WEBVIEW, { id: focused.id });
    },
    () => BrowserWindow.getFocusedWindow() !== null,
    (gid) => toggleFullscreenContainer(gid),
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
    if (patch && 'lockLayout' in patch && isContainerAlive(id)) sendGameUpdate(id);
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
    return errors.length ? { error: errors.join('; ') } : { ok: true };
  });

  ipcMain.handle(CH.CLOSE_GROUP, (_e, { id }) => {
    const group = findGroup(id);
    if (!group) return { error: 'Group not found' };
    sessionsOfGroup(id).filter(s => s.state !== 'idle').forEach(s => closeSessionInternal(s));
    return { ok: true };
  });

  ipcMain.handle(CH.APPLY_LAYOUT, (_e, { groupId, preset }) => {
    const group = findGroup(groupId);
    if (!group) return { error: 'Group not found' };
    group.activePreset = preset || group.activePreset;
    saveWorkspace(workspace);
    if (!isContainerAlive(groupId)) return { error: 'No active game window' };

    maximizeContainer(groupId);
    sendGameUpdate(groupId, true);

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

  ipcMain.handle(CH.SET_HOVER_FOCUS, (_e, { enabled, delayMs }) => {
    workspace.hoverFocusEnabled = !!enabled;
    workspace.hoverFocusDelayMs = delayMs || 400;
    saveWorkspace(workspace);
    workspace.groups.forEach(g => { if (isContainerAlive(g.id)) sendGameUpdate(g.id); });
    return { ok: true };
  });
});

app.on('before-quit', () => { stopTracking(); unbindAll(); });
app.on('window-all-closed', () => app.quit());

module.exports = { workspace };
