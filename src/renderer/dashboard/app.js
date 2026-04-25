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
      <span class="session-state ${s.state}">${s.state}</span>
      ${s.hwnd ? `<button class="btn-focus" data-id="${s.id}">&#9654;</button>` : ''}
    </li>
  `).join('');
  list.querySelectorAll('.btn-focus').forEach(b =>
    b.addEventListener('click', () => window.sunkist.focusSession(b.dataset.id)));
}

function renderCards(sessions) {
  const row = document.getElementById('cards-row');
  row.innerHTML = sessions.map(s => `
    <div class="session-card" style="border-top: 3px solid ${esc(s.accentColor)}">
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-state ${s.state}">${s.state}</div>
      <div class="card-hwnd">${s.hwnd ? `HWND 0x${Number(s.hwnd).toString(16).toUpperCase()}` : '—'}</div>
      ${s.state === 'idle'
        ? `<button class="card-btn" data-action="launch" data-id="${s.id}">Launch</button>`
        : `<button class="card-btn danger" data-action="close" data-id="${s.id}">Close</button>`
      }
    </div>
  `).join('');

  row.querySelectorAll('.card-btn').forEach(b => {
    b.addEventListener('click', async () => {
      const { action, id } = b.dataset;
      if (action === 'launch') {
        setStatus('Launching…');
        const r = await window.sunkist.launchSession(id);
        setStatus(r.error ? r.error : 'Launched', !!r.error);
      } else {
        await window.sunkist.closeSession(id);
        setStatus('Closed');
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

document.getElementById('btn-add').addEventListener('click', async () => {
  const name = prompt('Session name:', `Account ${currentSessions.length + 1}`);
  if (!name) return;
  const session = await window.sunkist.addSession(name);
  currentSessions.push(session);
  renderAll();
});

document.getElementById('chk-lock').addEventListener('change', async (e) => {
  await window.sunkist.saveWorkspace({ lockLayout: e.target.checked });
});

async function init() {
  const workspace = await window.sunkist.getWorkspace();
  currentSessions = workspace.sessions || [];
  selectedPreset  = workspace.activePreset || 'split-h-50';
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.preset-btn[data-preset="${selectedPreset}"]`)?.classList.add('active');
  document.getElementById('chk-lock').checked = !!workspace.lockLayout;
  renderAll();
}

init();
