let workspace = { sessions: [], groups: [] };
let statusTimer = null;

function describeLayout(group) {
  const L = group.layout || { cols: 0, rows: 0 };
  const n = countSessionsInGroup(group);
  return `${L.cols || 0}×${L.rows || 0} (${n} pane${n === 1 ? '' : 's'})`;
}

function countSessionsInGroup(group) {
  return workspace.sessions.filter(s => s.groupId === group.id).length;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.citra.onSessionChanged((updated) => {
  const idx = workspace.sessions.findIndex(s => s.id === updated.id);
  if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...updated };
  else workspace.sessions.push(updated);
  renderAll();
});

function renderAll() {
  renderSidebar();
  renderUngrouped();
  renderGroups();
}

function renderSidebar() {
  const list = document.getElementById('session-list');
  const sessions = workspace.sessions;
  list.innerHTML = sessions.map((s) => {
    const group = workspace.groups.find(g => g.id === s.groupId);
    const groupLabel = group?.name || 'ungrouped';
    return `
    <li draggable="true" data-id="${s.id}" data-state="${esc(s.state)}">
      <span class="dot" style="background:${esc(s.accentColor)}"></span>
      <span class="session-name" title="${esc(s.name)} — ${esc(groupLabel)}">${esc(s.name)}</span>
      <span class="session-state ${esc(s.state)}">${esc(s.state)}</span>
      <button class="btn-mute ${s.muted ? 'muted' : ''}" data-id="${s.id}" data-muted="${s.muted ? '1' : '0'}" title="${s.muted ? 'Unmute' : 'Mute'}">${s.muted ? '&#128263;' : '&#128266;'}</button>
      <button class="btn-rename" data-id="${s.id}" data-name="${esc(s.name)}" title="Rename">&#9998;</button>
      ${s.hwnd ? `<button class="btn-focus" data-id="${s.id}">&#9654;</button>` : ''}
    </li>`;
  }).join('');

  list.querySelectorAll('.btn-focus').forEach(b =>
    b.addEventListener('click', () => window.citra.focusSession(b.dataset.id)));
  list.querySelectorAll('.btn-rename').forEach(b =>
    b.addEventListener('click', () => openRename(b.dataset.id, b.dataset.name)));
  list.querySelectorAll('.btn-mute').forEach(b =>
    b.addEventListener('click', async () => {
      const next = b.dataset.muted !== '1';
      const r = await window.citra.setSessionMuted(b.dataset.id, next);
      if (r?.error) { setStatus(r.error, true); return; }
      if (r?.session) {
        const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
        if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
      }
      renderAll();
    }));

  list.querySelectorAll('li[draggable]').forEach(li => {
    li.addEventListener('dragstart', e => {
      if (li.dataset.state !== 'idle') { e.preventDefault(); return; }
      e.dataTransfer.setData('text/session-id', li.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
    });
    // Drop on sidebar item = reorder in workspace array, keep dragged session's group.
    // Cursor Y vs midpoint decides before-vs-after (after = beforeId of next sibling, null if last).
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      li.classList.toggle('drop-before', !after);
      li.classList.toggle('drop-after',   after);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-before');
      li.classList.remove('drop-after');
    });
    li.addEventListener('drop', async e => {
      e.preventDefault();
      const rect = li.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      li.classList.remove('drop-before');
      li.classList.remove('drop-after');
      const sessionId = e.dataTransfer.getData('text/session-id');
      if (!sessionId || sessionId === li.dataset.id) return;
      const dragged = workspace.sessions.find(s => s.id === sessionId);
      if (!dragged) return;
      const anchorId = after ? (li.nextElementSibling?.dataset.id ?? null) : li.dataset.id;
      // Dropping on self's neighbor in the "after self" slot → no-op (would land back on self).
      if (anchorId === sessionId) return;
      const r = await reorderOrMove(sessionId, dragged.groupId, anchorId);
      if (r) setStatus(r);
    });
  });
}

function renderGroups() {
  const root = document.getElementById('groups-container');
  root.innerHTML = workspace.groups.map(g => renderGroupSection(g)).join('');
  attachGroupHandlers(root);
}

function renderUngrouped() {
  const root = document.getElementById('ungrouped-list');
  const sessions = workspace.sessions.filter(s => !s.groupId);
  document.getElementById('ungrouped-count').textContent = sessions.length;
  root.innerHTML = sessions.length === 0
    ? `<div class="empty-group">Drop a session here to ungroup.</div>`
    : sessions.map(s => `
        <div class="ungrouped-item" draggable="true" data-id="${s.id}" data-state="${esc(s.state)}">
          <span class="dot" style="background:${esc(s.accentColor)}"></span>
          <span class="ungrouped-name" title="${esc(s.name)}">${esc(s.name)}</span>
          <button class="btn-rename" data-action="rename" data-id="${s.id}" data-name="${esc(s.name)}" title="Rename">&#9998;</button>
          <button class="btn-rename danger" data-action="delete" data-id="${s.id}" data-name="${esc(s.name)}" title="Delete">&#10005;</button>
        </div>`).join('');

  attachUngroupedHandlers(root);
}

function attachUngroupedHandlers(root) {
  root.querySelectorAll('button[data-action]').forEach(b => {
    b.addEventListener('click', async () => {
      const { action, id, name } = b.dataset;
      if (action === 'rename') {
        openRename(id, name);
      } else if (action === 'delete') {
        if (!confirm(`Delete session "${name}"? Cookies and storage for this account will be removed on next launch.`)) return;
        const r = await window.citra.deleteSession(id);
        if (r.error) { setStatus(r.error, true); return; }
        workspace.sessions = workspace.sessions.filter(s => s.id !== id);
        renderAll();
        setStatus('Deleted');
      }
    });
  });

  root.querySelectorAll('.ungrouped-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      if (item.dataset.state !== 'idle') { e.preventDefault(); return; }
      e.dataTransfer.setData('text/session-id', item.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
  });
}

function initUngroupedDropZone() {
  const details = document.getElementById('ungrouped-details');
  const root = document.getElementById('ungrouped-list');
  details.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    details.classList.add('drag-over');
    if (!details.open) details.open = true;
  });
  details.addEventListener('dragleave', e => {
    if (!details.contains(e.relatedTarget)) details.classList.remove('drag-over');
  });
  details.addEventListener('drop', async e => {
    e.preventDefault();
    details.classList.remove('drag-over');
    const sessionId = e.dataTransfer.getData('text/session-id');
    const session = workspace.sessions.find(s => s.id === sessionId);
    if (!session || session.groupId === null) return;
    const r = await window.citra.moveSessionToGroup(sessionId, null);
    if (r?.error) { setStatus(r.error, true); return; }
    if (r?.session) {
      const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
      if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
    }
    renderAll();
    setStatus('Ungrouped');
  });
}

function renderGroupSection(group) {
  const sessions = workspace.sessions.filter(s => s.groupId === group.id);
  const anyActive = sessions.some(s => s.state !== 'idle');
  const idleCount = sessions.filter(s => s.state === 'idle').length;

  const cards = sessions.length === 0
    ? `<div class="empty-group">No sessions in this group. Use "+ Add Session" to add one.</div>`
    : sessions.map(s => `
          <div class="session-card" draggable="true" data-id="${s.id}" data-state="${esc(s.state)}"
               style="border-top: 3px solid ${esc(s.accentColor)}">
            <div class="card-header">
              <span class="card-name">${esc(s.name)}</span>
              <span class="card-state ${esc(s.state)}">${esc(s.state)}</span>
            </div>
            <div class="card-actions">
              ${s.state === 'idle'
                ? `<button class="card-btn" data-action="launch" data-id="${s.id}">Launch</button>
                   <button class="card-btn" data-action="mute" data-id="${s.id}" data-muted="${s.muted ? '1' : '0'}">${s.muted ? '🔇 Unmute' : '🔊 Mute'}</button>
                   <button class="card-btn danger" data-action="remove" data-id="${s.id}" data-name="${esc(s.name)}">Remove</button>`
                : `<button class="card-btn" data-action="mute" data-id="${s.id}" data-muted="${s.muted ? '1' : '0'}">${s.muted ? '🔇 Unmute' : '🔊 Mute'}</button>
                   <button class="card-btn danger" data-action="close" data-id="${s.id}">Close</button>`}
            </div>
          </div>`).join('');

  return `
    <section class="group-section" data-group-id="${group.id}">
      <header class="group-header">
        <h2 class="group-title">${esc(group.name)}</h2>
        <div class="group-actions">
          <button class="btn-secondary group-btn" data-group-action="rename" data-id="${group.id}" data-name="${esc(group.name)}">Rename</button>
          <button class="btn-secondary group-btn danger-text" data-group-action="delete" data-id="${group.id}" data-name="${esc(group.name)}" ${anyActive ? 'disabled title="Close all sessions first"' : ''}>Delete</button>
          <button class="btn-accent group-btn" data-group-action="launch" data-id="${group.id}" ${idleCount === 0 ? 'disabled' : ''}>Launch Group</button>
          <button class="btn-primary danger group-btn" data-group-action="close" data-id="${group.id}" ${!anyActive ? 'disabled' : ''}>Close Group</button>
        </div>
      </header>

      <div class="cards-row">${cards}</div>

      <button class="btn-secondary group-add-session" data-group-action="add-session" data-id="${group.id}">+ Add Session</button>

      <div class="group-toolbar">
        <span class="section-label inline">LAYOUT</span>
        <span class="layout-display">${esc(describeLayout(group))}</span>
      </div>
    </section>`;
}

function attachGroupHandlers(root) {
  // Card buttons
  root.querySelectorAll('.session-card .card-btn').forEach(b => {
    b.addEventListener('click', async () => {
      const { action, id, name } = b.dataset;
      if (action === 'launch') {
        setStatus('Launching…');
        const r = await window.citra.launchSession(id);
        setStatus(r.error ? r.error : 'Launched', !!r.error);
      } else if (action === 'close') {
        await window.citra.closeSession(id);
        setStatus('Closed');
      } else if (action === 'rename') {
        openRename(id, name);
      } else if (action === 'mute') {
        const next = b.dataset.muted !== '1';
        const r = await window.citra.setSessionMuted(id, next);
        if (r?.error) { setStatus(r.error, true); return; }
        if (r?.session) {
          const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
          if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
        }
        renderAll();
        setStatus(next ? 'Muted' : 'Unmuted');
      } else if (action === 'remove') {
        const r = await window.citra.moveSessionToGroup(id, null);
        if (r?.error) { setStatus(r.error, true); return; }
        if (r?.session) {
          const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
          if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
        }
        renderAll();
        setStatus('Removed from group');
      } else if (action === 'delete') {
        if (!confirm(`Delete session "${name}"? Cookies and storage for this account will be removed on next launch.`)) return;
        const r = await window.citra.deleteSession(id);
        if (r.error) { setStatus(r.error, true); return; }
        workspace.sessions = workspace.sessions.filter(s => s.id !== id);
        renderAll();
        setStatus('Deleted');
      }
    });
  });

  // Card drag-and-drop sources + per-card drop targets (place-before reorder)
  root.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      if (card.dataset.state !== 'idle') { e.preventDefault(); return; }
      e.dataTransfer.setData('text/session-id', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      card.classList.toggle('drop-before', !after);
      card.classList.toggle('drop-after',   after);
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drop-before');
      card.classList.remove('drop-after');
    });
    card.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      const rect = card.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      card.classList.remove('drop-before');
      card.classList.remove('drop-after');
      const sessionId = e.dataTransfer.getData('text/session-id');
      if (!sessionId || sessionId === card.dataset.id) return;
      const section = card.closest('.group-section');
      const groupId = section?.dataset.groupId || null;
      const anchorId = after ? (card.nextElementSibling?.dataset.id ?? null) : card.dataset.id;
      if (anchorId === sessionId) return;
      const r = await reorderOrMove(sessionId, groupId, anchorId);
      if (r) setStatus(r);
    });
  });

  // Group sections as drop targets (drop on empty area = append at end)
  root.querySelectorAll('.group-section').forEach(section => {
    section.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      section.classList.add('drag-over');
    });
    section.addEventListener('dragleave', e => {
      if (!section.contains(e.relatedTarget)) {
        section.classList.remove('drag-over');
      }
    });
    section.addEventListener('drop', async e => {
      e.preventDefault();
      section.classList.remove('drag-over');
      const sessionId = e.dataTransfer.getData('text/session-id');
      const groupId = section.dataset.groupId === '' ? null : section.dataset.groupId;
      if (!sessionId) return;
      const r = await reorderOrMove(sessionId, groupId, null);
      if (r) setStatus(r);
    });
  });

  // Group action buttons
  root.querySelectorAll('[data-group-action]').forEach(b => {
    b.addEventListener('click', async () => {
      const { groupAction, id, name } = b.dataset;
      if (groupAction === 'launch') {
        setStatus('Launching group…');
        const r = await window.citra.launchGroup(id);
        setStatus(r.error ? r.error : 'Group launched', !!r.error);
      } else if (groupAction === 'close') {
        await window.citra.closeGroup(id);
        setStatus('Group closed');
      } else if (groupAction === 'rename') {
        openGroupDialog('rename', id, name);
      } else if (groupAction === 'delete') {
        if (!confirm(`Delete group "${name}"? Sessions will be moved to Ungrouped.`)) return;
        const r = await window.citra.deleteGroup(id);
        if (r.error) { setStatus(r.error, true); return; }
        if (r.workspace) workspace = r.workspace;
        renderAll();
        setStatus('Group deleted');
      } else if (groupAction === 'add-session') {
        dlgInput.value = `Account ${workspace.sessions.length + 1}`;
        dlgGroupSel.innerHTML = buildGroupOptions();
        dlgGroupSel.value = id;
        dlgGroupSel.disabled = true;
        addSubmit = false;
        dlgAdd.showModal();
        dlgInput.select();
      }
    });
  });
}

// Unified reorder/cross-group move. beforeId=null appends at end of group.
async function reorderOrMove(sessionId, groupId, beforeId) {
  const session = workspace.sessions.find(s => s.id === sessionId);
  if (!session) return null;
  // No-op: dropping in same group with no anchor change.
  if (session.groupId === groupId && beforeId === null && isLastInGroup(session)) return null;
  const r = await window.citra.moveSessionToGroup(sessionId, groupId, beforeId);
  if (r?.error) { setStatus(r.error, true); return null; }
  if (r?.sessions) workspace.sessions = r.sessions;
  renderAll();
  return session.groupId !== groupId ? 'Moved' : 'Reordered';
}

function isLastInGroup(session) {
  const peers = workspace.sessions.filter(s => s.groupId === session.groupId);
  return peers[peers.length - 1]?.id === session.id;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

// ── Add Session dialog ─────────────────────────────────────────────────────
const dlgAdd      = document.getElementById('dlg-add');
const dlgInput    = document.getElementById('dlg-add-input');
const dlgGroupSel = document.getElementById('dlg-add-group');
let addSubmit = false;

function buildGroupOptions() {
  const groupOpts = workspace.groups.map(g =>
    `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  return groupOpts + `<option value="">(Ungrouped)</option>`;
}

document.getElementById('btn-add').addEventListener('click', () => {
  dlgInput.value = `Account ${workspace.sessions.length + 1}`;
  dlgGroupSel.innerHTML = buildGroupOptions();
  dlgGroupSel.value = workspace.groups[0]?.id ?? '';
  addSubmit = false;
  dlgAdd.showModal();
  dlgInput.select();
});

dlgAdd.querySelector('form').addEventListener('submit', () => { addSubmit = true; });
document.getElementById('dlg-add-cancel').addEventListener('click', () => dlgAdd.close());

dlgAdd.addEventListener('close', async () => {
  dlgGroupSel.disabled = false;
  if (!addSubmit) return;
  const name = dlgInput.value.trim();
  if (!name) return;
  const groupId = dlgGroupSel.value === '' ? null : dlgGroupSel.value;
  const r = await window.citra.addSession(name, groupId);
  if (r?.error) { setStatus(r.error, true); return; }
  workspace.sessions.push(r);
  renderAll();
});

// ── Rename Session dialog ──────────────────────────────────────────────────
const dlgRename      = document.getElementById('dlg-rename');
const dlgRenameInput = document.getElementById('dlg-rename-input');
let renameTargetId = null;
let renameSubmit   = false;

function openRename(id, currentName) {
  renameTargetId = id;
  renameSubmit   = false;
  dlgRenameInput.value = currentName || '';
  dlgRename.showModal();
  dlgRenameInput.select();
}

dlgRename.querySelector('form').addEventListener('submit', () => { renameSubmit = true; });
document.getElementById('dlg-rename-cancel').addEventListener('click', () => dlgRename.close());

dlgRename.addEventListener('close', async () => {
  if (!renameSubmit || !renameTargetId) return;
  const name = dlgRenameInput.value.trim();
  if (!name) return;
  const r = await window.citra.renameSession(renameTargetId, name);
  if (r?.error) { setStatus(r.error, true); return; }
  const idx = workspace.sessions.findIndex(s => s.id === renameTargetId);
  if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
  renameTargetId = null;
  renderAll();
  setStatus('Renamed');
});

// ── Group dialog (add / rename) ────────────────────────────────────────────
const dlgGroup      = document.getElementById('dlg-group');
const dlgGroupTitle = document.getElementById('dlg-group-title');
const dlgGroupInput = document.getElementById('dlg-group-input');
let groupDialogMode = 'add'; // 'add' | 'rename'
let groupDialogId   = null;
let groupSubmit     = false;

function openGroupDialog(mode, id, currentName) {
  groupDialogMode = mode;
  groupDialogId   = id || null;
  groupSubmit     = false;
  dlgGroupTitle.textContent = mode === 'rename' ? 'RENAME GROUP' : 'NEW GROUP NAME';
  dlgGroupInput.value = currentName || `Group ${workspace.groups.length + 1}`;
  dlgGroup.showModal();
  dlgGroupInput.select();
}

document.getElementById('btn-add-group').addEventListener('click', () => {
  openGroupDialog('add');
});

document.getElementById('btn-kofi').addEventListener('click', () => {
  window.citra.openKofi();
});

dlgGroup.querySelector('form').addEventListener('submit', () => { groupSubmit = true; });
document.getElementById('dlg-group-cancel').addEventListener('click', () => dlgGroup.close());

dlgGroup.addEventListener('close', async () => {
  if (!groupSubmit) return;
  const name = dlgGroupInput.value.trim();
  if (!name) return;
  if (groupDialogMode === 'add') {
    const r = await window.citra.addGroup(name);
    if (r?.error) { setStatus(r.error, true); return; }
    workspace.groups.push(r.group);
    renderAll();
    setStatus('Group added');
  } else if (groupDialogMode === 'rename' && groupDialogId) {
    const r = await window.citra.renameGroup(groupDialogId, name);
    if (r?.error) { setStatus(r.error, true); return; }
    const idx = workspace.groups.findIndex(g => g.id === groupDialogId);
    if (idx >= 0) workspace.groups[idx] = { ...workspace.groups[idx], ...r.group };
    renderAll();
    setStatus('Group renamed');
  }
});

// ── Hover Focus toggle ─────────────────────────────────────────────────────
const btnHover = document.getElementById('btn-hover');
let hoverDelayMs = 0;
function renderHover(enabled) {
  btnHover.setAttribute('aria-pressed', String(enabled));
  btnHover.classList.toggle('on', enabled);
  btnHover.textContent = `Hover Focus: ${enabled ? 'On' : 'Off'}`;
}
btnHover.addEventListener('click', async () => {
  const next = btnHover.getAttribute('aria-pressed') !== 'true';
  renderHover(next);
  await window.citra.setHoverFocus(next, 30);
  setStatus(next ? 'Hover focus on' : 'Hover focus off');
});

async function init() {
  workspace = await window.citra.getWorkspace();
  workspace.sessions = workspace.sessions || [];
  workspace.groups   = workspace.groups   || [];
  hoverDelayMs = workspace.hoverFocusDelayMs ?? 0;
  renderHover(!!workspace.hoverFocusEnabled);
  initUngroupedDropZone();
  renderAll();
}

init();
