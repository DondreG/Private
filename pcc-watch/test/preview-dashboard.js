// Renders Dashboard.html in Chromium with made-up PCC activity (Mon 11/2 to
// Wed 11/4 afternoon), using the real Code.gs and dashboardData() against
// the fake sheets, and saves screenshots. No real data is involved.
//
//   node pcc-watch/test/preview-dashboard.js [outDir]
'use strict';

const fs = require('fs');
const path = require('path');
const F = require('./fixtures');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, 'preview'));
fs.mkdirSync(outDir, { recursive: true });

const w = F.buildWorld();
const { gas, P } = w;
const { d } = F;

const people = [];
for (let i = 0; i < 40; i++) people.push(F.patient('Sample' + String.fromCharCode(65 + (i % 26)) + i, 'Testcase' + i));
let next = 0;
const at = (day, h, m) => { gas.now = d(2026, 11, day, h, m); };
const check = (day, h, m) => F.run(w, d(2026, 11, day, h, m));

function nps(day, h, m, tab, takenBy, extra) {
  at(day, h, m);
  F.appendNps(gas, w.nov, tab, Object.assign({ date: d(2026, 11, day), takenBy, p: people[next++] }, extra || {}));
}
function ulAdd(day, h, m, ss, tab, fields) {
  at(day, h, m);
  const sheet = ss.getSheetByName(tab);
  const row = F.findRow(sheet, (r) => r[0] === '' && r[9] === false);
  F.ulRow(Object.assign({ name: people[next++].full, ie: true, rxEnd: '', pocEnd: '' }, fields || {}))
    .forEach((v, j) => sheet.set(row, j + 1, v));
  gas.touch(ss.id);
}
function ulSet(day, h, m, ss, tab, name, col, value) {
  at(day, h, m);
  F.setCell(gas, ss, tab, (r) => r[0] === name, col, value);
}

F.run(w, d(2026, 11, 2, 7, 5), true);

// Monday
nps(2, 9, 10, 'TR', 'Mariela', { ie: d(2026, 11, 5) });
check(2, 9, 15);
ulSet(2, 10, 20, w.ulTr, '11.9.26', P.jo.lastFirst, 4, 1);
check(2, 10, 30);
nps(2, 10, 40, 'BR', 'Damian', { ie: d(2026, 11, 6) });
check(2, 10, 45);
nps(2, 13, 20, 'MET', 'Kim');
check(2, 13, 30);
ulAdd(2, 14, 5, w.ulEw, '11.9.26');
check(2, 14, 15);

// Tuesday
nps(3, 9, 5, 'EW', 'Emily', { ie: d(2026, 11, 9) });
nps(3, 9, 8, 'EW', 'emily/josh', { status: 'Pending' });
check(3, 9, 15);
ulAdd(3, 11, 0, w.ulMet, '11.9.26', { sched: 2 });
check(3, 11, 15);
nps(3, 12, 40, 'SMST', 'Somerset', { ie: d(2026, 11, 10) });
check(3, 12, 45);
ulSet(3, 15, 10, w.ulBrick, '11.9.26', P.hal.lastFirst, 4, 3);
check(3, 15, 15);

// Wednesday (today)
check(4, 7, 50);
nps(4, 8, 25, 'TR', 'Mariela', { ie: d(2026, 11, 9) });
check(4, 8, 30);
ulSet(4, 8, 40, w.ulTr, '11.9.26', P.jo.lastFirst, 4, 2);
ulSet(4, 8, 42, w.ulTr, '11.9.26', P.ivy.lastFirst, 6, '11/3 lm [MARI]\n11/4 sched IE f/u [MARI]');
check(4, 8, 45);
at(4, 9, 5);
F.setCell(gas, w.hud, 'Brick', (r) => r[2] === P.oz.acct && r[0] === 'Brick', 10, 'yes');
check(4, 9, 15);
nps(4, 9, 25, 'EW', 'Emily', { status: 'Pending' });
ulAdd(4, 9, 40, w.ulBrick, '11.9.26');
check(4, 9, 45);
at(4, 10, 10);
F.setCell(gas, w.pr, 'East Windsor', (r) => r[2] === P.rae.acct, 15, 'Yes - Full');
check(4, 10, 15);
nps(4, 10, 35, 'MET', 'Brandon', { ie: d(2026, 11, 11) });
check(4, 10, 45);
nps(4, 11, 2, 'SMST', 'Somerset');
check(4, 11, 15);
ulSet(4, 11, 25, w.ulMet, '11.9.26', P.lu.lastFirst, 9, 'Work');
ulSet(4, 11, 27, w.ulMet, '11.9.26', P.mo.lastFirst, 4, 2);
check(4, 11, 30);
at(4, 12, 5);
F.setCell(gas, w.nov, 'EW', (r) => r[3] === people[next - 4].full, 10, d(2026, 11, 12));
check(4, 12, 15);
ulAdd(4, 12, 50, w.ulTr, '11.9.26', { sched: 1 });
check(4, 13, 0);
at(4, 13, 35);
F.setCell(gas, w.hud, 'Brick', (r) => r[2] === P.pip.acct && r[0] === 'Brick', 10, 'no');
check(4, 13, 45);
nps(4, 14, 5, 'TR', 'Mariela', { ie: d(2026, 11, 10) });
at(4, 14, 10);
F.setCell(gas, w.pr, 'Toms River', (r) => r[2] === P.sol.acct, 15, 'Yes - Full');
check(4, 14, 15);
ulAdd(4, 14, 20, w.ulEw, '11.9.26', { sched: 2 });
check(4, 14, 30);

const now = d(2026, 11, 4, 14, 32);
const DATA = { 1: w.code.dashboardData(now, 1), 7: w.code.dashboardData(now, 7), 30: w.code.dashboardData(now, 30) };

const text = JSON.stringify(DATA).toLowerCase();
const leaks = F.SENSITIVE.filter((s) => text.indexOf(String(s).toLowerCase()) !== -1);
if (leaks.length) throw new Error('Preview data contains patient identifiers: ' + leaks.slice(0, 5).join(', '));
fs.writeFileSync(path.join(outDir, 'sample-data.json'), JSON.stringify(DATA, null, 1));

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const html = fs.readFileSync(path.join(__dirname, '..', 'Dashboard.html'), 'utf8');
  const shots = [];
  const errors = [];

  async function shoot(name, opts, after) {
    const page = await browser.newPage({ viewport: opts.viewport, colorScheme: opts.scheme || 'light' });
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    const hook = '<script>window.PCC_PREVIEW_DATA = function (days) { return ' +
      JSON.stringify(DATA).replace(/</g, '\\u003c') + '[days]; };</script>\n<script>';
    await page.setContent(html.replace('<script>', hook), { waitUntil: 'load' });
    await page.waitForSelector('#feed tr');
    if (after) await after(page);
    const file = path.join(outDir, name + '.png');
    await page.screenshot({ path: file, fullPage: opts.fullPage !== false });
    shots.push(file);
    await page.close();
  }

  await shoot('dashboard-today', { viewport: { width: 1280, height: 900 } });
  await shoot('dashboard-7-days', { viewport: { width: 1280, height: 900 } }, async (page) => {
    await page.click('#range button[data-days="7"]');
    await page.waitForTimeout(100);
  });
  await shoot('dashboard-dark', { viewport: { width: 1280, height: 900 }, scheme: 'dark' });
  await shoot('dashboard-phone', { viewport: { width: 390, height: 844 } });
  await shoot('dashboard-hover', { viewport: { width: 1280, height: 900 }, fullPage: false }, async (page) => {
    const hits = await page.$$('#activityChart .hit');
    await hits[3].hover();
  });
  await browser.close();
  if (errors.length) throw new Error('Page errors:\n' + errors.join('\n'));
  console.log(shots.join('\n'));
})().catch((e) => { console.error(e); process.exit(1); });
