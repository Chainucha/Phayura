let currentSessions = [];
let selectedPreset = 'split-h-50';
let statusTimer = null;

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Receive state updates from main
window.sunkist.onSessionChanged((updated) => {
  const idx = currentSessions.findIndex(s => s.id === updated.id);
  if (idx >= 0) currentSessions[idx] = { ...currentSessions[idx], ...updated };
  else currentSessions.push(updated);
  renderAll();
});

function renderAll() {
  renderSidebar(currentSessions);
  renderCards(currentSessions);
}

function renderSidebar(sessions) {
  const list = document.getElementById('session-list');
  list.innerHTML = sessions.map(s => `
    <li>
      <span class="dot" style="background:${esc(s.accentColor)}"></span>
      <span class="session-name" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="session-state ${esc(s.state)}">${esc(s.state)}</span>
      <button class="btn-rename" data-id="${s.id}" data-name="${esc(s.name)}" title="Rename">&#9998;</button>
      ${s.hwnd ? `<button class="btn-focus" data-id="${s.id}">&#9654;</button>` : ''}
    </li>
  `).join('');
  list.querySelectorAll('.btn-focus').forEach(b =>
    b.addEventListener('click', () => window.sunkist.focusSession(b.dataset.id)));
  list.querySelectorAll('.btn-rename').forEach(b =>
    b.addEventListener('click', () => openRename(b.dataset.id, b.dataset.name)));
}

function renderCards(sessions) {
  const row = document.getElementById('cards-row');
  row.innerHTML = sessions.map(s => `
    <div class="session-card" style="border-top: 3px solid ${esc(s.accentColor)}">
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-state ${esc(s.state)}">${esc(s.state)}</div>
      <div class="card-hwnd">${s.hwnd ? `HWND 0x${Number(s.hwnd).toString(16).toUpperCase()}` : '—'}</div>
      <button class="card-btn" data-action="rename" data-id="${s.id}" data-name="${esc(s.name)}">Rename</button>
      ${s.state === 'idle'
        ? `<button class="card-btn" data-action="launch" data-id="${s.id}">Launch</button>
           <button class="card-btn danger" data-action="delete" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>`
        : `<button class="card-btn danger" data-action="close" data-id="${s.id}">Close</button>`
      }
    </div>
  `).join('');

  row.querySelectorAll('.card-btn').forEach(b => {
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
        currentSessions = currentSessions.filter(s => s.id !== id);
        renderAll();
        setStatus('Deleted');
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

// Preset buttons
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedPreset = btn.dataset.preset;
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('btn-apply').addEventListener('click', async () => {
  const r = await window.sunkist.applyLayout(selectedPreset);
  setStatus(r.error || 'Layout applied', !!r.error);
});

document.getElementById('btn-launch-all').addEventListener('click', async () => {
  setStatus('Launching all…');
  const results = await Promise.all(
    currentSessions.filter(s => s.state === 'idle').map(s => window.sunkist.launchSession(s.id))
  );
  const errors = results.filter(r => r?.error);
  setStatus(errors.length ? errors.map(e => e.error).join(', ') : 'All launched', errors.length > 0);
});

document.getElementById('btn-save').addEventListener('click', async () => {
  await window.sunkist.saveWorkspace({ activePreset: selectedPreset });
  setStatus('Saved');
});

const dlgAdd   = document.getElementById('dlg-add');
const dlgInput = document.getElementById('dlg-add-input');

document.getElementById('btn-add').addEventListener('click', () => {
  dlgInput.value = `Account ${currentSessions.length + 1}`;
  dlgAdd.showModal();
  dlgInput.select();
});

document.getElementById('dlg-add-cancel').addEventListener('click', () => dlgAdd.close());

dlgAdd.addEventListener('close', async () => {
  const name = dlgInput.value.trim();
  if (!name) return;
  const session = await window.sunkist.addSession(name);
  currentSessions.push(session);
  renderAll();
});

const dlgRename      = document.getElementById('dlg-rename');
const dlgRenameInput = document.getElementById('dlg-rename-input');
let renameTargetId   = null;
let renameSubmit     = false;

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
  const idx = currentSessions.findIndex(s => s.id === renameTargetId);
  if (idx >= 0) currentSessions[idx] = { ...currentSessions[idx], ...r.session };
  renameTargetId = null;
  renderAll();
  setStatus('Renamed');
});

const btnLock = document.getElementById('btn-lock');
function renderLock(isLocked) {
  btnLock.setAttribute('aria-pressed', String(isLocked));
  btnLock.classList.toggle('locked', isLocked);
  btnLock.textContent = isLocked ? '🔒 Locked' : '🔓 Unlocked';
}
btnLock.addEventListener('click', async () => {
  const next = btnLock.getAttribute('aria-pressed') !== 'true';
  renderLock(next);
  await window.sunkist.saveWorkspace({ lockLayout: next });
  setStatus(next ? 'Layout locked' : 'Layout unlocked');
});

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
  const workspace = await window.sunkist.getWorkspace();
  currentSessions = workspace.sessions || [];
  selectedPreset  = workspace.activePreset || 'split-h-50';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.preset-btn[data-preset="${selectedPreset}"]`)?.classList.add('active');
  renderLock(!!workspace.lockLayout);
  hoverDelayMs = workspace.hoverFocusDelayMs || 400;
  renderHover(!!workspace.hoverFocusEnabled);
  renderAll();
}

init();
