const { randomUUID } = require('crypto');
const Store = require('electron-store');

const store = new Store({ name: 'citra' });

function loadWorkspace() {
  const saved = store.get('workspace');
  if (!saved) {
    return {
      id: randomUUID(),
      name: 'Default',
      sessions: [],
      activePreset: 'split-h-50',
      lockLayout: false,
      overlayVisible: true,
    };
  }
  // Reset runtime-only fields
  saved.sessions = saved.sessions || [];
  saved.sessions.forEach(s => { s.hwnd = null; s.pid = null; s.state = 'idle'; });
  return saved;
}

function saveWorkspace(workspace, patch = {}) {
  Object.assign(workspace, patch);
  const toSave = {
    ...workspace,
    sessions: workspace.sessions.map(({ hwnd, pid, state, ...rest }) => rest),
  };
  store.set('workspace', toSave);
}

function addSession(workspace, name) {
  const colors = ['#F59E0B', '#06B6D4', '#8B5CF6', '#10B981'];
  const session = {
    id: randomUUID(),
    name,
    browserPath: null,
    url: 'https://universe.flyff.com/play',
    hotkey: null,
    accentColor: colors[workspace.sessions.length % colors.length],
    hwnd: null,
    pid: null,
    state: 'idle',
  };
  workspace.sessions.push(session);
  return session;
}

function deleteSession(workspace, id) {
  const idx = workspace.sessions.findIndex(s => s.id === id);
  if (idx < 0) return false;
  workspace.sessions.splice(idx, 1);
  return true;
}

function renameSession(workspace, id, name) {
  const session = workspace.sessions.find(s => s.id === id);
  if (!session) return null;
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  session.name = trimmed;
  return session;
}

module.exports = { loadWorkspace, saveWorkspace, addSession, deleteSession, renameSession };
