// Po Highlighter — content script.
// Highlight + comment on any page, persisted in chrome.storage.local and restored on reload.
// Extracted from the original Po extension (my-web-highlighter); every Zara/network feature removed.
// There are NO network calls in this file. Keep it that way — see CLAUDE.md.

// ============================================================
// CONSTANTS + STATE
// ============================================================
const STORAGE_KEY = 'highlights';
const PENDING_SCROLL_KEY = 'pendingScroll';
const PENDING_SCROLL_TTL_MS = 30000;
const UI_HOST_ID = 'hl-ext-root';
const RUNTIME_PING_EVENT = 'po-carryover:ping';
const RUNTIME_PONG_ATTR = 'data-po-carryover-pong';

const PALETTE_KEY = 'hlPalette';
const DEFAULT_PALETTE = ['#9BB4C0', '#FFCDC9', '#FEEAC9', '#F0C1E1'];
const RESOLVED_COLOR = '#b9f6ca';
const RESTORE_RETRY_DELAYS = [1000, 2500, 5000, 10000];
const LOCAL_FILES_GROUP = 'Local files';

let uiHost = null;
let mutationObserver = null;
let currentRange = null;
let userPalette = [...DEFAULT_PALETTE];
let selectedColor = userPalette[0];
let colorWidget = null;
let commentPopup = null;
let sidePanel = null;
let panelOpen = false;
let canRestoreHighlights = document.readyState === 'complete';
let restoreTimeoutId = null;
let globalListenersAttached = false;
let pendingScrollId = null;

// ---- Frames ----
// Po runs in the top page, and in "inline" frames whose document has no address of its own
// (about:srcdoc / about:blank / data: / blob:). Document viewers like OneDrive render HTML that
// way. Highlights made in an inline frame are saved under the TOP page's URL (asked for via
// background.js), so each viewed document keeps its own highlights. Other frames (ads, embeds)
// are left alone.
const IS_TOP_FRAME = window === window.top;
let framePage = null; // { url, title } of the top page, resolved at init in inline frames

function frameRole(isTop, href) {
  if (isTop) return 'top';
  if (/^(about:(srcdoc|blank)|data:|blob:)/.test(String(href || ''))) return 'inline';
  return 'none';
}

/** The URL highlights on this page are stored under. */
function currentPageUrl() {
  return IS_TOP_FRAME ? window.location.href : (framePage?.url || window.location.href);
}

async function resolveFramePage() {
  // The top frame's content script may still be starting — retry briefly.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const info = await chrome.runtime.sendMessage({ type: 'GET_PAGE_INFO_FOR_FRAME' });
      if (info?.ok && info.url) {
        framePage = { url: info.url, title: info.title || '' };
        return true;
      }
    } catch { /* background asleep or top not ready — retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  // Without the top URL every viewed doc would share "about:srcdoc" — better to stay off.
  console.warn('[Po] could not identify the page this frame belongs to; highlighting is off in this frame');
  return false;
}

// Persist expanded state across panel refreshes
const expandedDomains = new Set();
const expandedBuckets = new Set();

// After the extension is reloaded, the old content script keeps running in open tabs but
// loses chrome.runtime.id. Every handler checks this so an orphaned copy goes inert.
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// ============================================================
// STORAGE — chrome.storage.local, single key: highlights[]
// ============================================================
function storageLocalGet(defaults) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(defaults, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageLocalSet(value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(value, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(true);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getAllHighlights() {
  const result = await storageLocalGet({ [STORAGE_KEY]: [] });
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

// Serialize read-modify-write within this tab so quick successive edits don't clobber each other.
let writeChain = Promise.resolve();
function mutateHighlights(mutator) {
  const run = writeChain.then(async () => {
    const next = mutator(await getAllHighlights());
    await storageLocalSet({ [STORAGE_KEY]: next });
    return next;
  });
  writeChain = run.catch(() => {});
  return run;
}

function addHighlight(data) {
  return mutateHighlights((list) => [...list.filter((h) => h.id !== data.id), data]);
}

async function updateHighlight(id, patch) {
  let updated = null;
  await mutateHighlights((list) => list.map((h) => {
    if (h.id !== id) return h;
    updated = { ...h, ...patch };
    return updated;
  }));
  return updated;
}

function removeHighlights(ids) {
  const idSet = new Set(ids);
  return mutateHighlights((list) => list.filter((h) => !idSet.has(h.id)));
}

// ---- Palette: 4 user-chosen colours, stored under hlPalette ----
function isValidPalette(p) {
  return Array.isArray(p) && p.length === DEFAULT_PALETTE.length && p.every((hex) => /^#[0-9a-f]{6}$/i.test(hex));
}

async function loadPalette() {
  try {
    const result = await storageLocalGet({ [PALETTE_KEY]: null });
    if (isValidPalette(result[PALETTE_KEY])) userPalette = result[PALETTE_KEY];
  } catch { /* storage unavailable — keep defaults */ }
  selectedColor = userPalette[0];
}

/**
 * Replace palette slot `slot` with `newHex`. Existing highlights painted with the old
 * slot colour are recoloured too, so changing a colour you dislike changes it everywhere.
 */
async function setPaletteColor(slot, newHex) {
  const oldHex = userPalette[slot];
  if (!/^#[0-9a-f]{6}$/i.test(newHex) || oldHex.toLowerCase() === newHex.toLowerCase()) return;
  const next = [...userPalette];
  next[slot] = newHex;
  await savePalette(next, { [oldHex.toLowerCase()]: newHex });
}

async function resetPalette() {
  const recolor = {};
  userPalette.forEach((hex, i) => { recolor[hex.toLowerCase()] = DEFAULT_PALETTE[i]; });
  await savePalette([...DEFAULT_PALETTE], recolor);
}

async function savePalette(next, recolor) {
  if (selectedColor && recolor[selectedColor.toLowerCase()]) selectedColor = recolor[selectedColor.toLowerCase()];
  userPalette = next;
  try {
    await storageLocalSet({ [PALETTE_KEY]: next });
    await mutateHighlights((list) => list.map((h) => {
      const to = h.color && recolor[h.color.toLowerCase()];
      return to ? { ...h, color: to } : h;
    }));
  } catch (error) {
    console.error('[Po] palette save failed:', error);
  }
  // Repaint this page's spans that used a replaced colour
  document.querySelectorAll('span.my-extension-highlight:not(.resolved)').forEach((span) => {
    const current = rgbToHex(span.style.backgroundColor);
    if (current && recolor[current]) span.style.setProperty('background-color', recolor[current], 'important');
  });
  renderPaletteEditor();
  if (panelOpen) refreshSidePanel();
}

function rgbToHex(rgb) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

// Highlights belong to a page, not a scroll position — ignore #fragment when matching.
function pageKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch { return url; }
}

// ============================================================
// UI HOST
// ============================================================
function respondToRuntimePing(event) {
  if (!isContextValid()) return;
  const pingId = String(event?.detail?.pingId || '').trim();
  if (!pingId || !document.documentElement) return;
  document.documentElement.setAttribute(RUNTIME_PONG_ATTR, pingId);
}

function hasActiveRuntimeInstance() {
  const root = document.documentElement;
  if (!root) return false;

  const pingId = `po-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  root.removeAttribute(RUNTIME_PONG_ATTR);
  document.dispatchEvent(new CustomEvent(RUNTIME_PING_EVENT, { detail: { pingId } }));
  const responded = root.getAttribute(RUNTIME_PONG_ATTR) === pingId;
  root.removeAttribute(RUNTIME_PONG_ATTR);
  return responded;
}

function getUiHost() {
  if (uiHost?.isConnected) return uiHost;

  const existingHost = document.getElementById(UI_HOST_ID);
  if (existingHost) {
    uiHost = existingHost;
    return uiHost;
  }

  const mountTarget = document.documentElement || document.body;
  if (!mountTarget) return null;

  uiHost = document.createElement('div');
  uiHost.id = UI_HOST_ID;
  mountTarget.appendChild(uiHost);
  return uiHost;
}

// ============================================================
// INIT
// ============================================================
async function init() {
  if (!IS_TOP_FRAME && !(await resolveFramePage())) return;
  const host = getUiHost();
  if (!host) return;

  await loadPalette();
  mountUi();
  if (!globalListenersAttached) {
    attachGlobalListeners();
    globalListenersAttached = true;
  }

  await loadPendingScroll();
  startRestoreWhenLoaded();

  // SPA support — ignore mutations caused by the extension's own panel/widget/popup
  if (!mutationObserver) {
    let obsTimeout;
    mutationObserver = new MutationObserver((mutations) => {
      if (!isContextValid()) {
        mutationObserver.disconnect();
        return;
      }
      const hasExternalChange = mutations.some((mutation) => {
        const uiHostWasRemoved = [...mutation.removedNodes].some((node) => {
          if (node === uiHost) return true;
          return node instanceof Element && (
            node.id === UI_HOST_ID ||
            !!node.querySelector?.(`#${UI_HOST_ID}`)
          );
        });
        if (uiHostWasRemoved) return true;
        if (isInsideUI(mutation.target)) return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !isInsideUI(node));
      });
      if (!hasExternalChange) return;
      clearTimeout(obsTimeout);
      obsTimeout = setTimeout(() => {
        ensureUiMounted();
        if (canRestoreHighlights) scheduleHighlightRestore(800);
      }, 1200);
    });
    mutationObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
}

// Re-check readyState here rather than trusting the value captured at script start: init()
// awaits storage first, and a small local file (.md/.txt/.json) can finish loading in that
// gap — waiting for a `load` event that already fired meant highlights never restored.
function startRestoreWhenLoaded() {
  if (document.readyState === 'complete') canRestoreHighlights = true;
  if (canRestoreHighlights) {
    scheduleHighlightRestore(800);
  } else {
    window.addEventListener('load', onPageLoadReady, { once: true });
  }
}

// Po's UI is HTML; XML/SVG documents (incl. Chrome's XML viewer) reject it and throw.
// Local .md/.txt/.json are rendered by Chrome as HTML documents, so they qualify.
function isSupportedDocument(doc) {
  return doc instanceof HTMLDocument && !!doc.body;
}

function onPageLoadReady() {
  canRestoreHighlights = true;
  scheduleHighlightRestore(800);
}

function scheduleHighlightRestore(delay = 0) {
  clearTimeout(restoreTimeoutId);
  restoreTimeoutId = setTimeout(() => {
    loadHighlights();
  }, delay);
}

function mountUi() {
  const host = getUiHost();
  if (!host) return;

  host.replaceChildren();
  buildColorWidget();
  buildCommentPopup();
  if (IS_TOP_FRAME) { // one panel per tab, on the top page
    buildSidePanel();
    updatePanelState();
  }
}

function ensureUiMounted() {
  if (!getUiHost()?.isConnected || !colorWidget?.isConnected || !commentPopup?.isConnected ||
      (IS_TOP_FRAME && !sidePanel?.isConnected)) {
    mountUi();
  }
}

// ---- TOGGLE: message from background.js ----
function shouldHandleToggle(ts) {
  if (!ts) return true;
  const key = '__po_' + ts;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
  } catch { /* sessionStorage unavailable on some pages — proceed anyway */ }
  return true;
}

function onRuntimeMessage(msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  // An inline frame asking (via background.js, frameId 0) which page it belongs to
  if (msg.type === 'GET_PAGE_INFO') {
    if (IS_TOP_FRAME) sendResponse({ url: window.location.href, title: document.title });
    return;
  }
  // Panel click for a highlight that lives inside a frame on this page
  if (msg.type === 'SCROLL_TO') {
    if (spansFor(msg.id).length > 0) scrollToHighlight(msg.id);
    return;
  }

  if (!IS_TOP_FRAME) return;
  if (!shouldHandleToggle(msg.ts)) return;

  if (msg.type === 'TOGGLE_PANEL') {
    panelOpen = !panelOpen;
    updatePanelState();
    if (panelOpen) refreshSidePanel();
  }
}

// Another tab added/edited/deleted a highlight — keep an open panel current.
function onStorageChanged(changes, areaName) {
  if (areaName !== 'local') return;
  if (changes[PALETTE_KEY] && isValidPalette(changes[PALETTE_KEY].newValue)) {
    userPalette = changes[PALETTE_KEY].newValue;
    if (!userPalette.includes(selectedColor)) selectedColor = userPalette[0];
    renderPaletteEditor();
  }
  if (changes[STORAGE_KEY] && panelOpen) refreshSidePanel();
}

// ============================================================
// GLOBAL LISTENERS
// ============================================================
function attachGlobalListeners() {
  document.addEventListener('mouseup', (e) => {
    if (!isContextValid()) return;
    if (isInsideUI(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.toString().trim().length > 0) {
        currentRange = sel.getRangeAt(0).cloneRange();
        showColorWidget(currentRange);
      } else if (!isInsideUI(e.target)) {
        hideColorWidget();
      }
    }, 20);
  });

  document.addEventListener('mousedown', (e) => {
    if (!isContextValid()) return;
    if (!isInsideUI(e.target)) {
      hideColorWidget();
      hideCommentPopup();
    }
  });
}

function getTargetElement(target) {
  if (target instanceof Element) return target;
  if (target && target.parentElement instanceof Element) return target.parentElement;
  return null;
}

function isInsideUI(target) {
  const el = getTargetElement(target);
  if (!el) return false;
  return !!(
    el.id === UI_HOST_ID ||
    el.closest(`#${UI_HOST_ID}`) ||
    el.closest('.hl-ext-widget') ||
    el.closest('.hl-ext-popup') ||
    el.closest('.hl-ext-panel')
  );
}

// ============================================================
// COLOR WIDGET
// ============================================================
function buildColorWidget() {
  const host = getUiHost();
  if (!host) return;
  colorWidget = document.createElement('div');
  colorWidget.className = 'hl-ext-widget';
  host.appendChild(colorWidget);
}

function showColorWidget(range) {
  ensureUiMounted();
  if (!colorWidget) return;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  if (!userPalette.includes(selectedColor)) selectedColor = userPalette[0];
  colorWidget.innerHTML = buildWidgetHTML();

  const top = window.scrollY + rect.bottom + 8;
  const left = Math.min(
    Math.max(4, window.scrollX + rect.left),
    document.documentElement.clientWidth - 220
  );
  colorWidget.style.top = top + 'px';
  colorWidget.style.left = left + 'px';
  colorWidget.style.display = 'flex';

  colorWidget.querySelectorAll('.hl-swatch[data-color]').forEach(sw => {
    sw.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedColor = sw.dataset.color;
      hideColorWidget();
      saveCurrentHighlight();
    });
  });

  colorWidget.querySelector('#hl-comment-btn').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideColorWidget();
    showCommentPopup(false);
  });

  const activeSwatch = colorWidget.querySelector(`.hl-swatch[data-color="${selectedColor}"]`);
  if (activeSwatch) activeSwatch.classList.add('active');
  else colorWidget.querySelectorAll('.hl-swatch[data-color]')[0]?.classList.add('active');
}

function buildWidgetHTML() {
  const swatchesHTML = userPalette.map(hex =>
    `<div class="hl-swatch" data-color="${hex}" title="${hex}" style="background:${hex}"></div>`
  ).join('');
  return `
    <div class="hl-widget-inner">
      <div class="hl-swatch-row">
        ${swatchesHTML}
      </div>
      <button id="hl-comment-btn" class="hl-comment-btn">✏ Add note &amp; save</button>
    </div>
  `;
}

function showWidgetError(message) {
  ensureUiMounted();
  if (!colorWidget) return;
  colorWidget.innerHTML = `<div class="hl-widget-error">⚠ ${escapeHtml(message)}</div>`;
  colorWidget.style.display = 'flex';
  setTimeout(() => hideColorWidget(), 3500);
}

function hideColorWidget() {
  ensureUiMounted();
  if (colorWidget) colorWidget.style.display = 'none';
}

// ============================================================
// COMMENT POPUP
// ============================================================
function buildCommentPopup() {
  const host = getUiHost();
  if (!host) return;
  commentPopup = document.createElement('div');
  commentPopup.className = 'hl-ext-popup';
  host.appendChild(commentPopup);
}

function showCommentPopup(isViewMode, highlightData = null) {
  ensureUiMounted();
  if (!commentPopup) return;

  if (isViewMode && highlightData) {
    commentPopup.innerHTML = `
      <div class="hl-popup-header">
        <span>Comment</span>
        <div class="hl-popup-header-actions">
          <button class="hl-btn-icon" id="hl-edit" title="Edit comment">✏</button>
          <button class="hl-btn-icon hl-btn-icon-danger" id="hl-delete" title="Delete highlight">🗑</button>
          <button class="hl-btn-icon" id="hl-close">✕</button>
        </div>
      </div>
      <div class="hl-popup-body">
        <p class="hl-comment-text">${escapeHtml(highlightData.comment || '(no comment)')}</p>
        <p class="hl-popup-age">${relativeTime(highlightData.timestamp)}</p>
        <div class="hl-popup-footer">
          ${highlightData.resolved
            ? '<button class="hl-btn hl-btn-resolve" id="hl-reopen">Reopen</button>'
            : '<button class="hl-btn hl-btn-resolve" id="hl-resolve">Resolve ✓</button>'}
        </div>
      </div>
    `;
    commentPopup.querySelector('#hl-close').addEventListener('click', hideCommentPopup);
    commentPopup.querySelector('#hl-resolve')?.addEventListener('click', () => setResolved(highlightData.id, true));
    commentPopup.querySelector('#hl-reopen')?.addEventListener('click', () => setResolved(highlightData.id, false));
    commentPopup.querySelector('#hl-delete').addEventListener('click', () => {
      hideCommentPopup();
      deleteHighlight(highlightData.id);
    });
    commentPopup.querySelector('#hl-edit').addEventListener('click', () => {
      commentPopup.innerHTML = `
        <div class="hl-popup-header">
          <span>Edit comment</span>
          <button class="hl-btn-icon" id="hl-close">✕</button>
        </div>
        <div class="hl-popup-body">
          <textarea id="hl-comment-input" placeholder="Add a comment (optional)…"></textarea>
          <div class="hl-popup-footer">
            <button class="hl-btn hl-btn-primary" id="hl-save-edit">Save</button>
          </div>
        </div>
      `;
      const inp = commentPopup.querySelector('#hl-comment-input');
      inp.value = highlightData.comment || '';
      commentPopup.querySelector('#hl-close').addEventListener('click', hideCommentPopup);
      commentPopup.querySelector('#hl-save-edit').addEventListener('click', () =>
        editHighlight(highlightData.id, inp.value.trim())
      );
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) editHighlight(highlightData.id, inp.value.trim());
      });
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    });
  } else {
    commentPopup.innerHTML = `
      <div class="hl-popup-header">
        <span>New Highlight</span>
        <button class="hl-btn-icon" id="hl-close">✕</button>
      </div>
      <div class="hl-popup-body">
        <textarea id="hl-comment-input" placeholder="Add a comment (optional)…"></textarea>
        <div class="hl-popup-footer">
          <button class="hl-btn hl-btn-primary" id="hl-save">Save</button>
        </div>
      </div>
    `;
    commentPopup.querySelector('#hl-close').addEventListener('click', hideCommentPopup);
    const inp = commentPopup.querySelector('#hl-comment-input');
    commentPopup.querySelector('#hl-save').addEventListener('click', saveCurrentHighlight);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveCurrentHighlight();
    });
    inp.focus();
  }

  let rect;
  if (isViewMode && highlightData && highlightData.element) {
    rect = highlightData.element.getBoundingClientRect();
  } else if (currentRange) {
    rect = currentRange.getBoundingClientRect();
  } else {
    rect = { top: 100, left: 100, bottom: 120, height: 20 };
  }

  // Flip above selection if not enough space below viewport
  const POPUP_H = 210; // conservative estimate
  const spaceBelow = window.innerHeight - rect.bottom;
  const topPos = spaceBelow >= POPUP_H + 12
    ? window.scrollY + rect.bottom + 10
    : window.scrollY + rect.top - POPUP_H - 10;
  commentPopup.style.top  = Math.max(window.scrollY + 4, topPos) + 'px';
  commentPopup.style.left = Math.min(
    Math.max(4, window.scrollX + rect.left),
    document.documentElement.clientWidth - 290
  ) + 'px';
  commentPopup.style.display = 'block';
}

function hideCommentPopup() {
  ensureUiMounted();
  if (commentPopup) commentPopup.style.display = 'none';
}

// ============================================================
// SAVE / WRAP / RESTORE
// ============================================================
async function saveCurrentHighlight() {
  if (!currentRange) return;
  const input = commentPopup ? commentPopup.querySelector('#hl-comment-input') : null;
  const comment = input ? input.value.trim() : '';

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const color = selectedColor;
  const originalText = currentRange.toString();
  if (!originalText.trim()) return;

  const spans = wrapRange(currentRange, id, color);
  if (!spans || spans.length === 0) {
    showWidgetError('Could not highlight — try selecting within one block of text');
    currentRange = null;
    return;
  }

  const xpath = getXPath(spans[0].parentElement);
  const data = {
    id,
    url: currentPageUrl(),
    pageTitle: IS_TOP_FRAME ? document.title : (framePage?.title || document.title),
    comment,
    text: originalText,
    xpath,
    color,
    resolved: false,
    timestamp: new Date().toISOString(),
    isMultiSpan: spans.length > 1,
  };
  if (!IS_TOP_FRAME) data.inFrame = true;

  try {
    await addHighlight(data);
  } catch (error) {
    // Don't leave a highlight on screen that will vanish on refresh.
    console.error('[Po] highlight save failed:', error);
    unwrapHighlightSpans(id);
    hideCommentPopup();
    showWidgetError('Could not save highlight — refresh the page and try again');
    currentRange = null;
    return;
  }
  hideCommentPopup();
  spans.forEach(span => bindSpanInteraction(span, data));
  window.getSelection().removeAllRanges();
  currentRange = null;
  if (panelOpen) refreshSidePanel();
}

function wrapRange(range, id, color) {
  if (!range) return [];
  const spans = [];
  const ancestor = range.commonAncestorContainer.nodeType === 3
    ? range.commonAncestorContainer.parentNode
    : range.commonAncestorContainer;

  const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT, null);
  const textNodesInRange = [];
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) textNodesInRange.push(node);
  }
  if (textNodesInRange.length === 0) return spans;

  for (let i = 0; i < textNodesInRange.length; i++) {
    const textNode = textNodesInRange[i];
    let start = 0;
    let end = textNode.textContent.length;
    if (textNode === range.startContainer) start = range.startOffset;
    if (textNode === range.endContainer) end = range.endOffset;
    if (start >= end) continue;
    const segment = textNode.textContent.substring(start, end);
    if (!segment.trim()) continue;

    try {
      const middle = textNode.splitText(start);
      middle.splitText(end - start);
      const span = document.createElement('span');
      span.className = 'my-extension-highlight';
      span.dataset.id = id;
      span.dataset.spanIdx = String(i);
      span.style.setProperty('background-color', color, 'important');
      middle.parentNode.insertBefore(span, middle);
      span.appendChild(middle);
      spans.push(span);
    } catch (err) {
      console.warn('[Po] wrap failed:', err);
    }
  }
  return spans;
}

function bindSpanInteraction(span, data) {
  if (!span) return;
  span.title = data.comment || '';
  span.onclick = (e) => {
    e.stopPropagation();
    showCommentPopup(true, { ...data, element: span });
  };
}

function applyResolvedStyle(spans, data) {
  spans.forEach(span => {
    if (data.resolved) {
      span.classList.add('resolved');
      span.style.removeProperty('background-color');
    } else {
      span.classList.remove('resolved');
      span.style.setProperty('background-color', data.color || DEFAULT_PALETTE[0], 'important');
    }
  });
}

function hydrateExistingHighlight(spans, data) {
  spans.forEach(span => {
    bindSpanInteraction(span, data);
    span.dataset.id = data.id;
  });
  applyResolvedStyle(spans, data);
}

function spansFor(id) {
  return [...document.querySelectorAll(`span.my-extension-highlight[data-id="${id}"]`)];
}

async function setResolved(id, resolved) {
  let updated;
  try {
    updated = await updateHighlight(id, { resolved });
  } catch (error) {
    console.error('[Po] resolve failed:', error);
    return;
  }
  hideCommentPopup();
  if (!updated) return;
  const spans = spansFor(id);
  hydrateExistingHighlight(spans, updated);
  if (panelOpen) refreshSidePanel();
}

async function editHighlight(id, newComment) {
  let updated;
  try {
    updated = await updateHighlight(id, { comment: newComment });
  } catch (error) {
    console.error('[Po] comment save failed:', error);
    return;
  }
  hideCommentPopup();
  if (!updated) return;
  spansFor(id).forEach(span => bindSpanInteraction(span, updated));
  if (panelOpen) refreshSidePanel();
}

function unwrapHighlightSpans(id) {
  spansFor(id).forEach(span => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

async function deleteHighlight(id) {
  try {
    await removeHighlights([id]);
  } catch (error) {
    console.error('[Po] delete failed:', error);
    return;
  }
  unwrapHighlightSpans(id);
  if (panelOpen) refreshSidePanel();
}

/** Delete all highlights matching predicate. Optionally run cleanup() after. */
async function deleteGroupHighlights(predicate, cleanup) {
  let ids;
  try {
    ids = (await getAllHighlights()).filter(predicate).map((h) => h.id);
    if (ids.length === 0) return;
    await removeHighlights(ids);
  } catch (error) {
    console.error('[Po] bulk delete failed:', error);
    return;
  }
  ids.forEach(unwrapHighlightSpans);
  if (cleanup) cleanup();
  if (panelOpen) refreshSidePanel();
}

async function loadHighlights() {
  if (!canRestoreHighlights) return;
  let highlights;
  try {
    highlights = await getAllHighlights();
  } catch (error) {
    console.warn('[Po] could not read highlights:', error?.message);
    return;
  }

  // The top page restores its own highlights; inline frames restore the ones made in a frame
  const here = pageKey(currentPageUrl());
  highlights.filter((h) => pageKey(h.url) === here && !!h.inFrame === !IS_TOP_FRAME).forEach(data => {
    const spans = spansFor(data.id);
    if (spans.length > 0) {
      hydrateExistingHighlight(spans, data);
      scrollIfPending(data.id);
      return;
    }
    restoreHighlight(data);
  });
}

function restoreHighlight(data, attempt = 0) {
  // Guard: if the span already exists (restored by a parallel attempt), skip
  if (spansFor(data.id).length > 0) return;

  // Try XPath-resolved parent first (fast), then always fall back to document.body.
  // The XPath can point to the wrong element (fragile positional paths) OR to an element
  // that only covers part of a cross-element highlight — body search catches both cases.
  let range = null;
  const xpathParent = lookupElementByXPath(data.xpath);
  if (xpathParent) {
    range = findRangeInTextNodes(getTextNodes(xpathParent), data.text);
  }
  if (!range) {
    range = findRangeInTextNodes(getTextNodes(document.body), data.text);
  }

  if (!range) {
    if (attempt < RESTORE_RETRY_DELAYS.length) {
      setTimeout(() => restoreHighlight(data, attempt + 1), RESTORE_RETRY_DELAYS[attempt]);
    } else {
      console.warn(`[Po] Could not restore: "${data.text.substring(0, 30)}…"`);
    }
    return;
  }

  const color = data.resolved ? RESOLVED_COLOR : (data.color || DEFAULT_PALETTE[0]);
  const spans = wrapRange(range, data.id, color);
  hydrateExistingHighlight(spans, data);
  scrollIfPending(data.id);
}

// ---- Panel click on another page → navigate, then scroll once that highlight is restored ----
async function loadPendingScroll() {
  try {
    const result = await storageLocalGet({ [PENDING_SCROLL_KEY]: null });
    const pending = result[PENDING_SCROLL_KEY];
    if (!pending) return;
    const fresh = Date.now() - (pending.at || 0) < PENDING_SCROLL_TTL_MS;
    // Meant for another tab/page, or for the other context (top page vs. inline frame) of this page
    if (fresh && (pageKey(pending.url) !== pageKey(currentPageUrl()) || !!pending.inFrame === IS_TOP_FRAME)) return;
    if (fresh) pendingScrollId = pending.id;
    await storageLocalSet({ [PENDING_SCROLL_KEY]: null });
  } catch { /* storage unavailable — just don't auto-scroll */ }
}

function scrollIfPending(id) {
  if (pendingScrollId !== id) return;
  pendingScrollId = null;
  scrollToHighlight(id);
}

function isLocalFile(url) {
  return String(url || '').startsWith('file:');
}

// Navigation goes through background.js (chrome.tabs.update): a web page is not allowed
// to open file:// URLs itself, but the extension is (once file access is allowed).
async function openHighlight(id, url, inFrame = false) {
  if (pageKey(url) === pageKey(window.location.href)) {
    if (!inFrame) {
      scrollToHighlight(id);
      return;
    }
    // The highlight lives in a frame (e.g. OneDrive's viewer) — ask every frame in this tab
    try { await chrome.runtime.sendMessage({ type: 'SCROLL_TO_IN_TAB', id }); } catch { /* ignore */ }
    return;
  }
  try {
    await storageLocalSet({ [PENDING_SCROLL_KEY]: { id, url, at: Date.now(), inFrame: !!inFrame } });
  } catch { /* navigate anyway; just no auto-scroll */ }

  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'OPEN_URL', url });
  } catch (error) {
    response = { ok: false, error: error?.message || 'background unavailable' };
  }
  if (response?.ok) return;

  if (!isLocalFile(url)) {
    window.location.href = url;
    return;
  }
  console.warn('[Po] could not open local file:', response?.error);
  showPanelNotice(response?.error === 'file_access_off'
    ? 'To open local files, go to chrome://extensions → Po Highlighter → Details and turn on “Allow access to file URLs”.'
    : 'Could not open that file. It may have been moved or renamed.');
}

function showPanelNotice(message) {
  const notice = document.getElementById('hl-panel-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.style.display = 'block';
  clearTimeout(showPanelNotice.timer);
  showPanelNotice.timer = setTimeout(() => { notice.style.display = 'none'; }, 8000);
}

// ============================================================
// SIDE PANEL
// ============================================================
function buildSidePanel() {
  const host = getUiHost();
  if (!host) return;
  sidePanel = document.createElement('div');
  sidePanel.className = 'hl-ext-panel';
  sidePanel.id = 'hl-ext-panel';
  sidePanel.innerHTML = `
    <div class="hl-panel-header">
      <img class="hl-panel-icon" src="${chrome.runtime.getURL('images/po_webhighter_ext.png')}" alt=""/>
      <span class="hl-panel-title">Saved Highlights</span>
      <div class="hl-panel-header-actions">
        <span class="hl-group-count" id="hl-panel-total" title="Total highlights">0</span>
        <button class="hl-btn-icon" id="hl-panel-close" title="Close">✕</button>
      </div>
    </div>
    <div class="hl-panel-palette-wrap">
      <div class="hl-palette-header">Highlight colours <span class="hl-palette-hint">click a colour to change it</span></div>
      <div class="hl-palette-slots" id="hl-palette-slots"></div>
    </div>
    <div class="hl-panel-search-wrap">
      <input class="hl-panel-search" id="hl-panel-search" placeholder="Search text, comment, site or file…" autocomplete="off"/>
    </div>
    <div class="hl-panel-notice" id="hl-panel-notice" role="status"></div>
    <div class="hl-panel-body" id="hl-panel-body">
      <p class="hl-panel-empty">No highlights yet.<br>Select text on any page to begin.</p>
    </div>
  `;
  host.appendChild(sidePanel);

  // ── Resize handle (drag left edge) ──────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'hl-panel-resize-handle';
  sidePanel.insertBefore(resizeHandle, sidePanel.firstChild);

  let isResizing = false, rStartX = 0, rStartW = 0;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    isResizing = true;
    rStartX = e.clientX;
    rStartW = sidePanel.offsetWidth;
    document.documentElement.style.setProperty('cursor', 'ew-resize', 'important');
    document.documentElement.style.setProperty('user-select', 'none', 'important');
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newW = Math.max(320, Math.min(720, rStartW + (rStartX - e.clientX)));
    sidePanel.style.width = newW + 'px';
    if (!panelOpen) sidePanel.style.right = `-${newW}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
  });

  sidePanel.querySelector('#hl-panel-close').addEventListener('click', () => {
    panelOpen = false;
    updatePanelState();
  });

  sidePanel.querySelector('#hl-panel-search').addEventListener('input', (e) => {
    filterPanel(e.target.value.trim().toLowerCase());
  });

  renderPaletteEditor();
}

function renderPaletteEditor() {
  const container = document.getElementById('hl-palette-slots');
  if (!container) return;
  const isDefault = userPalette.every((hex, i) => hex.toLowerCase() === DEFAULT_PALETTE[i].toLowerCase());
  container.innerHTML = `
    ${userPalette.map((hex, i) => `
      <label class="hl-palette-slot" title="Colour ${i + 1}: ${hex}">
        <input type="color" class="hl-palette-color" data-slot="${i}" value="${hex.toLowerCase()}"/>
        <span class="hl-palette-swatch" style="background:${hex}"></span>
      </label>
    `).join('')}
    <button class="hl-palette-reset" id="hl-palette-reset" type="button" ${isDefault ? 'disabled' : ''}>Reset</button>
  `;
  container.querySelectorAll('.hl-palette-color').forEach((input) => {
    // Live preview while dragging in the picker; persist on commit
    input.addEventListener('input', () => {
      input.nextElementSibling.style.background = input.value;
    });
    input.addEventListener('change', () => {
      setPaletteColor(Number(input.dataset.slot), input.value);
    });
  });
  container.querySelector('#hl-palette-reset').addEventListener('click', () => resetPalette());
}

function updatePanelState() {
  ensureUiMounted();
  if (!sidePanel) return;
  if (panelOpen) {
    sidePanel.style.right = '0px';
  } else {
    const w = sidePanel.offsetWidth || 440;
    sidePanel.style.right = `-${w}px`;
    const searchInput = document.getElementById('hl-panel-search');
    if (searchInput) searchInput.value = '';
  }
}

/** Panel group for a URL: hostname incl. subdomain, or one shared group for all file:// pages. */
function groupKey(url) {
  return isLocalFile(url) ? LOCAL_FILES_GROUP : extractDomain(url);
}

/** "zara-flow-v2.html" from file:///Users/me/Docs/zara-flow-v2.html */
function fileName(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return path.split('/').filter(Boolean).pop() || path;
  } catch { return url; }
}

/**
 * Group highlights for the panel: site (hostname incl. subdomain) or "Local files" → time bucket,
 * newest first. Returns [{ domain, items, buckets: [{ label, order, items }] }].
 */
function groupHighlights(highlights) {
  const sorted = [...highlights].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const byDomain = new Map();
  sorted.forEach(h => {
    const domain = groupKey(h.url);
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(h);
  });

  return [...byDomain.entries()].map(([domain, items]) => {
    const byBucket = new Map();
    items.forEach(h => {
      const bucket = timeBucket(h.timestamp);
      if (!byBucket.has(bucket.label)) byBucket.set(bucket.label, { label: bucket.label, order: bucket.order, items: [] });
      byBucket.get(bucket.label).items.push(h);
    });
    const buckets = [...byBucket.values()].sort((a, b) => a.order - b.order);
    return { domain, items, buckets };
  });
}

// ============================================================
// PANEL RENDER — double grouping: domain → time bucket
// ============================================================
function refreshSidePanel() {
  ensureUiMounted();
  if (!sidePanel) return;
  const body = document.getElementById('hl-panel-body');
  if (!body) return;

  getAllHighlights().then((highlights) => {
    const total = document.getElementById('hl-panel-total');
    if (total) total.textContent = String(highlights.length);

    if (highlights.length === 0) {
      body.innerHTML = `<p class="hl-panel-empty">No highlights yet.<br>Select text on any page to begin.</p>`;
      return;
    }

    const currentDomain = groupKey(window.location.href);
    // Open the current site's group by default the first time the panel renders it
    if (!expandedDomains.has('__init__')) {
      expandedDomains.add('__init__');
      expandedDomains.add(currentDomain);
    }

    let html = '';
    groupHighlights(highlights).forEach(({ domain, items, buckets }, gIdx) => {
      const domainId = 'hl-d-' + gIdx;

      html += `
        <div class="hl-panel-group" data-domain="${escapeHtml(domain)}">
          <div class="hl-panel-group-header" data-domain-key="${escapeHtml(domain)}" data-target="${domainId}">
            <span class="hl-group-chevron">${expandedDomains.has(domain) ? '▾' : '▸'}</span>
            <span class="hl-group-domain">${domain === LOCAL_FILES_GROUP ? '📄 ' : ''}${escapeHtml(domain)}</span>
            <span class="hl-group-count">${items.length}</span>
            ${domain === currentDomain ? '<span class="hl-current-badge">current</span>' : ''}
            <button class="hl-group-delete" data-delete-domain="${escapeHtml(domain)}" title="Delete all highlights for ${escapeHtml(domain)}">✕</button>
          </div>
          <div class="hl-panel-group-items" id="${domainId}" style="display:${expandedDomains.has(domain) ? 'block' : 'none'}">
            ${buckets.map((bucket, bIdx) => {
        const bucketId = domainId + '-b-' + bIdx;
        const bucketKey = domain + '::' + bucket.label;
        // Buckets default open; user-collapsed ones are remembered
        const collapsed = expandedBuckets.has('collapsed::' + bucketKey);
        return `
                <div class="hl-bucket-group" data-bucket="${escapeHtml(bucket.label)}">
                  <div class="hl-bucket-header" data-bucket-key="${escapeHtml(bucketKey)}" data-target="${bucketId}">
                    <span class="hl-bucket-chevron">${collapsed ? '▸' : '▾'}</span>
                    <span class="hl-bucket-label">${escapeHtml(bucket.label)}</span>
                    <span class="hl-bucket-count">${bucket.items.length}</span>
                    <button class="hl-group-delete" data-delete-domain="${escapeHtml(domain)}" data-delete-bucket="${escapeHtml(bucket.label)}" title="Delete all in ${escapeHtml(bucket.label)}">✕</button>
                  </div>
                  <div class="hl-bucket-items" id="${bucketId}" style="display:${collapsed ? 'none' : 'block'}">
                    ${bucket.items.map(item => buildPanelItem(item)).join('')}
                  </div>
                </div>
              `;
      }).join('')}
          </div>
        </div>
      `;
    });

    body.innerHTML = html;

    // Domain collapse — persist expanded state in expandedDomains Set
    body.querySelectorAll('.hl-panel-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const target = document.getElementById(header.dataset.target);
        if (!target) return;
        const domainKey = header.dataset.domainKey;
        const collapsed = target.style.display === 'none';
        target.style.display = collapsed ? 'block' : 'none';
        header.querySelector('.hl-group-chevron').textContent = collapsed ? '▾' : '▸';
        if (collapsed) expandedDomains.add(domainKey);
        else expandedDomains.delete(domainKey);
      });
    });

    // Bucket collapse — persist collapsed state in expandedBuckets Set
    body.querySelectorAll('.hl-bucket-header').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = document.getElementById(header.dataset.target);
        if (!target) return;
        const key = 'collapsed::' + header.dataset.bucketKey;
        const collapsed = target.style.display === 'none';
        target.style.display = collapsed ? 'block' : 'none';
        header.querySelector('.hl-bucket-chevron').textContent = collapsed ? '▾' : '▸';
        if (collapsed) expandedBuckets.delete(key);
        else expandedBuckets.add(key);
      });
    });

    // Item click → open the page and scroll to the highlight
    body.querySelectorAll('.hl-panel-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.hl-item-delete')) return;
        openHighlight(item.dataset.id, item.dataset.url, item.dataset.inFrame === 'true');
      });
    });

    // Delete individual items
    body.querySelectorAll('.hl-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.hl-panel-item');
        if (item) deleteHighlight(item.dataset.id);
      });
    });

    // Delete entire domain group
    body.querySelectorAll('.hl-group-delete[data-delete-domain]:not([data-delete-bucket])').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const domain = btn.dataset.deleteDomain;
        if (!window.confirm(`Delete all highlights for ${domain}?`)) return;
        deleteGroupHighlights(h => groupKey(h.url) === domain, () => {
          expandedDomains.delete(domain);
        });
      });
    });

    // Delete entire bucket group
    body.querySelectorAll('.hl-group-delete[data-delete-bucket]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const domain = btn.dataset.deleteDomain;
        const bucket = btn.dataset.deleteBucket;
        if (!window.confirm(`Delete all ${domain} highlights from "${bucket}"?`)) return;
        deleteGroupHighlights(
          h => groupKey(h.url) === domain && timeBucket(h.timestamp).label === bucket,
          () => { expandedBuckets.delete('collapsed::' + domain + '::' + bucket); }
        );
      });
    });

    // Re-apply search filter if active
    const searchVal = document.getElementById('hl-panel-search')?.value.trim().toLowerCase();
    if (searchVal) filterPanel(searchVal);
  }).catch((error) => {
    console.error('[Po] panel load failed:', error);
    body.innerHTML = `<p class="hl-panel-empty">Could not load highlights.<br>${escapeHtml(error?.message || '')}</p>`;
  });
}

function buildPanelItem(data) {
  const snippet = truncate(data.text, 100);
  const comment = data.comment ? truncate(data.comment, 90) : '';
  const age = relativeTime(data.timestamp);
  const color = data.resolved ? RESOLVED_COLOR : (data.color || DEFAULT_PALETTE[0]);
  const local = isLocalFile(data.url);
  // Local files share one group, so each item names its file; web items show the page title
  const source = local ? `📄 ${fileName(data.url)}` : (data.pageTitle || '');
  const tooltip = local ? safeDecode(pageKey(data.url).replace(/^file:\/\//, '')) : (data.pageTitle || data.url);
  const searchText = `${data.text} ${data.comment || ''} ${data.pageTitle || ''} ${local ? fileName(data.url) : ''}`.toLowerCase();

  return `
    <div class="hl-panel-item ${data.resolved ? 'hl-item-resolved' : ''}"
         data-id="${escapeHtml(data.id)}"
         data-url="${escapeHtml(data.url)}"
         data-in-frame="${data.inFrame ? 'true' : 'false'}"
         data-text="${escapeHtml(searchText)}"
         data-domain="${escapeHtml(groupKey(data.url))}"
         title="${escapeHtml(tooltip)}">
      <div class="hl-item-dot" style="background:${escapeHtml(color)}"></div>
      <div class="hl-item-content">
        <p class="hl-item-text">${escapeHtml(snippet)}</p>
        ${comment ? `<p class="hl-item-comment">💬 ${escapeHtml(comment)}</p>` : ''}
        <div class="hl-item-footer">
          <span class="hl-item-ts">${age}</span>
          <span class="hl-item-page">${escapeHtml(truncate(source, 40))}</span>
          <span class="hl-item-footer-spacer"></span>
          <button class="hl-item-delete" title="Delete highlight">✕</button>
        </div>
      </div>
    </div>
  `;
}

// ---- Real-time search filter ----
function filterPanel(query) {
  const body = document.getElementById('hl-panel-body');
  if (!body) return;

  const items = body.querySelectorAll('.hl-panel-item');
  items.forEach(item => {
    const text = (item.dataset.text || '').toLowerCase();
    const domain = (item.dataset.domain || '').toLowerCase();
    const matches = !query || text.includes(query) || domain.includes(query);
    item.style.display = matches ? '' : 'none';
  });

  // Searching expands everything so matches are visible
  if (query) {
    body.querySelectorAll('.hl-panel-group-items, .hl-bucket-items').forEach(el => { el.style.display = 'block'; });
  }

  // Hide empty bucket groups
  body.querySelectorAll('.hl-bucket-group').forEach(bg => {
    const visible = [...bg.querySelectorAll('.hl-panel-item')].some(i => i.style.display !== 'none');
    bg.style.display = visible ? '' : 'none';
  });

  // Hide empty domain groups
  body.querySelectorAll('.hl-panel-group').forEach(dg => {
    const visible = [...dg.querySelectorAll('.hl-panel-item')].some(i => i.style.display !== 'none');
    dg.style.display = visible ? '' : 'none';
  });
}

// ---- Scroll & flash ----
function scrollToHighlight(id) {
  const span = document.querySelector(`span.my-extension-highlight[data-id="${id}"]`);
  if (span) {
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    span.classList.add('hl-flash');
    setTimeout(() => span.classList.remove('hl-flash'), 1600);
  }
}

// ============================================================
// UTILITIES
// ============================================================

/** Hostname incl. subdomain, minus www: docs.github.com, simonwillison.net */
function extractDomain(url) {
  try {
    let host = new URL(url).hostname;
    if (host.startsWith('www.')) host = host.slice(4);
    return host || url;
  } catch { return url; }
}

/** Time bucket for grouping within domain */
function timeBucket(iso) {
  if (!iso) return { label: 'Older', order: 99 };
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays === 0) return { label: 'Today', order: 0 };
  if (diffDays === 1) return { label: 'Yesterday', order: 1 };
  if (diffDays <= 6) return { label: 'This week', order: 2 };
  if (diffDays <= 29) return { label: 'This month', order: 3 };
  return { label: 'Older', order: 4 };
}

function relativeTime(iso) {
  if (!iso) return '';
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 60) return `${diffDays} days ago`;
    const diffMonths = Math.round(diffMs / (86400000 * 30.44));
    if (diffMonths < 24) return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
    const years = Math.floor(diffMonths / 12);
    const months = Math.round(diffMonths % 12);
    return months > 0 ? `${years} yr ${months} mo ago` : `${years} yr ago`;
  } catch { return ''; }
}

function safeDecode(str) {
  try { return decodeURIComponent(str); } catch { return str; }
}

function truncate(str, len) {
  if (!str) return '';
  str = String(str);
  return str.length > len ? str.substring(0, len) + '…' : str;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getXPath(element) {
  if (!element) return '';
  if (element.id) return `id("${element.id}")`;
  if (element === document.body) return element.tagName;
  const siblings = element.parentNode ? element.parentNode.childNodes : [];
  let ix = 0;
  for (let i = 0; i < siblings.length; i++) {
    const sib = siblings[i];
    if (sib === element) return getXPath(element.parentNode) + '/' + element.tagName + '[' + (ix + 1) + ']';
    if (sib.nodeType === 1 && sib.tagName === element.tagName) ix++;
  }
  return '';
}

function lookupElementByXPath(path) {
  if (!path) return null;
  try {
    const res = new XPathEvaluator().evaluate(path, document.documentElement, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return res.singleNodeValue;
  } catch { return null; }
}

function getTextNodes(node) {
  if (!node) return [];
  const result = [];
  if (node.nodeType === 3) {
    result.push(node);
  } else if (node.nodeType === 1) {
    const tag = node.tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return result;
    if (node.id === UI_HOST_ID) return result; // never match text inside our own panel
    for (const child of node.childNodes) result.push(...getTextNodes(child));
  }
  return result;
}

// Normalize non-breaking spaces and other Unicode whitespace to regular space
function normalizeWs(s) {
  return s.replace(/[      　]/g, ' ');
}

function findRangeInTextNodes(textNodes, searchText) {
  if (!searchText) return null;
  const needle = normalizeWs(searchText);

  // Pass 1: single-node match
  for (const node of textNodes) {
    const hay = normalizeWs(node.textContent);
    const idx = hay.indexOf(needle);
    if (idx !== -1) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + searchText.length);
      return r;
    }
  }

  // Pass 2: cross-node match (concatenated)
  let fullText = '';
  const nodeMap = [];
  for (const node of textNodes) {
    const txt = normalizeWs(node.textContent);
    nodeMap.push({ node, start: fullText.length, end: fullText.length + txt.length });
    fullText += txt;
  }
  const gi = fullText.indexOf(needle);
  if (gi !== -1) {
    const ge = gi + needle.length;
    const sInfo = nodeMap.find(m => gi >= m.start && gi < m.end);
    const eInfo = nodeMap.find(m => ge > m.start && ge <= m.end);
    if (sInfo && eInfo) {
      const r = document.createRange();
      r.setStart(sInfo.node, gi - sInfo.start);
      r.setEnd(eInfo.node, ge - eInfo.start);
      return r;
    }
  }
  return null;
}

// ============================================================
// BOOTSTRAP — last, so every top-level `let` above is initialized.
// Skipped when loaded as a plain <script> (test.html): no chrome.runtime.id there.
// ============================================================
if (isContextValid() && isSupportedDocument(document) &&
    frameRole(IS_TOP_FRAME, window.location.href) !== 'none' && !hasActiveRuntimeInstance()) {
  document.addEventListener(RUNTIME_PING_EVENT, respondToRuntimePing);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
