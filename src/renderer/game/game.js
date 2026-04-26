const PRESETS = {
  'split-h-50': { dir: 'row',    ratio: 0.5 },
  'split-h-70': { dir: 'row',    ratio: 0.7 },
  'split-v-50': { dir: 'column', ratio: 0.5 },
  'split-v-70': { dir: 'column', ratio: 0.7 },
};

const wrappers = new Map(); // sessionId → wrapper div (webview lives inside)
let dividerEl  = null;
let splitRatio = 0.5;
let splitDir   = 'row';
let lastIds    = '';

window.gameBridge.onUpdate(({ sessions, preset, applyRatio }) => {
  const cfg        = PRESETS[preset] || { dir: 'row', ratio: 0.5 };
  const newIds     = sessions.map(s => s.id).join(',');
  const dirChanged = cfg.dir !== splitDir;
  const idsChanged = newIds !== lastIds;

  if (applyRatio || dirChanged) { splitRatio = cfg.ratio; splitDir = cfg.dir; }
  lastIds = newIds;

  const container = document.getElementById('container');
  const overlay   = document.getElementById('drag-overlay');
  const active    = sessions.slice(0, 2);

  if (idsChanged) {
    // Session set changed — full rebuild (webviews reload, unavoidable)
    fullRebuild(active, container, overlay);
  } else if (dirChanged) {
    // Only direction changed — update CSS in-place, recreate divider only
    updateDirection(container, overlay);
  } else if (applyRatio) {
    // Only ratio changed — update flex values, no DOM mutation
    updateRatio();
  }
});

window.gameBridge.ready();

// ── Full rebuild ─────────────────────────────────────────────────────────────

function fullRebuild(sessions, container, overlay) {
  container.innerHTML = '';
  wrappers.clear();
  dividerEl = null;
  container.style.flexDirection = splitDir;

  if (sessions.length === 0) return;

  const views = sessions.map(s => {
    const w = createWrapper(s);
    wrappers.set(s.id, w);
    return w;
  });

  setDirStyles(views);

  if (views.length === 1) {
    views[0].style.flex = '1';
    container.appendChild(views[0]);
    return;
  }

  views[0].style.flex = String(splitRatio);
  views[1].style.flex = String(1 - splitRatio);
  dividerEl = createDivider(views[0], views[1], container, overlay);
  container.append(views[0], dividerEl, views[1]);
}

// ── In-place updates (no webview reload) ─────────────────────────────────────

function updateDirection(container, overlay) {
  container.style.flexDirection = splitDir;
  const views = [...wrappers.values()];
  setDirStyles(views);

  if (views.length === 2) {
    views[0].style.flex = String(splitRatio);
    views[1].style.flex = String(1 - splitRatio);

    // Recreate divider only (drag closure captures isRow — must be fresh)
    if (dividerEl) {
      const anchor = dividerEl.nextSibling;
      dividerEl.remove();
      dividerEl = createDivider(views[0], views[1], container, overlay);
      container.insertBefore(dividerEl, anchor);
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
  wrap.style.overflow  = 'hidden';
  wrap.style.minWidth  = '0';
  wrap.style.minHeight = '0';

  const wv = document.createElement('webview');
  wv.setAttribute('partition', `persist:${session.id}`);
  wv.setAttribute('src', session.url || 'https://universe.flyff.com/play');
  wv.style.width  = '100%';
  wv.style.height = '100%';

  wrap.appendChild(wv);
  return wrap;
}

function createDivider(a, b, container, overlay) {
  const isRow = splitDir === 'row';
  const div   = document.createElement('div');
  div.className = `divider ${isRow ? 'vertical' : 'horizontal'}`;
  div.innerHTML = '<div class="divider-handle"></div>';

  div.addEventListener('mousedown', e => {
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
