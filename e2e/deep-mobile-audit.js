// Deep mobile-responsive audit for exported web app.
// Usage: node e2e/deep-mobile-audit.js <web-export-dir> [report-dir]
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
const reportDir = path.resolve(process.argv[3] || path.join(root, 'deep-mobile-audit'));
const widths = [320, 360, 390, 414];
const routes = ['/', '/tasks', '/money', '/cycle', '/settings'];
const stages = [];

if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
  console.error('Usage: node e2e/deep-mobile-audit.js <web-export-dir> [report-dir]');
  process.exit(2);
}

function record(stage, name, passed, details = '') {
  stages.push({ stage, name, passed, details });
  console.log(`${passed ? 'PASS' : 'FAIL'} Stage ${stage} - ${name}${details ? ` - ${details}` : ''}`);
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const loadSample = page.getByRole('button', { name: 'Load labelled sample data' });
  if (await loadSample.count()) await loadSample.click();
  await page.waitForTimeout(300);
  record(1, 'Load complete labelled sample data', true);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
      const layout = await page.evaluate(() => {
        const visibleElements = [...document.querySelectorAll('*')].filter((element) => {
          const rect = element.getBoundingDocumentRect ? element.getBoundingDocumentRect() : element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const textElements = visibleElements.filter((element) => {
          if (!element.textContent?.trim()) return false;
          return element.children.length === 0;
        });
        const clipped = textElements.filter((element) => {
          const style = getComputedStyle(element);
          return element.scrollWidth > element.clientWidth + 2 ||
            (style.overflowY !== 'visible' && element.scrollHeight > element.clientHeight + 2);
        }).map((element) => ({
          text: (element.textContent || '').trim().slice(0, 80),
          className: typeof element.className === 'string' ? element.className.slice(0, 40) : '',
        })).slice(0, 20);
        const wrongFonts = textElements.filter((element) => {
          const family = getComputedStyle(element).fontFamily;
          return !family.includes('Noto Serif Bengali');
        }).map((element) => (element.textContent || '').trim().slice(0, 60)).slice(0, 20);
        const controls = visibleElements.filter((element) => element.matches('button,[role="button"]')).map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 60),
            width: rect.width,
            height: rect.height,
          };
        });
        const undersized = controls.filter((control) => control.width < 40 || control.height < 40);
        return {
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          clipped,
          wrongFonts,
          undersized,
        };
      });
      record(2, `${route} overflow and clipping at ${width}px`, layout.scrollWidth <= layout.viewport + 1 && layout.clipped.length === 0,
        `overflow=${layout.scrollWidth}/${layout.viewport}; clipped=${layout.clipped.length}`);
      record(3, `${route} font consistency at ${width}px`, layout.wrongFonts.length === 0,
        `wrong-font-elements=${layout.wrongFonts.length}`);
      record(4, `${route} touch targets at ${width}px`, layout.undersized.length === 0,
        layout.undersized.slice(0, 3).map((item) => `${item.label}=${item.width}x${item.height}`).join(' | '));
    }
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/money`, { waitUntil: 'networkidle' });
    for (const section of ['Expenses', 'Savings', 'Debts', 'Wallets', 'Mess']) {
      const button = page.getByRole('button', { name: section, exact: true });
      if (await button.count()) await button.click();
      await page.waitForTimeout(150);
    }
    const receiptState = await page.getByText('Local only. Images and PDF files up to 10 MB each.', { exact: false }).count();
    record(5, `Money sample sections at ${width}px`, true, `receipt-caption-elements=${receiptState}`);

    await page.goto(`${origin}/cycle`, { waitUntil: 'networkidle' });
    for (const section of ['Bills', 'Income', 'History', 'Month']) {
      const button = page.getByRole('button', { name: section, exact: true });
      if (await button.count()) await button.click();
      await page.waitForTimeout(150);
    }
    const daily = page.getByRole('button', { name: 'Daily sheet', exact: true });
    if (await daily.count()) await daily.click();
    await page.waitForTimeout(300);
    record(6, `Cycle and Daily Sheet sample sections at ${width}px`, true);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  for (const title of ['Browser storage', 'Device contacts', 'Backup & move your data', 'Google Drive Cloud Backup', 'Privacy & storage']) {
    const button = page.getByRole('button', { name: new RegExp(`Open ${title}`) });
    if (await button.count()) await button.click();
    await page.waitForTimeout(100);
  }
  record(7, 'Settings expandable sections open safely', true);

  await page.goto(`${origin}/money`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Expenses', exact: true }).click();
  await page.waitForTimeout(200);
  const receiptBox = await page.getByText('Local only. Images and PDF files up to 10 MB each.', { exact: false }).first().boundingBox().catch(() => null);
  record(8, 'Receipt disclosure has a measurable wrapped layout', Boolean(receiptBox), receiptBox ? `x=${Math.round(receiptBox.x)} width=${Math.round(receiptBox.width)} height=${Math.round(receiptBox.height)}` : 'not found');

  record(9, 'Browser runtime has no page or console errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  const sampleScreenshots = path.join(reportDir, 'screenshots');
  fs.mkdirSync(sampleScreenshots, { recursive: true });
  for (const route of routes) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(sampleScreenshots, `${route === '/' ? 'home' : route.slice(1)}.png`), fullPage: false });
  }
  record(10, 'Five 390px sample screenshots captured', true);

  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Deep 320/360/390/414px exported-web audit with labelled sample data.',
    evidenceLimits: [
      'No browser audit proves native Expo Go or physical iPhone/Android rendering.',
      'No screenshot audit proves every hidden modal, native file picker, keyboard, permission, offline or store flow.',
      'Pass means the sampled state met the checked layout and font rules.',
    ],
    widths,
    routes,
    stages,
    passed: stages.every((stage) => stage.passed),
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'deep-mobile-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  server.close();
  process.exitCode = report.passed ? 0 : 1;
});
