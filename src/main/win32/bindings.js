const koffi = require('koffi');

const user32   = koffi.load('user32.dll');
const winmm    = koffi.load('winmm.dll');

// --- Types ---
const HWND  = koffi.pointer('HWND',  koffi.opaque());
const BOOL  = koffi.alias('BOOL',  'int');
const LONG  = koffi.alias('LONG',  'int32');
const UINT  = koffi.alias('UINT',  'uint32');

const POINT = koffi.struct('POINT', { x: LONG, y: LONG });

// --- Functions ---
const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', HWND, []);
const GetCursorPos        = user32.func('__stdcall', 'GetCursorPos',        BOOL, [koffi.out(koffi.pointer(POINT))]);
const WindowFromPoint     = user32.func('__stdcall', 'WindowFromPoint',     HWND, [POINT]);
const GetAncestor         = user32.func('__stdcall', 'GetAncestor',         HWND, [HWND, UINT]);

const GA_ROOT = 2;
const GA_ROOTOWNER = 3;

const timeBeginPeriod = winmm.func('__stdcall', 'timeBeginPeriod', UINT, [UINT]);
const timeEndPeriod   = winmm.func('__stdcall', 'timeEndPeriod',   UINT, [UINT]);

// Focus switching goes through Electron's BrowserWindow.focus(); do not
// re-add SetForegroundWindow / AttachThreadInput here.
// Deliberately NOT bound: SendInput, keybd_event, mouse_event, PostMessage,
// ReadProcessMemory, SetWindowsHookEx(keyboard), BitBlt, CreateRemoteThread.
// Adding any of these is a compliance boundary crossing — flag in PR review.

module.exports = {
  HWND,
  GetForegroundWindow, GetCursorPos,
  WindowFromPoint, GetAncestor, GA_ROOT, GA_ROOTOWNER,
  timeBeginPeriod, timeEndPeriod,
};
