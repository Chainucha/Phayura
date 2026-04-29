let workspace = { sessions: [], groups: [] };
let statusTimer = null;

const PRESET_INFO = {
  'split-h-50': { dir: 'row',    ratio: 0.5, label: '50 / 50' },
  'split-h-70': { dir: 'row',    ratio: 0.7, label: '70 / 30' },
  'split-h-30': { dir: 'row',    ratio: 0.3, label: '30 / 70' },
  'split-v-50': { dir: 'column', ratio: 0.5, label: '50 / 50' },
  'split-v-70': { dir: 'column', ratio: 0.7, label: '70 / 30' },
  'split-v-30': { dir: 'column', ratio: 0.3, label: '30 / 70' },
};

function ratioLabel(group) {
  const info = PRESET_INFO[group.activePreset] || PRESET_INFO['split-h-50'];
  const ratio = group.splitRatio ?? info.ratio;
  const a = Math.round(ratio * 100);
  const b = 100 - a;
  const dir = info.dir === 'row' ? 'H' : 'V';
  const tag = group.splitRatio != null ? ' · custom' : '';
  return `${a} / ${b} ${dir}${tag}`;
}

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
    <li draggable="true" data-id="${s.id}" data-state="${esc(s.state)}">
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
  });
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

  const presetOpt = (preset) => {
    const info = PRESET_INFO[preset];
    const sel  = group.activePreset === preset ? 'selected' : '';
    return `<option value="${preset}" ${sel}>${info.label}</option>`;
  };

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
              <button class="card-btn" data-action="rename" data-id="${s.id}" data-name="${esc(s.name)}">Rename</button>
              ${s.state === 'idle'
                ? `<button class="card-btn" data-action="launch" data-id="${s.id}">Launch</button>
                   <button class="card-btn danger" data-action="delete" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>`
                : `<button class="card-btn danger" data-action="close" data-id="${s.id}">Close</button>`}
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
        <select class="preset-select" data-group="${group.id}">
          <optgroup label="Horizontal">
            ${presetOpt('split-h-50')}
            ${presetOpt('split-h-70')}
            ${presetOpt('split-h-30')}
          </optgroup>
          <optgroup label="Vertical">
            ${presetOpt('split-v-50')}
            ${presetOpt('split-v-70')}
            ${presetOpt('split-v-30')}
          </optgroup>
        </select>
        <span class="ratio-display">${esc(ratioLabel(group))}</span>
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

  // Card drag-and-drop sources
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
  });

  // Group sections as drop targets
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
      const groupId = section.dataset.groupId;
      const session = workspace.sessions.find(s => s.id === sessionId);
      if (!session || session.groupId === groupId) return;
      const r = await window.sunkist.moveSessionToGroup(sessionId, groupId);
      if (r?.error) { setStatus(r.error, true); return; }
      if (r?.session) {
        const idx = workspace.sessions.findIndex(s => s.id === r.session.id);
        if (idx >= 0) workspace.sessions[idx] = { ...workspace.sessions[idx], ...r.session };
      }
      renderAll();
      setStatus('Moved');
    });
  });

  // Preset selection (per group) — picking a new preset clears any custom
  // saved splitRatio so the chosen preset's default ratio applies cleanly.
  root.querySelectorAll('.preset-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const groupId = sel.dataset.group;
      const preset  = sel.value;
      const group   = workspace.groups.find(g => g.id === groupId);
      if (group) { group.activePreset = preset; delete group.splitRatio; }
      await window.sunkist.updateGroup(groupId, { activePreset: preset, splitRatio: null });
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
      } else if (groupAction === 'add-session') {
        dlgInput.value = `Account ${workspace.sessions.length + 1}`;
        dlgGroupSel.innerHTML = workspace.groups.map(g =>
          `<option value="${g.id}">${esc(g.name)}</option>`).join('');
        dlgGroupSel.value = id;
        dlgGroupSel.disabled = true;
        addSubmit = false;
        dlgAdd.showModal();
        dlgInput.select();
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
  dlgGroupSel.disabled = false;
  if (!addSubmit) return;
  const name = dlgInput.value.trim();
  if (!name) return;
  const r = await window.sunkist.addSession(name, dlgGroupSel.value);
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
let hoverDelayMs = 0;
function renderHover(enabled) {
  btnHover.setAttribute('aria-pressed', String(enabled));
  btnHover.classList.toggle('on', enabled);
  btnHover.textContent = `Hover Focus: ${enabled ? 'On' : 'Off'}`;
}
btnHover.addEventListener('click', async () => {
  const next = btnHover.getAttribute('aria-pressed') !== 'true';
  renderHover(next);
  await window.sunkist.setHoverFocus(next, 120);
  setStatus(next ? 'Hover focus on' : 'Hover focus off');
});

window.sunkist.onRatioChanged(({ groupId, ratio }) => {
  // Update display inline — no full rerender needed
  const section = document.querySelector(`.group-section[data-group-id="${groupId}"]`);
  if (!section) return;
  const display = section.querySelector('.ratio-display');
  if (!display) return;
  const group = workspace.groups.find(g => g.id === groupId);
  if (!group) return;
  const info = PRESET_INFO[group.activePreset] || PRESET_INFO['split-h-50'];
  const a = Math.round(ratio * 100);
  const b = 100 - a;
  const dir = info.dir === 'row' ? 'H' : 'V';
  display.textContent = `${a} / ${b} ${dir} · live`;
});

async function init() {
  workspace = await window.sunkist.getWorkspace();
  workspace.sessions = workspace.sessions || [];
  workspace.groups   = workspace.groups   || [];
  hoverDelayMs = workspace.hoverFocusDelayMs ?? 0;
  renderHover(!!workspace.hoverFocusEnabled);
  renderAll();
}

init();
