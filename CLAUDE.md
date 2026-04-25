# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Sunkist** — ToS-compliant Electron window manager for Flyff Universe dual-clienting. Spawns isolated Chrome instances and arranges them via Win32 APIs. No input injection, no game inspection, no CDP.

Implementation plan: `docs/superpowers/plans/2026-04-25-citra-electron.md`

## Commands

```bash
npm start          # run Electron app (dev mode)
npm run build      # electron-builder NSIS installer → dist/
NODE_ENV=dev npm start  # open DevTools in dashboard window
```

No test framework until architecture is proven against real Flyff windows (per plan).

## Architecture

Single Electron main process owns all Win32 calls and mutable state. Two renderer processes (dashboard, overlay badges) talk to main through narrow IPC preload bridges only.

```
src/
  main/
    index.js                 ← app lifecycle, single-instance lock, IPC wiring
    workspaceController.js   ← electron-store persistence; strips hwnd/pid/state before save
    browserInstanceManager.js← spawn Chrome with --user-data-dir profile, detect HWND by PID
    windowLayoutEngine.js    ← pure layout math → SetWindowPos (no focus side effects)
    focusController.js       ← globalShortcut + AttachThreadInput focus switching
    overlayManager.js        ← transparent badge BrowserWindows, 250ms tracking loop
    hoverFocus.js            ← uiohook-napi read-only hover detection (off by default)
    win32/
      bindings.js            ← all koffi declarations; absence list documented
      windowOps.js           ← findWindowsByPid, waitForWindow, placeWindow, focusWindow
  preload/
    dashboard.js             ← exposes window.sunkist.* to dashboard renderer
    overlay.js               ← exposes window.overlayBridge.* to badge renderer
  renderer/
    dashboard/               ← dark sidebar + cards + layout picker (vanilla JS)
    overlay/                 ← transparent badge with timer (vanilla JS)
  shared/
    ipc-channels.js          ← string constants used by main + both preloads
```

## Key Constraints

**Compliance boundary** — `src/main/win32/bindings.js` deliberately omits: `SendInput`, `keybd_event`, `mouse_event`, `PostMessage`, `ReadProcessMemory`, `WriteProcessMemory`, debugger APIs, `BitBlt`/`PrintWindow`. Adding any is a ToS violation — flag in PR review.

**Chrome args** — `browserInstanceManager.js` must never pass `--remote-debugging-port`, `--load-extension`, `--enable-automation`, or `--disable-web-security`.

**No Flyff in Electron** — game URL loads in external Chrome only, never in a `BrowserWindow`.

**koffi callbacks** — always `koffi.register` / `koffi.unregister` in pairs inside `findWindowsByPid` to avoid trampoline leaks.

**Overlay** — `focusable: false` + `setIgnoreMouseEvents(true, { forward: true })` at creation; per-element interactivity toggled by `mouseenter`/`mouseleave` in badge renderer via `OVERLAY_INTERACTIVE` IPC.

## State Model

`workspace.sessions[i]` fields:
- Persisted: `id`, `name`, `browserPath`, `url`, `hotkey`, `accentColor`
- Runtime only (cleared on load): `hwnd`, `pid`, `state` (`idle | launching | tracking | arranged | active`)

`electron-store` key: `sunkist` → `workspace` object.

## Tech Stack

Electron 30 · Node 20 · koffi 2.10 (Win32 FFI) · electron-store 10 · uiohook-napi 1.5 (optional) · vanilla HTML/JS — no TypeScript, no bundler.
