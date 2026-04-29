let timer   = null;
let running = false;
let timerPeriodSet = false;

// Poll cadence — ms between cursor reads. 1ms ≈ 1000Hz; each tick is a few
// microseconds (GetCursorPos + WindowFromPoint + GetAncestor + small set scan),
// so CPU cost is negligible. Independent of Electron event-loop backpressure.
// Effective cadence depends on Windows timer resolution — see timeBeginPeriod
// call in start() which drops it from default ~15.6ms to 1ms.
const POLL_MS = 1;

/**
 * Start hover-to-focus across containers. Read-only — no input synthesis.
 * Polls cursor via Win32 GetCursorPos, then asks the OS directly which top-level
 * HWND is under it via WindowFromPoint + GetAncestor(GA_ROOT). No rect cache, so
 * window moves/resizes never produce stale hits. Per-webview hover-focus inside
 * a single container lives in the container renderer (game.js), not here.
 */
function start(getSessions) {
  if (running) return;

  const { focusWindow } = require('./win32/windowOps');
  const w = require('./win32/bindings');
  const koffi = require('koffi');

  // koffi opaque-pointer HWNDs come back as External objects, not Numbers, so
  // `===` against session.hwnd (a JS Number from BigUInt64 cast) never matches.
  // Extract the raw address and convert to Number for comparison.
  const hwndNum = (h) => {
    if (h == null) return 0;
    if (typeof h === 'number') return h;
    return Number(koffi.address(h));
  };

  // Drop system timer resolution to 1ms so setInterval(1) actually fires every
  // 1ms instead of every ~16ms. Paired with timeEndPeriod(1) in stop().
  if (w.timeBeginPeriod(1) === 0) timerPeriodSet = true;

  let lastHwnd = 0;
  const ptOut = [{}];

  timer = setInterval(() => {
    if (!w.GetCursorPos(ptOut)) return;
    const { x, y } = ptOut[0];

    const raw = w.WindowFromPoint({ x, y });
    if (!raw) { lastHwnd = 0; return; }
    const rootN = hwndNum(w.GetAncestor(raw, w.GA_ROOT));
    if (!rootN) { lastHwnd = 0; return; }

    const sessions = getSessions();
    let owned = false;
    for (const s of sessions) {
      if (s.hwnd === rootN) { owned = true; break; }
    }
    if (!owned) { lastHwnd = 0; return; }

    if (rootN === lastHwnd) return;
    if (hwndNum(w.GetForegroundWindow()) === rootN) {
      lastHwnd = rootN;
      return;
    }

    focusWindow(rootN);
    lastHwnd = rootN;
  }, POLL_MS);

  running = true;
}

function stop() {
  if (!running) return;
  clearInterval(timer);
  timer = null;
  if (timerPeriodSet) {
    const w = require('./win32/bindings');
    w.timeEndPeriod(1);
    timerPeriodSet = false;
  }
  running = false;
}

module.exports = { start, stop };
