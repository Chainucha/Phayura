const { randomUUID } = require('crypto');
const Store = require('electron-store');
const {
  computeAutoGrid, uniformRatios, normalizeRatios,
  cellKey, fillCellMap, rebuildCellMap, flattenCellMap,
} = require('../shared/gridLayoutEngine');

const store = new Store({ name: 'citra' });
const DEFAULT_W = 1600;
const DEFAULT_H = 900;

function makeDefaultLayout() {
  return {
    cols: 0, rows: 0,
    colRatios: [],
    rowRatios: [],
    cellMap: {},
    manual: false,
  };
}

function makeDefaultGroup(name = 'Group 1') {
  return { id: randomUUID(), name, layout: makeDefaultLayout() };
}

function legacyPresetToRatios(preset, splitRatio) {
  const presets = {
    'split-h-50': { dir: 'row',    a: 0.5 },
    'split-h-70': { dir: 'row',    a: 0.7 },
    'split-h-30': { dir: 'row',    a: 0.3 },
    'split-v-50': { dir: 'column', a: 0.5 },
    'split-v-70': { dir: 'column', a: 0.7 },
    'split-v-30': { dir: 'column', a: 0.3 },
  };
  const p = presets[preset] || presets['split-h-50'];
  const a = (splitRatio != null) ? splitRatio : p.a;
  if (p.dir === 'row') return { cols: 2, rows: 1, colRatios: [a, 1 - a], rowRatios: [1] };
  return                      { cols: 1, rows: 2, colRatios: [1], rowRatios: [a, 1 - a] };
}

function migrateGroup(group, sessionIds) {
  if (group.layout && Array.isArray(group.layout.colRatios)) return;

  const N = sessionIds.length;
  if (N === 0) {
    group.layout = makeDefaultLayout();
  } else if (N === 1) {
    group.layout = {
      cols: 1, rows: 1,
      colRatios: [1], rowRatios: [1],
      cellMap: { [cellKey(0, 0)]: sessionIds[0] },
      manual: !!group.lockLayout,
    };
  } else if (N === 2 && group.activePreset) {
    const r = legacyPresetToRatios(group.activePreset, group.splitRatio);
    group.layout = {
      cols: r.cols, rows: r.rows,
      colRatios: r.colRatios, rowRatios: r.rowRatios,
      cellMap: fillCellMap(sessionIds, r.cols, r.rows),
      manual: !!group.lockLayout,
    };
  } else {
    const { cols, rows } = computeAutoGrid(N, DEFAULT_W, DEFAULT_H);
    group.layout = {
      cols, rows,
      colRatios: uniformRatios(cols),
      rowRatios: uniformRatios(rows),
      cellMap: fillCellMap(sessionIds, cols, rows),
      manual: !!group.lockLayout,
    };
  }
  delete group.activePreset;
  delete group.lockLayout;
  delete group.splitRatio;
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
  saved.sessions.forEach(s => {
    s.hwnd = null; s.pid = null; s.state = 'idle';
    if (typeof s.muted !== 'boolean') s.muted = true;
  });

  if (!Array.isArray(saved.groups) || saved.groups.length === 0) {
    const group = makeDefaultGroup();
    group.activePreset = saved.activePreset || 'split-h-50';
    group.lockLayout   = !!saved.lockLayout;
    saved.groups = [group];
    saved.sessions.forEach(s => { s.groupId = group.id; });
  } else {
    saved.sessions.forEach(s => {
      if (s.groupId && !saved.groups.some(g => g.id === s.groupId)) s.groupId = null;
      if (s.groupId === undefined) s.groupId = null;
    });
  }

  saved.groups.forEach(g => {
    const sessionIds = saved.sessions.filter(s => s.groupId === g.id).map(s => s.id);
    migrateGroup(g, sessionIds);
  });

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

function groupSessionIds(workspace, groupId) {
  return workspace.sessions.filter(s => s.groupId === groupId).map(s => s.id);
}

function ensureLayoutForCount(group, sessionIds, hintW = DEFAULT_W, hintH = DEFAULT_H) {
  const N = sessionIds.length;
  const layout = group.layout;

  if (N === 0) {
    layout.cols = 0; layout.rows = 0;
    layout.colRatios = []; layout.rowRatios = [];
    layout.cellMap = {};
    return;
  }

  if (layout.manual && N <= layout.cols * layout.rows) {
    const valid = new Set(sessionIds);
    const next = {};
    for (const k of Object.keys(layout.cellMap)) {
      if (valid.has(layout.cellMap[k])) next[k] = layout.cellMap[k];
    }
    layout.cellMap = next;
    return;
  }

  if (layout.manual && N > layout.cols * layout.rows) {
    layout.manual = false;
  }

  const { cols, rows } = computeAutoGrid(N, hintW, hintH);
  layout.cellMap = rebuildCellMap(layout.cellMap, layout.cols, layout.rows, cols, rows, sessionIds);
  layout.cols = cols;
  layout.rows = rows;
  layout.colRatios = uniformRatios(cols);
  layout.rowRatios = uniformRatios(rows);
}

function placeSessionInLayout(group, sessionId) {
  const layout = group.layout;
  for (const k of Object.keys(layout.cellMap)) {
    if (layout.cellMap[k] === sessionId) return;
  }
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const k = cellKey(r, c);
      if (!layout.cellMap[k]) { layout.cellMap[k] = sessionId; return; }
    }
  }
}

function setLayoutRatios(group, colRatios, rowRatios) {
  const layout = group.layout;
  layout.colRatios = normalizeRatios(colRatios, layout.cols);
  layout.rowRatios = normalizeRatios(rowRatios, layout.rows);
  layout.manual = true;
}

function swapLayoutCells(group, fromCell, toCell) {
  const layout = group.layout;
  const a = layout.cellMap[fromCell];
  const b = layout.cellMap[toCell];
  if (!a) return false;
  if (fromCell === toCell) return false;
  if (b) layout.cellMap[fromCell] = b; else delete layout.cellMap[fromCell];
  layout.cellMap[toCell] = a;
  return true;
}

function setLayoutManual(group, manual) {
  const layout = group.layout;
  layout.manual = !!manual;
  if (!layout.manual) {
    layout.colRatios = uniformRatios(layout.cols);
    layout.rowRatios = uniformRatios(layout.rows);
  }
}

function applyResizeHint(group, sessionIds, W, H) {
  const layout = group.layout;
  if (layout.manual) return false;
  const { cols, rows } = computeAutoGrid(sessionIds.length, W, H);
  if (cols === layout.cols && rows === layout.rows) return false;
  layout.cellMap = rebuildCellMap(layout.cellMap, layout.cols, layout.rows, cols, rows, sessionIds);
  layout.cols = cols;
  layout.rows = rows;
  layout.colRatios = uniformRatios(cols);
  layout.rowRatios = uniformRatios(rows);
  return true;
}

function addSession(workspace, name, groupId) {
  const colors = ['#F59E0B', '#06B6D4', '#8B5CF6', '#10B981'];
  const targetGroupId = (groupId && workspace.groups.some(g => g.id === groupId))
    ? groupId
    : null;
  const session = {
    id: randomUUID(),
    groupId: targetGroupId,
    name,
    browserPath: null,
    url: 'https://universe.flyff.com/play',
    hotkey: null,
    accentColor: colors[workspace.sessions.length % colors.length],
    muted: true,
    hwnd: null,
    pid: null,
    state: 'idle',
  };
  workspace.sessions.push(session);

  const group = workspace.groups.find(g => g.id === targetGroupId);
  if (group) {
    ensureLayoutForCount(group, groupSessionIds(workspace, group.id));
    placeSessionInLayout(group, session.id);
  }
  return session;
}

function deleteSession(workspace, id) {
  const idx = workspace.sessions.findIndex(s => s.id === id);
  if (idx < 0) return false;
  const { groupId } = workspace.sessions[idx];
  workspace.sessions.splice(idx, 1);
  const group = workspace.groups.find(g => g.id === groupId);
  if (group) ensureLayoutForCount(group, groupSessionIds(workspace, group.id));
  return true;
}

function setSessionMuted(workspace, id, muted) {
  const session = workspace.sessions.find(s => s.id === id);
  if (!session) return null;
  session.muted = !!muted;
  return session;
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
  if (workspace.sessions[idx].groupId !== workspace.sessions[target].groupId) return false;
  const [moved] = workspace.sessions.splice(idx, 1);
  workspace.sessions.splice(target, 0, moved);
  return true;
}

function moveSessionToGroup(workspace, sessionId, groupId) {
  const session = workspace.sessions.find(s => s.id === sessionId);
  if (!session) return null;
  if (groupId !== null && !workspace.groups.some(g => g.id === groupId)) return null;
  if (session.state !== 'idle') return null;
  const fromGroupId = session.groupId;
  session.groupId = groupId;
  [fromGroupId, groupId].forEach(gid => {
    if (gid === null) return;
    const group = workspace.groups.find(g => g.id === gid);
    if (group) {
      ensureLayoutForCount(group, groupSessionIds(workspace, gid));
      if (gid === groupId) placeSessionInLayout(group, session.id);
    }
  });
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
  const idx = workspace.groups.findIndex(g => g.id === id);
  if (idx < 0) return false;
  const hasActive = workspace.sessions.some(s => s.groupId === id && s.state !== 'idle');
  if (hasActive) return false;
  workspace.sessions.forEach(s => { if (s.groupId === id) s.groupId = null; });
  workspace.groups.splice(idx, 1);
  return true;
}

function updateGroup(workspace, id, patch) {
  const group = workspace.groups.find(g => g.id === id);
  if (!group) return null;
  if ('name' in patch && patch.name) {
    const trimmed = String(patch.name).trim();
    if (trimmed) group.name = trimmed;
  }
  return group;
}

module.exports = {
  loadWorkspace, saveWorkspace,
  addSession, deleteSession, renameSession, reorderSession, moveSessionToGroup, setSessionMuted,
  addGroup, deleteGroup, renameGroup, updateGroup,
  ensureLayoutForCount, placeSessionInLayout,
  setLayoutRatios, swapLayoutCells, setLayoutManual, applyResizeHint,
  groupSessionIds,
};
