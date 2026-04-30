const { globalShortcut, BrowserWindow } = require('electron');
const { focusWindow } = require('./win32/windowOps');
const { getGroupIdByWebContents } = require('./browserInstanceManager');

let registered = [];

// Per-group state: groupId → { sessions, onSwitch }
const cycleByGroup = new Map();
let onFullscreen = null;
let onPaneZoom   = null;
let containerOn  = false;

// Returns the currently-focused session in a group, derived from session.state.
// Source of truth is session.state === 'active', set by onSwitch / FOCUS_SESSION.
function recordFocus(groupId) {
  const state = cycleByGroup.get(groupId);
  if (!state) return null;
  return state.sessions.find(s => s.state === 'active') || null;
}

// Bind per-session global hotkeys for one group's sessions.
// Per-session hotkeys are workspace-global (cannot collide between groups —
// dashboard is responsible for unique accelerators).
function bindHotkeys(groupId, sessions, onSwitch, shouldFire, onFullscreenCb, cellOrder) {
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

  cycleByGroup.set(groupId, { sessions, onSwitch, cellOrder });
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
  const okF10 = globalShortcut.register('F10', () => {
    const groupId = focusedContainerGroupId();
    if (groupId) onPaneZoom?.(groupId);
  });
  if (!okTab) console.warn('[hotkey] Could not register Tab');
  if (!okF11) console.warn('[hotkey] Could not register F11');
  if (!okF10) console.warn('[hotkey] Could not register F10');
  containerOn = true;
}

function disableContainerHotkeys() {
  if (!containerOn) return;
  globalShortcut.unregister('Tab');
  globalShortcut.unregister('F11');
  globalShortcut.unregister('F10');
  containerOn = false;
}

function setPaneZoomHandler(fn) {
  onPaneZoom = fn;
}

function focusedContainerGroupId() {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return null;
  return getGroupIdByWebContents(win.webContents);
}

// Tab cycle: <=2 active sessions toggle to the other; 3+ round-robin by
// row-major cellMap order (via cellOrder callback) starting from current focus.
function cycleFocus() {
  const groupId = focusedContainerGroupId();
  if (!groupId) return;
  const state = cycleByGroup.get(groupId);
  if (!state) return;
  const active = state.sessions.filter(s => s.hwnd);
  if (active.length === 0) return;

  const currentId = recordFocus(groupId)?.id;
  let target = null;

  if (active.length <= 2) {
    target = active.find(s => s.id !== currentId) || active[0];
  } else {
    const order = (typeof state.cellOrder === 'function')
      ? state.cellOrder().filter(id => active.some(s => s.id === id))
      : active.map(s => s.id);
    if (order.length === 0) return;
    const idx = order.indexOf(currentId);
    const nextId = idx === -1 ? order[0] : order[(idx + 1) % order.length];
    target = active.find(s => s.id === nextId) || active[0];
  }
  if (!target) return;

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
  enableContainerHotkeys, disableContainerHotkeys, setPaneZoomHandler,
};
