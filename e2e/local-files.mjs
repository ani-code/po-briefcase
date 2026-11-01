// End-to-end check: highlight + comment on real local files survive a reload.
//
//   node e2e/local-files.mjs          (from the repo root; needs Node 22+ and Google Chrome)
//
// Real Chrome renders each fixture from file://, the real content.js runs in the page, a
// highlight is saved, the page is reloaded, and we check it came back with its comment.
// chrome.* is a stand-in (storage backed by localStorage so it survives the reload) because
// branded Chrome refuses --load-extension, so an unpacked extension can't be loaded headlessly.
// Talks only to Chrome's local DevTools port — nothing leaves the machine.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'e2e', 'fixtures');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

// [file, phrase to highlight, expect Po to run?]
const CASES = [
  ['explainer.html', 'matching the saved text', true],
  ['doc one.md', 'partial transcripts', true],
  ['notes.txt', 'phrase to highlight', true],
  ['data.json', 'json phrase', true],
  ['data.xml', 'xml phrase', false], // Chrome's XML viewer — Po must stay out, not crash
  ['pic.svg', 'svg phrase', false],
];

const contentJs = readFileSync(join(ROOT, 'content.js'), 'utf8');
const inject = `
  window.chrome = { runtime: { id: 'e2e', lastError: undefined, getURL: p => p,
      onMessage: { addListener() {} }, sendMessage: () => Promise.resolve({ ok: true }) },
    storage: { onChanged: { addListener() {} }, local: {
      get(d, cb) { const s = JSON.parse(localStorage.getItem('__po') || '{}'); const o = {};
        for (const [k, v] of Object.entries(d)) o[k] = k in s ? s[k] : v; setTimeout(() => cb(o)); },
      set(o, cb) { const s = JSON.parse(localStorage.getItem('__po') || '{}'); Object.assign(s, o);
        localStorage.setItem('__po', JSON.stringify(s)); setTimeout(() => cb && cb()); } } } };
  (() => {
    // Run at DOMContentLoaded, like a content script at document_end
    const run = () => { try { const el = document.createElementNS('http://www.w3.org/1999/xhtml', 'script');
      el.textContent = ${JSON.stringify(contentJs)}; (document.head || document.documentElement).appendChild(el); }
      catch (e) { window.__poError = String(e); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();
  })();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'po-e2e-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

let failures = 0;
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); }
  }
  if (!targets) throw new Error('Chrome DevTools port never came up');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { exception: r.result.exceptionDetails.exception?.description };
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: inject });

  for (const [file, phrase, shouldRun] of CASES) {
    await send('Page.navigate', { url: pathToFileURL(join(FIXTURES, file)).href });
    await sleep(2000);
    const save = await evaluate(`(async () => {
      if (window.__poError) return { exception: window.__poError };
      if (!isSupportedDocument(document)) return { skipped: true, poUi: !!document.getElementById('hl-ext-root') };
      localStorage.removeItem('__po');
      currentRange = findRangeInTextNodes(getTextNodes(document.body), ${JSON.stringify(phrase)});
      if (!currentRange) return { exception: 'phrase not found' };
      ensureUiMounted();
      commentPopup.innerHTML = '<textarea id="hl-comment-input"></textarea>';
      commentPopup.querySelector('#hl-comment-input').value = 'e2e comment';
      await saveCurrentHighlight();
      return { saved: (await getAllHighlights()).length };
    })()`);

    let ok;
    let detail;
    if (!shouldRun) {
      ok = save?.skipped === true && save.poUi === false;
      detail = ok ? 'Po stayed out (no UI injected, no error)' : JSON.stringify(save);
    } else if (save?.saved !== 1) {
      ok = false;
      detail = `save failed: ${JSON.stringify(save)}`;
    } else {
      await send('Page.reload');
      await sleep(3000); // load + 800ms restore delay + margin
      const after = await evaluate(`(async () => {
        const all = await getAllHighlights();
        const spans = spansFor(all[0]?.id);
        return { text: spans.map((s) => s.textContent).join(''), comment: spans[0]?.title };
      })()`);
      ok = after?.text === phrase && after?.comment === 'e2e comment';
      detail = ok ? 'restored after reload with comment' : `after reload: ${JSON.stringify(after)}`;
    }
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${file.padEnd(16)} ${detail}`);
  }
  ws.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : `\nall ${CASES.length} passed`);
process.exit(failures ? 1 : 0);
