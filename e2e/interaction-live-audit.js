// Safe interaction audit for the exported web app.
// Usage: node e2e/interaction-live-audit.js <web-export-dir> [report-dir]
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
const reportDir = path.resolve(process.argv[3] || path.join(root, 'interaction-audit'));
const widths = [320, 390, 414, 768, 1024, 1280];
const results = [];

if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
  console.error('Usage: node e2e/interaction-live-audit.js <web-export-dir> [report-dir]');
  process.exit(2);
}

function record(name, status, details = '') {
  results.push({ name, status, details });
  console.log(`${status.toUpperCase()} ${name}${details ? ` - ${details}` : ''}`);
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
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  async function open(route) {
    browserErrors.length = 0;
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1,h2,[role="heading"]', { state: 'visible', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }

  async function step(name, action) {
    try {
      await action();
      record(name, 'passed');
    } catch (error) {
      record(name, 'failed', error.message);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await open('/');
  await step('Home loads labelled sample data safely', async () => {
    await page.getByRole('button', { name: 'Load sample data' }).click();
    await page.getByText('You are viewing sample data.', { exact: false }).waitFor();
  });

  for (const tab of ['Tasks', 'Money', 'Cycle', 'Settings']) {
    await step(`Navigate to ${tab}`, async () => {
      await page.getByRole('tab', { name: new RegExp(tab) }).click();
      await page.waitForTimeout(200);
      if (!(await page.locator('body').innerText()).includes(tab === 'Cycle' ? 'Money Cycle' : tab)) {
        throw new Error(`Expected ${tab} content was not rendered`);
      }
    });
  }

  await open('/money');
  for (const section of ['Expenses', 'Savings', 'Debts', 'Wallets', 'Mess']) {
    await step(`Open Money section - ${section}`, async () => {
      await page.getByRole('button', { name: section, exact: true }).click();
      await page.waitForTimeout(150);
    });
  }

  await step('Create a wallet', async () => {
    await page.getByRole('button', { name: 'Wallets', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '＋ Add wallet' }).click();
    await page.getByLabel('Wallet name').fill('Audit Wallet');
    await page.getByLabel(/Opening balance/).fill('1000');
    await page.getByRole('button', { name: 'Create wallet' }).click();
    await page.getByText('Audit Wallet', { exact: true }).waitFor();
  });

  await step('Add a manual wallet entry', async () => {
    await page.getByRole('button', { name: '＋ Add funds or withdrawal' }).click();
    await page.getByLabel(/Amount -/).fill('125');
    await page.getByLabel('Note - optional').fill('Audit entry');
    await page.getByRole('button', { name: 'Save entry' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Audit entry'));
  });

  await step('Transfer between wallets', async () => {
    await page.getByRole('button', { name: '＋ Transfer' }).click();
    await page.getByLabel(/Amount -/).fill('50');
    await page.getByLabel('Note - optional').fill('Audit transfer');
    await page.getByRole('button', { name: 'Save transfer' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Audit transfer'));
  });

  await open('/cycle');
  for (const section of ['Bills', 'Income', 'History', 'Month']) {
    await step(`Open Cycle section - ${section}`, async () => {
      await page.getByRole('button', { name: section, exact: true }).click();
      await page.waitForTimeout(150);
    });
  }
  await step('Open Daily sheet mode', async () => {
    await page.getByRole('button', { name: 'Daily sheet', exact: true }).click();
    await page.getByText('Daily expense sheet', { exact: false }).waitFor();
  });

  await open('/settings');
  await step('Change and restore theme preference', async () => {
    await page.getByRole('button', { name: 'dark', exact: true }).click();
    await page.getByRole('button', { name: 'system', exact: true }).click();
  });

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/', '/tasks', '/money', '/cycle', '/settings']) {
      await open(route);
      const layout = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      const passed = layout.scrollWidth <= layout.viewport + 1;
      record(`Responsive layout - ${route} at ${width}px`, passed ? 'passed' : 'failed', `${layout.viewport}/${layout.scrollWidth}`);
    }
  }

  record('Browser error summary', browserErrors.length === 0 ? 'passed' : 'failed', browserErrors.slice(0, 3).join(' | '));
  record('Native iPhone and Android rendering', 'unimplemented', 'Requires physical devices or release builds');
  record('Offline cold start', 'unimplemented', 'No service worker and native offline run requires a device');
  record('Native file sharing and keyboard behavior', 'unimplemented', 'Requires native device evidence');

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Safe web interaction workflows and responsive widths on an isolated browser origin.',
    evidenceLimits: [
      'This audit does not prove native iPhone or Android rendering.',
      'This audit does not prove release builds or offline cold start.',
      'Created audit records are isolated to this browser context and are never user data.',
    ],
    widths,
    results,
    passed: results.every((result) => result.status !== 'failed'),
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'interaction-live-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  server.close();
  process.exitCode = report.passed ? 0 : 1;
});
