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

module.exports = { loadWorkspace, saveWorkspace, addSession };
