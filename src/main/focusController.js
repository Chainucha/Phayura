const { globalShortcut, BrowserWindow } = require('electron');
const { focusWindow } = require('./win32/windowOps');
const { getGroupIdByWebContents } = require('./browserInstanceManager');

let registered = [];

// Per-group cycle state: groupId → { sessions, idx, onSwitch }
const cycleByGroup = new Map();
let onFullscreen = null;
let containerOn  = false;

// Bind per-session global hotkeys for one group's sessions.
// Per-session hotkeys are workspace-global (cannot collide between groups —
// dashboard is responsible for unique accelerators).
function bindHotkeys(groupId, sessions, onSwitch, shouldFire, onFullscreenCb) {
  // Unbind any previous registrations for this group
  unbindGroup(groupId);
  const fire = shouldFire || (() => true);

  sessions.forEach(session => {
    const accel = session.hotkey;
    if (!accel) return;
    const ok = globalShortcut.register(accel, () => {
      if (!fire() || !session.hwnd) return;
      focusWindow(session.hwnd);
      onSwitch?.(session);
    });
    if (ok) registered.push({ groupId, accel });
    else console.warn(`[hotkey] Could not register "${accel}" — already claimed.`);
  });

  cycleByGroup.set(groupId, { sessions, onSwitch, idx: 0 });
  if (onFullscreenCb !== undefined) onFullscreen = onFullscreenCb;
}

function unbindGroup(groupId) {
  registered = registered.filter(r => {
    if (r.groupId !== groupId) return true;
    globalShortcut.unregister(r.accel);
    return false;
  });
  cycleByGroup.delete(groupId);
}

function enableContainerHotkeys() {
  if (containerOn) return;
  const okTab = globalShortcut.register('Tab', () => cycleFocus());
  const okF11 = globalShortcut.register('F11', () => {
    const groupId = focusedContainerGroupId();
    if (groupId) onFullscreen?.(groupId);
  });
  if (!okTab) console.warn('[hotkey] Could not register Tab');
  if (!okF11) console.warn('[hotkey] Could not register F11');
  containerOn = true;
}

function disableContainerHotkeys() {
  if (!containerOn) return;
  globalShortcut.unregister('Tab');
  globalShortcut.unregister('F11');
  containerOn = false;
}

function focusedContainerGroupId() {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  return getGroupIdByWebContents(win.webContents);
}

function cycleFocus() {
  const groupId = focusedContainerGroupId();
  if (!groupId) return;
  const state = cycleByGroup.get(groupId);
  if (!state) return;
  const active = state.sessions.filter(s => s.hwnd);
  if (active.length === 0) return;
  state.idx = (state.idx + 1) % active.length;
  const target = active[state.idx];
  focusWindow(target.hwnd);
  state.onSwitch?.(target);
}

function unbindAll() {
  registered.forEach(r => globalShortcut.unregister(r.accel));
  registered = [];
  cycleByGroup.clear();
  disableContainerHotkeys();
}

module.exports = {
  bindHotkeys, unbindGroup, unbindAll, cycleFocus,
  enableContainerHotkeys, disableContainerHotkeys,
};
