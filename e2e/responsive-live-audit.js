// Responsive live audit for the exported web app.
// Usage: node e2e/responsive-live-audit.js <web-export-dir> [report-dir]
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
const reportDir = path.resolve(process.argv[3] || path.join(root, 'responsive-audit'));
const widths = [320, 360, 390, 414, 768, 1024, 1280];
const routes = ['/', '/tasks', '/money', '/cycle', '/settings'];
const results = [];

if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
  console.error('Usage: node e2e/responsive-live-audit.js <web-export-dir> [report-dir]');
  process.exit(2);
}

function record(name, passed, details = '') {
  results.push({ name, passed, details });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${details ? ` - ${details}` : ''}`);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

const server = http.createServer((request, response) => {
  let file = path.join(root, decodeURIComponent((request.url || '/').split('?')[0]));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  response.writeHead(200, { 'content-type': contentType(file) });
  fs.createReadStream(file).pipe(response);
});

server.listen(0, async () => {
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      errors.length = 0;
      await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1,h2,[role="heading"]', { state: 'visible', timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.getBoundingClientRect().width,
        hasHeading: Boolean(document.querySelector('[role="heading"], h1, h2')),
      }));
      const controls = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')]
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { label: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 60), width: rect.width, height: rect.height };
        }));
      record(
        `${route} at ${width}px has no horizontal overflow`,
        layout.scrollWidth <= layout.viewport + 1,
        `viewport=${layout.viewport} scrollWidth=${layout.scrollWidth}`,
      );
      record(`${route} at ${width}px renders a heading`, layout.hasHeading);
      const undersized = controls.filter((control) => control.width < 40 || control.height < 40);
      record(`${route} at ${width}px controls meet 40px visual target`, undersized.length === 0, undersized.slice(0, 3).map((control) => `${control.label}=${control.width}x${control.height}`).join(' | '));
      record(`${route} at ${width}px has no browser errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    }

    await page.goto(`${origin}/money`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1,h2,[role="heading"]', { state: 'visible', timeout: 5000 }).catch(() => {});
    await page.getByText('Expenses', { exact: true }).click();
    await page.getByText('Savings', { exact: true }).click();
    await page.getByText('Debts', { exact: true }).click();
    await page.getByText('Wallets', { exact: true }).click();
    await page.getByText('Mess', { exact: true }).click();
    record(`Money sections respond at ${width}px`, true);

    await page.goto(`${origin}/cycle`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1,h2,[role="heading"]', { state: 'visible', timeout: 5000 }).catch(() => {});
    for (const label of ['Bills', 'Income', 'History', 'Month']) {
      await page.getByText(label, { exact: true }).click();
    }
    await page.getByText('Daily sheet', { exact: true }).click();
    record(`Cycle sections respond at ${width}px`, true);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Exported web app routes and responsive widths from 320px through 1280px.',
    evidenceLimits: [
      'This audit does not prove native iPhone or Android rendering.',
      'This audit does not prove release builds or offline cold start.',
      'Interaction checks avoid destructive actions and do not replace feature-specific tests.',
    ],
    widths,
    routes,
    results,
    passed: results.every((result) => result.passed),
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'responsive-live-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  server.close();
  process.exitCode = report.passed ? 0 : 1;
});
