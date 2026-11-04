/**
 * Trinity Rehab — PCC Watch
 *
 * Tells Dondre when each PCC (Patient Care Coordinator) puts something new
 * onto the sheets they work in, without changing how anyone works:
 *
 *   - NPS (monthly New Patient Spreadsheet): a new patient row whose
 *     "Taken By" names a PCC, or a web / AI Agent lead a PCC claims by
 *     putting their name on it.
 *   - UL (each PCC clinic's weekly utilization log): a patient added, visits
 *     scheduled (# SCHED went up), a care note added, or a reason-not-
 *     scheduled filled in, on this week's tab or any future week's tab.
 *   - PCC Daily Huddle: "Booked? (PCC)" marked on the nothing-booked list.
 *   - Patient Responsibility by Clinic (and the Huddle's pay table):
 *     "Collected?" marked.
 *
 * Other people own all four, and Dondre can only view them, so nothing here
 * hooks their edits. Every 15 minutes the script takes a snapshot and
 * compares it with the last one. The snapshot can't identify a patient:
 * rows are keyed by a keyed hash (HMAC) of the name or account number with a
 * secret that never leaves Script Properties, and care notes are kept only
 * as hashes of each line. The activity log, the Today tab and the emails
 * name the PCC, the clinic, what changed and a link to the row — never the
 * patient.
 *
 * Who did it: the NPS "Taken By" column names the person. The UL, Huddle and
 * Patient Responsibility sheets have no "entered by" column, so their events
 * go to the clinic's PCC, narrowed to one person when a UL note carries a
 * signature tag such as [MARI] or -BV. Notes signed by non-PCC staff
 * (Jerome, Jibril, ...) are not credited to anyone.
 *
 * Output: ONE spreadsheet ("PCC Watch", created on first run) with
 *   - Today:    one row per PCC clinic — today's activity next to the
 *               Huddle's targets and yesterday's collection rate.
 *   - Activity: every detected event, newest first, with a link to the row.
 *   - Roster:   who the PCCs are. Edit this tab, not the code, when someone
 *               joins, leaves or starts signing notes differently.
 * plus a batched email when a PCC puts a new patient on the NPS or UL, a
 * mid-afternoon "no activity yet" heads-up, and an end-of-day summary.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit these before running
// ---------------------------------------------------------------------------
var CONFIG = {
  // Output spreadsheet. Leave '' and setup() creates "PCC Watch" in your
  // Drive and remembers its ID (Script Properties).
  OUTPUT_SPREADSHEET_ID: '',
  OUTPUT_TITLE: 'PCC Watch',

  // Optional: Drive folder to put the output sheet and the state file in
  // (e.g. the familiar's folder). Leave '' for My Drive.
  FOLDER_ID: '',
  STATE_FILE_TITLE: 'PCC Watch — state (do not edit)',

  // Danielle's live sheets (rebuilt every weekday morning, ~7:48 and ~8:04 AM).
  HUDDLE_ID: '18n8VTw-1BFXx5B2CA7bxdsFdH8zi7opWv0E8c6EOIJM',
  RESPONSIBILITY_ID: '1bvKm2HPgdsVJiTltIypmnc2BviP479WEDPApTzw2KLg',

  // One UL file per PCC clinic ("Trinity Rehab <Clinic> UL 2026").
  UL_FILES: {
    'Brick': '1jbQniN942G-xpmBHw9vw-KGUiXGll6t1BQUuhIpSIaQ',
    'East Brunswick': '15uU4CxEZTXKFOLZkAxVmTj5-EjeRrRbSfopqeMyZXhY',
    'East Windsor': '1lyXHyRTsylRzbI7i_Nl0iu1vrX-lAY_BKsVG59f7RVw',
    'Flemington': '1bKVwlISI7BdZjJx0qXTf9X26RuUhGdlHJWeF6EXr0_k',
    'Metuchen': '1oaipzEtjB76sFfPNvaPQSLpIYIk3MbmHPBqMiCG5CkU',
    'Somerset': '13JtAQJ53wv7Klp6jrH9_xv-xKQOMqYpUwniERnPPoIs',
    'Somerville': '1N6TaKLaUsdeyWt4EjQAyZiE5CSpaae7741yQ1NIzqhk',
    'Toms River': '1lt5O6DlSgqgotWzJ83KIR1wf2U3pVhI5nxRoc6lZraI',
    'Upper Dublin': '1h2uoLSbJOk9gufgkWgqFWgpkstfz_WgzuoWgNLl15Zs',
  },
  // UL tabs are named for their Monday ("11.2.26"). This week's tab and
  // tabs up to this many weeks ahead are watched; PCCs mostly work next
  // week's tab.
  UL_WEEKS_AHEAD: 4,

  // Monthly NPS titles, as in the NPS IE Sweep. {MONTH} = "November",
  // {YEAR} = "2026". Matched case-insensitively, ignoring outer spaces.
  NPS_TITLE_PATTERNS: [
    '{MONTH} {YEAR} New Patient Spreadsheet',
    '{MONTH} {YEAR} NPS',
  ],
  // Keep watching last month's NPS for this many days into the new month
  // (late rows for last month's calls still land there).
  NPS_PREVIOUS_MONTH_DAYS: 10,
  HEADER_SEARCH_ROWS: 15,

  // NPS tab -> clinic name (same map as the NPS IE Sweep).
  NPS_CLINIC_TABS: {
    BR: 'Brick', CherryHill: 'Cherry Hill', CLRK: 'Clark', CLFTN: 'Clifton',
    CLIFTN: 'Clifton', Doylestown: 'Doylestown', EB: 'East Brunswick',
    EW: 'East Windsor', EMRSN: 'Emerson', Flemington: 'Flemington',
    HAM: 'Hamilton', HWL: 'Howell', MAN: 'Manalapan', MAT: 'Matawan',
    MET: 'Metuchen', Middletown: 'Middletown', Newtown: 'Newtown',
    Piscataway: 'Piscataway', SEWELL: 'Sewell', SHRW: 'Shrewsbury',
    SMST: 'Somerset', SMRVL: 'Somerville', SPRTA: 'Sparta', TR: 'Toms River',
    UpperDublin: 'Upper Dublin', Warren: 'Warren', WayneNJ: 'Wayne',
    WDBRDGE: 'Woodbridge',
  },

  // Seeds the Roster tab on the first run. After that the Roster tab wins:
  // edit it there. "Taken By" = first names as typed in the NPS (several
  // allowed, comma-separated). "Note tags" = how they sign UL notes:
  // [MARI] -> MARI, "-BV" -> BV.
  DEFAULT_ROSTER: [
    { pcc: "Damian O'Loughlin", clinic: 'Brick', takenBy: 'Damian', tags: '' },
    { pcc: 'Tiago Capela', clinic: 'East Brunswick', takenBy: 'Tiago', tags: 'TC' },
    { pcc: 'Emily Freire', clinic: 'East Windsor', takenBy: 'Emily', tags: 'EMILY' },
    { pcc: '', clinic: 'Flemington', takenBy: '', tags: '' },
    { pcc: 'Kim Collins', clinic: 'Metuchen', takenBy: 'Kim', tags: 'KC' },
    { pcc: 'Brandon Vargas', clinic: 'Metuchen', takenBy: 'Brandon', tags: 'BV' },
    { pcc: 'Alexa Quintanilla', clinic: 'Somerset', takenBy: 'Alexa', tags: 'AQ' },
    { pcc: 'Chris Noriega', clinic: 'Somerville', takenBy: 'Chris', tags: 'CN' },
    { pcc: 'Mariela Ponce', clinic: 'Toms River', takenBy: 'Mariela', tags: 'MARI, MP' },
    { pcc: 'Leah Carpenter', clinic: 'Upper Dublin', takenBy: 'Leah', tags: 'LC' },
  ],

  // UL note signatures that belong to people who are NOT the clinic's PCC
  // (central schedulers, offshore, clinicians). Notes signed with these are
  // not credited to anyone.
  OTHER_STAFF_TAGS: ['JEROME', 'JIBRIL', 'AS', 'SS', 'CW', 'PR', 'DL'],

  // "Taken By" values that are channels, not people.
  NOT_PEOPLE: ['auto', 'ai agent', 'voicemail', 'vm', 'weave', 'text'],

  // "Taken By" values that are a clinic name rather than a person. Some
  // PCCs type these instead of their name (Somerset, EB). Credited to that
  // clinic's PCC as "probable".
  CLINIC_TAKEN_BY: {
    'brick': 'Brick', 'eb clinic': 'East Brunswick', 'east brunswick': 'East Brunswick',
    'east windsor': 'East Windsor', 'ew clinic': 'East Windsor', 'flemington': 'Flemington',
    'metuchen': 'Metuchen', 'somerset': 'Somerset', 'somerset clinic': 'Somerset',
    'somerville': 'Somerville', 'toms river': 'Toms River', 'tr clinic': 'Toms River',
    'ud clinic': 'Upper Dublin', 'upper dublin': 'Upper Dublin',
  },

  // When to run (script time zone). 1 = Monday … 7 = Sunday.
  RUN_DAYS: [1, 2, 3, 4, 5, 6],
  RUN_FROM_HOUR: 7,
  RUN_TO_HOUR: 19,
  TRIGGER_EVERY_MINUTES: 15,

  // Email. Leave NOTIFY_EMAILS empty to send to yourself (the account the
  // script runs as). Set NOTIFY to false to rely on the sheet only.
  NOTIFY: true,
  NOTIFY_EMAILS: [],
  // These events send an email (batched: at most one email per
  // NOTIFY_EVERY_MINUTES). Everything else rides along in the next email
  // and the end-of-day summary.
  NOTIFY_ON: ['new_entry', 'claimed_lead', 'new_patient'],
  NOTIFY_EVERY_MINUTES: 30,
  // Weekdays at this hour: one email listing PCC clinics with no activity
  // yet today. Set to null to turn off.
  QUIET_CHECK_HOUR: 13,
  // Weekdays at this hour: one end-of-day summary email. null = off.
  DAY_SUMMARY_HOUR: 16,

  // Activity rows older than this are deleted.
  LOG_DAYS_KEPT: 60,
};

var SECRET_PROPERTY = 'PCC_WATCH_SECRET';
var OUTPUT_ID_PROPERTY = 'PCC_WATCH_OUTPUT_ID';
var STATE_ID_PROPERTY = 'PCC_WATCH_STATE_FILE_ID';
var STATE_VERSION = 1;
var HUDDLE_ALL_TAB = 'All PCC Clinics';
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// What each event means. `counter` is its column on the Today tab.
var EVENT_TYPES = {
  new_entry: { source: 'NPS', label: 'New patient on the NPS', counter: 'npsNew' },
  claimed_lead: { source: 'NPS', label: 'Claimed a web / AI lead on the NPS', counter: 'npsClaimed' },
  new_patient: { source: 'UL', label: 'Added a patient to the UL', counter: 'ulNew' },
  scheduled: { source: 'UL', label: 'Scheduled visits on the UL', counter: 'ulScheduled' },
  note: { source: 'UL', label: 'Added a UL care note', counter: 'ulNotes' },
  reason: { source: 'UL', label: 'Set a reason not scheduled', counter: 'ulReasons' },
  booked: { source: 'Huddle', label: 'Marked "Booked?" on the Huddle', counter: 'booked' },
  collected: { source: 'Collections', label: 'Marked "Collected?"', counter: 'collected' },
  info: { source: 'Watcher', label: 'Note', counter: null },
};
var COUNTERS = ['npsNew', 'npsClaimed', 'ulNew', 'ulScheduled', 'ulNotes', 'ulReasons', 'booked', 'collected'];

var ACTIVITY_HEADERS = ['When', 'PCC', 'Clinic', 'Source', 'What', 'Detail', 'Row', 'How we know'];
var ROSTER_HEADERS = ['PCC', 'Clinic', 'NPS "Taken By" names', 'UL note tags', 'Active (Y/N)'];
var TODAY_HEADERS = [
  'Clinic', 'PCC', 'NPS new', 'NPS leads claimed', 'UL patients added', 'UL visits scheduled',
  'UL notes', 'UL reasons set', 'Huddle: nothing booked', 'Marked booked', 'New IEs today',
  'Collect today (pts)', 'Collect today ($)', 'Marked collected', 'Yesterday collected',
  'Last activity', 'Heads-up',
];
var TODAY_HEADER_ROW = 4;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Run once. Creates the PCC Watch sheet and the secret, takes the first
 * (silent) snapshot of every source, and schedules runWatch every
 * CONFIG.TRIGGER_EVERY_MINUTES minutes.
 */
function setup() {
  getSecret();
  var output = getOutputSpreadsheet();
  ensureTabs(output);
  installTrigger();
  runWatchAt(new Date(), { force: true });
  Logger.log('PCC Watch is running. Open: ' + output.getUrl());
}

/** Trigger handler. Does nothing outside CONFIG.RUN_DAYS / RUN_FROM_HOUR–RUN_TO_HOUR. */
function runWatch() {
  runWatchAt(new Date(), {});
}

/** Manual run that ignores the run window (handy for testing). */
function runNow() {
  runWatchAt(new Date(), { force: true });
}

/** Re-schedules runWatch. Safe to run again after changing the interval. */
function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runWatch').timeBased().everyMinutes(CONFIG.TRIGGER_EVERY_MINUTES).create();
}

/** Stops the watcher (the sheet and the state file are left as they are). */
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runWatch') ScriptApp.deleteTrigger(t);
  });
}

/**
 * Forgets every snapshot. The next run re-baselines silently (no events),
 * e.g. after a sheet was restructured.
 */
function resetSnapshots() {
  var state = loadState();
  var fresh = newState();
  fresh.day = state.day;
  fresh.notify = state.notify;
  saveState(fresh);
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function runWatchAt(now, opts) {
  opts = opts || {};
  if (!opts.force && !inRunWindow(now)) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Previous run still going; skipping this one.');
    return;
  }
  try {
    var tz = Session.getScriptTimeZone();
    var output = getOutputSpreadsheet();
    ensureTabs(output);
    var ctx = {
      now: now,
      tz: tz,
      today: isoKey(now, tz),
      secret: getSecret(),
      roster: loadRoster(output),
      state: loadState(),
      events: [],
      errors: [],
    };
    rollDay(ctx);

    [
      ['NPS', watchNps],
      ['UL', watchUl],
      ['Huddle', watchHuddle],
      ['Patient Responsibility', watchResponsibility],
    ].forEach(function (w) {
      try {
        w[1](ctx);
      } catch (e) {
        ctx.errors.push(w[0] + ': ' + errorText(e));
      }
    });

    countEvents(ctx);
    writeActivity(output, ctx);
    writeToday(output, ctx);
    notify(output, ctx);
    saveState(ctx.state);
  } finally {
    lock.releaseLock();
  }
}

/** Is `now` inside the configured days/hours (script time zone)? */
function inRunWindow(now) {
  var tz = Session.getScriptTimeZone();
  var day = Number(Utilities.formatDate(now, tz, 'u'));
  var hour = Number(Utilities.formatDate(now, tz, 'H'));
  return CONFIG.RUN_DAYS.indexOf(day) !== -1 && hour >= CONFIG.RUN_FROM_HOUR && hour < CONFIG.RUN_TO_HOUR;
}

/** New day: reset today's counters and the once-a-day emails. */
function rollDay(ctx) {
  var day = ctx.state.day;
  if (day.date === ctx.today) return;
  ctx.state.day = {
    date: ctx.today, firstRun: ctx.now.getTime(), counts: {}, last: {}, seen: {}, quietSent: false, summarySent: false,
  };
  ctx.state.notify.pending = [];
}

// ---------------------------------------------------------------------------
// NPS
// ---------------------------------------------------------------------------

/**
 * Watches this month's NPS, last month's for the first few days of a
 * month, and next month's once Jenny creates it. A file or tab seen for the
 * first time is a silent baseline.
 */
function watchNps(ctx) {
  var inScope = {};
  npsMonths(ctx.now).forEach(function (month) {
    var file = findNpsFile(MONTH_NAMES[month.getMonth()], String(month.getFullYear()));
    if (!file) return;
    var id = file.getId();
    inScope[id] = true;
    var prev = ctx.state.nps[id];
    var updated = file.getLastUpdated().getTime();
    if (prev && prev.updated === updated) return;

    var ss = SpreadsheetApp.openById(id);
    var tz = ss.getSpreadsheetTimeZone();
    var cur = { updated: updated, tabs: {} };
    ss.getSheets().forEach(function (sheet) {
      var tab = readNpsTab(sheet, tz, ctx.secret);
      if (!tab) return;
      var name = sheet.getName();
      cur.tabs[name] = tab.rows;
      if (prev && prev.tabs[name]) diffNpsTab(ctx, prev.tabs[name], tab.rows, ss, sheet, tz);
    });
    ctx.state.nps[id] = cur;
  });
  Object.keys(ctx.state.nps).forEach(function (id) {
    if (!inScope[id]) delete ctx.state.nps[id];
  });
}

/** First of each month to watch: last month (early in the month), this month, next month. */
function npsMonths(now) {
  var tz = Session.getScriptTimeZone();
  var d = parseIsoDate(isoKey(now, tz));
  var months = [];
  if (d.getDate() <= CONFIG.NPS_PREVIOUS_MONTH_DAYS) months.push(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  months.push(new Date(d.getFullYear(), d.getMonth(), 1));
  months.push(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  return months;
}

/**
 * Snapshot of one NPS clinic tab: { rows: { key: { r, t, a } } }, or null if
 * the tab isn't a clinic tab. key = HMAC(patient name + call date) with an
 * occurrence suffix for exact duplicates; r = sheet row; t = normalized
 * "Taken By"; a = 1 when the call date carries a time of day (rows the web
 * form writes, as opposed to typed rows). Only Date, Taken By and Patient
 * Name are read.
 */
function readNpsTab(sheet, tz, secret) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.min(sheet.getLastColumn(), 26);
  if (width < 1) return null;
  var head = sheet.getRange(1, 1, Math.min(last, CONFIG.HEADER_SEARCH_ROWS), width).getValues();
  var h = findHeaderRow(head, { date: 'date', takenBy: 'taken by', patient: 'patient name' });
  if (!h) return null;

  var rows = {};
  var firstRow = h.row + 2;
  if (last < firstRow) return { rows: rows };
  var readWidth = Math.max(h.cols.date, h.cols.takenBy, h.cols.patient) + 1;
  var values = sheet.getRange(firstRow, 1, last - firstRow + 1, readWidth).getValues();
  var occ = {};
  values.forEach(function (row, i) {
    var name = normalizeName(row[h.cols.patient]);
    if (!name) return;
    var dateCell = row[h.cols.date];
    var day = toIsoKey(dateCell, tz) || String(dateCell).trim().toLowerCase();
    var key = occurrenceKey(occ, hmac(secret, 'nps|' + name + '|' + day));
    rows[key] = { r: firstRow + i, t: normalizeTakenBy(row[h.cols.takenBy]), a: isTimestamped(dateCell, tz) ? 1 : 0 };
  });
  return { rows: rows };
}

/**
 * Compares two snapshots of one NPS tab.
 *   - New row with a PCC in Taken By -> new_entry (claimed_lead if the web
 *     form wrote it and the PCC put their name on it before we looked).
 *   - New row with Taken By still blank -> decided when it's filled in.
 *   - Taken By goes from blank to a PCC -> new_entry; from "Auto" /
 *     "AI Agent" to a PCC -> claimed_lead.
 *   - A row whose key changed but kept its row number and Taken By is a
 *     corrected name or date, not a new entry.
 */
function diffNpsTab(ctx, before, now, ss, sheet, tz) {
  var removedAtRow = {};
  Object.keys(before).forEach(function (k) {
    if (!now[k]) removedAtRow[before[k].r] = before[k];
  });
  var tabName = sheet.getName();
  var tabClinic = CONFIG.NPS_CLINIC_TABS[tabName] || tabName;

  Object.keys(now).forEach(function (k) {
    var cur = now[k];
    var was = before[k];
    var type = null;
    if (!was) {
      var gone = removedAtRow[cur.r];
      if (gone && gone.t === cur.t) return;
      if (!cur.t) return;
      type = cur.a ? 'claimed_lead' : 'new_entry';
    } else if (cur.t === was.t) {
      return;
    } else if (!was.t) {
      type = cur.a ? 'claimed_lead' : 'new_entry';
    } else if (isChannelOnly(was.t)) {
      type = 'claimed_lead';
    } else {
      return;
    }
    var who = attributeTakenBy(ctx.roster, cur.t);
    if (!who) return;
    if (type === 'claimed_lead' && attributeTakenBy(ctx.roster, was ? was.t : '')) return;
    addEvent(ctx, {
      type: type,
      who: who,
      detail: tabClinic + ' tab',
      link: rowLink(ss, sheet, cur.r),
      linkLabel: tabName + ' row ' + cur.r,
    });
  });
}

/** Most recently updated spreadsheet whose title matches an NPS pattern. */
function findNpsFile(month, year) {
  var wanted = CONFIG.NPS_TITLE_PATTERNS.map(function (p) {
    return p.replace('{MONTH}', month).replace('{YEAR}', year).toLowerCase();
  });
  var query = "title contains '" + month + ' ' + year + "' and " +
    "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
  var it = DriveApp.searchFiles(query);
  var best = null;
  while (it.hasNext()) {
    var f = it.next();
    if (wanted.indexOf(f.getName().trim().toLowerCase()) === -1) continue;
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
  return best;
}

// ---------------------------------------------------------------------------
// UL
// ---------------------------------------------------------------------------

/**
 * Watches each PCC clinic's UL: this week's tab and future weeks' tabs. A
 * clinic seen for the first time, or a week tab seen for the first time
 * (usually last week's tab duplicated), is a silent baseline.
 */
function watchUl(ctx) {
  var monday = mondayOf(ctx.now, ctx.tz);
  var lastWatched = addDays(monday, 7 * CONFIG.UL_WEEKS_AHEAD);
  Object.keys(CONFIG.UL_FILES).forEach(function (clinic) {
    try {
      var id = CONFIG.UL_FILES[clinic];
      var updated = DriveApp.getFileById(id).getLastUpdated().getTime();
      var prev = ctx.state.ul[clinic];
      if (prev && prev.updated === updated) return;

      var ss = SpreadsheetApp.openById(id);
      var cur = { updated: updated, tabs: {} };
      ss.getSheets().forEach(function (sheet) {
        var name = sheet.getName();
        var week = parseUlTabDate(name);
        if (!week || week < monday || week > lastWatched) return;
        var tab = readUlTab(sheet, ctx.secret);
        if (!tab) return;
        cur.tabs[name] = tab.rows;
        if (!prev) return;
        if (!prev.tabs[name]) {
          addEvent(ctx, {
            type: 'info',
            who: clinicWho(ctx.roster, clinic),
            detail: 'Started watching UL tab ' + name + ' (' + Object.keys(tab.rows).length + ' patients)',
            link: rowLink(ss, sheet, 1),
            linkLabel: name,
          });
          return;
        }
        diffUlTab(ctx, clinic, prev.tabs[name], tab, ss, sheet);
      });
      ctx.state.ul[clinic] = cur;
    } catch (e) {
      ctx.errors.push('UL ' + clinic + ': ' + errorText(e));
    }
  });
}

/**
 * Snapshot of one UL week tab: { rows: { key: { r, d, n, i, s } }, notes }
 * key = HMAC(patient name) with an occurrence suffix; r = sheet row;
 * d = # SCHED; n = hashes of each care-note line; i = reason not scheduled
 * (dropdown value, first word only); s = hash of the row's fixed columns
 * (RX FREQ, RX END, POC END DATE, IE) used to spot a renamed row. `notes`
 * holds the note text in memory only (to read signature tags) and is
 * never saved.
 */
function readUlTab(sheet, secret) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.min(sheet.getLastColumn(), 26);
  if (width < 1) return null;
  var head = sheet.getRange(1, 1, Math.min(last, CONFIG.HEADER_SEARCH_ROWS), width).getValues();
  var h = findHeaderRow(head, {
    patient: 'patient name', sched: '# sched', notes: 'patient care notes',
    reason: 'reason not scheduled', rxFreq: 'rx freq', rxEnd: 'rx end', pocEnd: 'poc end date', ie: 'ie',
  });
  if (!h || h.cols.patient === null || h.cols.sched === null) return null;

  var rows = {};
  var notes = {};
  var firstRow = h.row + 2;
  if (last < firstRow) return { rows: rows, notes: notes };
  var readWidth = 0;
  Object.keys(h.cols).forEach(function (k) {
    if (h.cols[k] !== null) readWidth = Math.max(readWidth, h.cols[k] + 1);
  });
  var values = sheet.getRange(firstRow, 1, last - firstRow + 1, readWidth).getValues();
  var occ = {};
  values.forEach(function (row, i) {
    var name = normalizeName(row[h.cols.patient]);
    if (!name) return;
    var key = occurrenceKey(occ, hmac(secret, 'ul|' + name));
    var noteText = h.cols.notes === null ? '' : String(row[h.cols.notes] || '');
    var fixed = ['rxFreq', 'rxEnd', 'pocEnd', 'ie'].map(function (c) {
      return h.cols[c] === null ? '' : cellKey(row[h.cols[c]]);
    }).join('|');
    rows[key] = {
      r: firstRow + i,
      d: toNumber(row[h.cols.sched]) || 0,
      n: noteLineHashes(secret, noteText),
      i: h.cols.reason === null ? '' : reasonWord(row[h.cols.reason]),
      s: hmac(secret, 'ulrow|' + fixed).substring(0, 8),
    };
    notes[key] = noteText;
  });
  return { rows: rows, notes: notes };
}

/**
 * Compares two snapshots of one UL week tab. Rows are matched by key, so
 * re-sorting (Brick re-sorts by status after every edit) is harmless.
 *   - New patient row -> new_patient (unless a row with identical fixed
 *     columns disappeared at the same time: a corrected name).
 *   - # SCHED went up -> scheduled.
 *   - A care-note line that wasn't there before -> note, credited to the
 *     signer when the line carries a known tag, to nobody when it's signed
 *     by non-PCC staff, else to the clinic's PCC.
 *   - Reason not scheduled filled or changed -> reason.
 */
function diffUlTab(ctx, clinic, before, tab, ss, sheet) {
  var name = sheet.getName();
  var removedSig = {};
  Object.keys(before).forEach(function (k) {
    if (!tab.rows[k]) removedSig[before[k].s] = (removedSig[before[k].s] || 0) + 1;
  });

  Object.keys(tab.rows).forEach(function (k) {
    var cur = tab.rows[k];
    var was = before[k];
    var link = rowLink(ss, sheet, cur.r);
    var linkLabel = clinic + ' UL ' + name + ' row ' + cur.r;
    var lines = newNoteLines(ctx.secret, tab.notes[k], was ? was.n : []);
    var who = attributeUlLines(ctx.roster, clinic, lines);

    if (!was) {
      if (removedSig[cur.s]) {
        removedSig[cur.s]--;
        return;
      }
      if (!who) return;
      addEvent(ctx, {
        type: 'new_patient', who: who, link: link, linkLabel: linkLabel,
        detail: 'Week of ' + name + (cur.d ? ' · # SCHED ' + cur.d : ''),
      });
      return;
    }

    var clinicPcc = clinicWho(ctx.roster, clinic);
    if (cur.d > was.d) {
      addEvent(ctx, {
        type: 'scheduled', who: clinicPcc, link: link, linkLabel: linkLabel,
        detail: 'Week of ' + name + ' · # SCHED ' + was.d + ' → ' + cur.d,
      });
    }
    if (lines.length && who) {
      var tag = lines.tag ? ' · signed ' + lines.tag : '';
      addEvent(ctx, {
        type: 'note', who: who, link: link, linkLabel: linkLabel,
        detail: 'Week of ' + name + tag,
      });
    }
    if (cur.i && cur.i !== was.i) {
      addEvent(ctx, {
        type: 'reason', who: clinicPcc, link: link, linkLabel: linkLabel,
        detail: 'Week of ' + name + ' · ' + cur.i,
      });
    }
  });
}

/** "11.2.26" -> Date (local midnight), or null for any other tab name. */
function parseUlTabDate(name) {
  var m = String(name).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  var d = new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return d.getMonth() === Number(m[1]) - 1 ? d : null;
}

/** Hashes of each non-blank line of a care note. */
function noteLineHashes(secret, text) {
  return noteLines(text).map(function (line) {
    return hmac(secret, 'note|' + line.toLowerCase()).substring(0, 8);
  });
}

function noteLines(text) {
  return String(text || '').split(/\r?\n/).map(function (s) {
    return s.replace(/\s+/g, ' ').trim();
  }).filter(function (s) { return s; });
}

/**
 * Lines of `text` whose hash isn't in `oldHashes` (array of the new lines'
 * text, in memory only), with `.tag` = the first known signature tag found
 * in them (roster or OTHER_STAFF_TAGS), if any.
 */
function newNoteLines(secret, text, oldHashes) {
  var added = noteLines(text).filter(function (line) {
    return oldHashes.indexOf(hmac(secret, 'note|' + line.toLowerCase()).substring(0, 8)) === -1;
  });
  added.tag = '';
  for (var i = added.length - 1; i >= 0 && !added.tag; i--) {
    added.tag = knownTag(signatureTags(added[i]));
  }
  return added;
}

/** Candidate signature tags in a note line: [MARI], "- BV", "(PR 11/4)". */
function signatureTags(line) {
  var tags = [];
  var m;
  var bracket = /\[([A-Za-z]{2,12})\]/g;
  while ((m = bracket.exec(line)) !== null) tags.push(m[1].toUpperCase());
  var dash = /(?:^|\s)[-–]\s?([A-Za-z]{2,3})\b/g;
  while ((m = dash.exec(line)) !== null) tags.push(m[1].toUpperCase());
  var paren = /\(([A-Za-z]{2,3})\b[^)]*\)/g;
  while ((m = paren.exec(line)) !== null) tags.push(m[1].toUpperCase());
  return tags;
}

/** Last candidate that is a roster tag or a known other-staff tag, else ''. */
function knownTag(candidates) {
  var others = CONFIG.OTHER_STAFF_TAGS.map(function (t) { return t.toUpperCase(); });
  for (var i = candidates.length - 1; i >= 0; i--) {
    var t = candidates[i];
    if (others.indexOf(t) !== -1 || rosterByTag(t)) return t;
  }
  return '';
}

/** Who wrote these new note lines (null = non-PCC staff signed them). */
function attributeUlLines(roster, clinic, lines) {
  var tag = lines && lines.tag;
  if (tag) {
    var pcc = rosterByTag(tag, roster);
    if (!pcc) return null;
    return { pccs: [pcc], clinic: pcc.clinic, how: 'Signed note ' + tag };
  }
  return clinicWho(roster, clinic);
}

/** "Work", "Away", "See MD", ... (first word of a free-text value). */
function reasonWord(v) {
  var s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  var known = ['See MD', 'MD Hold'];
  for (var i = 0; i < known.length; i++) {
    if (s.toLowerCase().indexOf(known[i].toLowerCase()) === 0) return known[i];
  }
  return s.split(' ')[0].replace(/[^A-Za-z]/g, '').substring(0, 20);
}

// ---------------------------------------------------------------------------
// PCC Daily Huddle
// ---------------------------------------------------------------------------

/**
 * Watches "Booked? (PCC)" on each clinic tab's nothing-booked list (and the
 * All PCC Clinics copy) and "Collected?" on each clinic tab's pay table. The
 * morning rebuild (Summary A1 changes) is a silent baseline. Also keeps the
 * Summary numbers for the Today tab.
 */
function watchHuddle(ctx) {
  var st = ctx.state.huddle;
  var updated = DriveApp.getFileById(CONFIG.HUDDLE_ID).getLastUpdated().getTime();
  if (st.updated === updated) return;

  var ss = SpreadsheetApp.openById(CONFIG.HUDDLE_ID);
  var tz = ss.getSpreadsheetTimeZone();
  var summary = ss.getSheetByName('Summary');
  var summaryValues = summary ? summary.getDataRange().getValues() : [];
  var title = summaryValues.length ? String(summaryValues[0][0] || '').trim() : '';
  var clinics = rosterClinics(ctx.roster);
  var marks = {};

  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name === 'Summary') return;
    var isAll = name === HUDDLE_ALL_TAB;
    if (!isAll && clinics.indexOf(name) === -1) return;
    var values = sheet.getDataRange().getValues();
    readBookedSection(values, isAll ? null : name, ctx.secret, marks, ss, sheet);
    if (!isAll) readPaySection(values, name, ctx.secret, marks, ss, sheet, tz);
  });

  var rebuilt = title !== st.title;
  if (!rebuilt) diffMarks(ctx, st.marks || {}, marks);
  ctx.state.huddle = {
    title: title,
    updated: updated,
    targets: readHuddleSummary(summaryValues),
    marks: storedMarks(marks),
  };
}

/**
 * Nothing-booked list: header row has "Clinic" in A and a "Booked? (PCC)"
 * column; rows run until A is blank. `clinic` null = take it from column A
 * (the All PCC Clinics tab).
 */
function readBookedSection(values, clinic, secret, marks, ss, sheet) {
  var h = null;
  for (var r = 0; r < Math.min(values.length, CONFIG.HEADER_SEARCH_ROWS) && !h; r++) {
    if (lc(values[r][0]) !== 'clinic') continue;
    var bookedCol = indexWhere(values[r], function (v) { return lc(v).indexOf('booked?') === 0; });
    var acctCol = indexWhere(values[r], function (v) { return lc(v) === 'account #'; });
    if (bookedCol !== -1 && acctCol !== -1) h = { row: r, booked: bookedCol, acct: acctCol };
  }
  if (!h) return;
  for (var i = h.row + 1; i < values.length; i++) {
    var row = values[i];
    var rowClinic = clinic || String(row[0] || '').trim();
    if (!String(row[0] || '').trim()) break;
    var acct = String(row[h.acct] || '').trim();
    if (!acct) continue;
    var key = 'b|' + rowClinic + '|' + hmac(secret, 'acct|' + acct);
    var mark = lc(row[h.booked]);
    if (!marks[key] || (!marks[key].m && mark)) {
      marks[key] = { m: mark, clinic: rowClinic, link: rowLink(ss, sheet, i + 1), linkLabel: sheet.getName() + ' row ' + (i + 1) };
    }
  }
}

/**
 * Pay table: header row has "Time" in A and a "Collected?" column; data
 * rows have a time like "9:20 AM" in A. Keyed the same way as Patient
 * Responsibility's TODAY rows, so a mark in both places counts once.
 */
function readPaySection(values, clinic, secret, marks, ss, sheet, tz) {
  for (var r = 0; r < values.length; r++) {
    if (lc(values[r][0]) !== 'time') continue;
    var cols = payColumns(values[r]);
    if (cols.collected === -1 || cols.acct === -1) continue;
    var occ = {};
    for (var i = r + 1; i < values.length; i++) {
      var row = values[i];
      if (!isTimeCell(row[0], tz)) {
        if (String(row[0] || '').trim()) break;
        continue;
      }
      var key = payKey(secret, clinic, row, cols, occ, tz);
      marks[key] = {
        m: lc(row[cols.collected]),
        clinic: clinic,
        dollars: toNumber(row[cols.total]) || 0,
        link: rowLink(ss, sheet, i + 1),
        linkLabel: sheet.getName() + ' row ' + (i + 1),
      };
    }
  }
}

/** Summary tab: { clinic: { visits, nothingBooked, newIe, stillUnbooked, collectPts, collectDollars }, _label }. */
function readHuddleSummary(values) {
  var out = {};
  for (var r = 0; r < values.length; r++) {
    if (lc(values[r][0]) !== 'clinic') continue;
    var hdr = values[r].map(lc);
    var col = function (test) { return indexWhere(hdr, test); };
    var c = {
      visits: col(function (h) { return /visits$/.test(h) && h.charAt(0) !== '%'; }),
      nothingBooked: col(function (h) { return h.indexOf('nothing booked') === 0; }),
      newIe: col(function (h) { return h.indexOf('new pt') === 0; }),
      stillUnbooked: col(function (h) { return h.indexOf('still unbooked') === 0; }),
      collectPts: col(function (h) { return h.indexOf('patients to collect') === 0; }),
      collectDollars: col(function (h) { return h.indexOf('$ to collect') === 0; }),
    };
    out._label = c.nothingBooked === -1 ? '' : String(values[r][c.nothingBooked]).trim();
    for (var i = r + 1; i < values.length; i++) {
      var clinic = String(values[i][0] || '').trim();
      if (!clinic || clinic.toUpperCase() === 'TOTAL') break;
      var t = {};
      Object.keys(c).forEach(function (k) { t[k] = c[k] === -1 ? null : toNumber(values[i][c[k]]); });
      out[clinic] = t;
    }
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Patient Responsibility by Clinic
// ---------------------------------------------------------------------------

/**
 * Watches "Collected?" in each PCC clinic tab's TODAY and TOMORROW sections.
 * The morning rebuild (Summary A1 changes) is a silent baseline. Also keeps
 * today's to-collect numbers and yesterday's collection results (from
 * Prompt) for the Today tab.
 */
function watchResponsibility(ctx) {
  var st = ctx.state.pr;
  var updated = DriveApp.getFileById(CONFIG.RESPONSIBILITY_ID).getLastUpdated().getTime();
  if (st.updated === updated) return;

  var ss = SpreadsheetApp.openById(CONFIG.RESPONSIBILITY_ID);
  var tz = ss.getSpreadsheetTimeZone();
  var summary = ss.getSheetByName('Summary');
  var summaryValues = summary ? summary.getDataRange().getValues() : [];
  var title = summaryValues.length ? String(summaryValues[0][0] || '').trim() : '';
  var marks = {};

  rosterClinics(ctx.roster).forEach(function (clinic) {
    var sheet = ss.getSheetByName(clinic);
    if (!sheet) return;
    var values = sheet.getDataRange().getValues();
    for (var r = 0; r < values.length; r++) {
      var a = String(values[r][0] || '').trim();
      var section = a.indexOf('TODAY (') === 0 ? 'today' : a.indexOf('TOMORROW (') === 0 ? 'tomorrow' : null;
      if (!section) continue;
      var hdr = -1;
      for (var j = r + 1; j < Math.min(values.length, r + 4); j++) {
        if (lc(values[j][0]) === 'time') { hdr = j; break; }
      }
      if (hdr === -1) continue;
      var cols = payColumns(values[hdr]);
      if (cols.collected === -1 || cols.acct === -1) continue;
      var occ = {};
      for (var i = hdr + 1; i < values.length && isTimeCell(values[i][0], tz); i++) {
        var key = payKey(ctx.secret, clinic, values[i], cols, occ, tz) + (section === 'tomorrow' ? '|t' : '');
        marks[key] = {
          m: lc(values[i][cols.collected]),
          clinic: clinic,
          dollars: toNumber(values[i][cols.total]) || 0,
          tomorrow: section === 'tomorrow',
          link: rowLink(ss, sheet, i + 1),
          linkLabel: clinic + ' row ' + (i + 1),
        };
      }
    }
  });

  var rebuilt = title !== st.title;
  if (!rebuilt) diffMarks(ctx, st.marks || {}, marks);
  var sums = readResponsibilitySummary(summaryValues);
  ctx.state.pr = { title: title, updated: updated, today: sums.today, yesterday: sums.yesterday, marks: storedMarks(marks) };
}

/**
 * Summary tab -> { today: { clinic: { pts, dollars } }, yesterday: { clinic:
 * { label, should, collected, pct, notCollected } } }. The yesterday headers
 * carry the date ("11/03 Collected ($)"), so they're matched by suffix.
 */
function readResponsibilitySummary(values) {
  var out = { today: {}, yesterday: {} };
  for (var r = 0; r < values.length; r++) {
    if (lc(values[r][0]) !== 'clinic') continue;
    var hdr = values[r].map(lc);
    var col = function (test) { return indexWhere(hdr, test); };
    var c = {
      pts: col(function (h) { return h === 'patients today'; }),
      dollars: col(function (h) { return h.indexOf('total to collect today') === 0; }),
      should: col(function (h) { return /should have collected/.test(h); }),
      collected: col(function (h) { return /\scollected \(\$\)$/.test(h) && !/should/.test(h); }),
      pct: col(function (h) { return /% collected$/.test(h); }),
      notCollected: col(function (h) { return /not collected \(pts\)$/.test(h); }),
    };
    var label = c.collected === -1 ? '' : String(values[r][c.collected]).split(' ')[0];
    for (var i = r + 1; i < values.length; i++) {
      var clinic = String(values[i][0] || '').trim();
      if (!clinic || clinic.toUpperCase() === 'TOTAL') break;
      var get = function (k) { return c[k] === -1 ? null : toNumber(values[i][c[k]]); };
      out.today[clinic] = { pts: get('pts'), dollars: get('dollars') };
      out.yesterday[clinic] = {
        label: label, should: get('should'), collected: get('collected'),
        pct: get('pct'), notCollected: get('notCollected'),
      };
    }
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared: Huddle / Patient Responsibility marks
// ---------------------------------------------------------------------------

function payColumns(header) {
  var hdr = header.map(lc);
  return {
    acct: hdr.indexOf('account #'),
    visit: hdr.indexOf('visit type'),
    total: hdr.indexOf('total to collect'),
    collected: indexWhere(hdr, function (h) { return h.indexOf('collected?') === 0; }),
  };
}

function payKey(secret, clinic, row, cols, occ, tz) {
  var raw = [String(row[cols.acct] || '').trim(), timeText(row[0], tz),
    cols.visit === -1 ? '' : String(row[cols.visit] || '').trim().toLowerCase()].join('|');
  return 'c|' + clinic + '|' + occurrenceKey(occ, hmac(secret, 'pay|' + raw));
}

/**
 * Blank -> filled marks become booked / collected events. A patient counts
 * once per day even if marked in two places (clinic tab and All PCC
 * Clinics, Huddle and Patient Responsibility) or re-marked after a rebuild.
 */
function diffMarks(ctx, before, now) {
  Object.keys(now).forEach(function (key) {
    var cur = now[key];
    if (!cur.m || before[key] === cur.m) return;
    if (before[key]) return;
    var dayKey = key.replace(/\|t$/, '');
    if (ctx.state.day.seen[dayKey]) return;
    ctx.state.day.seen[dayKey] = 1;
    var booked = key.indexOf('b|') === 0;
    addEvent(ctx, {
      type: booked ? 'booked' : 'collected',
      who: clinicWho(ctx.roster, cur.clinic),
      link: cur.link,
      linkLabel: cur.linkLabel,
      dollars: booked ? 0 : cur.dollars,
      detail: booked
        ? 'Marked "' + cur.m + '"'
        : 'Marked "' + cur.m + '"' + (cur.dollars ? ' · $' + cur.dollars.toFixed(2) + ' to collect' : '') +
          (cur.tomorrow ? ' · tomorrow\'s new patient' : ''),
    });
  });
}

/** What's kept between runs: just the mark per key. */
function storedMarks(marks) {
  var out = {};
  Object.keys(marks).forEach(function (k) { out[k] = marks[k].m; });
  return out;
}

// ---------------------------------------------------------------------------
// Roster and attribution
// ---------------------------------------------------------------------------

/** Active roster rows: [{ pcc, clinic, names: ['mariela'], tags: ['MARI'] }]. */
function loadRoster(output) {
  var sheet = output.getSheetByName('Roster');
  var values = sheet.getDataRange().getValues();
  var roster = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var clinic = String(row[1] || '').trim();
    if (!clinic || lc(row[4]) === 'n') continue;
    roster.push({
      pcc: String(row[0] || '').trim(),
      clinic: clinic,
      names: splitList(row[2]).map(function (s) { return s.toLowerCase(); }),
      tags: splitList(row[3]).map(function (s) { return s.replace(/[\[\]\-\s]/g, '').toUpperCase(); }),
    });
  }
  CURRENT_ROSTER = roster;
  return roster;
}
var CURRENT_ROSTER = [];

function rosterClinics(roster) {
  var seen = {};
  roster.forEach(function (p) { seen[p.clinic] = true; });
  Object.keys(CONFIG.UL_FILES).forEach(function (c) { seen[c] = true; });
  return Object.keys(seen).sort();
}

function rosterByTag(tag, roster) {
  roster = roster || CURRENT_ROSTER;
  for (var i = 0; i < roster.length; i++) {
    if (roster[i].tags.indexOf(tag) !== -1) return roster[i];
  }
  return null;
}

/** Everyone at a clinic (a clinic can have two PCCs, e.g. Metuchen). */
function clinicWho(roster, clinic) {
  var pccs = roster.filter(function (p) { return p.clinic === clinic; });
  return { pccs: pccs, clinic: clinic, how: pccs.length > 1 ? 'Clinic (shared PCCs)' : 'Clinic' };
}

/**
 * Who a "Taken By" value names: a PCC by first name (any part of
 * "Auto/Emily", "Mariela/Lana", ...), or a clinic name typed instead of a
 * name ("Somerset", "EB Clinic") -> that clinic's PCC, "probable". null =
 * not a PCC (central schedulers, Auto, AI Agent, ...).
 */
function attributeTakenBy(roster, takenBy) {
  if (!takenBy) return null;
  var tokens = takenBy.split(/[\/,&+]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  var hits = [];
  tokens.forEach(function (tok) {
    var first = tok.split(' ')[0];
    roster.forEach(function (p) {
      if (p.names.indexOf(first) !== -1 && hits.indexOf(p) === -1) hits.push(p);
    });
  });
  if (hits.length) return { pccs: hits, clinic: hits[0].clinic, how: 'Taken By' };

  var candidates = [takenBy].concat(tokens);
  for (var i = 0; i < candidates.length; i++) {
    var clinic = CONFIG.CLINIC_TAKEN_BY[candidates[i]];
    if (clinic) {
      var who = clinicWho(roster, clinic);
      who.how = 'Probable (Taken By = clinic name)';
      return who;
    }
  }
  return null;
}

function isChannelOnly(takenBy) {
  var tokens = takenBy.split('/').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  return tokens.length > 0 && tokens.every(function (t) { return CONFIG.NOT_PEOPLE.indexOf(t) !== -1; });
}

function whoLabel(who) {
  var names = who.pccs.map(function (p) { return p.pcc; }).filter(function (n) { return n; });
  return names.length ? names.join(' / ') : who.clinic + ' PCC (name not set)';
}

// ---------------------------------------------------------------------------
// Events, Today tab, Activity tab
// ---------------------------------------------------------------------------

function addEvent(ctx, e) {
  ctx.events.push({
    at: ctx.now.getTime(),
    type: e.type,
    pcc: whoLabel(e.who),
    clinic: e.who.clinic,
    how: e.who.how,
    detail: e.detail || '',
    link: e.link || '',
    linkLabel: e.linkLabel || '',
    dollars: e.dollars || 0,
  });
}

function countEvents(ctx) {
  var day = ctx.state.day;
  ctx.events.forEach(function (e) {
    var counter = EVENT_TYPES[e.type].counter;
    if (!counter) return;
    var c = day.counts[e.clinic] = day.counts[e.clinic] || {};
    c[counter] = (c[counter] || 0) + 1;
    if (e.type === 'collected') c.collectedDollars = (c.collectedDollars || 0) + e.dollars;
    day.last[e.clinic] = e.at;
  });
}

/** Newest first. Rows older than CONFIG.LOG_DAYS_KEPT are deleted. */
function writeActivity(output, ctx) {
  var sheet = output.getSheetByName('Activity');
  if (ctx.events.length) {
    var rows = ctx.events.slice().reverse().map(function (e) {
      return [
        new Date(e.at), e.pcc, e.clinic, EVENT_TYPES[e.type].source, EVENT_TYPES[e.type].label,
        e.detail, e.link ? '=HYPERLINK("' + e.link + '","' + e.linkLabel.replace(/"/g, '') + '")' : '', e.how,
      ];
    });
    sheet.insertRowsAfter(1, rows.length);
    sheet.getRange(2, 1, rows.length, ACTIVITY_HEADERS.length).setValues(rows);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('ddd MM/dd h:mm am/pm');
  }
  var last = sheet.getLastRow();
  if (last < 2) return;
  var cutoff = ctx.now.getTime() - CONFIG.LOG_DAYS_KEPT * 24 * 60 * 60 * 1000;
  var whens = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < whens.length; i++) {
    var w = whens[i][0];
    if (w instanceof Date && w.getTime() < cutoff) {
      sheet.deleteRows(i + 2, last - (i + 1));
      break;
    }
  }
}

/** Rebuilds the Today tab: one row per PCC clinic. */
function writeToday(output, ctx) {
  var sheet = output.getSheetByName('Today');
  var tz = ctx.tz;
  var day = ctx.state.day;
  var targets = ctx.state.huddle.targets || {};
  var pr = ctx.state.pr || {};
  var hour = Number(Utilities.formatDate(ctx.now, tz, 'H'));
  var quietHour = CONFIG.QUIET_CHECK_HOUR === null || !watchedSinceMorning(ctx) ? 99 : CONFIG.QUIET_CHECK_HOUR;

  var rows = rosterClinics(ctx.roster).map(function (clinic) {
    var c = day.counts[clinic] || {};
    var t = targets[clinic] || {};
    var today = (pr.today || {})[clinic] || {};
    var y = (pr.yesterday || {})[clinic] || {};
    var total = activityTotal(c);
    var heads = [];
    if (!total && hour >= quietHour) heads.push('No activity yet today');
    if (t.nothingBooked && !c.booked) heads.push(t.nothingBooked + ' on the nothing-booked list, none marked');
    return [
      clinic,
      whoLabel(clinicWho(ctx.roster, clinic)),
      c.npsNew || 0, c.npsClaimed || 0, c.ulNew || 0, c.ulScheduled || 0, c.ulNotes || 0, c.ulReasons || 0,
      blankIfNull(t.nothingBooked), c.booked || 0, blankIfNull(t.newIe),
      blankIfNull(today.pts !== undefined ? today.pts : t.collectPts),
      blankIfNull(today.dollars !== undefined ? today.dollars : t.collectDollars),
      c.collected ? c.collected + (c.collectedDollars ? ' ($' + c.collectedDollars.toFixed(2) + ')' : '') : 0,
      y.should === null || y.should === undefined ? '' :
        '$' + Number(y.collected || 0).toFixed(2) + ' of $' + Number(y.should).toFixed(2) +
        (y.pct === null || y.pct === undefined ? '' : ' (' + Math.round(y.pct * 100) + '%)'),
      day.last[clinic] ? Utilities.formatDate(new Date(day.last[clinic]), tz, 'h:mm a') : '',
      heads.join('; '),
    ];
  });

  sheet.clear();
  sheet.getRange(1, 1).setValue('PCC Watch — ' + Utilities.formatDate(ctx.now, tz, 'EEE MM/dd/yyyy'))
    .setFontWeight('bold').setFontSize(13);
  var status = 'Updated ' + Utilities.formatDate(ctx.now, tz, 'h:mm a') + ' · checks every ' +
    CONFIG.TRIGGER_EVERY_MINUTES + ' min · ' +
    (ctx.errors.length ? 'PROBLEMS: ' + ctx.errors.join(' | ') : 'all sources read OK');
  sheet.getRange(2, 1).setValue(status).setFontColor(ctx.errors.length ? '#c00000' : '#666666');
  var headers = TODAY_HEADERS.slice();
  if (targets._label) headers[8] = 'Huddle: ' + targets._label;
  sheet.getRange(TODAY_HEADER_ROW, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff').setWrap(true);
  if (rows.length) sheet.getRange(TODAY_HEADER_ROW + 1, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(TODAY_HEADER_ROW);
  var notesRow = TODAY_HEADER_ROW + rows.length + 2;
  sheet.getRange(notesRow, 1, 3, 1).setValues([
    ['NPS counts are credited by the "Taken By" name. UL, Huddle and Collected? marks have no "entered by" column, so they are credited to the clinic\'s PCC (or to the signer of a UL note).'],
    ['Huddle and to-collect numbers come from Danielle\'s morning rebuilds; "Yesterday collected" is what Prompt recorded.'],
    ['Every event, with a link to its row, is on the Activity tab. Edit the Roster tab when PCCs change.'],
  ]).setFontColor('#666666');
}

/**
 * Has the watcher been running since early this morning? "No activity yet"
 * means nothing on the day you install it (or after a long outage).
 */
function watchedSinceMorning(ctx) {
  var first = ctx.state.day.firstRun;
  return !!first && Number(Utilities.formatDate(new Date(first), ctx.tz, 'H')) < CONFIG.RUN_FROM_HOUR + 3;
}

function activityTotal(c) {
  return COUNTERS.reduce(function (sum, k) { return sum + (c[k] || 0); }, 0);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Batches events into one email at most every NOTIFY_EVERY_MINUTES, sent
 * only when something in CONFIG.NOTIFY_ON happened. Plus, on weekdays, one
 * "no activity yet" email at QUIET_CHECK_HOUR and one summary at
 * DAY_SUMMARY_HOUR.
 */
function notify(output, ctx) {
  var st = ctx.state.notify;
  st.pending = st.pending.concat(ctx.events.filter(function (e) { return e.type !== 'info'; }));
  if (!CONFIG.NOTIFY) {
    st.pending = [];
    return;
  }
  var url = output.getUrl();
  var tz = ctx.tz;
  var hour = Number(Utilities.formatDate(ctx.now, tz, 'H'));
  var weekday = Number(Utilities.formatDate(ctx.now, tz, 'u')) <= 5;

  var headline = st.pending.some(function (e) { return CONFIG.NOTIFY_ON.indexOf(e.type) !== -1; });
  var due = !st.lastSent || ctx.now.getTime() - st.lastSent >= CONFIG.NOTIFY_EVERY_MINUTES * 60 * 1000;
  if (headline && due) {
    sendMail(digestSubject(st.pending), digestBody(st.pending, url, tz));
    st.lastSent = ctx.now.getTime();
    st.pending = [];
  }

  var day = ctx.state.day;
  if (weekday && CONFIG.QUIET_CHECK_HOUR !== null && hour >= CONFIG.QUIET_CHECK_HOUR && !day.quietSent &&
      watchedSinceMorning(ctx)) {
    day.quietSent = true;
    var quiet = rosterClinics(ctx.roster).filter(function (c) {
      return !activityTotal(day.counts[c] || {});
    });
    if (quiet.length) {
      sendMail('PCC Watch: no activity yet from ' + quiet.length + ' clinic' + (quiet.length > 1 ? 's' : ''),
        'As of ' + Utilities.formatDate(ctx.now, tz, 'h:mm a') + ', nothing new on the NPS, UL, Huddle or Collected? from:\n\n' +
        quiet.map(function (c) { return '  • ' + c + ' — ' + whoLabel(clinicWho(ctx.roster, c)); }).join('\n') +
        '\n\nToday by PCC: ' + url);
    }
  }

  if (weekday && CONFIG.DAY_SUMMARY_HOUR !== null && hour >= CONFIG.DAY_SUMMARY_HOUR && !day.summarySent) {
    day.summarySent = true;
    sendMail('PCC Watch: today\'s summary (' + Utilities.formatDate(ctx.now, tz, 'EEE MM/dd') + ')',
      summaryBody(ctx, url));
    st.pending = [];
  }
}

function digestSubject(events) {
  var parts = [];
  var seen = {};
  events.forEach(function (e) {
    if (CONFIG.NOTIFY_ON.indexOf(e.type) === -1) return;
    var k = e.pcc + '|' + EVENT_TYPES[e.type].source;
    if (seen[k]) { seen[k].n++; return; }
    seen[k] = { first: firstNames(e.pcc), source: EVENT_TYPES[e.type].source, n: 1 };
    parts.push(seen[k]);
  });
  return 'PCC Watch: ' + parts.map(function (p) {
    return p.first + ' +' + p.n + ' ' + p.source;
  }).join(' · ');
}

/** Grouped by PCC; new patients listed one by one, other work counted. */
function digestBody(events, url, tz) {
  var byPcc = {};
  var order = [];
  events.forEach(function (e) {
    var k = e.pcc + ' (' + e.clinic + ')';
    if (!byPcc[k]) { byPcc[k] = []; order.push(k); }
    byPcc[k].push(e);
  });
  var lines = [];
  order.forEach(function (k) {
    lines.push(k);
    var counted = {};
    byPcc[k].forEach(function (e) {
      if (CONFIG.NOTIFY_ON.indexOf(e.type) !== -1) {
        lines.push('  • ' + EVENT_TYPES[e.type].label + ' — ' + e.linkLabel + ' (' +
          Utilities.formatDate(new Date(e.at), tz, 'h:mm a') + ')' + (e.link ? '\n    ' + e.link : ''));
      } else {
        counted[e.type] = (counted[e.type] || 0) + 1;
      }
    });
    Object.keys(counted).forEach(function (t) {
      lines.push('  • ' + EVENT_TYPES[t].label + (counted[t] > 1 ? ' ×' + counted[t] : ''));
    });
    lines.push('');
  });
  lines.push('Today by PCC and every event: ' + url);
  return lines.join('\n');
}

function summaryBody(ctx, url) {
  var day = ctx.state.day;
  var targets = ctx.state.huddle.targets || {};
  var lines = ['PCC activity today (' + Utilities.formatDate(ctx.now, ctx.tz, 'EEE MM/dd') + ')', ''];
  rosterClinics(ctx.roster).forEach(function (clinic) {
    var c = day.counts[clinic] || {};
    var t = targets[clinic] || {};
    lines.push(clinic + ' — ' + whoLabel(clinicWho(ctx.roster, clinic)));
    lines.push('  NPS: ' + (c.npsNew || 0) + ' new, ' + (c.npsClaimed || 0) + ' leads claimed');
    lines.push('  UL: ' + (c.ulNew || 0) + ' patients added, ' + (c.ulScheduled || 0) + ' scheduled, ' +
      (c.ulNotes || 0) + ' notes, ' + (c.ulReasons || 0) + ' reasons');
    lines.push('  Huddle: ' + (c.booked || 0) + ' marked booked' +
      (t.nothingBooked ? ' of ' + t.nothingBooked + ' on the list' : '') +
      ' · Collected? marked: ' + (c.collected || 0));
    lines.push('');
  });
  lines.push('Details: ' + url);
  return lines.join('\n');
}

function firstNames(label) {
  return label.split(' / ').map(function (n) { return n.split(' ')[0]; }).join('/');
}

function sendMail(subject, body) {
  var to = CONFIG.NOTIFY_EMAILS.length ? CONFIG.NOTIFY_EMAILS.join(',') : Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: subject, body: body });
}

// ---------------------------------------------------------------------------
// Output sheet, roster seed, state
// ---------------------------------------------------------------------------

function getOutputSpreadsheet() {
  if (CONFIG.OUTPUT_SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.OUTPUT_SPREADSHEET_ID);
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(OUTPUT_ID_PROPERTY);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      Logger.log('Stored output sheet not reachable (' + e + '); creating a new one.');
    }
  }
  var ss = SpreadsheetApp.create(CONFIG.OUTPUT_TITLE);
  moveToFolder(ss.getId());
  props.setProperty(OUTPUT_ID_PROPERTY, ss.getId());
  Logger.log('Created output spreadsheet: ' + ss.getUrl());
  return ss;
}

/** Creates the Today / Activity / Roster tabs if they're missing. */
function ensureTabs(output) {
  if (!output.getSheetByName('Today')) output.insertSheet('Today', 0);
  if (!output.getSheetByName('Activity')) {
    var act = output.insertSheet('Activity', 1);
    act.getRange(1, 1, 1, ACTIVITY_HEADERS.length).setValues([ACTIVITY_HEADERS])
      .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
    act.setFrozenRows(1);
  }
  if (!output.getSheetByName('Roster')) {
    var roster = output.insertSheet('Roster', 2);
    var rows = [ROSTER_HEADERS].concat(CONFIG.DEFAULT_ROSTER.map(function (p) {
      return [p.pcc, p.clinic, p.takenBy, p.tags, 'Y'];
    }));
    roster.getRange(1, 1, rows.length, ROSTER_HEADERS.length).setValues(rows);
    roster.getRange(1, 1, 1, ROSTER_HEADERS.length)
      .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
    roster.setFrozenRows(1);
  }
  output.getSheets().forEach(function (s) {
    var n = s.getName();
    if (n !== 'Today' && n !== 'Activity' && n !== 'Roster' && s.getLastRow() === 0 && output.getSheets().length > 3) {
      output.deleteSheet(s);
    }
  });
}

function newState() {
  return {
    v: STATE_VERSION,
    nps: {},
    ul: {},
    huddle: { marks: {}, targets: {} },
    pr: { marks: {}, today: {}, yesterday: {} },
    day: { date: '', firstRun: 0, counts: {}, last: {}, seen: {}, quietSent: false, summarySent: false },
    notify: { lastSent: 0, pending: [] },
  };
}

function stateFile() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(STATE_ID_PROPERTY);
  if (id) {
    try {
      return DriveApp.getFileById(id);
    } catch (e) {
      Logger.log('State file not reachable (' + e + '); starting fresh.');
    }
  }
  var file = DriveApp.createFile(CONFIG.STATE_FILE_TITLE, JSON.stringify(newState()), MimeType.PLAIN_TEXT);
  moveToFolder(file.getId());
  props.setProperty(STATE_ID_PROPERTY, file.getId());
  return file;
}

function loadState() {
  var state;
  try {
    state = JSON.parse(stateFile().getBlob().getDataAsString());
  } catch (e) {
    state = null;
  }
  if (!state || state.v !== STATE_VERSION) state = newState();
  var fresh = newState();
  Object.keys(fresh).forEach(function (k) { if (!state[k]) state[k] = fresh[k]; });
  return state;
}

function saveState(state) {
  stateFile().setContent(JSON.stringify(state));
}

function moveToFolder(fileId) {
  if (!CONFIG.FOLDER_ID) return;
  DriveApp.getFileById(fileId).moveTo(DriveApp.getFolderById(CONFIG.FOLDER_ID));
}

/** The HMAC secret, created on first use. It never leaves Script Properties. */
function getSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty(SECRET_PROPERTY);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(SECRET_PROPERTY, secret);
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 12 hex chars of HMAC-SHA256(value) under `secret`. */
function hmac(secret, value) {
  var bytes = Utilities.computeHmacSha256Signature(value, secret);
  var hex = '';
  for (var i = 0; i < 6; i++) hex += ('0' + ((bytes[i] + 256) % 256).toString(16)).slice(-2);
  return hex;
}

/** base, base#2, base#3 ... for repeated identical rows. */
function occurrenceKey(occ, base) {
  occ[base] = (occ[base] || 0) + 1;
  return occ[base] > 1 ? base + '#' + occ[base] : base;
}

/**
 * Header row within `values` whose cells include every label in `want`
 * ({ key: 'label' }, case-insensitive exact match). Returns { row, cols }
 * with cols[key] = column index, or null. A label missing from the row is
 * only allowed for keys after the first three.
 */
function findHeaderRow(values, want) {
  var keys = Object.keys(want);
  var required = keys.slice(0, 3);
  for (var r = 0; r < values.length; r++) {
    var labels = values[r].map(lc);
    var cols = {};
    keys.forEach(function (k) {
      var idx = labels.indexOf(want[k]);
      cols[k] = idx === -1 ? null : idx;
    });
    var ok = required.every(function (k) { return cols[k] !== null; });
    if (ok) return { row: r, cols: cols };
  }
  return null;
}

/**
 * Patient name -> comparison form: lower case, single spaces, "Last, First"
 * turned into "first last", punctuation other than ' and - dropped.
 */
function normalizeName(v) {
  var s = String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return '';
  var comma = s.indexOf(',');
  if (comma !== -1) s = s.substring(comma + 1).trim() + ' ' + s.substring(0, comma).trim();
  return s.replace(/[^a-z0-9' \-]/g, '').replace(/\s+/g, ' ').trim();
}

/** "Mariela / Lana " -> "mariela/lana" */
function normalizeTakenBy(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
}

/** A date cell with a time of day (rows the web form writes). */
function isTimestamped(v, tz) {
  return v instanceof Date && !isNaN(v.getTime()) && Utilities.formatDate(v, tz, 'HH:mm:ss') !== '00:00:00';
}

/** A visit-time cell ("9:20 AM"); a real time value counts too. */
function isTimeCell(v, tz) {
  return /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(timeText(v, tz));
}

/** Visit time as "9:20 AM" whether the cell holds text or a time value. */
function timeText(v, tz) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'h:mm a').toUpperCase();
  return String(v || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Stable string for a cell (dates as yyyy-MM-dd). */
function cellKey(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : isoKey(v, Session.getScriptTimeZone());
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function splitList(v) {
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function lc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function indexWhere(arr, test) {
  for (var i = 0; i < arr.length; i++) if (test(arr[i])) return i;
  return -1;
}

function toNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? null : n;
}

function blankIfNull(v) {
  return v === null || v === undefined ? '' : v;
}

function rowLink(ss, sheet, row) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + row;
}

function errorText(e) {
  return String(e && e.message ? e.message : e).substring(0, 200);
}

function isoKey(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/**
 * Cell value -> 'yyyy-MM-dd', or null. Accepts real dates and typed text
 * like "11/4/26" or "11/04/2026".
 */
function toIsoKey(v, tz) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : isoKey(v, tz);
  var m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  var year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return year + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

function parseIsoDate(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday (local midnight) of the week containing `now` in `tz`. */
function mondayOf(now, tz) {
  var d = parseIsoDate(isoKey(now, tz));
  var dow = Number(Utilities.formatDate(now, tz, 'u'));
  return addDays(d, -(dow - 1));
}
