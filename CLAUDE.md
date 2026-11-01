# CLAUDE.md — Po Highlighter (carryover)

A Chrome extension (Manifest V3) for **highlighting text on any web page, attaching a comment, and browsing every highlight by site** from a side panel. Highlights survive page refreshes. Everything is stored locally in this Chrome profile. **There are no network calls.**

---

## Why this exists

- Ani built **Po** on a personal machine. Po is a bigger extension that also syncs to a private backend called Zara: page scraping, image snips, chat-with-page, YouTube transcripts and a knowledge base.
- This machine is a **work laptop with no connection to Zara whatsoever**. Only the core reading workflow was wanted here: highlight, comment, find it again later.
- So this folder is a **standalone extract** of Po's highlight, comment and panel code with every network and Zara path removed. It was extracted on 2026-11-01 from `my-web-highlighter` commit `0516c52`. The highlight and restore logic is copied, not rewritten, because it was already proven in daily use.

### Hard rules for this project
1. **No network, ever.** No `fetch`, XHR, WebSocket, `sendBeacon`, no `host_permissions`, no remote scripts or fonts. This is a work machine and the data stays in the browser. `npm test` enforces it (no-network guard).
2. **Local storage only**: `chrome.storage.local`. No sync storage, no backend.
3. Keep it small. If a feature needs a server, it doesn't belong here.
4. **`npm test` must pass before every commit.** Add a test with every change (see Testing).

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

### OneDrive (and other document viewers)
OneDrive shows an uploaded `.html` file inside a **sandboxed `about:srcdoc` iframe**, nested in a viewer iframe from another origin. (Confirmed on the work Mac: right-click the doc, then **View frame source** gives `view-source:about:srcdoc`.) `.md` files on OneDrive render in the main page and always worked.
- Po runs in the top page **and** in "inline" frames (`about:srcdoc`, `about:blank`, `data:`, `blob:`). See `frameRole()`. Ordinary `http(s)` subframes (ads, embeds) are ignored: no UI, no listeners.
- An inline frame has no address of its own, so it asks for the **top page's URL** (`GET_PAGE_INFO_FOR_FRAME`, relayed by `background.js` to the top frame's content script at `frameId 0`) and saves highlights under it with `inFrame: true`. Each OneDrive doc URL (`…onedrive.aspx?id=…/doc.html`) keeps its own highlights. If the top URL can't be resolved, Po stays **off** in that frame rather than saving under `about:srcdoc`, which every doc would share.
- The top page restores only `!inFrame` highlights; frames restore only `inFrame` ones.
- **One panel per tab, on the top page.** Clicking a frame highlight on the same page sends `SCROLL_TO_IN_TAB`, which background broadcasts so every frame checks for it. From another page, it navigates and a `pendingScroll` with `inFrame: true` is consumed only by the frame.
- Manifest: `all_frames: true` + `match_origin_as_fallback: true` (needed to inject into sandboxed `about:srcdoc` frames).

### Local files: what works
Needs **Allow access to file URLs** turned on (see Install). Verified end-to-end by `e2e/local-files.mjs`:

| File type | Chrome shows it as | Po |
|---|---|---|
| `.html` | the page | ✓ highlight, comment, restore on refresh |
| `.md`, `.txt`, `.json` (and other plain text) | raw text in a `<pre>` | ✓ same. Markdown is **not** rendered, you highlight the raw text |
| `.xml`, `.svg` | XML viewer / image | ✗ Po stays out on purpose (its HTML UI can't go into XML documents) |
| `.pdf` | Chrome's built-in PDF viewer | ✗ extensions can't reach the PDF's text layer |
| `.csv`, `.docx`, … | downloaded, not displayed | nothing to highlight |

**Not included (on purpose):** Zara sync, page scrape, image snip/OCR, chat-with-page, YouTube transcripts, options page, diagnostics.

---

## How it works

### Files
| File | Role |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `activeTab`, `scripting`. **No `host_permissions`.** The content script runs on `<all_urls>`, in all frames (`all_frames`, `match_origin_as_fallback`). `content.js` decides where it actually starts |
| `content.js` | Everything: selection widget, comment popup, highlight wrap/restore, side panel, storage helpers. Bootstrap is at the **bottom** of the file |
| `background.js` | Service worker. (1) `OPEN_URL` from the panel → `chrome.tabs.update` on that tab. Returns `file_access_off` if a `file://` URL is requested without file access, and the panel shows a notice. (2) Toolbar icon click sends `TOGGLE_PANEL` to the tab. If the tab has no live content script (opened before install or reload), it injects `styles.css` + `content.js` via `activeTab`, then toggles |
| `styles.css` | Po's styles trimmed to spans, widget, popup and panel (sage `#2d7d5e` accent, light UI) |
| `test.html` | In-browser test suite against the real `content.js` (see Testing) |
| `package.json`, `.puppeteerrc.cjs` | **Test tooling only** (Puppeteer + Chrome for Testing, cached in `.cache/`, git-ignored). The extension itself has no dependencies or build step |
| `e2e/run-all.mjs` | `npm test`: no-network guard plus the three suites below |
| `e2e/unit.mjs` | Runs `test.html` headless |
| `e2e/local-files.mjs` + `e2e/fixtures/` | Real local files in real Chrome: highlight, reload, restored |
| `e2e/extension.mjs` | **Real extension** in Chrome for Testing: top page, OneDrive-style sandboxed srcdoc viewer, ad frames, panel, cross-page navigation |
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

**Timing trap (fixed 2026-11-01):** `init()` awaits storage (palette, pending scroll) before deciding whether to restore. Small local files finish loading during those awaits, so a `readyState` captured at script start is stale. Waiting for a `load` event that had already fired meant **highlights never came back on .md/.txt/.json**. `startRestoreWhenLoaded()` re-checks `document.readyState` at decision time. Don't move that check back above the awaits.

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

**One command, run before every commit:**
```bash
npm install   # first time only: Puppeteer + Chrome for Testing (~600 MB into .cache/, git-ignored)
npm test      # ~1.5 min; exit code 0 = safe to commit
```
It runs four things (each also on its own via `npm run test:unit|test:local|test:extension`):

| Suite | What it proves |
|---|---|
| **no-network guard** | `content.js` and `background.js` contain no `fetch`/XHR/WebSocket/`sendBeacon`/`EventSource`, and the manifest has no `host_permissions` |
| **unit** (`test.html`, 33 tests) | Logic against the real `content.js` with an in-memory `chrome.storage`: page keys, site and Local-files grouping, text matching, wrap/unwrap, storage, refresh restore (comment, colour, `#fragment`, resolved, late content), restore-timing race, HTML-only documents, `frameRole`, panel render and search, pending scroll, local-file opening, colours. Also openable by hand in Chrome |
| **local files** (6 fixtures) | Real Chrome opens html/md/txt/json from `file://`, saves a highlight with a comment, **reloads**, and it must be restored. XML/SVG must be left alone. (`chrome.*` is a stand-in here; file access can't be toggled in automation) |
| **extension** (10 tests) | The **real unpacked extension** in Chrome for Testing, driven through the page's DOM: top-page highlight + reload; ad iframe ignored; **OneDrive mock** (top page, cross-origin viewer, sandboxed `about:srcdoc` doc): highlight in the frame saved under the top URL, restored after reload, no leak into another doc; exactly one panel per tab; panel click scrolls inside the frame; panel navigation across pages scrolls in the right context; exactly one selection widget |

**The suites are known to catch regressions.** They were checked against deliberate breakage: the pre-OneDrive version fails 5 extension tests; frames keying by `about:srcdoc` fails 5 (including doc1's highlight leaking into doc2); the old restore-timing code fails the local-files suite on .md/.txt. To rerun the extension suite against another copy, set `PO_EXTENSION_DIR=/path/to/copy npm run test:extension`.

- **Manual check on the real thing after a change:** `chrome://extensions` → reload Po → refresh tabs. Highlight with a comment, refresh, open the panel, click an item from another site. On the work Mac, also check an HTML doc open in OneDrive.
- **Writing tests:** pure logic goes in `test.html` (`test(name, async fn)`, `assert`, `assertEq`). Anything involving frames, the toolbar, navigation or real storage goes in `e2e/extension.mjs` (`highlight(frame, phrase, {comment})`, `spanInfo`, `openPanel`, `clickPanelItem`, `waitForFlash`). Assert the behaviour itself (e.g. "restored span has the comment"), not a stand-in for it.

## Changing things: where to look

| Want to change… | Go to |
|---|---|
| Highlight colours | Users pick them in the panel. Defaults are `DEFAULT_PALETTE` at the top of `content.js`; editor is `renderPaletteEditor()` / `setPaletteColor()` |
| Widget / popup look | `styles.css` → COLOR WIDGET / COMMENT POPUP |
| Panel grouping | `groupHighlights()` + `groupKey()` (`file://` → "Local files", otherwise `extractDomain()`) |
| Restore reliability | `restoreHighlight()`, `findRangeInTextNodes()`, `RESTORE_RETRY_DELAYS` |
| Toolbar click behaviour | `background.js` |
| Which frames Po runs in / how frames identify their page | `frameRole()`, `resolveFramePage()`, `currentPageUrl()` in `content.js`; relays in `background.js` |

Possible next steps (not built): export/import highlights as JSON (a backup, since uninstalling wipes data), a highlight-count badge on the icon, a keyboard shortcut to open the panel.
