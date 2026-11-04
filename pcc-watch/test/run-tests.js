// End-to-end tests for PCC Watch against made-up sheets shaped like the real
// NPS, UL, PCC Daily Huddle and Patient Responsibility files.
//
//   node pcc-watch/test/run-tests.js
//
// Every patient below is invented. The privacy check at the end fails if any
// of their names, account numbers, phones or DOBs reach the state file, the
// PCC Watch sheet, an email or the log.
'use strict';

process.env.TZ = 'America/New_York';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const EXPORTS = ['CONFIG', 'setup', 'runWatchAt', 'runWatch', 'resetSnapshots', 'getOutputSpreadsheet',
  'ensureTabs', 'getSecret', 'loadState', 'installTrigger', 'removeTriggers', 'signatureTags',
  'normalizeName', 'attributeTakenBy', 'parseUlTabDate', 'npsMonths', 'mondayOf', 'loadRoster', 'reasonWord'];

/** Loads Code.gs with the fake services as its globals (same realm, so instanceof Date works). */
function loadCode(gas) {
  const names = Object.keys(gas.context);
  const factory = new Function(...names, CODE + '\nreturn {' + EXPORTS.join(',') + '};');
  return factory(...names.map((n) => gas.context[n]));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SENSITIVE = [];
let seq = 0;
function patient(first, last) {
  seq++;
  const p = {
    first, last,
    full: first + ' ' + last,
    lastFirst: last + ', ' + first,
    acct: '99' + String(10000 + seq) + '-TAB',
    phone: '555' + String(1000000 + seq),
    dob: '1970-01-' + String(10 + (seq % 18)).padStart(2, '0'),
  };
  SENSITIVE.push(p.full, p.lastFirst, p.acct, p.phone, p.dob, last);
  return p;
}
const d = (y, m, day, h, min) => new Date(y, m - 1, day, h || 0, min || 0);

const NPS_HEADER = ['Date', 'Taken By', 'Email?', 'Patient Name', 'Referral Source', 'Diagnosis', 'Town',
  'Primary Insurance', 'Secondary Insurance', 'FS/IE Date', 'Days to FS/IE', 'Notes', 'Status', 'Inactive Reason'];

function npsTab(ss, tab, title, rows) {
  const data = [['leftover scratch'], [title, '', '', 'TOTAL CALLS'], ['', '', '', rows.length], [], [], NPS_HEADER.slice()];
  rows.forEach((r) => data.push(npsRow(r)));
  for (let i = 0; i < 15; i++) data.push(['', '', false]);
  return ss.addSheet(tab, data);
}
function npsRow(r) {
  return [r.date, r.takenBy, false, r.p.full, 'Google Search', 'Knee', 'Brick', 'BCBS', '', '', '',
    r.notes || '', 'Active', ''];
}
function appendNps(gas, ss, tab, r) {
  const sheet = ss.getSheetByName(tab);
  let row = 7;
  while (sheet.data[row - 1] && sheet.data[row - 1][3]) row++;
  npsRow(r).forEach((v, j) => sheet.set(row, j + 1, v));
  gas.touch(ss.id);
  return row;
}
function findRow(sheet, test) {
  return sheet.data.findIndex((r) => r && test(r)) + 1;
}

const UL_HEADER = ['PATIENT NAME', 'INSURANCE', 'RX FREQ', '# SCHED', 'STATUS', 'PATIENT CARE NOTES', 'RX END',
  'POC END DATE', 'REASON NOT SCHEDULED', 'IE', 'DC', 'Auth', 'Auth Start Date', 'Auth App Visits'];
function ulRow(u) {
  return [u.name, 'BCBS', u.freq || 2, u.sched || 0, 'NOT SCHEDULED', u.note || '', u.rxEnd || d(2026, 12, 1),
    u.pocEnd || d(2026, 12, 15), u.reason || '', !!u.ie, false, false, '', false];
}
function ulTab(ss, name, clinic, rows) {
  const data = [['TRINITY REHAB — ' + clinic.toUpperCase()], ['Week of ' + name], [],
    ['TOTAL ACTIVE', 'FULLY SCHEDULED', '', 'UNDERSCHEDULED'], [rows.length, '1 (10%)'], ['LEAKAGE'], [0.2], [],
    ['⚠ Staff: only edit columns D (# Sched), F (Notes), and I (Reason Not Scheduled)'], [], UL_HEADER.slice()];
  rows.forEach((u) => data.push(ulRow(u)));
  for (let i = 0; i < 6; i++) data.push(['', '', '', '', '', '', '', '', '', false, false, false]);
  return ss.addSheet(name, data);
}

const PAY_HEADER = ['Time', 'Patient', 'Account #', 'Mobile', 'New', 'Visit Type', 'Owes at Check-In', 'Balance Owed',
  'Balance From', 'Total to Collect', 'Patient Responsibility', 'Benefits', 'Primary Payer', 'Collected?', 'Notes'];
const BOOK_HEADER = ['Clinic', 'Patient', 'Account #', 'Phone', 'DOB', 'Wed 11/4 Time', 'Visit Type', 'Case', 'Action',
  'Booked? (PCC)', 'Notes'];

function huddle(gas, id, dateLabel, perClinic) {
  const ss = gas.addSpreadsheet(id, 'PCC Daily Huddle (live)');
  const summary = [['PCC Daily Huddle - ' + dateLabel], ['Use today\'s visit ... Refreshed automatically.'], [],
    ['Clinic', 'Wed Visits', 'Nothing Booked Wk of 11/9', '% of Visits', 'New Pt (IE)', 'Still Unbooked from Last List',
      'Patients to Collect Today', '$ to Collect Today']];
  const all = [BOOK_HEADER.slice()];
  Object.keys(perClinic).forEach((clinic) => {
    const c = perClinic[clinic];
    summary.push([clinic, 40, c.book.length, c.book.length / 40, 2, 1, c.pay.length,
      c.pay.reduce((s, x) => s + x.total, 0)]);
    const rows = [[clinic + ' - NOTHING BOOKED WEEK OF 11/9'], ['Book these patients at today\'s visit.'], [],
      BOOK_HEADER.slice()];
    c.book.forEach((b) => {
      const r = [clinic, b.p.lastFirst, b.p.acct, b.p.phone, b.p.dob, '09:20', 'PT TX', 'Knee',
        'Rebook for week of 11/9', b.mark || '', ''];
      rows.push(r);
      all.push(r.slice());
    });
    rows.push([], [], [clinic + ' - PATIENTS WHO NEED TO PAY TODAY (Wed 11/4)'], ['Collect at check-in.'], [],
      PAY_HEADER.slice());
    c.pay.forEach((x) => rows.push([x.time, x.p.lastFirst, x.p.acct, x.p.phone, '', 'PT TX', x.total, 0,
      'Copay $' + x.total, x.total, 'Copay', 'Verified', 'BCBS', x.mark || '', '']));
    rows.push([c.pay.length + ' patients']);
    ss.addSheet(clinic, rows);
  });
  summary.push(['TOTAL', '378', '131']);
  const sum = ss.addSheet('Summary', summary);
  const allSheet = ss.addSheet('All PCC Clinics', all);
  ss.sheets = [sum, allSheet].concat(ss.sheets.filter((s) => s !== sum && s !== allSheet));
  return ss;
}

const PR_HEADER = ['Time', 'Patient', 'Account #', 'Mobile', 'New', 'Visit Type', 'Owes at Check-In', 'Balance Owed',
  'Balance From', 'Total to Collect', 'Patient Responsibility', 'Benefits', 'Primary Payer', 'Secondary Payer',
  'Collected?', 'Notes'];
function responsibility(gas, id, dateLabel, yLabel, perClinic) {
  const ss = gas.addSpreadsheet(id, 'Patient Responsibility by Clinic — TODAY (live)');
  const summary = [['Daily Patient Responsibility — ' + dateLabel], ['desc'], [],
    ['Clinic', 'New Pts Tomorrow', 'Tomorrow Owes ($)', 'Patients Today', 'Owes at Check-In Today ($)', 'Balances Today ($)',
      'Total to Collect Today ($)', 'Not Verified / No Payer', yLabel + ' Should Have Collected ($)', yLabel + ' Collected ($)',
      yLabel + ' % Collected', yLabel + ' Not Collected (pts)']];
  Object.keys(perClinic).forEach((clinic) => {
    const c = perClinic[clinic];
    const dollars = c.today.reduce((s, x) => s + x.total, 0);
    summary.push([clinic, c.tomorrow.length, 0, c.today.length, dollars, 0, dollars, 0, 200, 150, 0.75, 1]);
    const rows = [[clinic + ' — Patient Responsibility', '', '', '', '', 'Printed for ' + dateLabel], [],
      ['TOMORROW (Thu 11/05) — New Patients to Call Ahead'], PR_HEADER.slice()];
    if (!c.tomorrow.length) rows.push(['None']);
    c.tomorrow.forEach((x) => rows.push(prRow(x)));
    if (c.tomorrow.length) rows.push([c.tomorrow.length + ' patients']);
    rows.push([], ['TODAY (Wed 11/04) — Collect at Check-In'], PR_HEADER.slice());
    c.today.forEach((x) => rows.push(prRow(x)));
    rows.push([c.today.length + ' patients'], [], ['YESTERDAY (Tue 11/03) — What We Collected'],
      ['Time', 'Patient', 'Account #', 'Mobile', '', 'Visit Type', 'Owes at Check-In', 'Balance Owed', 'Result',
        'Should Have Collected', 'Collected', 'Still Owed', 'Primary Payer', 'Benefits', 'Clinic Marked', 'Clinic Notes'],
      ['8:00 AM', 'Old, Patient', '9900000-TAB', '5550000000', '', 'PT TX', 20, 0, 'Collected in full', 20, 20, 0, 'BCBS',
        'Verified', '', ''], ['1 patients · 1 in full']);
    ss.addSheet(clinic, rows);
  });
  summary.push(['TOTAL']);
  const sum = ss.addSheet('Summary', summary);
  ss.sheets = [sum].concat(ss.sheets.filter((s) => s !== sum));
  return ss;
}
function prRow(x) {
  return [x.time, x.p.lastFirst, x.p.acct, x.p.phone, x.isNew ? 'Yes' : '', 'PT TX', x.total, 0, '', x.total,
    'Copay', 'Verified', 'BCBS', '', x.mark || '', ''];
}
function setCell(gas, ss, tab, test, col, value) {
  const sheet = ss.getSheetByName(tab);
  const row = findRow(sheet, test);
  assert(row > 0, 'fixture row not found in ' + tab);
  sheet.set(row, col, value);
  gas.touch(ss.id);
  return row;
}

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------
let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
function buildWorld() {
  const gas = createGas();
  gas.now = d(2026, 11, 4, 7, 5);
  const code = loadCode(gas);
  code.CONFIG.UL_FILES = {
    'Brick': 'ul-brick', 'Toms River': 'ul-tr', 'Somerset': 'ul-smst', 'Metuchen': 'ul-met', 'East Windsor': 'ul-ew',
  };
  code.CONFIG.HUDDLE_ID = 'huddle';
  code.CONFIG.RESPONSIBILITY_ID = 'pr';

  const P = {};
  ['ada', 'bo', 'cy', 'di', 'ed', 'fay', 'gus', 'hal', 'ivy', 'jo', 'kai', 'lu', 'mo', 'ned', 'oz', 'pip', 'quin',
    'rae', 'sol', 'tam', 'uma', 'vic', 'wren', 'xan'].forEach((k, i) => {
    P[k] = patient(k.charAt(0).toUpperCase() + k.slice(1) + 'ette', 'Zqx' + ['alpha', 'bravo', 'charl', 'delt', 'echo',
      'foxt', 'golf', 'hotel', 'indi', 'julie', 'kilo', 'lima', 'mike', 'novem', 'oscar', 'papa', 'queb', 'romeo',
      'sierr', 'tango', 'unif', 'victr', 'whisk', 'xray'][i] + 'son');
  });

  // NPS: November (current) and October (still in its grace window on 11/4).
  const nov = gas.addSpreadsheet('nps-nov', 'November 2026 New Patient Spreadsheet');
  npsTab(nov, 'BR', 'BRICK', [{ date: d(2026, 11, 2), takenBy: 'Damian', p: P.ada }]);
  npsTab(nov, 'TR', 'TOMS RIVER', [{ date: d(2026, 11, 3), takenBy: 'Mariela ', p: P.bo }]);
  npsTab(nov, 'EW', 'EAST WINDS', [{ date: d(2026, 11, 3), takenBy: 'Lana', p: P.cy }]);
  npsTab(nov, 'SMST', 'SOMERSET', []);
  npsTab(nov, 'MET', 'METUCHEN', [{ date: d(2026, 11, 3), takenBy: 'Pia', p: P.di }]);
  npsTab(nov, 'CLRK', 'CLARK', []);
  nov.addSheet('CONSOLIDATED', [['TOTAL CALLS'], [], [], [], [], ['Clinic', 'Date', 'Taken By']]);
  const oct = gas.addSpreadsheet('nps-oct', 'October 2026 New Patient Spreadsheet');
  npsTab(oct, 'TR', 'TOMS RIVER', [{ date: d(2026, 10, 30), takenBy: 'Mariela', p: P.ed }]);
  gas.addSpreadsheet('nps-unrelated', 'November 2026 Budget');

  // ULs: last week (ignored), this week 11.2.26 and next week 11.9.26.
  const ulBrick = gas.addSpreadsheet('ul-brick', 'Trinity Rehab Brick UL 2026');
  ulTab(ulBrick, '10.26.26', 'Brick', [{ name: P.fay.lastFirst }]);
  ulTab(ulBrick, '11.2.26', 'Brick', [{ name: P.fay.lastFirst, sched: 2 }, { name: P.gus.full }]);
  ulTab(ulBrick, '11.9.26', 'Brick', [{ name: P.fay.lastFirst }, { name: P.gus.full, note: 'LVM 11/3' },
    { name: P.hal.lastFirst, sched: 2 }]);
  const ulTr = gas.addSpreadsheet('ul-tr', 'Trinity Rehab Toms River UL 2026');
  ulTab(ulTr, '11.9.26', 'Toms River', [{ name: P.ivy.lastFirst, note: '11/3 lm [MARI]' }, { name: P.jo.lastFirst }]);
  const ulSmst = gas.addSpreadsheet('ul-smst', 'Trinity Rehab Somerset UL 2026');
  ulTab(ulSmst, '11.9.26', 'Somerset', [{ name: P.kai.lastFirst }]);
  const ulMet = gas.addSpreadsheet('ul-met', 'Trinity Rehab Metuchen UL 2026');
  ulTab(ulMet, '11.9.26', 'Metuchen', [{ name: P.lu.lastFirst }, { name: P.mo.lastFirst }]);
  const ulEw = gas.addSpreadsheet('ul-ew', 'Trinity Rehab East Windsor UL 2026');
  ulTab(ulEw, '11.9.26', 'East Windsor', [{ name: P.ned.lastFirst }]);

  const hud = huddle(gas, 'huddle', 'Wed 11/04/2026', {
    'Brick': { book: [{ p: P.oz }, { p: P.pip }], pay: [{ time: '9:20 AM', p: P.oz, total: 25 }] },
    'East Windsor': { book: [{ p: P.quin }], pay: [{ time: '10:00 AM', p: P.rae, total: 40 }] },
    'Toms River': { book: [{ p: P.sol }], pay: [] },
  });
  const pr = responsibility(gas, 'pr', 'Wednesday 11/04/2026', '11/03', {
    'Brick': { tomorrow: [], today: [{ time: '9:20 AM', p: P.oz, total: 25 }] },
    'East Windsor': { tomorrow: [{ time: '8:40 AM', p: P.tam, total: 30, isNew: true }],
      today: [{ time: '10:00 AM', p: P.rae, total: 40 }] },
    'Toms River': { tomorrow: [], today: [{ time: '11:00 AM', p: P.sol, total: 15 }] },
  });
  return { gas, code, P, nov, oct, ulBrick, ulTr, ulSmst, ulMet, ulEw, hud, pr };
}

function run(w, when, force) {
  w.gas.now = when;
  w.code.runWatchAt(new Date(when), force ? { force: true } : {});
}
function output(w) { return w.code.getOutputSpreadsheet(); }
function activity(w) {
  const sheet = output(w).getSheetByName('Activity');
  return sheet.getDataRange().getValues().slice(1).filter((r) => r[0]);
}
function eventsSince(w, n) { return activity(w).slice(0, activity(w).length - n); }
function todayRow(w, clinic) {
  const vals = output(w).getSheetByName('Today').getDataRange().getValues();
  const hdr = vals[3];
  const row = vals.find((r) => r[0] === clinic);
  const o = {};
  hdr.forEach((h, i) => { o[h] = row ? row[i] : undefined; });
  return o;
}

console.log('PCC Watch tests');

console.log('\nUnit helpers');
{
  const w = buildWorld();
  const c = w.code;
  check('signature tags: [MARI], -BV, - AS, (PR 11/4)', () => {
    assert.deepStrictEqual(c.signatureTags('11/4 lm [MARI]'), ['MARI']);
    assert.deepStrictEqual(c.signatureTags('IE 11/10 sched -BV'), ['BV']);
    assert.deepStrictEqual(c.signatureTags('called pt - AS'), ['AS']);
    assert.deepStrictEqual(c.signatureTags('(PR 11/4) left vm'), ['PR']);
  });
  check('names: "Last, First" and "First Last" normalize the same', () => {
    assert.strictEqual(c.normalizeName('  Doe,  Jane '), c.normalizeName('jane DOE'));
  });
  check('UL tab names parse to their Monday; others are ignored', () => {
    assert.strictEqual(c.parseUlTabDate('11.2.26').getTime(), d(2026, 11, 2).getTime());
    assert.strictEqual(c.parseUlTabDate('Copy of 11.2.26'), null);
    assert.strictEqual(c.parseUlTabDate('13.40.26'), null);
  });
  check('NPS months on 11/4: Oct (grace), Nov, Dec; on 11/20: Nov, Dec', () => {
    const m = c.npsMonths(d(2026, 11, 4, 9)).map((x) => x.getMonth() + 1);
    assert.deepStrictEqual(m, [10, 11, 12]);
    assert.deepStrictEqual(c.npsMonths(d(2026, 11, 20, 9)).map((x) => x.getMonth() + 1), [11, 12]);
  });
  check('Monday of Wed 11/4 is 11/2; of Sun 11/8 is 11/2', () => {
    assert.strictEqual(c.mondayOf(d(2026, 11, 4, 9), 'America/New_York').getTime(), d(2026, 11, 2).getTime());
    assert.strictEqual(c.mondayOf(d(2026, 11, 8, 9), 'America/New_York').getTime(), d(2026, 11, 2).getTime());
  });
  check('reason values reduce to their first word', () => {
    assert.strictEqual(c.reasonWord('Away visiting family in FL'), 'Away');
    assert.strictEqual(c.reasonWord('See MD next week'), 'See MD');
    assert.strictEqual(c.reasonWord('Hospitalized '), 'Hospitalized');
  });
}

console.log('\nScenario: Wed 11/4 – Thu 11/5');
const w = buildWorld();
const { gas, code, P } = w;

run(w, d(2026, 11, 4, 7, 5), true);
check('first run is a silent baseline: no events, no email', () => {
  assert.strictEqual(activity(w).length, 0);
  assert.strictEqual(gas.mail.length, 0);
});
check('Today tab lists every PCC clinic with Huddle targets', () => {
  const r = todayRow(w, 'Brick');
  assert.strictEqual(r.PCC, "Damian O'Loughlin");
  assert.strictEqual(r['Huddle: Nothing Booked Wk of 11/9'], 2);
  assert.strictEqual(todayRow(w, 'Metuchen').PCC, 'Kim Collins / Brandon Vargas');
  assert.strictEqual(todayRow(w, 'Flemington').PCC, 'Flemington PCC (name not set)');
});
check('Today status line says all sources read OK', () => {
  const status = output(w).getSheetByName('Today').getRange(2, 1).getValue();
  assert(/all sources read OK/.test(status), status);
});

run(w, d(2026, 11, 4, 7, 20));
check('nothing changed -> nothing logged', () => assert.strictEqual(activity(w).length, 0));

run(w, d(2026, 11, 4, 3, 0));
check('outside the run window (3 AM) the trigger does nothing', () => assert.strictEqual(activity(w).length, 0));

// 9:00 — a burst of real work.
gas.now = d(2026, 11, 4, 8, 55);
const trRow = appendNps(gas, w.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela ', p: P.uma });
appendNps(gas, w.nov, 'SMST', { date: d(2026, 11, 4), takenBy: 'Somerset', p: P.vic });
appendNps(gas, w.nov, 'EW', { date: d(2026, 11, 4, 8, 41), takenBy: 'Auto', p: P.wren, notes: 'Phone: x | Landing page: y' });
appendNps(gas, w.nov, 'BR', { date: d(2026, 11, 4), takenBy: 'Lana', p: P.xan });
appendNps(gas, w.nov, 'MET', { date: d(2026, 11, 4), takenBy: '', p: P.kai });
// UL: TR next week # SCHED 0 -> 2 and a signed note line appended.
setCell(gas, w.ulTr, '11.9.26', (r) => r[0] === P.jo.lastFirst, 4, 2);
setCell(gas, w.ulTr, '11.9.26', (r) => r[0] === P.ivy.lastFirst, 6, '11/3 lm [MARI]\n11/4 sched IE f/u [MARI]');
// Somerset: Jerome signs a note -> not the PCC's work.
setCell(gas, w.ulSmst, '11.9.26', (r) => r[0] === P.kai.lastFirst, 6, '11/4 left vm [JEROME]');
// Brick: new patient inserted mid-table, and the tab re-sorts (rows move).
{
  const sheet = w.ulBrick.getSheetByName('11.9.26');
  const data = sheet.data;
  const rows = data.slice(11, 14);
  data.splice(11, 3, ulRow({ name: P.pip.full, ie: true, note: 'IE 11/4', rxEnd: '', pocEnd: '' }), rows[2], rows[0], rows[1]);
  gas.touch('ul-brick');
}
// Metuchen: reason set.
setCell(gas, w.ulMet, '11.9.26', (r) => r[0] === P.lu.lastFirst, 9, 'Work');
run(w, d(2026, 11, 4, 9, 0));

check('NPS: Mariela\'s new row is credited to her by Taken By', () => {
  const e = activity(w).find((r) => r[1] === 'Mariela Ponce' && r[4] === 'New patient on the NPS');
  assert(e, 'missing');
  assert.strictEqual(e[7], 'Taken By');
  assert(String(e[6]).indexOf('TR row ' + trRow) !== -1, e[6]);
});
check('NPS: "Somerset" in Taken By goes to Alexa as probable', () => {
  const e = activity(w).find((r) => r[1] === 'Alexa Quintanilla' && r[3] === 'NPS');
  assert(e, 'missing');
  assert(/Probable/.test(e[7]));
});
check('NPS: Auto, central staff and blank Taken By rows are not PCC events', () => {
  assert(!activity(w).some((r) => r[3] === 'NPS' && /Emily|Kim|Brandon|Damian/.test(r[1])));
});
check('UL: # SCHED 0 -> 2 is "scheduled" for Toms River', () => {
  const e = activity(w).find((r) => r[4] === 'Scheduled visits on the UL' && r[2] === 'Toms River');
  assert(e && /0 → 2/.test(e[5]), e && e[5]);
});
check('UL: a note line signed [MARI] is credited to Mariela by tag', () => {
  const e = activity(w).find((r) => r[4] === 'Added a UL care note' && r[2] === 'Toms River');
  assert(e && e[1] === 'Mariela Ponce' && /MARI/.test(e[7]), e && e.join(' | '));
});
check('UL: a note signed [JEROME] is not credited to anyone', () => {
  assert(!activity(w).some((r) => r[2] === 'Somerset' && r[3] === 'UL'));
});
check('UL: Brick new patient is logged once; re-sorting adds nothing else', () => {
  const brick = activity(w).filter((r) => r[2] === 'Brick' && r[3] === 'UL');
  assert.strictEqual(brick.length, 1, brick.map((r) => r[4]).join(', '));
  assert.strictEqual(brick[0][4], 'Added a patient to the UL');
  assert.strictEqual(brick[0][1], "Damian O'Loughlin");
});
check('UL: Metuchen reason is credited to both Metuchen PCCs (shared)', () => {
  const e = activity(w).find((r) => r[4] === 'Set a reason not scheduled');
  assert(e && e[1] === 'Kim Collins / Brandon Vargas' && /shared/.test(e[7]) && /Work/.test(e[5]));
});
check('email sent at 9:00 for the new NPS/UL patients, one email', () => {
  assert.strictEqual(gas.mail.length, 1);
  const m = gas.mail[0];
  assert.strictEqual(m.to, 'dondre.test@example.test');
  assert(/Mariela \+1 NPS/.test(m.subject), m.subject);
  assert(/Damian \+1 UL/.test(m.subject), m.subject);
  assert(/Scheduled visits on the UL/.test(m.body));
});

// 9:15 — Taken By filled in on the blank Metuchen row; Emily claims the web lead.
setCell(gas, w.nov, 'MET', (r) => r[3] === P.kai.full, 2, 'Brandon');
setCell(gas, w.nov, 'EW', (r) => r[3] === P.wren.full, 2, 'Auto/ Emily');
run(w, d(2026, 11, 4, 9, 15));
check('NPS: blank Taken By later filled with "Brandon" -> Brandon new entry', () => {
  assert(activity(w).some((r) => r[1] === 'Brandon Vargas' && r[4] === 'New patient on the NPS'));
});
check('NPS: "Auto" -> "Auto/ Emily" is a claimed lead for Emily', () => {
  assert(activity(w).some((r) => r[1] === 'Emily Freire' && r[4] === 'Claimed a web / AI lead on the NPS'));
});
check('email batching: no second email within 30 minutes', () => assert.strictEqual(gas.mail.length, 1));

run(w, d(2026, 11, 4, 9, 30));
check('at 9:30 the held events go out in one email', () => {
  assert.strictEqual(gas.mail.length, 2);
  assert(/Brandon \+1 NPS/.test(gas.mail[1].subject) && /Emily \+1 NPS/.test(gas.mail[1].subject), gas.mail[1].subject);
});

// 9:45 — a typo fix on an NPS name (same row), and next-next week's UL tab is created.
const before945 = activity(w).length;
setCell(gas, w.nov, 'TR', (r) => r[3] === P.uma.full, 4, P.uma.full + 'x');
SENSITIVE.push(P.uma.full + 'x');
ulTab(w.ulBrick, '11.16.26', 'Brick', [{ name: P.fay.lastFirst }, { name: P.gus.full }, { name: P.hal.lastFirst }]);
gas.touch('ul-brick');
run(w, d(2026, 11, 4, 9, 45));
check('NPS: correcting a name on the same row is not a new entry', () => {
  const fresh = eventsSince(w, before945);
  assert(!fresh.some((r) => r[3] === 'NPS'), fresh.map((r) => r.join('|')).join('\n'));
});
check('UL: a newly created week tab is baselined (one info line, no PCC credit)', () => {
  const fresh = eventsSince(w, before945);
  assert.strictEqual(fresh.length, 1, fresh.map((r) => r.join('|')).join('\n'));
  assert.strictEqual(fresh[0][3], 'Watcher');
  assert.strictEqual(todayRow(w, 'Brick')['UL patients added'], 1);
});

// 10:00 — Huddle marks and Collected? marks.
setCell(gas, w.hud, 'Brick', (r) => r[2] === P.oz.acct && r[0] === 'Brick', 10, 'yes');
setCell(gas, w.hud, 'All PCC Clinics', (r) => r[2] === P.oz.acct, 10, 'Yes');
setCell(gas, w.hud, 'East Windsor', (r) => r[2] === P.rae.acct, 14, 'Yes - Full');
setCell(gas, w.pr, 'East Windsor', (r) => r[2] === P.rae.acct, 15, 'Yes - Full');
setCell(gas, w.pr, 'East Windsor', (r) => r[2] === P.tam.acct, 15, 'Card on File');
run(w, d(2026, 11, 4, 10, 0));
check('Huddle: Booked? marked on the clinic tab and All PCC Clinics counts once', () => {
  const booked = activity(w).filter((r) => r[4] === 'Marked booked on the Huddle');
  assert.strictEqual(booked.length, 1);
  assert.strictEqual(booked[0][1], "Damian O'Loughlin");
});
check('Collected?: same patient marked in Huddle and Patient Responsibility counts once', () => {
  const col = activity(w).filter((r) => r[4] === 'Marked collected' && r[2] === 'East Windsor');
  assert.strictEqual(col.length, 2, col.map((r) => r[5]).join(' / '));
  assert(col.some((r) => /\$40\.00/.test(r[5])));
  assert(col.some((r) => /tomorrow/.test(r[5])));
});
check('Today tab counts the day\'s work per clinic', () => {
  const tr = todayRow(w, 'Toms River');
  assert.strictEqual(tr['NPS new'], 1);
  assert.strictEqual(tr['UL visits scheduled'], 1);
  assert.strictEqual(tr['UL notes'], 1);
  assert.strictEqual(String(todayRow(w, 'Brick')['Marked booked']), '1');
  assert(/^2 \(\$40\.00 in full\)/.test(String(todayRow(w, 'East Windsor')['Marked collected'])),
    todayRow(w, 'East Windsor')['Marked collected']);
});

// A source that can't be opened is reported and the rest still work.
gas.files['ul-met'].denied = true;
gas.touch('ul-met');
setCell(gas, w.ulTr, '11.9.26', (r) => r[0] === P.jo.lastFirst, 4, 3);
run(w, d(2026, 11, 4, 10, 15));
check('an unreadable UL is reported on the Today tab; other ULs still watched', () => {
  const status = output(w).getSheetByName('Today').getRange(2, 1).getValue();
  assert(/UL Metuchen/.test(status), status);
  assert.strictEqual(todayRow(w, 'Toms River')['UL visits scheduled'], 2);
});
gas.files['ul-met'].denied = false;

run(w, d(2026, 11, 4, 13, 0));
check('1 PM: "no activity yet" names only the clinics that did nothing', () => {
  const quiet = gas.mail.filter((m) => /no activity/.test(m.subject));
  assert.strictEqual(quiet.length, 1);
  ['Somerville — Chris Noriega', 'East Brunswick — Tiago Capela', 'Upper Dublin — Leah Carpenter',
    'Flemington — Flemington PCC (name not set)'].forEach((s) => assert(quiet[0].body.indexOf(s) !== -1, s));
  ['Toms River', 'Brick', 'East Windsor', 'Somerset', 'Metuchen'].forEach((s) =>
    assert(quiet[0].body.indexOf(s) === -1, s + ' should not be listed'));
});
run(w, d(2026, 11, 4, 16, 0));
check('end-of-day summary email at 4 PM', () => {
  const m = gas.mail.find((x) => /today's summary/.test(x.subject));
  assert(m, 'missing');
  assert(/Toms River — Mariela Ponce/.test(m.body));
});

// Thursday: morning rebuilds wipe marks and re-lay rows. They must be silent.
const beforeThu = activity(w).length;
const mailThu = gas.mail.length;
gas.now = d(2026, 11, 5, 7, 48);
w.pr = responsibility(gas, 'pr', 'Thursday 11/05/2026', '11/04', {
  'Brick': { tomorrow: [], today: [{ time: '8:00 AM', p: P.pip, total: 10 }, { time: '9:20 AM', p: P.oz, total: 25 }] },
  'East Windsor': { tomorrow: [], today: [{ time: '8:40 AM', p: P.tam, total: 30 }] },
});
gas.now = d(2026, 11, 5, 8, 4);
w.hud = huddle(gas, 'huddle', 'Thu 11/05/2026', {
  'Brick': { book: [{ p: P.pip }], pay: [{ time: '8:00 AM', p: P.pip, total: 10 }] },
  'East Windsor': { book: [{ p: P.tam, mark: '' }], pay: [{ time: '8:40 AM', p: P.tam, total: 30 }] },
});
run(w, d(2026, 11, 5, 7, 50));
run(w, d(2026, 11, 5, 8, 15));
check('Thursday: rebuilds are silent and the day\'s counters reset', () => {
  assert.strictEqual(activity(w).length, beforeThu);
  assert.strictEqual(todayRow(w, 'Toms River')['NPS new'], 0);
  assert.strictEqual(todayRow(w, 'Brick')['Huddle: Nothing Booked Wk of 11/9'], 1);
});
check('Thursday: yesterday\'s collection rate comes from the PR summary', () => {
  assert(/\$150\.00 of \$200\.00 \(75%\)/.test(todayRow(w, 'Brick')['Yesterday collected']));
});
gas.now = d(2026, 11, 5, 10, 0);
appendNps(gas, w.nov, 'TR', { date: d(2026, 11, 5), takenBy: 'Mariela/Lana', p: P.sol });
run(w, d(2026, 11, 5, 10, 0));
run(w, d(2026, 11, 5, 13, 0));
check('Thursday 1 PM: one "no activity yet" email naming quiet clinics, not Toms River', () => {
  const quiet = gas.mail.slice(mailThu).filter((m) => /no activity/.test(m.subject));
  assert.strictEqual(quiet.length, 1);
  assert(!/Toms River/.test(quiet[0].body), quiet[0].body);
  assert(/Somerville — Chris Noriega/.test(quiet[0].body), quiet[0].body);
});
run(w, d(2026, 11, 5, 13, 15));
check('the "no activity" email is sent once a day', () => {
  assert.strictEqual(gas.mail.slice(mailThu).filter((m) => /no activity/.test(m.subject)).length, 1);
});

// After the 10th, last month's NPS is no longer watched.
run(w, d(2026, 11, 11, 9, 0));
check('October NPS drops out of the state after 11/10', () => {
  const state = JSON.parse(gas.files[gas.props.PCC_WATCH_STATE_FILE_ID].content);
  assert(!state.nps['nps-oct']);
  assert(state.nps['nps-nov']);
});

console.log('\nReview regressions');
const REGRESSION_WORLDS = [];
/** A fresh world, baselined Wednesday 7:05 AM. */
function freshWorld() {
  const x = buildWorld();
  REGRESSION_WORLDS.push(x);
  run(x, d(2026, 11, 4, 7, 5), true);
  return x;
}
const at = (x, h, m) => { x.gas.now = d(2026, 11, 4, h, m || 0); };

{
  const x = freshWorld();
  const outId = x.gas.props.PCC_WATCH_OUTPUT_ID;
  x.gas.failOpen[outId] = 2;
  run(x, d(2026, 11, 4, 7, 20));
  check('a passing failure to open the PCC Watch sheet is retried', () => {
    assert.strictEqual(x.gas.props.PCC_WATCH_OUTPUT_ID, outId);
  });
  x.gas.failOpen[outId] = 5;
  let threw = false;
  try { run(x, d(2026, 11, 4, 7, 35)); } catch (e) { threw = true; }
  x.gas.failOpen[outId] = 0;
  check('a lasting failure aborts the run; no second PCC Watch sheet, Roster kept', () => {
    assert(threw);
    assert.strictEqual(x.gas.props.PCC_WATCH_OUTPUT_ID, outId);
    const sheets = Object.keys(x.gas.files).filter((id) => x.gas.files[id].name === 'PCC Watch');
    assert.strictEqual(sheets.length, 1);
  });
  at(x, 7, 40);
  appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma });
  x.gas.files[x.gas.props.PCC_WATCH_STATE_FILE_ID].content = '{"v":1,"nps":';
  threw = false;
  try { run(x, d(2026, 11, 4, 7, 50)); } catch (e) { threw = true; }
  check('an unreadable state file aborts the run instead of silently re-baselining', () => {
    assert(threw);
    assert.strictEqual(activity(x).length, 0);
  });
  x.code.resetSnapshots();
  run(x, d(2026, 11, 4, 8, 5));
  check('resetSnapshots() recovers: next run re-baselines quietly', () => {
    assert.strictEqual(activity(x).length, 0);
    assert(/all sources read OK/.test(output(x).getSheetByName('Today').getRange(2, 1).getValue()));
  });
}

{
  const x = freshWorld();
  at(x, 8, 50);
  appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma });
  x.gas.mailDown = true;
  run(x, d(2026, 11, 4, 9, 0));
  run(x, d(2026, 11, 4, 9, 15));
  check('mail outage: the event is logged once, not again every run', () => {
    assert.strictEqual(activity(x).filter((r) => r[1] === 'Mariela Ponce').length, 1);
    assert(/Email:/.test(output(x).getSheetByName('Today').getRange(2, 1).getValue()));
  });
  x.gas.mailDown = false;
  run(x, d(2026, 11, 4, 9, 30));
  check('mail back: the held email goes out', () => {
    assert.strictEqual(x.gas.mail.length, 1);
    assert(/Mariela \+1 NPS/.test(x.gas.mail[0].subject));
  });
  output(x).insertSheet('Dashboard');
  run(x, d(2026, 11, 4, 9, 45));
  check('a tab you add to the PCC Watch sheet is left alone', () => {
    assert(output(x).getSheetByName('Dashboard'));
  });
}

{
  const x = freshWorld();
  const freeBooked = 'no - pt hospitalized call daughter 5551234567';
  const freeCollected = 'partial acct ' + x.P.rae.acct + ' paid 20';
  SENSITIVE.push('5551234567', 'call daughter', 'paid 20');
  at(x, 9, 55);
  setCell(x.gas, x.hud, 'Brick', (r) => r[2] === x.P.oz.acct && r[0] === 'Brick', 10, freeBooked);
  setCell(x.gas, x.hud, 'Brick', (r) => r[2] === x.P.pip.acct && r[0] === 'Brick', 10, 'no');
  setCell(x.gas, x.hud, 'East Windsor', (r) => r[2] === x.P.rae.acct, 14, freeCollected);
  setCell(x.gas, x.pr, 'Toms River', (r) => r[2] === x.P.sol.acct, 15, 'No');
  run(x, d(2026, 11, 4, 10, 0));
  check('Booked? "no ..." is "not booked", never "booked"', () => {
    const r = todayRow(x, 'Brick');
    assert.strictEqual(String(r['Marked booked']), '0 (+2 not booked)');
    assert(!activity(x).some((a) => a[4] === 'Marked booked on the Huddle'));
  });
  check('Collected? "No" is "nothing collected" with no dollars; "partial ..." counts without dollars', () => {
    assert.strictEqual(String(todayRow(x, 'Toms River')['Marked collected']), '0 (+1 nothing collected)');
    assert.strictEqual(String(todayRow(x, 'East Windsor')['Marked collected']), '1');
  });
  check('typed text in Booked? / Collected? is stored and shown only as its class', () => {
    const details = activity(x).map((a) => a[5]).join(' | ');
    assert(/Marked "no"/.test(details) && /Marked "partial"/.test(details), details);
  });
}

{
  const x = freshWorld();
  at(x, 9, 55);
  // Jerome schedules, sets a reason and signs his note on a Toms River row.
  setCell(x.gas, x.ulTr, '11.9.26', (r) => r[0] === x.P.jo.lastFirst, 4, 2);
  setCell(x.gas, x.ulTr, '11.9.26', (r) => r[0] === x.P.jo.lastFirst, 9, 'Chemo until 12/1');
  setCell(x.gas, x.ulTr, '11.9.26', (r) => r[0] === x.P.jo.lastFirst, 6, '11/4 sched 2x [JEROME]');
  // Ordinary note text that looks like initials must not be read as a tag.
  setCell(x.gas, x.ulTr, '11.9.26', (r) => r[0] === x.P.ivy.lastFirst, 6,
    '11/3 lm [MARI]\n11/4 lm - as discussed w/ MD (as needed) [MARI]');
  SENSITIVE.push('Chemo until');
  run(x, d(2026, 11, 4, 10, 0));
  check('work on a row whose new note is signed [JEROME] is not credited to the PCC', () => {
    const tr = activity(x).filter((a) => a[2] === 'Toms River' && a[3] === 'UL');
    assert.strictEqual(tr.length, 1, tr.map((a) => a.join('|')).join('\n'));
    assert.strictEqual(tr[0][1], 'Mariela Ponce');
    assert(/Signed note MARI/.test(tr[0][7]), tr[0][7]);
  });
  check('"- as discussed" / "(as needed)" are not initials', () => {
    assert.deepStrictEqual(x.code.signatureTags('lm - as discussed w/ MD (as needed) [MARI]'), ['MARI']);
  });
  check('a free-text reason is logged as "Other"', () => {
    assert.strictEqual(x.code.reasonWord('Chemo until 12/1'), 'Other');
  });
}

{
  const x = freshWorld();
  at(x, 9, 55);
  // The same new IE goes onto this week's and next week's Brick tab.
  ['11.2.26', '11.9.26'].forEach((tab) => {
    const sheet = x.ulBrick.getSheetByName(tab);
    const row = findRow(sheet, (r) => r[0] === '' && r[9] === false);
    ulRow({ name: x.P.mo.full, ie: true, rxEnd: '', pocEnd: '' }).forEach((v, j) => sheet.set(row, j + 1, v));
  });
  // Meanwhile a Toms River row with no dates disappears while a new IE (no dates) is added.
  const trSheet = x.ulTr.getSheetByName('11.9.26');
  const joRow = findRow(trSheet, (r) => r[0] === x.P.jo.lastFirst);
  ulRow({ name: x.P.ned.full, ie: true, rxEnd: '', pocEnd: '' }).forEach((v, j) => trSheet.set(joRow, j + 1, v));
  // And a name typo is fixed on an Ivy row that has dates.
  const ivyRow = findRow(trSheet, (r) => r[0] === x.P.ivy.lastFirst);
  trSheet.set(ivyRow, 1, x.P.ivy.lastFirst + 'e');
  SENSITIVE.push(x.P.ivy.lastFirst + 'e');
  x.gas.touch('ul-brick');
  x.gas.touch('ul-tr');
  run(x, d(2026, 11, 4, 10, 0));
  check('a new patient added to two week tabs counts once', () => {
    assert.strictEqual(todayRow(x, 'Brick')['UL patients added'], 1);
  });
  check('a new IE is still counted when an undated row vanishes; a dated row\'s typo fix is not', () => {
    assert.strictEqual(todayRow(x, 'Toms River')['UL patients added'], 1);
  });
}

{
  const x = freshWorld();
  at(x, 8, 55);
  const row = appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma });
  run(x, d(2026, 11, 4, 9, 0));
  const sheet = x.nov.getSheetByName('TR');
  const saved = sheet.data[row - 1].slice();
  sheet.data[row - 1] = [];
  x.gas.touch('nps-nov');
  run(x, d(2026, 11, 4, 9, 15));
  sheet.data[row - 1] = saved;
  x.gas.touch('nps-nov');
  run(x, d(2026, 11, 4, 9, 30));
  check('an NPS row cleared and restored is credited once', () => {
    assert.strictEqual(todayRow(x, 'Toms River')['NPS new'], 1);
  });
}

{
  const x = freshWorld();
  x.gas.files['nps-nov'].name = 'November 2026 New Patient Spreadsheet (old)';
  x.gas.touch('nps-nov');
  run(x, d(2026, 11, 4, 12, 45));
  run(x, d(2026, 11, 4, 13, 0));
  check('a missing NPS for this month is reported, emailed once, and the quiet email is held back', () => {
    assert(/NPS: no "November 2026/.test(output(x).getSheetByName('Today').getRange(2, 1).getValue()));
    const mails = x.gas.mail.map((m) => m.subject);
    assert.strictEqual(mails.filter((m) => /can't read/.test(m)).length, 1, mails.join(' / '));
    assert(!mails.some((m) => /no activity/.test(m)), mails.join(' / '));
  });
  run(x, d(2026, 11, 4, 13, 15));
  check('the "can\'t read" email is not repeated every run', () => {
    assert.strictEqual(x.gas.mail.filter((m) => /can't read/.test(m.subject)).length, 1);
  });
}

{
  const x = freshWorld();
  const act = output(x).getSheetByName('Activity');
  const old = d(2026, 8, 20, 9);
  const recent = d(2026, 11, 3, 9);
  // Someone sorted the tab: an old row sits between recent ones.
  act.insertRowsAfter(1, 3);
  act.getRange(2, 1, 3, 8).setValues([
    [recent, 'A', 'Brick', 'NPS', 'x', '', '', ''],
    [old, 'B', 'Brick', 'NPS', 'x', '', '', ''],
    [recent, 'C', 'Brick', 'NPS', 'x', '', '', ''],
  ]);
  run(x, d(2026, 11, 4, 9, 0));
  check('only Activity rows older than 60 days are deleted, wherever they are', () => {
    const left = activity(x).map((r) => r[1]);
    assert.deepStrictEqual(left, ['A', 'C']);
  });
}

{
  const x = freshWorld();
  at(x, 18, 25);
  appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma });
  run(x, d(2026, 11, 4, 18, 30));
  at(x, 18, 40);
  appendNps(x.gas, x.nov, 'EW', { date: d(2026, 11, 4), takenBy: 'Emily', p: x.P.vic });
  run(x, d(2026, 11, 4, 18, 45));
  const sentBy645 = x.gas.mail.filter((m) => /Emily/.test(m.subject)).length;
  run(x, d(2026, 11, 5, 7, 0));
  check('a new patient found after the evening\'s last email goes out next morning', () => {
    assert.strictEqual(sentBy645, 0);
    assert(x.gas.mail.some((m) => /Emily \+1 NPS/.test(m.subject)));
  });
  check('before the morning rebuild, yesterday\'s Huddle targets are not shown as today\'s', () => {
    assert.strictEqual(todayRow(x, 'Brick')['Huddle: nothing booked'], '');
  });
}

{
  const x = freshWorld();
  // Thursday: the Huddle is rebuilt at 8:04 and a PCC marks a patient at 8:10,
  // all before the 8:15 check.
  x.gas.now = d(2026, 11, 5, 8, 4);
  x.hud = huddle(x.gas, 'huddle', 'Thu 11/05/2026', {
    'Brick': { book: [{ p: x.P.pip, mark: 'yes' }], pay: [] },
  });
  run(x, d(2026, 11, 5, 8, 15));
  check('a mark made between the morning rebuild and the next check still counts', () => {
    assert.strictEqual(String(todayRow(x, 'Brick')['Marked booked']), '1');
  });
}

{
  const x = freshWorld();
  run(x, d(2026, 11, 16, 9, 0));
  check('a UL with no tab for the current week is flagged even if the file hasn\'t changed', () => {
    const status = output(x).getSheetByName('Today').getRange(2, 1).getValue();
    assert(/UL Somerset: no tab for this week or later/.test(status), status);
  });
}

{
  const x = freshWorld();
  x.code.installTrigger();
  x.code.CONFIG.TRIGGER_EVERY_MINUTES = 20;
  let threw = false;
  try { x.code.installTrigger(); } catch (e) { threw = /must be one of/.test(e.message); }
  x.code.CONFIG.TRIGGER_EVERY_MINUTES = 15;
  check('an invalid interval is refused and the existing trigger is kept', () => {
    assert(threw);
    assert.strictEqual(x.gas.triggers.length, 1);
  });
}

console.log('\nRoster edits');
check('a PCC added on the Roster tab is picked up without code changes', () => {
  const roster = output(w).getSheetByName('Roster');
  const flem = findRow(roster, (r) => r[1] === 'Flemington');
  roster.set(flem, 1, 'Pat Example');
  roster.set(flem, 3, 'Pat');
  const who = code.attributeTakenBy(code.loadRoster(output(w)), 'auto/pat');
  assert(who && who.pccs[0].pcc === 'Pat Example');
});

console.log('\nInstalled mid-day');
{
  const w3 = buildWorld();
  run(w3, d(2026, 11, 4, 11, 30), true);
  run(w3, d(2026, 11, 4, 13, 0));
  check('no "no activity" email on a day the watcher started late', () => {
    assert(!w3.gas.mail.some((m) => /no activity/.test(m.subject)));
    assert.strictEqual(todayRow(w3, 'Somerville')['Heads-up'].indexOf('No activity'), -1);
  });
}

console.log('\nsetup()');
{
  const w2 = buildWorld();
  w2.gas.now = new Date();
  w2.code.setup();
  check('setup() installs one 15-minute trigger and creates the three tabs', () => {
    assert.strictEqual(w2.gas.triggers.length, 1);
    assert.strictEqual(w2.gas.triggers[0].every, 15);
    const names = w2.code.getOutputSpreadsheet().getSheets().map((s) => s.getName());
    assert.deepStrictEqual(names, ['Today', 'Activity', 'Roster']);
  });
  w2.code.setup();
  check('running setup() twice still leaves one trigger', () => assert.strictEqual(w2.gas.triggers.length, 1));
}

console.log('\nPrivacy');
/** Every place a sensitive fixture string turns up in a world's state, PCC Watch sheet, emails or logs. */
function findLeaks(world) {
  const g = world.gas;
  const haystacks = [];
  Object.keys(g.files).forEach((id) => {
    if (g.files[id].kind === 'blob') haystacks.push(['state file', g.files[id].content]);
  });
  output(world).getSheets().forEach((sh) => haystacks.push(['sheet ' + sh.getName(), JSON.stringify(sh.data)]));
  g.mail.forEach((m, i) => haystacks.push(['email ' + i, m.subject + '\n' + m.body]));
  haystacks.push(['logs', g.logs.join('\n')]);
  const leaks = [];
  haystacks.forEach(([where, text]) => {
    const lower = String(text).toLowerCase();
    SENSITIVE.forEach((x) => { if (lower.indexOf(String(x).toLowerCase()) !== -1) leaks.push(where + ': ' + x); });
  });
  return leaks;
}
check('no patient name, account #, phone or DOB in state, PCC Watch sheet, emails or logs', () => {
  const leaks = findLeaks(w).concat(...REGRESSION_WORLDS.map(findLeaks));
  assert.strictEqual(leaks.length, 0, leaks.slice(0, 5).join('; '));
});
check('the HMAC secret is only in Script Properties', () => {
  const secret = gas.props.PCC_WATCH_SECRET;
  assert(secret && secret.length >= 64);
  const state = gas.files[gas.props.PCC_WATCH_STATE_FILE_ID].content;
  assert(state.indexOf(secret) === -1);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
