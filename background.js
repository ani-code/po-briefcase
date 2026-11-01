// Po Highlighter — service worker.
// Its only job: toolbar icon click → toggle the side panel in the active tab.
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
