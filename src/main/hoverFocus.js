let timer   = null;
let running = false;

// Poll cadence — 16ms ≈ 60Hz, aligns with monitor refresh. Default Windows
// timer resolution (~15.6ms) handles this without timeBeginPeriod.
// Higher rates would hammer focus attempts while Windows foreground-stealing
// prevention is blocking them.
const POLL_MS = 16;
// Cooldown between focus attempts on the same hwnd. If focus silently fails
// (stealing prevention), don't retry every poll tick.
const REFOCUS_COOLDOWN_MS = 250;

/**
 * Start hover-to-focus across containers. Read-only — no input synthesis.
 * Polls cursor via Win32 GetCursorPos, then asks the OS directly which top-level
 * HWND is under it via WindowFromPoint + GetAncestor(GA_ROOT). No rect cache, so
 * window moves/resizes never produce stale hits. Per-webview hover-focus inside
 * a single container lives in the container renderer (game.js), not here.
 *
 * Enter-delay: only focuses the container after the cursor has stayed inside the
 * same owned HWND for `getDelay()` ms. Prevents transient passes (e.g. cursor
 * crossing a container on the way to the dashboard) from snatching foreground.
 */
function start(getSessions, getDelay) {
  if (running) return;

  const { focusContainer } = require('./browserInstanceManager');
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

  let lastFocusedHwnd  = 0; // hwnd of the last container we successfully focused
  let lastAttemptHwnd  = 0; // hwnd of last focus attempt
  let lastAttemptAt    = 0; // timestamp of last focus attempt
  let pendingHwnd      = 0; // hwnd cursor is currently hovering, awaiting delay
  let pendingSince     = 0; // timestamp cursor entered pendingHwnd
  const ptOut = [{}];

  timer = setInterval(() => {
    if (!w.GetCursorPos(ptOut)) return;
    const { x, y } = ptOut[0];

    const raw = w.WindowFromPoint({ x, y });
    if (!raw) { pendingHwnd = 0; return; }
    const rootN = hwndNum(w.GetAncestor(raw, w.GA_ROOT));
    if (!rootN) { pendingHwnd = 0; return; }

    const sessions = getSessions();
    const owner = sessions.find(s => s.hwnd === rootN);
    if (!owner) { pendingHwnd = 0; return; }

    // Already focused this hwnd — nothing to do.
    if (rootN === lastFocusedHwnd && hwndNum(w.GetForegroundWindow()) === rootN) {
      pendingHwnd = rootN;
      return;
    }

    // Track dwell time on this owned hwnd.
    const now = Date.now();
    if (pendingHwnd !== rootN) {
      pendingHwnd  = rootN;
      pendingSince = now;
      return;
    }

    const delay = Math.max(0, (typeof getDelay === 'function' ? getDelay() : 0) | 0);
    if (now - pendingSince < delay) return;

    if (hwndNum(w.GetForegroundWindow()) === rootN) {
      lastFocusedHwnd = rootN;
      return;
    }

    // Per-hwnd cooldown — if SFW silently failed (stealing prevention), skip
    // retries on the same target. Switching to a different hwnd is instant.
    if (rootN === lastAttemptHwnd && now - lastAttemptAt < REFOCUS_COOLDOWN_MS) return;
    lastAttemptHwnd = rootN;
    lastAttemptAt   = now;

    focusContainer(owner.groupId);
    lastFocusedHwnd = rootN;
  }, POLL_MS);

  running = true;
}

function stop() {
  if (!running) return;
  clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = { start, stop };
