// Po Highlighter — service worker.
// 1. Toolbar icon click → toggle the side panel in the active tab.
// 2. OPEN_URL from the panel → navigate that tab (web pages can't open file:// themselves).
// 3. Relays for frames: GET_PAGE_INFO_FOR_FRAME (frame → top page URL), SCROLL_TO_IN_TAB.
// There are no network calls anywhere in this extension.

const RESTRICTED_URL_RE = /^(chrome|chrome-extension|chrome-search|devtools|edge|about|view-source):/;

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  if (RESTRICTED_URL_RE.test(tab.url) || tab.url.startsWith('https://chromewebstore.google.com')) return;

  const ts = Date.now();

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL', ts });
    return;
  } catch {
    // No live content script — the tab was open before the extension was installed or reloaded.
  }

  // Inject into this tab (activeTab grants access on icon click), then toggle.
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['styles.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL', ts });
  } catch (error) {
    console.warn('[Po] Could not open panel on this tab — refresh the page and try again:', error?.message);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg?.type === 'OPEN_URL') {
    openUrlInTab(msg.url, tabId).then(sendResponse);
    return true; // async response
  }

  // An inline frame (e.g. OneDrive's about:srcdoc viewer) asks which page it belongs to.
  // Relay to the top frame's content script — no "tabs" permission needed.
  if (msg?.type === 'GET_PAGE_INFO_FOR_FRAME') {
    if (!tabId) { sendResponse({ ok: false }); return; }
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' }, { frameId: 0 }).then(
      (info) => sendResponse(info?.url ? { ok: true, url: info.url, title: info.title } : { ok: false }),
      () => sendResponse({ ok: false })
    );
    return true;
  }

  // Panel click for a highlight inside a frame of this tab → every frame checks for it
  if (msg?.type === 'SCROLL_TO_IN_TAB') {
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'SCROLL_TO', id: msg.id }).catch(() => {});
    sendResponse({ ok: true });
  }
});

async function openUrlInTab(url, tabId) {
  if (!/^(https?|file):/.test(String(url || ''))) return { ok: false, error: 'unsupported_url' };
  if (url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return { ok: false, error: 'file_access_off' };
  }
  try {
    if (tabId) await chrome.tabs.update(tabId, { url });
    else await chrome.tabs.create({ url });
    return { ok: true };
  } catch (error) {
    console.warn('[Po] open failed:', url, error?.message);
    return { ok: false, error: error?.message || 'open_failed' };
  }
}
