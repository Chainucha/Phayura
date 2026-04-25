const { globalShortcut } = require('electron');
const { focusWindow } = require('./win32/windowOps');

let registered = [];

const DEFAULT_HOTKEYS = [
  'CommandOrControl+Alt+1',
  'CommandOrControl+Alt+2',
  'CommandOrControl+Alt+3',
  'CommandOrControl+Alt+4',
];

function bindHotkeys(sessions, onSwitch) {
  unbindAll();
  sessions.forEach((session, i) => {
    const accel = session.hotkey || DEFAULT_HOTKEYS[i];
    if (!accel) return;

    const ok = globalShortcut.register(accel, () => {
      if (session.hwnd) {
        focusWindow(session.hwnd);
        onSwitch?.(session);
      }
    });

    if (ok) registered.push(accel);
    else console.warn(`[hotkey] Could not register "${accel}" — already claimed by another app.`);
  });

  // Cycle hotkey: Ctrl+Alt+Tab
  const cycleAccel = 'CommandOrControl+Alt+Tab';
  let lastFocusedIdx = 0;
  const ok = globalShortcut.register(cycleAccel, () => {
    const active = sessions.filter(s => s.hwnd);
    if (active.length === 0) return;
    lastFocusedIdx = (lastFocusedIdx + 1) % active.length;
    const target = active[lastFocusedIdx];
    focusWindow(target.hwnd);
    onSwitch?.(target);
  });
  if (ok) registered.push(cycleAccel);
}

function unbindAll() {
  registered.forEach(a => globalShortcut.unregister(a));
  registered = [];
}

module.exports = { bindHotkeys, unbindAll };
