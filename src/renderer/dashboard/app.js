let currentSessions = [];
let selectedPreset = 'split-h-50';

window.sunkist.onSessionChanged((updated) => {
  const idx = currentSessions.findIndex(s => s.id === updated.id);
  if (idx >= 0) currentSessions[idx] = updated;
  renderSessions(currentSessions);
});

async function init() {
  const workspace = await window.sunkist.getWorkspace();
  currentSessions = workspace.sessions;
  selectedPreset = workspace.activePreset || 'split-h-50';
  document.querySelector(`.preset-btn[data-preset="${selectedPreset}"]`)?.classList.add('active');
  renderSessions(currentSessions);
}

function renderSessions(sessions) {
  const list = document.getElementById('session-list');
  list.innerHTML = sessions.map(s => `
    <li data-id="${s.id}">
      <span class="dot" style="background:${s.accentColor}"></span>
      <span>${s.name}</span>
      <span class="state">${s.state}</span>
      ${s.state !== 'idle' ? `<button class="btn-focus" data-id="${s.id}">▶</button>` : ''}
    </li>
  `).join('');

  list.querySelectorAll('.btn-focus').forEach(btn => {
    btn.addEventListener('click', () => window.sunkist.focusSession(btn.dataset.id));
  });
}

document.getElementById('btn-add').addEventListener('click', async () => {
  const name = prompt('Session name:', `Account ${currentSessions.length + 1}`);
  if (!name) return;
  const session = await window.sunkist.addSession(name);
  currentSessions.push(session);
  renderSessions(currentSessions);
});

init();

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedPreset = btn.dataset.preset;
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('btn-apply').addEventListener('click', async () => {
  const result = await window.sunkist.applyLayout(selectedPreset);
  if (result.error) alert(result.error);
});
