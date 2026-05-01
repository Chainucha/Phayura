# Phayura

ToS-compliant multi-client launcher for Flyff Universe. Manage many accounts in side-by-side panes with per-account cookie isolation and global hotkey focus switching — no input injection, no memory reads.

## Features

- **Groups** — organize sessions into groups; each group launches in its own window so you can run multiple grid layouts simultaneously.
- **Per-session storage** — every account gets its own persistent Chromium partition (`persist:<sessionId>`); cookies and localStorage stay isolated.
- **CSS Grid layouts** — sessions tile into an N-column × M-row grid that auto-fits the container's aspect ratio. Drag dividers live to adjust column/row ratios, then lock the topology.
- **Drag-and-swap** — enable "Edit Position" on any session badge to drag it onto another cell and swap positions without reloading either webview.
- **Reorder + rename** — move sessions within the workspace and rename without restarting them. Reordering updates grid placement only — no webview reload.
- **Focus indicator** — accent-colored session badge highlights the focused pane.
- **Global hotkeys** — per-session accelerators focus an account from anywhere. `Tab` cycles focus inside the active group window. `F11` toggles fullscreen; `F10` zooms the focused pane (hides all others) and restores on a second press.
- **Hover focus** (optional) — automatically focus a pane when the mouse hovers over it for a configurable delay.
- **Manage Panel from any pane** — each session badge has a dropdown to reopen the dashboard. If the manager window was closed, it is recreated; otherwise restored and focused.
- **Manager stays in front on launch** — launching a group spawns the container window without stealing focus from the dashboard, so you can keep managing while the panes load.

## How it works

Each group opens one Electron `BrowserWindow`. Inside that window, sessions render as `<webview>` panes laid out via CSS Grid (`grid-template-columns/rows` driven by `colRatios`/`rowRatios`). A `cellMap` records which session occupies each grid cell. Reconcile is incremental — surviving webviews are never detached, so switching layouts or reordering does not reload any page.

The main process owns all OS-level state (HWNDs, hotkeys, workspace persistence) and exposes a small IPC surface to the dashboard. The dashboard is a single window with one section per group: launch/close at the group level, plus per-session controls.

## Install

1. Go to the [Releases](../../releases/latest) page.
2. Download `Citra-Setup-*.exe`.
3. Run the installer — no admin rights required.

Citra auto-updates are not yet implemented; check Releases for new versions manually.

## Compliance boundary

Citra never injects input, never reads game memory, and never attaches a debugger. Win32 usage is limited to window placement and focus (`SetWindowPos`, `SetForegroundWindow`, `AttachThreadInput`, `GetWindowRect`). The deliberately-omitted API list is documented in `src/main/win32/bindings.js`; adding any of those should be flagged in review.

## Develop

```bash
npm install
npm start                 # run Electron app
NODE_ENV=dev npm start    # also opens DevTools
npm run build             # NSIS installer → dist/
```

Stack: Electron 41 · Node 20 · koffi 2.10 (Win32 FFI) · electron-store 8 · uiohook-napi 1.5 (optional hover focus) · vanilla HTML/JS (no TypeScript, no bundler).

## Status

Early — architecture stabilizing. No automated tests yet; verify against real Flyff windows.
