const { contextBridge, ipcRenderer } = require('electron');
const CH = require('../shared/ipc-channels');

const groupArg = process.argv.find(a => a.startsWith('--group-id='));
const groupId  = groupArg ? groupArg.split('=')[1] : null;

contextBridge.exposeInMainWorld('gameBridge', {
  groupId,
  onUpdate:        (cb) => ipcRenderer.on(CH.GAME_UPDATE,        (_e, data) => cb(data)),
  onFocusWebview:  (cb) => ipcRenderer.on(CH.GAME_FOCUS_WEBVIEW, (_e, data) => cb(data)),
  onPaneZoom:      (cb) => ipcRenderer.on(CH.GAME_PANE_ZOOM,     (_e)       => cb()),
  onSetMuted:      (cb) => ipcRenderer.on(CH.GAME_SET_MUTED,     (_e, data) => cb(data)),
  ready:           ()   => ipcRenderer.send(CH.GAME_READY),

  updateRatios:    (colRatios, rowRatios) => ipcRenderer.invoke(CH.LAYOUT_UPDATE_RATIOS, { groupId, colRatios, rowRatios }),
  swapCells:       (fromCell, toCell)     => ipcRenderer.invoke(CH.LAYOUT_SWAP_CELLS,    { groupId, fromCell, toCell }),
  resizeHint:      (width, height)        => ipcRenderer.send(CH.LAYOUT_RESIZE_HINT,    { width, height }),
  saveLayout:      ()                     => ipcRenderer.invoke(CH.LAYOUT_SAVE,          { groupId }),

  reportFocus:     (id) => ipcRenderer.send(CH.GAME_REPORT_FOCUS, { groupId, id }),
  openDashboard:   ()   => ipcRenderer.send(CH.OPEN_DASHBOARD),
});
