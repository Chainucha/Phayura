const { BrowserWindow } = require('electron');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const gameWindows = new Map(); // sessionId -> BrowserWindow

function launchSession(session, onClosed) {
  if (gameWindows.has(session.id)) throw new Error('Session already running');

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: session.name,
    webPreferences: {
      partition: `persist:${session.id}`,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    },
  });

  win.webContents.setUserAgent(CHROME_UA);
  win.loadURL(session.url || 'https://universe.flyff.com/play');

  const hwndBuf = win.getNativeWindowHandle();
  const hwnd = Number(hwndBuf.readBigUInt64LE(0));

  gameWindows.set(session.id, win);
  win.on('closed', () => {
    gameWindows.delete(session.id);
    if (onClosed) onClosed(session.id);
  });

  return { hwnd, pid: win.webContents.getOSProcessId() };
}

function closeSession(session) {
  const win = gameWindows.get(session.id);
  if (win && !win.isDestroyed()) win.destroy();
  gameWindows.delete(session.id);
}

module.exports = { launchSession, closeSession };
