// End-to-end with the REAL extension loaded in Chrome for Testing (via Puppeteer).
//
//   npm run test:extension
//
// A local server plays two roles on two origins:
//   http://localhost:PORT/article          normal page + a cross-origin "ad" iframe
//   http://localhost:PORT/onedrive.aspx    OneDrive look-alike: top page → cross-origin viewer
//   http://127.0.0.1:PORT/viewer             iframe → sandboxed about:srcdoc iframe with the doc
// That last frame is how OneDrive shows an uploaded .html file (confirmed on the work Mac:
// "View frame source" → view-source:about:srcdoc).
//
// User actions are driven through the page's DOM (real selection + mouseup/mousedown events),
// so the extension's own handlers do the work. Nothing leaves the machine.
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// PO_EXTENSION_DIR lets you run this suite against another copy (e.g. an older commit).
const EXTENSION_DIR = process.env.PO_EXTENSION_DIR || ROOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 2500; // load + 800ms restore delay + frame page-URL handshake
const TEST_TIMEOUT_MS = 30000;

// ---------- mock sites ----------
const docHtml = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1><p>Shared phrase that appears in every doc.</p><p>Unique phrase for ${name} only.</p>
<div style="height:2400px"></div><p>Deep phrase far down in ${name}.</p></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const port = server.address().port;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/article') {
    return res.end(`<!doctype html><html><head><title>Article</title></head><body>
      <h1>Article</h1><p>Article phrase on the top page.</p>
      <iframe id="ad" src="http://127.0.0.1:${port}/ad" width="400" height="120"></iframe>
      <div style="height:2400px"></div><p>Bottom phrase of the article.</p></body></html>`);
  }
  if (url.pathname === '/ad') {
    return res.end('<!doctype html><body><p>Ad frame phrase that should be ignored.</p></body>');
  }
  if (url.pathname === '/onedrive.aspx') {
    const id = url.searchParams.get('id');
    return res.end(`<!doctype html><html><head><title>${id} - OneDrive</title></head><body>
      <h1>OneDrive</h1><iframe id="viewer" src="http://127.0.0.1:${port}/viewer?doc=${encodeURIComponent(id)}"
        width="900" height="600"></iframe></body></html>`);
  }
  if (url.pathname === '/viewer') {
    const doc = docHtml(url.searchParams.get('doc'));
    return res.end(`<!doctype html><body style="margin:0"><iframe id="doc" sandbox="allow-scripts allow-popups"
      width="880" height="580" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></body>`);
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ARTICLE = `http://localhost:${PORT}/article`;
const DOC1 = `http://localhost:${PORT}/onedrive.aspx?id=Documents%2Fdoc1.html`;
const DOC2 = `http://localhost:${PORT}/onedrive.aspx?id=Documents%2Fdoc2.html`;

// ---------- browser ----------
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXTENSION_DIR] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
let extension;
for (let i = 0; i < 20 && !extension; i++) {
  extension = [...(await browser.extensions()).values()].find((e) => e.name === 'Po Highlighter');
  if (!extension) await sleep(250);
}
if (!extension) throw new Error('Po Highlighter extension did not load');

// Read/clear storage through Po's own content-script realm on the current page. (The MV3
// service worker may be asleep, so extension.workers() can legitimately be empty.)
async function poRealm() {
  for (let i = 0; i < 20; i++) {
    const realm = page.mainFrame().extensionRealms().find((r) => r.extension?.id === extension.id) ||
      page.mainFrame().extensionRealms()[0];
    if (realm) return realm;
    await sleep(250);
  }
  throw new Error('Po content script not running on the top page');
}
async function storage() {
  return (await poRealm()).evaluate(() => chrome.storage.local.get(null));
}
async function clearStorage() {
  if (!page.url().startsWith('http')) await go(ARTICLE); // need a page Po runs on
  await (await poRealm()).evaluate(() => chrome.storage.local.clear());
}
const docFrame = () => page.frames().find((f) => f.url() === 'about:srcdoc');
const adFrame = () => page.frames().find((f) => f.url().endsWith('/ad'));
async function go(url) {
  await page.goto(url, { waitUntil: 'load' });
  await sleep(SETTLE_MS);
}

/** Select `phrase` in `frame`, let Po's mouseup handler show the widget, then save via the UI. */
async function highlight(frame, phrase, { comment = '', swatch = 1 } = {}) {
  const shown = await frame.evaluate(async (phrase) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.textContent.indexOf(phrase);
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + phrase.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 150));
      const w = document.querySelector('#hl-ext-root .hl-ext-widget');
      return !!w && w.style.display === 'flex';
    }
    return 'phrase not found';
  }, phrase);
  if (shown !== true) throw new Error(`widget did not appear (${shown})`);

  if (comment) {
    await frame.evaluate(async (comment) => {
      document.querySelector('#hl-comment-btn').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      document.querySelector('#hl-comment-input').value = comment;
      document.querySelector('#hl-save').click();
    }, comment);
  } else {
    await frame.evaluate((i) => {
      document.querySelectorAll('.hl-swatch[data-color]')[i]
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }, swatch);
  }
  await sleep(400);
}

const spanInfo = (frame, phrase) => frame.evaluate((phrase) => {
  const spans = [...document.querySelectorAll('span.my-extension-highlight')];
  const hit = spans.filter((s) => phrase.includes(s.textContent) && s.textContent.trim());
  return { count: hit.length, text: hit.map((s) => s.textContent).join(''), comment: hit[0]?.title ?? null,
           flashing: hit.some((s) => s.classList.contains('hl-flash')) };
}, phrase);

async function waitForFlash(frame, phrase, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const info = await spanInfo(frame, phrase).catch(() => null);
    if (info?.flashing) return true;
    await sleep(100);
  }
  return false;
}

async function openPanel() {
  await page.triggerExtensionAction(extension);
  await sleep(600);
}
async function panelState() {
  const perFrame = [];
  for (const f of page.frames()) {
    perFrame.push(await f.evaluate(() => document.querySelectorAll('.hl-ext-panel').length).catch(() => 0));
  }
  const top = await page.evaluate(() => {
    const p = document.querySelector('.hl-ext-panel');
    return p && {
      open: p.style.right === '0px',
      groups: [...p.querySelectorAll('.hl-group-domain')].map((g) => g.textContent.trim()),
      items: [...p.querySelectorAll('.hl-panel-item')].map((i) => ({ text: i.querySelector('.hl-item-text').textContent, inFrame: i.dataset.inFrame, url: i.dataset.url })),
    };
  });
  return { totalPanels: perFrame.reduce((a, b) => a + b, 0), top };
}
async function clickPanelItem(phrase) {
  const ok = await page.evaluate((phrase) => {
    // Expand everything, then click the item
    document.querySelectorAll('.hl-panel-group-items, .hl-bucket-items').forEach((e) => { e.style.display = 'block'; });
    const item = [...document.querySelectorAll('.hl-panel-item')].find((i) => i.querySelector('.hl-item-text').textContent.includes(phrase));
    if (!item) return false;
    item.click();
    return true;
  }, phrase);
  if (!ok) throw new Error(`panel item "${phrase}" not found`);
}

// ---------- tests ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

test('top page: highlight + comment survives reload', async () => {
  await clearStorage();
  await go(ARTICLE);
  await highlight(page.mainFrame(), 'Article phrase', { comment: 'top note' });
  const { highlights } = await storage();
  eq(highlights.length, 1, 'stored');
  eq(highlights[0].url, ARTICLE, 'saved under the page URL');
  eq(!!highlights[0].inFrame, false, 'not a frame highlight');
  await go(ARTICLE);
  const s = await spanInfo(page.mainFrame(), 'Article phrase');
  eq(s.text, 'Article phrase', 'restored text');
  eq(s.comment, 'top note', 'restored comment');
});

test('ad-style cross-origin iframe: Po stays out', async () => {
  const frame = adFrame();
  assert(frame, 'ad frame present');
  const r = await frame.evaluate(async () => {
    const p = document.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 200));
    return { uiHost: !!document.getElementById('hl-ext-root') };
  });
  eq(r.uiHost, false, 'no Po UI injected in the ad frame');
});

test('OneDrive viewer: highlight inside the sandboxed srcdoc frame', async () => {
  await clearStorage();
  await go(DOC1);
  const frame = docFrame();
  assert(frame, 'srcdoc frame present');
  await highlight(frame, 'Unique phrase for Documents/doc1.html', { comment: 'doc1 note' });
  await highlight(frame, 'Shared phrase', { swatch: 2 });
  const { highlights } = await storage();
  eq(highlights.length, 2, 'stored');
  assert(highlights.every((h) => h.url === DOC1), `saved under the OneDrive page URL, got ${highlights.map((h) => h.url)}`);
  assert(highlights.every((h) => h.inFrame === true), 'marked as frame highlights');
  eq(highlights[0].pageTitle, 'Documents/doc1.html - OneDrive', 'title from the top page');
});

test('OneDrive viewer: highlights + comment survive reload', async () => {
  await go(DOC1);
  const frame = docFrame();
  const u = await spanInfo(frame, 'Unique phrase for Documents/doc1.html');
  eq(u.text, 'Unique phrase for Documents/doc1.html', 'unique phrase restored');
  eq(u.comment, 'doc1 note', 'comment restored');
  eq((await spanInfo(frame, 'Shared phrase')).text, 'Shared phrase', 'second highlight restored');
  eq(await page.evaluate(() => document.querySelectorAll('span.my-extension-highlight').length), 0,
    'nothing restored into the top page');
});

test('OneDrive viewer: another doc does not show doc1 highlights', async () => {
  await go(DOC2);
  const frame = docFrame();
  eq((await spanInfo(frame, 'Shared phrase')).count, 0, 'shared text stays unhighlighted in doc2');
});

test('panel opens once (top page only) and lists the frame highlights', async () => {
  await go(DOC1);
  await openPanel();
  const s = await panelState();
  eq(s.totalPanels, 1, 'exactly one panel across all frames');
  assert(s.top?.open, 'panel open on the top page');
  assert(s.top.groups.includes('localhost'), `grouped by site: ${s.top.groups}`);
  const item = s.top.items.find((i) => i.text.includes('Unique phrase'));
  assert(item, 'doc1 item listed');
  eq(item.inFrame, 'true', 'item knows it lives in a frame');
});

test('panel click (same page) scrolls to the highlight inside the frame', async () => {
  const frame = docFrame();
  await highlight(frame, 'Deep phrase far down', { swatch: 0 });
  await sleep(300); // open panel refreshes via storage.onChanged
  await clickPanelItem('Deep phrase far down');
  assert(await waitForFlash(frame, 'Deep phrase far down'), 'frame span flashed');
});

test('panel click from another page opens the OneDrive doc and scrolls in the frame', async () => {
  await go(ARTICLE);
  await openPanel();
  await clickPanelItem('Deep phrase far down');
  await page.waitForNavigation({ waitUntil: 'load', timeout: 6000 }).catch(() => {});
  eq(page.url(), DOC1, 'navigated to the doc');
  await sleep(1500);
  assert(await waitForFlash(docFrame(), 'Deep phrase far down', 6000), 'frame span flashed after navigation');
});

test('panel click from the doc opens the article and scrolls on the top page', async () => {
  await go(ARTICLE);
  await highlight(page.mainFrame(), 'Bottom phrase of the article', { swatch: 0 });
  await go(DOC1);
  await openPanel();
  await clickPanelItem('Bottom phrase of the article');
  await page.waitForNavigation({ waitUntil: 'load', timeout: 6000 }).catch(() => {});
  eq(page.url(), ARTICLE, 'navigated to the article');
  await sleep(1000);
  assert(await waitForFlash(page.mainFrame(), 'Bottom phrase of the article', 6000), 'top span flashed after navigation');
});

test('selecting text on a normal page shows exactly one widget', async () => {
  await go(ARTICLE);
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((x) => x.textContent.startsWith('Article'));
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await sleep(200);
  let visible = 0;
  for (const f of page.frames()) {
    visible += await f.evaluate(() => [...document.querySelectorAll('.hl-ext-widget')]
      .filter((w) => w.style.display === 'flex').length).catch(() => 0);
  }
  eq(visible, 1, 'one widget');
});

// ---------- run ----------
let failed = 0;
try {
  for (const t of tests) {
    try {
      // A regression must fail, not hang the suite
      await Promise.race([t.fn(), sleep(TEST_TIMEOUT_MS).then(() => { throw new Error(`timed out after ${TEST_TIMEOUT_MS / 1000}s`); })]);
      console.log(`✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`✗ ${t.name}\n    ${e.message}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
