const { BrowserWindow } = require('electron');
const path = require('path');

let containerWin = null;

function ensureContainer(onClosedOnce) {
  if (containerWin && !containerWin.isDestroyed()) return containerWin;

  containerWin = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      sandbox: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload/game.js'),
    },
  });

  containerWin.maximize();
  containerWin.loadFile(path.join(__dirname, '../renderer/game/index.html'));
  if (process.env.NODE_ENV === 'dev') {
    containerWin.webContents.openDevTools({ mode: 'detach' });
  }
  containerWin.on('closed', () => {
    containerWin = null;
    if (onClosedOnce) onClosedOnce();
  });

  return containerWin;
}

function sendToContainer(channel, payload) {
  if (containerWin && !containerWin.isDestroyed()) {
    containerWin.webContents.send(channel, payload);
  }
}

function getContainerHwnd() {
  if (!containerWin || containerWin.isDestroyed()) return null;
  return Number(containerWin.getNativeWindowHandle().readBigUInt64LE(0));
}

function destroyContainer() {
  if (!containerWin || containerWin.isDestroyed()) { containerWin = null; return; }
  containerWin.removeAllListeners('close');
  try { containerWin.close(); } catch { containerWin.destroy(); }
  containerWin = null;
}

function isContainerAlive() {
  return containerWin != null && !containerWin.isDestroyed();
}

function getContainerWindow() {
  return isContainerAlive() ? containerWin : null;
}

function maximizeContainer() {
  if (containerWin && !containerWin.isDestroyed()) containerWin.maximize();
}

function toggleFullscreenContainer() {
  if (!containerWin || containerWin.isDestroyed()) return;
  try {
    containerWin.setFullScreen(!containerWin.isFullScreen());
  } catch (e) {
    console.warn('[fullscreen] toggle failed:', e?.message);
  }
}

module.exports = { ensureContainer, sendToContainer, getContainerHwnd, getContainerWindow, destroyContainer, isContainerAlive, maximizeContainer, toggleFullscreenContainer };
