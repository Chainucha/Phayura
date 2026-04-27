let workspace = { sessions: [], groups: [] };
let statusTimer = null;

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.sunkist.onSessionChanged((updated) => {
  const idx = workspace.sessions.findIndex(s => s.id === updated.id);
  if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...updated };
  else workspace.sessions.push(updated);
  renderAll();
});

function renderAll() {
  renderSidebar();
  renderGroups();
}

function renderSidebar() {
  const list = document.getElementById('session-list');
  const sessions = workspace.sessions;
  const last = sessions.length - 1;
  list.innerHTML = sessions.map((s, i) => {
    const group = workspace.groups.find(g => g.id === s.groupId);
    return `
    <li>
      <span class="dot" style="background:${esc(s.accentColor)}"></span>
      <span class="session-name" title="${esc(s.name)} — ${esc(group?.name || '')}">${esc(s.name)}</span>
      <span class="session-state ${esc(s.state)}">${esc(s.state)}</span>
      <button class="btn-move" data-id="${s.id}" data-dir="up" title="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
      <button class="btn-move" data-id="${s.id}" data-dir="down" title="Move down" ${i === last ? 'disabled' : ''}>&#9660;</button>
      <button class="btn-rename" data-id="${s.id}" data-name="${esc(s.name)}" title="Rename">&#9998;</button>
      ${s.hwnd ? `<button class="btn-focus" data-id="${s.id}">&#9654;</button>` : ''}
    </li>`;
  }).join('');
  list.querySelectorAll('.btn-focus').forEach(b =>
    b.addEventListener('click', () => window.sunkist.focusSession(b.dataset.id)));
  list.querySelectorAll('.btn-rename').forEach(b =>
    b.addEventListener('click', () => openRename(b.dataset.id, b.dataset.name)));
  list.querySelectorAll('.btn-move').forEach(b =>
    b.addEventListener('click', async () => {
      const r = await window.sunkist.reorderSession(b.dataset.id, b.dataset.dir);
      if (r?.error) { setStatus(r.error, true); return; }
      if (r?.sessions) workspace.sessions = r.sessions;
      renderAll();
    }));
}

function renderGroups() {
  const root = document.getElementById('groups-container');
  root.innerHTML = workspace.groups.map(g => renderGroupSection(g)).join('');
  attachGroupHandlers(root);
}

function renderGroupSection(group) {
  const sessions = workspace.sessions.filter(s => s.groupId === group.id);
  const anyActive = sessions.some(s => s.state !== 'idle');
  const idleCount = sessions.filter(s => s.state === 'idle').length;
  const groupOptions = workspace.groups.map(o =>
    `<option value="${o.id}">${esc(o.name)}</option>`).join('');

  const presetBtn = (preset, label) =>
    `<button class="preset-btn ${group.activePreset === preset ? 'active' : ''}" data-group="${group.id}" data-preset="${preset}">${label}</button>`;

  const cards = sessions.length === 0
    ? `<div class="empty-group">No sessions in this group. Use "+ Add Session" to add one.</div>`
    : sessions.map(s => {
        const groupSelect = `
          <select class="card-group-select" data-id="${s.id}" ${s.state !== 'idle' ? 'disabled' : ''} title="Move to group">
            ${workspace.groups.map(o =>
              `<option value="${o.id}" ${o.id === s.groupId ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select>`;
        return `
          <div class="session-card" style="border-top: 3px solid ${esc(s.accentColor)}">
            <div class="card-name">${esc(s.name)}</div>
            <div class="card-state ${esc(s.state)}">${esc(s.state)}</div>
            <div class="card-hwnd">${s.hwnd ? `HWND 0x${Number(s.hwnd).toString(16).toUpperCase()}` : '—'}</div>
            ${groupSelect}
            <button class="card-btn" data-action="rename" data-id="${s.id}" data-name="${esc(s.name)}">Rename</button>
            ${s.state === 'idle'
              ? `<button class="card-btn" data-action="launch" data-id="${s.id}">Launch</button>
                 <button class="card-btn danger" data-action="delete" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>`
              : `<button class="card-btn danger" data-action="close" data-id="${s.id}">Close</button>`
            }
          </div>`;
      }).join('');

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

      <div class="group-toolbar">
        <span class="section-label inline">LAYOUT</span>
        <div class="preset-row">
          ${presetBtn('split-h-50', '50/50 H')}
          ${presetBtn('split-v-50', '50/50 V')}
          ${presetBtn('split-h-70', '70/30 H')}
          ${presetBtn('split-v-70', '70/30 V')}
          ${presetBtn('split-h-30', '30/70 H')}
          ${presetBtn('split-v-30', '30/70 V')}
        </div>
        <button class="btn-primary apply-btn" data-group-action="apply" data-id="${group.id}" ${!anyActive ? 'disabled' : ''}>Apply</button>
        <button class="btn-toggle ${group.lockLayout ? 'locked' : ''}" data-group-action="lock" data-id="${group.id}" aria-pressed="${group.lockLayout}">
          ${group.lockLayout ? '🔒 Locked' : '🔓 Unlocked'}
        </button>
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
        const r = await window.sunkist.launchSession(id);
        setStatus(r.error ? r.error : 'Launched', !!r.error);
      } else if (action === 'close') {
        await window.sunkist.closeSession(id);
        setStatus('Closed');
      } else if (action === 'rename') {
        openRename(id, name);
      } else if (action === 'delete') {
        if (!confirm(`Delete session "${name}"? Cookies and storage for this account will be removed on next launch.`)) return;
        const r = await window.sunkist.deleteSession(id);
        if (r.error) { setStatus(r.error, true); return; }
        workspace.sessions = workspace.sessions.filter(s => s.id !== id);
        renderAll();
        setStatus('Deleted');
      }
    });
  });

  // Move-to-group dropdown
  root.querySelectorAll('.card-group-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const r = await window.sunkist.moveSessionToGroup(sel.dataset.id, sel.value);
      if (r?.error) { setStatus(r.error, true); return; }
      if (r?.session) {
        const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
        if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
      }
      renderAll();
      setStatus('Moved');
    });
  });

  // Preset selection (per group)
  root.querySelectorAll('.preset-btn').forEach(b => {
    b.addEventListener('click', async () => {
      const groupId = b.dataset.group;
      const preset  = b.dataset.preset;
      const group   = workspace.groups.find(g => g.id === groupId);
      if (group) group.activePreset = preset;
      await window.sunkist.updateGroup(groupId, { activePreset: preset });
      renderAll();
    });
  });

  // Group action buttons
  root.querySelectorAll('[data-group-action]').forEach(b => {
    b.addEventListener('click', async () => {
      const { groupAction, id, name } = b.dataset;
      if (groupAction === 'launch') {
        setStatus('Launching group…');
        const r = await window.sunkist.launchGroup(id);
        setStatus(r.error ? r.error : 'Group launched', !!r.error);
      } else if (groupAction === 'close') {
        await window.sunkist.closeGroup(id);
        setStatus('Group closed');
      } else if (groupAction === 'apply') {
        const group = workspace.groups.find(g => g.id === id);
        const r = await window.sunkist.applyLayout(id, group?.activePreset);
        setStatus(r.error || 'Layout applied', !!r.error);
      } else if (groupAction === 'lock') {
        const group = workspace.groups.find(g => g.id === id);
        if (!group) return;
        const next = !group.lockLayout;
        group.lockLayout = next;
        await window.sunkist.updateGroup(id, { lockLayout: next });
        renderAll();
        setStatus(next ? 'Layout locked' : 'Layout unlocked');
      } else if (groupAction === 'rename') {
        openGroupDialog('rename', id, name);
      } else if (groupAction === 'delete') {
        if (!confirm(`Delete group "${name}"? Sessions will be moved to another group.`)) return;
        const r = await window.sunkist.deleteGroup(id);
        if (r.error) { setStatus(r.error, true); return; }
        if (r.workspace) workspace = r.workspace;
        renderAll();
        setStatus('Group deleted');
      }
    });
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 3000);
}

document.getElementById('btn-save').addEventListener('click', async () => {
  await window.sunkist.saveWorkspace({});
  setStatus('Saved');
});

// ── Add Session dialog ─────────────────────────────────────────────────────
const dlgAdd      = document.getElementById('dlg-add');
const dlgInput    = document.getElementById('dlg-add-input');
const dlgGroupSel = document.getElementById('dlg-add-group');
let addSubmit = false;

document.getElementById('btn-add').addEventListener('click', () => {
  dlgInput.value = `Account ${workspace.sessions.length + 1}`;
  dlgGroupSel.innerHTML = workspace.groups.map(g =>
    `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  addSubmit = false;
  dlgAdd.showModal();
  dlgInput.select();
});

dlgAdd.querySelector('form').addEventListener('submit', () => { addSubmit = true; });
document.getElementById('dlg-add-cancel').addEventListener('click', () => dlgAdd.close());

dlgAdd.addEventListener('close', async () => {
  if (!addSubmit) return;
  const name = dlgInput.value.trim();
  if (!name) return;
  const session = await window.sunkist.addSession(name, dlgGroupSel.value);
  workspace.sessions.push(session);
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
  const r = await window.sunkist.renameSession(renameTargetId, name);
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

dlgGroup.querySelector('form').addEventListener('submit', () => { groupSubmit = true; });
document.getElementById('dlg-group-cancel').addEventListener('click', () => dlgGroup.close());

dlgGroup.addEventListener('close', async () => {
  if (!groupSubmit) return;
  const name = dlgGroupInput.value.trim();
  if (!name) return;
  if (groupDialogMode === 'add') {
    const r = await window.sunkist.addGroup(name);
    if (r?.error) { setStatus(r.error, true); return; }
    workspace.groups.push(r.group);
    renderAll();
    setStatus('Group added');
  } else if (groupDialogMode === 'rename' && groupDialogId) {
    const r = await window.sunkist.renameGroup(groupDialogId, name);
    if (r?.error) { setStatus(r.error, true); return; }
    const idx = workspace.groups.findIndex(g => g.id === groupDialogId);
    if (idx >= 0) workspace.groups[idx] = { ...workspace.groups[idx], ...r.group };
    renderAll();
    setStatus('Group renamed');
  }
});

// ── Hover Focus toggle ─────────────────────────────────────────────────────
const btnHover = document.getElementById('btn-hover');
let hoverDelayMs = 400;
function renderHover(enabled) {
  btnHover.setAttribute('aria-pressed', String(enabled));
  btnHover.classList.toggle('on', enabled);
  btnHover.textContent = `Hover Focus: ${enabled ? 'On' : 'Off'}`;
}
btnHover.addEventListener('click', async () => {
  const next = btnHover.getAttribute('aria-pressed') !== 'true';
  renderHover(next);
  await window.sunkist.setHoverFocus(next, hoverDelayMs);
  setStatus(next ? 'Hover focus on' : 'Hover focus off');
});

async function init() {
  workspace = await window.sunkist.getWorkspace();
  workspace.sessions = workspace.sessions || [];
  workspace.groups   = workspace.groups   || [];
  hoverDelayMs = workspace.hoverFocusDelayMs || 400;
  renderHover(!!workspace.hoverFocusEnabled);
  renderAll();
}

init();
