// Keep the Chrome for Testing download inside this folder (git-ignored), not ~/.cache.
const { join } = require('path');
module.exports = { cacheDirectory: join(__dirname, '.cache', 'puppeteer') };
