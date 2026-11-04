// Shared fixtures for the PCC Watch tests and the dashboard preview: made-up
// sheets shaped like the real NPS, UL, PCC Daily Huddle and Patient
// Responsibility files, and a loader that runs Code.gs against the fake
// Apps Script services in gas-mock.js. Every patient here is invented.
'use strict';

process.env.TZ = 'America/New_York';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const EXPORTS = ['CONFIG', 'setup', 'runWatchAt', 'runWatch', 'resetSnapshots', 'getOutputSpreadsheet',
  'ensureTabs', 'getSecret', 'loadState', 'installTrigger', 'removeTriggers', 'signatureTags',
  'normalizeName', 'attributeTakenBy', 'parseUlTabDate', 'npsMonths', 'mondayOf', 'loadRoster', 'reasonWord',
  'dashboardData', 'todayModel', 'doGet', 'getDashboardData', 'backfillAt', 'noteLineDate'];

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
  return [r.date, r.takenBy, false, r.p.full, 'Google Search', 'Knee', 'Brick', 'BCBS', '', r.ie || '', '',
    r.notes || '', r.status || 'Active', ''];
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


module.exports = {
  SENSITIVE, d, loadCode, patient, npsTab, npsRow, appendNps, findRow, ulRow, ulTab, huddle, responsibility, prRow,
  setCell, buildWorld, run, output, activity, eventsSince, todayRow,
};
