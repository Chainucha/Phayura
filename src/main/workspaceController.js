const { randomUUID } = require('crypto');
const Store = require('electron-store');

const store = new Store({ name: 'citra' });

function makeDefaultGroup(name = 'Group 1', preset = 'split-h-50', lock = false) {
  return { id: randomUUID(), name, activePreset: preset, lockLayout: lock };
}

function loadWorkspace() {
  const saved = store.get('workspace');
  if (!saved) {
    const group = makeDefaultGroup();
    return {
      id: randomUUID(),
      name: 'Default',
      sessions: [],
      groups: [group],
      overlayVisible: true,
    };
  }
  saved.sessions = saved.sessions || [];
  saved.sessions.forEach(s => { s.hwnd = null; s.pid = null; s.state = 'idle'; });

  // Migration: ensure groups exist + every session has a valid groupId
  if (!Array.isArray(saved.groups) || saved.groups.length === 0) {
    const group = makeDefaultGroup(
      'Group 1',
      saved.activePreset || 'split-h-50',
      !!saved.lockLayout,
    );
    saved.groups = [group];
    saved.sessions.forEach(s => { s.groupId = group.id; });
  } else {
    const fallback = saved.groups[0].id;
    saved.sessions.forEach(s => {
      if (!s.groupId || !saved.groups.some(g => g.id === s.groupId)) s.groupId = fallback;
    });
  }
  // Drop legacy top-level layout fields — now per-group
  delete saved.activePreset;
  delete saved.lockLayout;
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

function addSession(workspace, name, groupId) {
  const colors = ['#F59E0B', '#06B6D4', '#8B5CF6', '#10B981'];
  const targetGroupId = groupId && workspace.groups.some(g => g.id === groupId)
    ? groupId
    : workspace.groups[0]?.id;
  const session = {
    id: randomUUID(),
    groupId: targetGroupId,
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

function reorderSession(workspace, id, direction) {
  const idx = workspace.sessions.findIndex(s => s.id === id);
  if (idx < 0) return false;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= workspace.sessions.length) return false;
  const [moved] = workspace.sessions.splice(idx, 1);
  workspace.sessions.splice(target, 0, moved);
  return true;
}

function moveSessionToGroup(workspace, sessionId, groupId) {
  const session = workspace.sessions.find(s => s.id === sessionId);
  if (!session) return null;
  if (!workspace.groups.some(g => g.id === groupId)) return null;
  if (session.state !== 'idle') return null;
  session.groupId = groupId;
  return session;
}

function addGroup(workspace, name) {
  const group = makeDefaultGroup(name || `Group ${workspace.groups.length + 1}`);
  workspace.groups.push(group);
  return group;
}

function renameGroup(workspace, id, name) {
  const group = workspace.groups.find(g => g.id === id);
  if (!group) return null;
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  group.name = trimmed;
  return group;
}

function deleteGroup(workspace, id) {
  if (workspace.groups.length <= 1) return false;
  const idx = workspace.groups.findIndex(g => g.id === id);
  if (idx < 0) return false;
  // Refuse delete if any session in this group is non-idle
  const hasActive = workspace.sessions.some(s => s.groupId === id && s.state !== 'idle');
  if (hasActive) return false;
  const fallbackId = workspace.groups.find(g => g.id !== id)?.id;
  workspace.sessions.forEach(s => { if (s.groupId === id) s.groupId = fallbackId; });
  workspace.groups.splice(idx, 1);
  return true;
}

function updateGroup(workspace, id, patch) {
  const group = workspace.groups.find(g => g.id === id);
  if (!group) return null;
  if ('activePreset' in patch && patch.activePreset) group.activePreset = patch.activePreset;
  if ('lockLayout' in patch) group.lockLayout = !!patch.lockLayout;
  if ('name' in patch && patch.name) {
    const trimmed = String(patch.name).trim();
    if (trimmed) group.name = trimmed;
  }
  return group;
}

module.exports = {
  loadWorkspace, saveWorkspace,
  addSession, deleteSession, renameSession, reorderSession, moveSessionToGroup,
  addGroup, deleteGroup, renameGroup, updateGroup,
};
