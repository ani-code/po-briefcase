// npm test — the full regression suite. Run before every commit.
//   1. unit       test.html: logic against the real content.js (mock chrome.storage)
//   2. local      real Chrome + real file:// fixtures: highlight → reload → restored
//   3. extension  REAL extension in Chrome for Testing: top page, OneDrive-style
//                 sandboxed srcdoc viewer, ad frames, panel, cross-page navigation
// Plus a static guard that the extension makes no network calls.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

// Static guard: extension code must never talk to the network
const NETWORK_RE = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/;
const offenders = ['content.js', 'background.js'].filter((f) => NETWORK_RE.test(readFileSync(join(ROOT, f), 'utf8')));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const hostPerms = manifest.host_permissions || [];
const guardOk = offenders.length === 0 && hostPerms.length === 0;
console.log(`\n=== no-network guard\n${guardOk ? '✓ no network APIs, no host_permissions'
  : `✗ network API in: ${offenders.join(', ') || '-'}; host_permissions: ${JSON.stringify(hostPerms)}`}`);
results.push(['no-network guard', guardOk]);

for (const [name, script] of [['unit', 'unit.mjs'], ['local files', 'local-files.mjs'], ['extension', 'extension.mjs']]) {
  console.log(`\n=== ${name}`);
  const r = spawnSync(process.execPath, [join(ROOT, 'e2e', script)], { stdio: 'inherit', cwd: ROOT });
  results.push([name, r.status === 0]);
}

console.log('\n=== summary');
results.forEach(([name, ok]) => console.log(`${ok ? '✓' : '✗'} ${name}`));
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} suite(s) failed — do not commit` : '\nall suites passed');
process.exit(failed ? 1 : 0);
