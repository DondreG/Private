// End-to-end tests for PCC Watch against made-up sheets shaped like the real
// NPS, UL, PCC Daily Huddle and Patient Responsibility files.
//
//   node pcc-watch/test/run-tests.js
//
// Every patient below is invented. The privacy check at the end fails if any
// of their names, account numbers, phones or DOBs reach the state file, the
// PCC Watch sheet, an email or the log.
'use strict';


const assert = require('assert');
const {
  SENSITIVE, d, loadCode, npsTab, appendNps, findRow, ulRow, ulTab, huddle, responsibility,
  setCell, buildWorld, run, output, activity, eventsSince, todayRow,
} = require('./fixtures');

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
    assert(/Marked "no"/.test(details) && /Marked "Partial"/.test(details) && /Marked "No"/.test(details), details);
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

console.log('\nDashboard');
{
  const x = buildWorld();
  REGRESSION_WORLDS.push(x);
  run(x, d(2026, 11, 4, 7, 5), true);
  x.gas.now = d(2026, 11, 4, 8, 55);
  appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma, ie: d(2026, 11, 10) });
  appendNps(x.gas, x.nov, 'EW', { date: d(2026, 11, 4), takenBy: 'Emily', p: x.P.vic, status: 'Pending' });
  run(x, d(2026, 11, 4, 9, 0));
  x.gas.now = d(2026, 11, 4, 9, 10);
  setCell(x.gas, x.nov, 'EW', (r) => r[3] === x.P.vic.full, 10, d(2026, 11, 12));
  setCell(x.gas, x.ulTr, '11.9.26', (r) => r[0] === x.P.jo.lastFirst, 4, 2);
  run(x, d(2026, 11, 4, 9, 15));
  const data = x.code.dashboardData(d(2026, 11, 4, 9, 20), 1);
  const ev = (type, pcc) => data.events.find((e) => e.type === type && e.pcc === pcc);
  check('dashboard: an NPS entry shows the clinic and its IE date', () => {
    const e = ev('new_entry', 'Mariela Ponce');
    assert(e, JSON.stringify(data.events.map((x2) => x2.type + ':' + x2.pcc)));
    assert.strictEqual(e.forClinic, 'Toms River');
    assert.strictEqual(e.ie, '2026-11-10');
    assert(/IE Tue 11\/10 · Active/.test(e.detail), e.detail);
    assert(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/nps-nov\/edit#gid=\d+&range=A\d+$/.test(e.link), e.link);
  });
  check('dashboard: an entry with no IE yet says so; the IE filled in later is "IE booked" for its owner', () => {
    assert(/no IE date yet · Pending/.test(ev('new_entry', 'Emily Freire').detail));
    const b = ev('ie_booked', 'Emily Freire');
    assert(b && b.ie === '2026-11-12' && b.forClinic === 'East Windsor', JSON.stringify(b));
  });
  check('dashboard: events carry hour and day for the charts; newest first', () => {
    assert(data.events.every((e) => e.day === '2026-11-04' && e.hour === 9));
    assert(data.events[0].at >= data.events[data.events.length - 1].at);
  });
  check('dashboard: clinic cards match the Today tab and the last check is reported', () => {
    assert.strictEqual(data.clinics.length, 9);
    const tr = data.clinics.find((c) => c.clinic === 'Toms River');
    assert.strictEqual(tr.counts.npsNew, 1);
    assert.strictEqual(tr.counts.ulScheduled, 1);
    assert.strictEqual(data.lastRun.errors.length, 0);
    assert(data.pccs.indexOf('Mariela Ponce') !== -1);
  });
  const week = x.code.dashboardData(d(2026, 11, 10, 9, 0), 7);
  const later = x.code.dashboardData(d(2026, 11, 12, 9, 0), 1);
  check('dashboard: the 7-day range includes the week; "today" on a later day is empty', () => {
    assert(week.events.length === data.events.length);
    assert.strictEqual(later.events.length, 0);
    assert.strictEqual(later.clinics.find((c) => c.clinic === 'Toms River').counts.npsNew, 0);
  });
  check('the web app serves Dashboard.html with a phone-friendly viewport', () => {
    const page = x.code.doGet();
    assert.strictEqual(page.file, 'Dashboard');
    assert.strictEqual(page.title, 'PCC Watch');
    assert(/width=device-width/.test(page.meta.viewport));
  });
  x.gas.webAppUrl = 'https://script.google.com/macros/s/example/exec';
  x.gas.now = d(2026, 11, 4, 9, 40);
  appendNps(x.gas, x.nov, 'BR', { date: d(2026, 11, 4), takenBy: 'Damian', p: x.P.ivy });
  run(x, d(2026, 11, 4, 9, 45));
  check('once deployed, emails link to the dashboard', () => {
    const m = x.gas.mail[x.gas.mail.length - 1];
    assert(/Damian \+1 NPS/.test(m.subject), m.subject);
    assert(m.body.indexOf('https://script.google.com/macros/s/example/exec') !== -1);
  });
  check('dashboard data has no patient identifiers', () => {
    const text = JSON.stringify([data, week]).toLowerCase();
    const hits = SENSITIVE.filter((s) => text.indexOf(String(s).toLowerCase()) !== -1);
    assert.strictEqual(hits.length, 0, hits.join(', '));
  });
}

console.log('\nBackfill (October + November)');
{
  const x = buildWorld();
  REGRESSION_WORLDS.push(x);
  const c = x.code;
  check('note dates: leading m/d only, latest not after today', () => {
    assert.strictEqual(c.noteLineDate('11/3 lm [MARI]', '2026-11-04'), '2026-11-03');
    assert.strictEqual(c.noteLineDate('12/30 called', '2026-11-04'), '2025-12-30');
    assert.strictEqual(c.noteLineDate('10/28/26 sched', '2026-11-04'), '2026-10-28');
    assert.strictEqual(c.noteLineDate('IE 11/10', '2026-11-04'), '');
    assert.strictEqual(c.noteLineDate('13/1 x', '2026-11-04'), '');
    assert.strictEqual(c.noteLineDate('11/31 x', '2026-11-04'), '');
  });
  // Emily entered a patient this morning, before the watcher was installed.
  x.gas.now = d(2026, 11, 4, 10, 0);
  appendNps(x.gas, x.nov, 'EW', { date: d(2026, 11, 4), takenBy: 'Emily', p: x.P.wren });
  run(x, d(2026, 11, 4, 15, 0), true);
  x.gas.now = d(2026, 11, 4, 15, 20);
  appendNps(x.gas, x.nov, 'TR', { date: d(2026, 11, 4), takenBy: 'Mariela', p: x.P.uma });
  run(x, d(2026, 11, 4, 15, 30));
  const liveRows = activity(x).length;
  x.gas.now = d(2026, 11, 4, 15, 40);
  const added = c.backfillAt(d(2026, 11, 4, 15, 40));
  const rows = activity(x);
  const bf = rows.filter((r) => r[12]);
  check('backfill covers October and November NPS entries by PCC', () => {
    const who = bf.filter((r) => r[3] === 'NPS').map((r) => r[1] + ' ' + r[5].split(' · call ')[1]).sort();
    assert.deepStrictEqual(who, ["Damian O'Loughlin Mon 11/2", 'Emily Freire Wed 11/4', 'Mariela Ponce Fri 10/30',
      'Mariela Ponce Tue 11/3']);
    assert(!bf.some((r) => /Lana|Pia/.test(r[1])));
  });
  check('backfill adds dated UL note lines (signed [MARI]); undated notes are skipped', () => {
    const notes = bf.filter((r) => r[3] === 'UL');
    assert.strictEqual(notes.length, 1, notes.map((r) => r.join('|')).join('\n'));
    assert.strictEqual(notes[0][1], 'Mariela Ponce');
    assert(/note dated Tue 11\/3 · signed MARI/.test(notes[0][5]), notes[0][5]);
  });
  check('live events are kept and not duplicated; the log is newest first', () => {
    assert.strictEqual(added, 5);
    assert.strictEqual(rows.length, liveRows + 5);
    assert.strictEqual(rows.filter((r) => r[1] === 'Mariela Ponce' && r[3] === 'NPS' && !r[12]).length, 1);
    const times = rows.map((r) => r[0].getTime());
    assert.deepStrictEqual(times, times.slice().sort((a, b) => b - a));
  });
  check('today\'s pre-install entry counts on today\'s card; the live one isn\'t counted twice', () => {
    const data = c.dashboardData(d(2026, 11, 4, 15, 45), 1);
    assert.strictEqual(data.clinics.find((k) => k.clinic === 'East Windsor').counts.npsNew, 1);
    assert.strictEqual(data.clinics.find((k) => k.clinic === 'Toms River').counts.npsNew, 1);
  });
  check('the dashboard shows backfilled history with dates but no time of day', () => {
    const data = c.dashboardData(d(2026, 11, 4, 15, 45), 60);
    const oct = data.events.find((e) => e.day === '2026-10-30');
    assert(oct && oct.backfilled && oct.hour === null && oct.time === '', JSON.stringify(oct));
    assert.strictEqual(data.backfill.from, '2026-10-01');
  });
  c.backfillAt(d(2026, 11, 4, 15, 50));
  check('running backfill again replaces its rows instead of adding more', () => {
    assert.strictEqual(activity(x).length, liveRows + 5);
  });
  x.gas.now = d(2026, 11, 4, 16, 5);
  setCell(x.gas, x.nov, 'EW', (r) => r[3] === x.P.wren.full, 10, d(2026, 11, 11));
  run(x, d(2026, 11, 4, 16, 15));
  check('a backfilled entry that later gets an IE date fires "IE booked"', () => {
    const e = activity(x).find((r) => r[8] === 'ie_booked');
    assert(e && e[1] === 'Emily Freire', e && e.join('|'));
  });
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
