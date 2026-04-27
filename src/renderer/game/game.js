const PRESETS = {
  'split-h-50': { dir: 'row',    ratio: 0.5 },
  'split-h-70': { dir: 'row',    ratio: 0.7 },
  'split-h-30': { dir: 'row',    ratio: 0.3 },
  'split-v-50': { dir: 'column', ratio: 0.5 },
  'split-v-70': { dir: 'column', ratio: 0.7 },
  'split-v-30': { dir: 'column', ratio: 0.3 },
};

const wrappers = new Map(); // sessionId → wrapper div (webview lives inside)
let dividerEl  = null;
let splitRatio = 0.5;
let splitDir   = 'row';
let lastIds    = '';
let locked     = false;
let hoverEnabled = false;
let hoverDelayMs = 400;
let hoverTimer   = null;

window.gameBridge.onUpdate(({ sessions, preset, lockLayout, applyRatio, hoverFocusEnabled, hoverFocusDelayMs }) => {
  const cfg        = PRESETS[preset] || { dir: 'row', ratio: 0.5 };
  const newIds     = sessions.map(s => s.id).join(',');
  const dirChanged = cfg.dir !== splitDir;
  const idsChanged = newIds !== lastIds;
  const lockChanged = !!lockLayout !== locked;

  if (applyRatio || dirChanged) { splitRatio = cfg.ratio; splitDir = cfg.dir; }
  locked  = !!lockLayout;
  lastIds = newIds;
  hoverEnabled = !!hoverFocusEnabled;
  hoverDelayMs = hoverFocusDelayMs || 400;

  const container = document.getElementById('container');
  const overlay   = document.getElementById('drag-overlay');
  const active    = sessions.slice(0, 2);

  if (idsChanged) {
    // Session set changed — reconcile in-place (preserve existing webviews)
    reconcile(active, container, overlay);
  } else if (dirChanged) {
    // Only direction changed — update CSS in-place, recreate divider only
    updateDirection(container, overlay);
  } else if (applyRatio) {
    // Only ratio changed — update flex values, no DOM mutation
    updateRatio();
  } else if (lockChanged && dividerEl) {
    applyLockState();
  }

  // Sync label name + dot color (rename/recolor must not reload webview)
  active.forEach(s => syncLabel(s));
});

window.gameBridge.onFocusWebview(({ id }) => {
  const wrap = wrappers.get(id);
  const wv = wrap?.querySelector('webview');
  if (!wv) return;
  try { document.activeElement?.blur?.(); } catch {}
  try { wv.focus(); } catch {}
});

window.gameBridge.ready();

// ── Reconcile ────────────────────────────────────────────────────────────────
// Preserve existing wrappers across updates — removing a webview from DOM
// destroys its webContents, so we only add/remove the diff and never re-append
// surviving nodes.

function reconcile(sessions, container, overlay) {
  const incomingIds = new Set(sessions.map(s => s.id));

  // Drop wrappers no longer present
  for (const [id, wrap] of [...wrappers]) {
    if (!incomingIds.has(id)) {
      wrap.remove();
      wrappers.delete(id);
    }
  }

  // Detach old divider — recreated below if 2 panes
  if (dividerEl) { dividerEl.remove(); dividerEl = null; }

  container.style.flexDirection = splitDir;

  // Append new wrappers; existing wrappers stay where they are
  sessions.forEach(s => {
    if (!wrappers.has(s.id)) {
      const w = createWrapper(s);
      wrappers.set(s.id, w);
      container.appendChild(w);
    }
  });

  if (sessions.length === 0) return;

  const views = sessions.map(s => wrappers.get(s.id));
  setDirStyles(views);

  if (views.length === 1) {
    views[0].style.flex  = '1';
    views[0].style.order = '';
    return;
  }

  views[0].style.flex  = String(splitRatio);
  views[1].style.flex  = String(1 - splitRatio);
  views[0].style.order = '0';
  views[1].style.order = '2';
  dividerEl = createDivider(views[0], views[1], container, overlay);
  dividerEl.style.order = '1';
  container.appendChild(dividerEl);
}

// ── In-place updates (no webview reload) ─────────────────────────────────────

function updateDirection(container, overlay) {
  container.style.flexDirection = splitDir;
  const views = [...wrappers.values()];
  setDirStyles(views);

  if (views.length === 2) {
    // Visual order may differ from DOM order — driven by CSS order in reconcile.
    // Look up by visual order so drag math + flex assignment stay consistent.
    const ordered = [...wrappers.values()].sort((a, b) =>
      (parseInt(a.style.order || '0', 10)) - (parseInt(b.style.order || '0', 10))
    );
    ordered[0].style.flex = String(splitRatio);
    ordered[1].style.flex = String(1 - splitRatio);

    // Recreate divider only (drag closure captures isRow — must be fresh)
    if (dividerEl) {
      dividerEl.remove();
      dividerEl = createDivider(ordered[0], ordered[1], container, overlay);
      dividerEl.style.order = '1';
      container.appendChild(dividerEl);
    }
  }
}

function updateRatio() {
  const views = [...wrappers.values()];
  if (views.length < 2) return;
  views[0].style.flex = String(splitRatio);
  views[1].style.flex = String(1 - splitRatio);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setDirStyles(views) {
  views.forEach(v => {
    if (splitDir === 'row') { v.style.height = '100%'; v.style.width  = ''; }
    else                    { v.style.width  = '100%'; v.style.height = ''; }
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
  // Keep WebGL/timers running when pane unfocused (matches host BrowserWindow setting)
  wv.setAttribute('webpreferences', 'backgroundThrottling=false');

  const label = document.createElement('div');
  label.className = 'session-label';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = session.accentColor || '#f59e0b';
  const name = document.createElement('span');
  name.textContent = session.name || 'Session';
  label.append(dot, name);

  wv.addEventListener('focus',  () => wrap.classList.add('focused'));
  wv.addEventListener('blur',   () => wrap.classList.remove('focused'));

  wrap.addEventListener('mouseenter', () => {
    if (!hoverEnabled) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      try { document.activeElement?.blur?.(); } catch {}
      try { wv.focus(); } catch {}
    }, hoverDelayMs);
  });
  wrap.addEventListener('mouseleave', () => clearTimeout(hoverTimer));

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
  const name = label.querySelector('span:last-child');
  if (dot)  dot.style.background = session.accentColor || '#f59e0b';
  if (name) name.textContent     = session.name || 'Session';
}

function applyLockState() {
  if (!dividerEl) return;
  dividerEl.classList.toggle('locked', locked);
}

function createDivider(a, b, container, overlay) {
  const isRow = splitDir === 'row';
  const div   = document.createElement('div');
  div.className = `divider ${isRow ? 'vertical' : 'horizontal'}${locked ? ' locked' : ''}`;
  div.innerHTML = '<div class="divider-handle"></div>';

  div.addEventListener('mousedown', e => {
    if (locked) return;
    e.preventDefault();
    overlay.style.cursor = isRow ? 'col-resize' : 'row-resize';
    overlay.classList.add('active');
    div.classList.add('dragging');

    const startPos  = isRow ? e.clientX : e.clientY;
    const startFlex = parseFloat(a.style.flex);

    const onMove = e => {
      const size    = isRow ? container.clientWidth  : container.clientHeight;
      const divSize = isRow ? div.offsetWidth        : div.offsetHeight;
      const delta   = (isRow ? e.clientX : e.clientY) - startPos;
      const next    = Math.max(0.1, Math.min(0.9, startFlex + delta / (size - divSize)));
      a.style.flex  = String(next);
      b.style.flex  = String(1 - next);
      splitRatio    = next;
    };

    const onUp = () => {
      overlay.classList.remove('active');
      div.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return div;
}
