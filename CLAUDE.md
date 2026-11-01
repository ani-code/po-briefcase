# CLAUDE.md — Po Highlighter (carryover)

A Chrome extension (Manifest V3) for **highlighting text on any web page, attaching a comment, and browsing every highlight by site** from a side panel. Highlights survive page refreshes. Everything is stored locally in this Chrome profile. **There are no network calls.**

---

## Why this exists

- Ani built **Po** on a personal machine. Po is a bigger extension that also syncs to a private backend called Zara: page scraping, image snips, chat-with-page, YouTube transcripts and a knowledge base.
- This machine is a **work laptop with no connection to Zara whatsoever**. Only the core reading workflow was wanted here: highlight, comment, find it again later.
- So this folder is a **standalone extract** of Po's highlight, comment and panel code with every network and Zara path removed. It was extracted on 2026-11-01 from `my-web-highlighter` commit `0516c52`. The highlight and restore logic is copied, not rewritten, because it was already proven in daily use.

### Hard rules for this project
1. **No network, ever.** No `fetch`, XHR, WebSocket, `sendBeacon`, no `host_permissions`, no remote scripts or fonts. This is a work machine and the data stays in the browser. `test.html` and the grep below enforce it.
2. **Local storage only**: `chrome.storage.local`. No sync storage, no backend.
3. Keep it small. If a feature needs a server, it doesn't belong here.

---

## What it does

| Action | How |
|---|---|
| Highlight | Select text, then a widget appears. Click one of the 4 colour swatches to save it immediately |
| Highlight + comment | Select text, click **✏ Add note & save**, type, then **Save** (or ⌘/Ctrl+Enter) |
| View a comment | Click any highlighted text on the page. Hovering also shows the comment as a tooltip |
| Edit / delete / resolve | Click the highlight, then ✏ / 🗑 / **Resolve ✓** (resolved highlights turn green; **Reopen** undoes it) |
| Open the panel | Click the extension's toolbar icon. Click again or ✕ to close |
| Panel layout | Grouped by **site (hostname incl. subdomain)**, so `docs.github.com` and `github.com` are separate groups. **Every local `file://` page shares one 📄 Local files group**, and each item shows its file name (full path on hover). Then by time (Today / Yesterday / This week / This month / Older), newest first. The current site's group opens by default |
| Open a highlight | Click it in the panel. If it's on another page or a local file, it opens in this tab and scrolls to the highlight (flashes green) once it's restored. Opening goes through `background.js` (`chrome.tabs.update`) because a web page isn't allowed to open `file://` URLs itself |
| Choose colours | Panel → **Highlight colours** → click a circle to open the colour picker. Changing a colour also **recolours every existing highlight that used it**. **Reset** goes back to the defaults |
| Search | Panel search box filters by highlighted text, comment, page title, site or file name |
| Bulk delete | Hover a site or time header and click ✕ (asks for confirmation) |
| Resize panel | Drag its left edge (320–720px) |

**Not included (on purpose):** Zara sync, page scrape, image snip/OCR, chat-with-page, YouTube transcripts, options page, diagnostics.

---

## How it works

### Files
| File | Role |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `activeTab`, `scripting`. **No `host_permissions`.** The content script runs on `<all_urls>` |
| `content.js` | Everything: selection widget, comment popup, highlight wrap/restore, side panel, storage helpers. Bootstrap is at the **bottom** of the file |
| `background.js` | Service worker. (1) `OPEN_URL` from the panel → `chrome.tabs.update` on that tab. Returns `file_access_off` if a `file://` URL is requested without file access, and the panel shows a notice. (2) Toolbar icon click sends `TOGGLE_PANEL` to the tab. If the tab has no live content script (opened before install or reload), it injects `styles.css` + `content.js` via `activeTab`, then toggles |
| `styles.css` | Po's styles trimmed to spans, widget, popup and panel (sage `#2d7d5e` accent, light UI) |
| `test.html` | In-browser test suite against the real `content.js` (see Testing) |
| `images/po_webhighter_ext.png` | Icon |

### Data model: `chrome.storage.local`
- Key `highlights` is an array of:
  ```js
  { id, url, pageTitle, text, xpath, color, comment, resolved, timestamp /* ISO */, isMultiSpan }
  ```
- Key `hlPalette` holds 4 hex colours (defaults to `DEFAULT_PALETTE`; invalid values fall back to defaults). Each highlight stores its own `color`, so changing a palette slot rewrites `color` on highlights that used the old hex (`savePalette()`).
- Key `pendingScroll` is `{ id, url, at }`. It is set when you click a panel item that lives on another page. The destination page picks it up after load, scrolls to the highlight, then clears it. It expires after 30 seconds.
- All writes go through `mutateHighlights()`, which serializes read-modify-write within a tab so rapid edits don't overwrite each other.
- `chrome.storage.onChanged` refreshes an open panel when another tab changes highlights.

### Why highlights survive a refresh (the core feature)
1. **Save:** the selected `Range` is wrapped in `<span class="my-extension-highlight" data-id=…>` (one span per text node, so selections across `<b>`, `<a>` etc. work). Stored with the **exact text** plus an **XPath** of the first span's parent.
2. **Reload:** after the `load` event, plus 800ms, `loadHighlights()` reads storage and takes every highlight whose `pageKey(url)` matches this page. `pageKey` strips the `#fragment`, so `page#section` still matches.
3. **Find the text again:** `findRangeInTextNodes()` searches the XPath parent first, then the whole `<body>`. It matches within one text node, then across concatenated nodes. Non-breaking and other Unicode spaces count as normal spaces.
4. **Late content:** if the text isn't on the page yet, it retries after 1s, 2.5s, 5s and 10s.
5. **SPAs / dynamic pages:** a `MutationObserver` (debounced 1.2s, ignoring the extension's own UI) re-runs restore when the page changes.

**Known limitation:** restore is text-based. If the page's text changes, the highlight can't be placed. It stays in the panel (and storage) but won't appear on the page. If the same text appears twice, the first occurrence gets highlighted.

### Orphaned content scripts
When the extension is reloaded at `chrome://extensions`, the old `content.js` keeps running in open tabs but loses `chrome.runtime.id`. `isContextValid()` guards every handler so the orphan goes inert. The ping/pong check (`hasActiveRuntimeInstance`) only answers from a live instance, so a re-injected script still boots. **After reloading the extension, refresh open tabs** to be safe.

---

## Install (on this machine)

Repo: `https://github.com/ani-code/po-briefcase` (**public**: never commit highlights, exports or anything work-related).

0. `git clone https://github.com/ani-code/po-briefcase.git` into a **permanent** location. Chrome loads the extension from that exact path, so moving it later breaks the install.
1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → select the cloned folder.
3. Pin the icon (puzzle-piece menu → pin).
4. Refresh any tabs that were already open.
5. **For local HTML files (`file://`)**: open the extension's **Details** and turn on **Allow access to file URLs**. Without it the extension doesn't run on local files, and the panel can't open them. Extensions can't turn this on themselves.

**Work laptop caveat:** if Chrome is company-managed, policy can block Developer mode or unpacked extensions. If **Load unpacked** is missing or greyed out, check `chrome://policy` (look for `ExtensionInstallBlocklist`, `ExtensionAllowedTypes` or `DeveloperToolsAvailability`). That's an IT setting, not a bug here.

**Data caveat:** highlights live only in this Chrome profile. **Removing the extension deletes them.** Reloading or updating the files does not. They don't sync to any other machine.

---

## Testing

- **Automated:** open `test.html` in Chrome and it runs automatically. Expect **29/29 passed**. It loads the real `content.js` (nothing is copied into the test) with an in-memory `chrome.storage`, and covers: `pageKey`, `extractDomain`, grouping by subdomain and time, text matching (single node, across elements, nbsp, miss), wrap/unwrap round-trip, storage add/update/remove plus concurrent writes, **refresh restore** (comment, colour, `#fragment`, resolved state, late-rendered content via retry), delete, edit, panel rendering and search, pending-scroll targeting, the **Local files** group (grouping, file name, search, opening via the background with the scroll queued, file-access-off notice) and **colours** (save, recolour existing highlights and on-page spans, reset, invalid stored palette).
- **Headless run** (no clicking):
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
    --user-data-dir=/tmp/po-test-prof --virtual-time-budget=30000 \
    --dump-dom "file://$PWD/test.html" 2>/dev/null | grep -o 'summary" class="[a-z]*">[^<]*'
  ```
- **No-network guard:** this must print nothing except the `chromewebstore` string check in `background.js`:
  ```bash
  grep -nE "\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|https?://" *.js
  ```
- **Manual smoke test after any change:** reload the extension at `chrome://extensions` and refresh a real article page. Highlight something with a comment and refresh: it should still be there. Open the panel and check it's under the right site. Go to another site, click the item in the panel: the original page should open and scroll to it.
- **Add a test to `test.html` with every change.** The `test(name, async fn)`, `assert` and `assertEq` helpers are at the top of the last `<script>`. Test the behaviour itself (e.g. "restored span exists with the comment"), not a stand-in for it.

---

## Changing things: where to look

| Want to change… | Go to |
|---|---|
| Highlight colours | Users pick them in the panel. Defaults are `DEFAULT_PALETTE` at the top of `content.js`; editor is `renderPaletteEditor()` / `setPaletteColor()` |
| Widget / popup look | `styles.css` → COLOR WIDGET / COMMENT POPUP |
| Panel grouping | `groupHighlights()` + `groupKey()` (`file://` → "Local files", otherwise `extractDomain()`) |
| Restore reliability | `restoreHighlight()`, `findRangeInTextNodes()`, `RESTORE_RETRY_DELAYS` |
| Toolbar click behaviour | `background.js` |

Possible next steps (not built): export/import highlights as JSON (a backup, since uninstalling wipes data), a highlight-count badge on the icon, a keyboard shortcut to open the panel.
