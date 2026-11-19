// Regression check for D-10: a stale tab must not silently overwrite newer data.
// Usage: PLAYWRIGHT_PATH=<playwright> CHROMIUM_PATH=<chromium> node e2e/repro-d10-two-tabs.js <exported-web-dir>
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
const srv = http.createServer((q, r) => { let f = path.join(root, q.url.split('?')[0]); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html'); r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const origin = `http://localhost:${srv.address().port}`;
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });   // same context = same origin storage, like two browser tabs
  const A = await ctx.newPage(), B = await ctx.newPage();
  await A.goto(origin); await B.goto(origin);
  await A.getByText('Quick command').waitFor(); await B.getByText('Quick command').waitFor();
  const add = async (p, title) => { await p.getByRole('tab', { name: /Tasks/ }).click(); await p.getByRole('button', { name: '＋ New' }).click(); await p.getByLabel('Title').fill(title); await p.getByRole('button', { name: 'Save', exact: true }).click(); await p.getByText(title).first().waitFor(); };
  await add(A, 'Sample task from TAB A');
  await A.waitForFunction(() => {
    const raw = localStorage.getItem('aio.data');
    return raw !== null && JSON.parse(raw).tasks.some(task => task.title === 'Sample task from TAB A');
  });
  await add(B, 'Sample task from TAB B');
  await B.getByRole('alert').getByText(/Data changed in another tab/).waitFor();
  const titles = await A.evaluate(() => JSON.parse(localStorage.getItem('aio.data')).tasks.map(t => t.title));
  const firstWriteSurvived = titles.length === 1 && titles[0] === 'Sample task from TAB A';
  console.log(firstWriteSurvived ? 'PASS: stale tab did not overwrite the persisted task' : 'FAIL: unexpected persisted tasks', JSON.stringify(titles));
  console.log('PASS: stale tab displayed a save-conflict warning');
  console.log('LIMIT: the stale tab task was not merged or persisted and can be lost on reload');
  process.exitCode = firstWriteSurvived ? 0 : 1;
  await b.close(); srv.close();
});
