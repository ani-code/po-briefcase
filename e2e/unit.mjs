// Runs test.html (in-browser unit tests against the real content.js) in headless
// Chrome for Testing and reports the results.
//
//   npm run test:unit
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await puppeteer.launch({ headless: true });
let failed = 1;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(ROOT, 'test.html')).href);
  await page.waitForSelector('body[data-result]', { timeout: 60000 });
  const { summary, rows } = await page.evaluate(() => ({
    summary: document.getElementById('summary').textContent,
    rows: [...document.querySelectorAll('#results li')].map((li) => li.textContent),
  }));
  rows.forEach((r) => console.log(r));
  const [passed, total] = summary.split(' ')[0].split('/').map(Number);
  failed = total - passed;
  console.log(failed ? `\n${failed} of ${total} failed` : `\nall ${total} passed`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
