// Po Highlighter — service worker.
// 1. Toolbar icon click → toggle the side panel in the active tab.
// 2. OPEN_URL from the panel → navigate that tab (web pages can't open file:// themselves).
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
  if (msg?.type !== 'OPEN_URL') return;
  openUrlInTab(msg.url, sender.tab?.id).then(sendResponse);
  return true; // async response
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
