# Po Highlighter

A small Chrome extension for **highlighting text on any page, adding a comment, and finding it again later**. Highlights come back when you refresh or revisit the page, and a side panel lists everything you've saved, grouped by site.

Everything stays in your browser. **The extension makes no network requests**: no account, no server, no sync, no analytics.

<p align="center"><img src="images/po_webhighter_ext.png" width="96" alt="Po icon"></p>

---

## Contents
- [Features](#features)
- [Install](#install)
- [Using it](#using-it)
- [Where it works](#where-it-works)
- [Your data](#your-data)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Background](#background)

---

## Features

- **Highlight in one click.** Select text, then pick a colour.
- **Comments.** Attach a note to any highlight. Hover to see it, or click the highlight to read, edit, resolve or delete it.
- **Survives refresh.** Highlights and comments are put back every time the page loads, including on pages that load their content late.
- **Side panel.** Click the toolbar icon to see every highlight:
  - grouped by **site**, with subdomains kept apart (`docs.github.com` ≠ `github.com`)
  - all local files together under **📄 Local files**, each item showing its file name
  - then by time: Today / Yesterday / This week / This month / Older
  - search across highlighted text, comments, page titles, sites and file names
  - **click any item to open that page and scroll straight to the highlight**
- **Your own colours.** Pick the four highlight colours from the panel. Changing a colour updates existing highlights that used it too.
- **Local files.** Works on `.html`, `.md`, `.txt` and `.json` files opened from disk.
- **OneDrive.** Works on HTML documents opened in OneDrive's web viewer, with each document keeping its own highlights.
- **Resolve.** Mark a highlight as done: it turns green and stays visible. Reopen it any time.

## Install

Po isn't on the Chrome Web Store. You load it directly from this folder ("unpacked").

1. Get the code and **put it somewhere permanent**. Chrome loads the extension from this exact folder, so moving or deleting it removes the extension.
   ```bash
   git clone https://github.com/ani-code/po-briefcase.git
   ```
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the cloned folder.
4. Pin it: puzzle-piece icon in the toolbar → pin **Po Highlighter**.
5. **Refresh any tabs that were already open.**
6. *(For local files)* On the extension's **Details** page, turn on **Allow access to file URLs**. Chrome doesn't let extensions turn this on themselves.

You don't need to be signed in to Chrome.

**Updating:** `git pull`, then click the reload icon on Po's card in `chrome://extensions`, then refresh open tabs. Your highlights are kept.

## Using it

| To… | Do this |
|---|---|
| Highlight | Select text → click a colour circle in the little widget that appears |
| Highlight with a comment | Select text → **✏ Add note & save** → type → **Save** (or ⌘/Ctrl + Enter) |
| Read a comment | Hover the highlight, or click it |
| Edit / delete | Click the highlight → ✏ or 🗑 |
| Resolve / reopen | Click the highlight → **Resolve ✓** / **Reopen** |
| Open the panel | Click the Po icon in the toolbar (click again or ✕ to close) |
| Jump to a highlight | Click it in the panel. Other pages and local files open in the current tab |
| Search | Type in the panel's search box |
| Change colours | Panel → **Highlight colours** → click a circle → pick a colour. **Reset** restores the defaults |
| Delete a whole site or time group | Hover its header in the panel → ✕ (asks first) |
| Resize the panel | Drag its left edge |

## Where it works

| Page | Works? | Notes |
|---|---|---|
| Normal websites | ✓ | |
| Local `.html` files | ✓ | Needs **Allow access to file URLs** |
| Local `.md`, `.txt`, `.json` | ✓ | Chrome shows these as raw text, so you highlight the raw text (Markdown isn't rendered) |
| HTML docs in OneDrive's viewer | ✓ | Highlights are saved per document, using the OneDrive page address |
| Markdown in OneDrive | ✓ | |
| Local `.xml`, `.svg` | — | Po deliberately stays out (these aren't HTML pages) |
| PDFs | ✗ | Chrome's PDF viewer doesn't let extensions reach the text |
| `chrome://` pages, Chrome Web Store | ✗ | Chrome blocks all extensions there |
| Ads and embedded third-party frames | — | Ignored on purpose |

**Known limits**
- Highlights are found again by their **text**. If a page's wording changes, that highlight can't be placed. It stays in the panel but won't show on the page. If the same text appears twice on a page, the first occurrence is highlighted.
- Highlights are tied to the page address, ignoring anything after `#`. The same article at two different addresses counts as two pages.
- Po runs inside embedded frames only when they're document viewers (`about:srcdoc` and similar). Text inside other embedded frames can't be highlighted.

## Your data

- Highlights and colours are stored in **`chrome.storage.local`**: on your disk, in your Chrome profile, readable only by this extension.
- **Nothing is sent anywhere.** The code contains no network calls, and the manifest asks for no website access permissions. The test suite enforces both (see below).
- Highlights **don't sync** between computers or Chrome profiles, even if you're signed in to Chrome.
- ⚠️ **Removing the extension deletes all your highlights.** Reloading or updating it doesn't.

**Permissions requested**

| Permission | Why |
|---|---|
| `storage` | Save highlights and colours locally |
| `activeTab` | When you click the icon on a tab opened before Po was installed, add Po to that tab |
| `scripting` | The mechanism for that same one-off injection |

## Troubleshooting

| Problem | Fix |
|---|---|
| Clicking the icon does nothing | Refresh the tab. Tabs opened before installing or reloading Po have an old copy. `chrome://` pages and the Web Store never work |
| Highlights don't show on a local file | Turn on **Allow access to file URLs** on Po's Details page, then refresh |
| Panel says to turn on file access when opening a local file | Same as above |
| "Could not open that file" | The file was moved or renamed since you highlighted it |
| A highlight is in the panel but not on the page | The page's text changed, so it can't be found again |
| "Could not highlight — try selecting within one block of text" | The selection spans something that can't be wrapped. Select a smaller piece |
| **Load unpacked** is missing or greyed out | Your Chrome is probably managed by an organisation. Check `chrome://policy` for extension rules |
| Nothing works in a OneDrive HTML doc | Reload Po and refresh the OneDrive tab. Right-click the doc: if **View frame source** shows `about:srcdoc`, Po should run there. If not, OneDrive has changed how it shows files; please open an issue |

## Development

The extension is plain JavaScript and CSS: **no build step, no runtime dependencies**. Edit, then reload it in `chrome://extensions`.

### Tests

Run before every commit:

```bash
npm install   # first time: installs Puppeteer + Chrome for Testing (~600 MB, into .cache/, git-ignored)
npm test      # ~1.5 minutes; exit code 0 means everything passed
```

`npm test` runs:

1. **No-network guard.** The extension code must contain no network APIs, and the manifest no website access permissions.
2. **Unit tests** (`test.html`). The real `content.js` against an in-memory storage. You can also just open `test.html` in Chrome.
3. **Local files** (`e2e/local-files.mjs`). Real Chrome opens `.html/.md/.txt/.json` files from disk, saves a highlight, reloads, and checks it came back. Also checks that XML and SVG are left alone.
4. **Real extension** (`e2e/extension.mjs`). The actual unpacked extension in Chrome for Testing, against:
   - a normal page with an ad-style frame
   - a **OneDrive look-alike**: top page → viewer frame on another site → sandboxed `about:srcdoc` document

   It checks highlighting, restore after reload, per-document separation, one panel per tab, and panel navigation that scrolls to the highlight.

Each suite also runs on its own: `npm run test:unit`, `npm run test:local`, `npm run test:extension`.

To check whether a test would catch a regression, run the extension suite against another copy of the code:
```bash
PO_EXTENSION_DIR=/path/to/older/copy npm run test:extension
```

Why Chrome for Testing? Regular Chrome no longer lets automation load an unpacked extension. Google's Chrome for Testing build does, so the suite can test the real extension, not a stand-in.

### Working on it with Claude Code

[`CLAUDE.md`](CLAUDE.md) holds the full design notes: data model, how restore and frames work, past bugs and their causes, and where to change what. Claude Code reads it automatically when started in this folder.

## How it works

- **Saving.** The selected text is wrapped in `<span class="my-extension-highlight">` elements, one per text node, so selections across bold text and links work. Saved with it: the exact text, a hint about where it was (an XPath), the colour, comment and time.
- **Restoring.** When a page loads, Po finds each saved highlight's text again: first near its old position, then anywhere on the page, including text split across elements and non-breaking spaces. If the text isn't there yet (pages that load content late), it retries for up to ~20 seconds. It also re-checks when the page changes without reloading (single-page apps).
- **Panel navigation.** Clicking an item on another page asks the extension's background worker to open it, because web pages aren't allowed to open local files themselves. The destination page then scrolls to that highlight once it's restored.
- **Document viewers (OneDrive).** OneDrive shows HTML files inside a sandboxed frame with no address of its own. Po asks the main page for its address and saves highlights under it, so each document keeps its own highlights. The panel stays on the main page; clicks are passed to the frame to scroll.

## Project layout

```
manifest.json        Extension manifest (MV3)
content.js           Everything on the page: highlighting, comments, restore, panel, colours
background.js        Toolbar click, opening pages/files, relays between frames
styles.css           Widget, popup and panel styles
images/              Icon
test.html            Unit tests (open in Chrome, or run via npm)
e2e/                 Automated suites + fixtures (see Development)
package.json         Test tooling only
CLAUDE.md            Design notes for Claude Code / maintainers
```

## Background

Po Highlighter is a stripped-down, offline version of a larger personal extension ("Po") that also synced highlights to a private backend. This version keeps only highlighting, comments and the panel, with all networking removed, so it can run on a machine with no access to that backend.
