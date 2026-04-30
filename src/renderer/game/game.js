const wrappers  = new Map();
let dividers    = [];
let layoutState = null;
let sessionsById = new Map();
let hoverEnabled = false;
let hoverDelayMs = 120;
let hoverTimer   = null;
let isDragging   = false;
let zoomedSessionId = null;
let editModeActive = false;
let saveLayoutPending = false;

const containerEl = () => document.getElementById('container');
const overlayEl   = () => document.getElementById('drag-overlay');

window.gameBridge.onUpdate(({ sessions, layout, hoverFocusEnabled, hoverFocusDelayMs }) => {
  hoverEnabled = !!hoverFocusEnabled;
  hoverDelayMs = hoverFocusDelayMs ?? 120;

  sessionsById = new Map(sessions.map(s => [s.id, s]));
  layoutState = layout;

  reconcile();
  sessions.forEach(syncLabel);
});

window.gameBridge.onFocusWebview(({ id }) => {
  const wrap = wrappers.get(id);
  const wv = wrap?.querySelector('webview');
  if (!wv) return;
  try { document.activeElement?.blur?.(); } catch {}
  try { wv.focus(); } catch {}
});

window.gameBridge.ready();

function reconcile() {
  const c = containerEl();
  if (!layoutState) return;

  c.style.gridTemplateColumns = (layoutState.colRatios.length > 0
    ? layoutState.colRatios.map(v => `${v}fr`).join(' ')
    : '1fr');
  c.style.gridTemplateRows = (layoutState.rowRatios.length > 0
    ? layoutState.rowRatios.map(v => `${v}fr`).join(' ')
    : '1fr');

  const idToCell = new Map();
  for (const k of Object.keys(layoutState.cellMap)) {
    idToCell.set(layoutState.cellMap[k], k);
  }

  for (const [id, wrap] of [...wrappers]) {
    if (!idToCell.has(id) || !sessionsById.has(id)) {
      wrap.remove();
      wrappers.delete(id);
    }
  }

  for (const [id, key] of idToCell) {
    if (!wrappers.has(id)) {
      const session = sessionsById.get(id);
      if (!session) continue;
      const wrap = createWrapper(session);
      wrappers.set(id, wrap);
      c.appendChild(wrap);
    }
  }

  for (const [id, wrap] of wrappers) {
    const key = idToCell.get(id);
    if (!key) continue;
    const [r, col] = key.split(',').map(n => parseInt(n, 10));
    wrap.style.gridArea = `${r + 1} / ${col + 1} / ${r + 2} / ${col + 2}`;
    wrap.dataset.cell = key;
    wrap.classList.toggle('edit-mode', editModeActive);
  }

  rebuildDividers(c);
  applyZoomState();
}

function rebuildDividers(c) {
  for (const d of dividers) d.el.remove();
  dividers = [];

  const { cols, rows } = layoutState;
  for (let i = 0; i < cols - 1; i++) {
    const el = document.createElement('div');
    el.className = 'divider col-divider';
    el.style.gridArea = `1 / ${i + 1} / -1 / ${i + 2}`;
    el.style.justifySelf = 'end';
    attachColDividerDrag(el, i);
    c.appendChild(el);
    dividers.push({ el, kind: 'col', index: i });
  }
  for (let i = 0; i < rows - 1; i++) {
    const el = document.createElement('div');
    el.className = 'divider row-divider';
    el.style.gridArea = `${i + 1} / 1 / ${i + 2} / -1`;
    el.style.alignSelf = 'end';
    attachRowDividerDrag(el, i);
    c.appendChild(el);
    dividers.push({ el, kind: 'row', index: i });
  }
}

function lockWebviews() {
  for (const w of wrappers.values()) {
    const wv = w.querySelector('webview');
    if (wv) wv.style.pointerEvents = 'none';
  }
}

function unlockWebviews() {
  for (const w of wrappers.values()) {
    const wv = w.querySelector('webview');
    if (wv) wv.style.pointerEvents = '';
  }
}

function attachColDividerDrag(el, index) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    const c = containerEl();
    const overlay = overlayEl();
    overlay.style.cursor = 'col-resize';
    overlay.classList.add('active');
    el.classList.add('dragging');
    lockWebviews();

    const startX = e.clientX;
    const ratios = layoutState.colRatios.slice();
    const totalW = c.clientWidth;
    const startA = ratios[index];
    const startB = ratios[index + 1];
    const pairSum = startA + startB;

    const onMove = ev => {
      const delta = (ev.clientX - startX) / totalW;
      const a = Math.max(0.05, Math.min(pairSum - 0.05, startA + delta));
      ratios[index] = a;
      ratios[index + 1] = pairSum - a;
      layoutState.colRatios = ratios;
      c.style.gridTemplateColumns = ratios.map(v => `${v}fr`).join(' ');
    };

    const onUp = async () => {
      overlay.classList.remove('active');
      el.classList.remove('dragging');
      unlockWebviews();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      await window.gameBridge.updateRatios(layoutState.colRatios, layoutState.rowRatios);
      saveLayoutPending = true;
      refreshSaveLayoutVisibility();
      showToast('Layout updated');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachRowDividerDrag(el, index) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    const c = containerEl();
    const overlay = overlayEl();
    overlay.style.cursor = 'row-resize';
    overlay.classList.add('active');
    el.classList.add('dragging');
    lockWebviews();

    const startY = e.clientY;
    const ratios = layoutState.rowRatios.slice();
    const totalH = c.clientHeight;
    const startA = ratios[index];
    const startB = ratios[index + 1];
    const pairSum = startA + startB;

    const onMove = ev => {
      const delta = (ev.clientY - startY) / totalH;
      const a = Math.max(0.05, Math.min(pairSum - 0.05, startA + delta));
      ratios[index] = a;
      ratios[index + 1] = pairSum - a;
      layoutState.rowRatios = ratios;
      c.style.gridTemplateRows = ratios.map(v => `${v}fr`).join(' ');
    };

    const onUp = async () => {
      overlay.classList.remove('active');
      el.classList.remove('dragging');
      unlockWebviews();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      await window.gameBridge.updateRatios(layoutState.colRatios, layoutState.rowRatios);
      saveLayoutPending = true;
      refreshSaveLayoutVisibility();
      showToast('Layout updated');
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function createWrapper(session) {
  const wrap = document.createElement('div');
  wrap.className = 'webview-wrap';
  wrap.style.setProperty('--accent', session.accentColor || '#f59e0b');

  const wv = document.createElement('webview');
  wv.setAttribute('partition', `persist:${session.id}`);
  wv.setAttribute('src', session.url || 'https://universe.flyff.com/play');
  wv.setAttribute('tabindex', '0');
  wv.setAttribute('webpreferences', 'backgroundThrottling=false');

  const label = document.createElement('div');
  label.className = 'session-label';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = session.accentColor || '#f59e0b';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = session.name || 'Session';

  const btnMenu = document.createElement('button');
  btnMenu.className = 'menu-btn';
  btnMenu.title = 'More';
  btnMenu.innerHTML = '&#9663;';

  const menu = document.createElement('div');
  menu.className = 'session-menu hidden';

  const itemDash = document.createElement('button');
  itemDash.textContent = 'Open Manage Panel';
  itemDash.addEventListener('click', () => {
    window.gameBridge.openDashboard();
    closeMenu();
  });

  const itemSave = document.createElement('button');
  itemSave.className = 'save-layout-item hidden';
  itemSave.textContent = 'Save Layout';
  if (saveLayoutPending) itemSave.classList.remove('hidden');
  itemSave.addEventListener('click', async () => {
    closeMenu();
    await window.gameBridge.saveLayout();
    saveLayoutPending = false;
    refreshSaveLayoutVisibility();
    showToast('Layout saved');
  });

  const itemEdit = document.createElement('button');
  itemEdit.className = 'edit-position-item';
  itemEdit.textContent = editModeActive ? 'Lock Positions' : 'Edit Positions';
  itemEdit.addEventListener('click', () => {
    closeMenu();
    toggleEditMode();
  });

  menu.append(itemDash, itemSave, itemEdit);

  btnMenu.addEventListener('click', e => {
    e.stopPropagation();
    const willHide = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    btnMenu.classList.toggle('open', !willHide);
  });
  function closeMenu() { menu.classList.add('hidden'); btnMenu.classList.remove('open'); }
  wrap.addEventListener('mouseleave', closeMenu);

  label.append(dot, name, btnMenu, menu);

  wv.addEventListener('focus', () => {
    wrap.classList.add('focused');
    window.gameBridge.reportFocus(session.id);
  });
  wv.addEventListener('blur', () => wrap.classList.remove('focused'));

  wrap.addEventListener('mouseenter', () => {
    if (!hoverEnabled || isDragging) return;
    clearTimeout(hoverTimer);
    if (hoverDelayMs <= 0) {
      try { document.activeElement?.blur?.(); } catch {}
      try { wv.focus(); } catch {}
      return;
    }
    hoverTimer = setTimeout(() => {
      try { document.activeElement?.blur?.(); } catch {}
      try { wv.focus(); } catch {}
    }, hoverDelayMs);
  });
  wrap.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

  attachLabelDrag(wrap, label, session.id);

  wrap.append(wv, label);
  return wrap;
}

function syncLabel(session) {
  const wrap = wrappers.get(session.id);
  if (!wrap) return;
  wrap.style.setProperty('--accent', session.accentColor || '#f59e0b');
  const label = wrap.querySelector('.session-label');
  if (!label) return;
  const dot  = label.querySelector('.dot');
  const name = label.querySelector('.name');
  if (dot)  dot.style.background = session.accentColor || '#f59e0b';
  if (name) name.textContent     = session.name || 'Session';
}

function toggleEditMode() {
  editModeActive = !editModeActive;
  const label = editModeActive ? 'Lock Positions' : 'Edit Positions';
  for (const wrap of wrappers.values()) {
    wrap.classList.toggle('edit-mode', editModeActive);
    const btn = wrap.querySelector('.edit-position-item');
    if (btn) btn.textContent = label;
  }
}

function attachLabelDrag(wrap, label, sessionId) {
  label.addEventListener('mousedown', e => {
    if (!editModeActive) return;
    if (e.target.closest('.menu-btn') || e.target.closest('.session-menu')) return;
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    const overlay = overlayEl();
    overlay.style.cursor = 'grabbing';
    overlay.classList.add('active');
    wrap.classList.add('drag-source');

    const fromCell = wrap.dataset.cell;

    const onMove = ev => {
      let target = null;
      for (const [id, w] of wrappers) {
        if (id === sessionId) continue;
        const r = w.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          target = w;
          break;
        }
      }
      for (const w of wrappers.values()) {
        w.classList.toggle('drop-target', w === target);
      }
    };

    const onUp = async ev => {
      isDragging = false;
      overlay.classList.remove('active');
      wrap.classList.remove('drag-source');

      let toCell = null;
      for (const [id, w] of wrappers) {
        if (id === sessionId) continue;
        const r = w.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          toCell = w.dataset.cell;
          break;
        }
      }
      for (const w of wrappers.values()) w.classList.remove('drop-target');

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (toCell && toCell !== fromCell) {
        await window.gameBridge.swapCells(fromCell, toCell);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function refreshSaveLayoutVisibility() {
  for (const wrap of wrappers.values()) {
    wrap.querySelector('.save-layout-item')?.classList.toggle('hidden', !saveLayoutPending);
  }
}

function applyZoomState() {
  for (const [id, wrap] of wrappers) {
    wrap.classList.toggle('pane-zoomed', id === zoomedSessionId);
    wrap.style.display = (zoomedSessionId && id !== zoomedSessionId) ? 'none' : '';
  }
  for (const d of dividers) d.el.style.display = zoomedSessionId ? 'none' : '';
}

window.gameBridge.onPaneZoom(() => {
  const focusedId = (() => {
    for (const [id, w] of wrappers) if (w.classList.contains('focused')) return id;
    return null;
  })();
  zoomedSessionId = (zoomedSessionId || !focusedId) ? null : focusedId;
  applyZoomState();
});

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 1800);
}

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const c = containerEl();
    window.gameBridge.resizeHint(c.clientWidth, c.clientHeight);
  }, 150);
}).observe(document.getElementById('container'));
