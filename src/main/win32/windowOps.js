const w = require('./bindings');

/** Move/resize without stealing focus. */
function placeWindow(hwnd, { x, y, width, height }) {
  const flags = w.SWP_NOZORDER | w.SWP_NOACTIVATE | w.SWP_ASYNCWINDOWPOS;
  w.SetWindowPos(hwnd, w.HWND_TOP, x, y, width, height, flags);
}

/** Get window position/size. */
function getRect(hwnd) {
  const out = [{}];
  w.GetWindowRect(hwnd, out);
  const r = out[0];
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/** Reliably bring window to foreground using AttachThreadInput. */
function focusWindow(hwnd) {
  const fg = w.GetForegroundWindow();
  if (fg === hwnd) return;          // already foreground, nothing to do
  if (!fg) { w.SetForegroundWindow(hwnd); return; }

  const fgPidOut = [0];
  const fgThread = w.GetWindowThreadProcessId(fg, fgPidOut);
  const myThread = w.GetCurrentThreadId();

  if (fgThread !== myThread) {
    w.AttachThreadInput(myThread, fgThread, 1);
    try {
      w.BringWindowToTop(hwnd);
      w.SetForegroundWindow(hwnd);
    } finally {
      w.AttachThreadInput(myThread, fgThread, 0);
    }
  } else {
    w.SetForegroundWindow(hwnd);
  }
}

module.exports = { placeWindow, getRect, focusWindow };
