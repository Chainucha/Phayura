const { contextBridge, ipcRenderer } = require('electron');
const CH = require('../shared/ipc-channels');

contextBridge.exposeInMainWorld('citra', {
  getWorkspace:    ()       => ipcRenderer.invoke(CH.GET_WORKSPACE),
  launchSession:   (id)     => ipcRenderer.invoke(CH.LAUNCH_SESSION, { id }),
  closeSession:    (id)     => ipcRenderer.invoke(CH.CLOSE_SESSION,  { id }),
  applyLayout:     (groupId, preset) => ipcRenderer.invoke(CH.APPLY_LAYOUT, { groupId, preset }),
  addSession:      (name, groupId) => ipcRenderer.invoke(CH.ADD_SESSION, { name, groupId }),
  deleteSession:   (id)     => ipcRenderer.invoke(CH.DELETE_SESSION, { id }),
  focusSession:    (id)     => ipcRenderer.invoke(CH.FOCUS_SESSION,  { id }),
  saveWorkspace:   (data)   => ipcRenderer.invoke(CH.SAVE_WORKSPACE, data),
  setHoverFocus:   (enabled, delayMs) => ipcRenderer.invoke(CH.SET_HOVER_FOCUS, { enabled, delayMs }),
  renameSession:   (id, name) => ipcRenderer.invoke(CH.RENAME_SESSION, { id, name }),
  moveSessionToGroup: (sessionId, groupId, beforeId) => ipcRenderer.invoke(CH.MOVE_SESSION_GROUP, { sessionId, groupId, beforeId }),
  setSessionMuted: (id, muted) => ipcRenderer.invoke(CH.SESSION_SET_MUTED, { id, muted }),
  openKofi:        () => ipcRenderer.send(CH.OPEN_KOFI),
  // Group ops
  addGroup:        (name)   => ipcRenderer.invoke(CH.ADD_GROUP,    { name }),
  renameGroup:     (id, name) => ipcRenderer.invoke(CH.RENAME_GROUP, { id, name }),
  deleteGroup:     (id)     => ipcRenderer.invoke(CH.DELETE_GROUP, { id }),
  updateGroup:     (id, patch) => ipcRenderer.invoke(CH.UPDATE_GROUP, { id, patch }),
  launchGroup:     (id)     => ipcRenderer.invoke(CH.LAUNCH_GROUP, { id }),
  closeGroup:      (id)     => ipcRenderer.invoke(CH.CLOSE_GROUP,  { id }),
  onSessionChanged:(cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on(CH.SESSION_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(CH.SESSION_STATE_CHANGED, handler);
  },
});
