const { app, BrowserWindow } = require('electron');
const path = require('path');

const containers = new Map(); // groupId → BrowserWindow

function ensureContainer(groupId, onClosedOnce) {
  let win = containers.get(groupId);
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: app.isPackaged,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload/game.js'),
      additionalArguments: [`--group-id=${groupId}`],
    },
  });

  win.maximize();
  win.loadFile(path.join(__dirname, '../renderer/game/index.html'));
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.on('closed', () => {
    containers.delete(groupId);
    if (onClosedOnce) onClosedOnce();
  });

  containers.set(groupId, win);
  return win;
}

function sendToContainer(groupId, channel, payload) {
  const win = containers.get(groupId);
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getContainerHwnd(groupId) {
  const win = containers.get(groupId);
  if (!win || win.isDestroyed()) return null;
  return Number(win.getNativeWindowHandle().readBigUInt64LE(0));
}

function destroyContainer(groupId) {
  const win = containers.get(groupId);
  if (!win) return;
  containers.delete(groupId);
  if (win.isDestroyed()) return;
  win.removeAllListeners('close');
  try { win.close(); } catch { win.destroy(); }
}

function isContainerAlive(groupId) {
  const win = containers.get(groupId);
  return win != null && !win.isDestroyed();
}

function maximizeContainer(groupId) {
  const win = containers.get(groupId);
  if (win && !win.isDestroyed()) win.maximize();
}

function toggleFullscreenContainer(groupId) {
  const win = containers.get(groupId);
  if (!win || win.isDestroyed()) return;
  try {
    win.setFullScreen(!win.isFullScreen());
  } catch (e) {
    console.warn('[fullscreen] toggle failed:', e?.message);
  }
}

function getGroupIdByWebContents(webContents) {
  for (const [groupId, win] of containers) {
    if (!win.isDestroyed() && win.webContents.id === webContents.id) return groupId;
  }
  return null;
}

function isAnyContainerAlive() {
  for (const win of containers.values()) if (!win.isDestroyed()) return true;
  return false;
}

module.exports = {
  ensureContainer, sendToContainer, getContainerHwnd,
  destroyContainer, isContainerAlive, maximizeContainer, toggleFullscreenContainer,
  getGroupIdByWebContents, isAnyContainerAlive,
};
