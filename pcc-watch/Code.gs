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

  // backfill() adds history from this date (yyyy-MM-dd). '' = the first
  // day of last month, so last month's and this month's NPS are covered.
  BACKFILL_FROM: '',
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
  ie_booked: { source: 'NPS', label: 'Booked the IE for an NPS patient', counter: 'npsIe' },
  new_patient: { source: 'UL', label: 'Added a patient to the UL', counter: 'ulNew' },
  scheduled: { source: 'UL', label: 'Scheduled visits on the UL', counter: 'ulScheduled' },
  note: { source: 'UL', label: 'Added a UL care note', counter: 'ulNotes' },
  reason: { source: 'UL', label: 'Set a reason not scheduled', counter: 'ulReasons' },
  booked: { source: 'Huddle', label: 'Marked booked on the Huddle', counter: 'booked' },
  not_booked: { source: 'Huddle', label: 'Worked the Huddle list: not booked', counter: 'bookedNo' },
  collected: { source: 'Collections', label: 'Marked collected', counter: 'collected' },
  not_collected: { source: 'Collections', label: 'Marked nothing collected', counter: 'collectedNo' },
  info: { source: 'Watcher', label: 'Note', counter: null },
};
var COUNTERS = ['npsNew', 'npsClaimed', 'npsIe', 'ulNew', 'ulScheduled', 'ulNotes', 'ulReasons', 'booked', 'bookedNo',
  'collected', 'collectedNo'];

// "Booked?" and "Collected?" are free text in places, so only these classes
// are ever stored or shown — never what someone typed.
var COLLECTED_CLASSES = ['yes - full', 'partial', 'card on file', '$0 owed', 'no'];
var COLLECTED_COUNTS_AS_COLLECTED = ['yes - full', 'partial', 'card on file'];
// Collected? classes as the dropdown spells them.
var COLLECTED_LABELS = {
  'yes - full': 'Yes - Full', 'partial': 'Partial', 'card on file': 'Card on File', '$0 owed': '$0 Owed', 'no': 'No',
};

// REASON NOT SCHEDULED dropdown values. Anything else is logged as "Other".
var UL_REASONS = ['See MD', 'MD Hold', 'Hospitalized', 'Transportation', 'Work', 'Away', 'Sick', 'Auth'];

var VALID_TRIGGER_MINUTES = [1, 5, 10, 15, 30];

// The last four columns feed the dashboard: event type, the clinic the
// patient is for (an NPS entry can be typed in another clinic's tab), the
// IE date when known, and the raw row link.
// "Backfilled" is "date" for history added by backfill() with only a date
// known, "time" when the time of day is known too, blank for live events.
var ACTIVITY_HEADERS = ['When', 'PCC', 'Clinic', 'Source', 'What', 'Detail', 'Row', 'How we know',
  'Type', 'Patient clinic', 'IE date', 'Link', 'Backfilled'];
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
  ownerOnly_();
  getSecret_();
  var output = getOutputSpreadsheet_();
  ensureTabs_(output);
  installTrigger();
  runWatchAt_(new Date(), { force: true });
  Logger.log('PCC Watch is running. Data sheet: ' + output.getUrl());
  Logger.log('For the dashboard: Deploy > New deployment > Web app (Execute as: Me, Who has access: Only myself).');
}

/** Trigger handler. Does nothing outside CONFIG.RUN_DAYS / RUN_FROM_HOUR–RUN_TO_HOUR. */
function runWatch() {
  // The trigger runs as you; a page visitor calling this does nothing.
  var active = Session.getActiveUser().getEmail();
  if (active && active.toLowerCase() !== Session.getEffectiveUser().getEmail().toLowerCase()) return;
  runWatchAt_(new Date(), {});
}

/** Manual run that ignores the run window (handy for testing). */
function runNow() {
  ownerOnly_();
  runWatchAt_(new Date(), { force: true });
}

/** Re-schedules runWatch. Safe to run again after changing the interval. */
function installTrigger() {
  ownerOnly_();
  if (VALID_TRIGGER_MINUTES.indexOf(CONFIG.TRIGGER_EVERY_MINUTES) === -1) {
    throw new Error('TRIGGER_EVERY_MINUTES must be one of ' + VALID_TRIGGER_MINUTES.join(', '));
  }
  removeTriggers();
  ScriptApp.newTrigger('runWatch').timeBased().everyMinutes(CONFIG.TRIGGER_EVERY_MINUTES).create();
}

/** Stops the watcher (the sheet and the state file are left as they are). */
function removeTriggers() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runWatch') ScriptApp.deleteTrigger(t);
  });
}

/**
 * Forgets every snapshot. The next run re-baselines silently (no events),
 * e.g. after a sheet was restructured.
 */
function resetSnapshots() {
  ownerOnly_();
  var fresh = newState_();
  try {
    var state = loadState_();
    fresh.day = state.day;
    fresh.notify = state.notify;
    fresh.backfill = state.backfill;
    fresh.ulLive = state.ulLive || {};
    Object.keys(state.nps || {}).forEach(function (id) {
      var old = state.nps[id];
      fresh.nps[id] = { month: old.month, tabs: {}, credited: old.credited || {}, backfilled: old.backfilled || {} };
    });
  } catch (e) {
    Logger.log('Old state unreadable (' + errorText_(e) + '); starting clean.');
  }
  saveState_(fresh);
}

/**
 * Use only if the PCC Watch sheet was deleted: forgets it, and the next
 * setup() creates a new one (with a fresh Roster tab to fill in again).
 */
function forgetOutputSheet() {
  ownerOnly_();
  PropertiesService.getScriptProperties().deleteProperty(OUTPUT_ID_PROPERTY);
}

/**
 * Anyone who can open the dashboard can call this script's public functions
 * through the page (every helper ends in "_" so it can't be called). The
 * admin functions above are for you, from the editor, so they refuse anyone
 * else.
 */
function ownerOnly_() {
  var active = Session.getActiveUser().getEmail();
  var owner = Session.getEffectiveUser().getEmail();
  if (!active || active.toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error('Only the owner of PCC Watch can run this.');
  }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function runWatchAt_(now, opts) {
  opts = opts || {};
  if (!opts.force && !inRunWindow_(now)) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('Previous run still going; skipping this one.');
    return;
  }
  try {
    var tz = Session.getScriptTimeZone();
    var output = getOutputSpreadsheet_();
    ensureTabs_(output);
    var ctx = {
      now: now,
      tz: tz,
      today: isoKey_(now, tz),
      secret: getSecret_(),
      roster: loadRoster_(output),
      state: loadState_(),
      events: [],
      errors: [],
    };
    rollDay_(ctx);
    if (!ctx.state.startedDay) ctx.state.startedDay = isoKey_(new Date(installedAt_()), tz);

    // A watcher that fails part-way keeps its old snapshot, so its events
    // are dropped here and found again on the next run (never logged twice).
    [
      ['NPS', watchNps_],
      ['UL', watchUl_],
      ['Huddle', watchHuddle_],
      ['Patient Responsibility', watchResponsibility_],
    ].forEach(function (w) {
      guarded_(ctx, w[0], function () { w[1](ctx); });
    });

    // Activity is the record: if writing it fails, nothing is saved and the
    // next run retries. After it's written, the snapshot must be saved.
    countEvents_(ctx);
    writeActivity_(output, ctx);
    try {
      notify_(output, ctx);
    } catch (e) {
      ctx.errors.push('Email: ' + errorText_(e));
    }
    try {
      writeToday_(output, ctx);
    } catch (e) {
      Logger.log('Today tab not updated: ' + errorText_(e));
    }
    ctx.state.lastRun = { at: now.getTime(), errors: ctx.errors };
    saveState_(ctx.state);
  } finally {
    lock.releaseLock();
  }
}

/** Is `now` inside the configured days/hours (script time zone)? */
function inRunWindow_(now) {
  var tz = Session.getScriptTimeZone();
  var day = Number(Utilities.formatDate(now, tz, 'u'));
  var hour = Number(Utilities.formatDate(now, tz, 'H'));
  return CONFIG.RUN_DAYS.indexOf(day) !== -1 && hour >= CONFIG.RUN_FROM_HOUR && hour < CONFIG.RUN_TO_HOUR;
}

/**
 * Runs `fn` (one source, or one file of a source). If it throws, the events
 * it added and its per-day dedupe marks are rolled back and the error is
 * shown on the Today tab; the source's old snapshot stays, so the next run
 * finds the same changes again.
 */
function guarded_(ctx, label, fn) {
  var events = ctx.events.length;
  var seen = JSON.stringify(ctx.state.day.seen);
  try {
    fn();
  } catch (e) {
    ctx.events.length = events;
    ctx.state.day.seen = JSON.parse(seen);
    ctx.errors.push(label + ': ' + errorText_(e));
  }
}

/**
 * New day: reset today's counters and the once-a-day emails. New-patient
 * events found after the last email of yesterday are kept so they still
 * go out (first thing this morning).
 */
function rollDay_(ctx) {
  var day = ctx.state.day;
  if (day.date === ctx.today) return;
  ctx.state.day = {
    date: ctx.today, firstRun: ctx.now.getTime(), counts: {}, last: {}, seen: {}, quietSent: false, summarySent: false,
  };
  ctx.state.notify.pending = ctx.state.notify.pending.filter(isHeadline_);
}

// ---------------------------------------------------------------------------
// NPS
// ---------------------------------------------------------------------------

/**
 * Watches this month's NPS, last month's for the first few days of a
 * month, and next month's once Jenny creates it. A file or tab seen for the
 * first time is a silent baseline. Only the clinic tabs in
 * CONFIG.NPS_CLINIC_TABS are read.
 */
function watchNps_(ctx) {
  var inScope = {};
  var thisMonth = parseIsoDate_(ctx.today).getMonth();
  var todayDate = parseIsoDate_(ctx.today);
  var oldestKept = monthKey_(new Date(todayDate.getFullYear(), todayDate.getMonth() - 4, 1));
  npsMonths_(ctx.now).forEach(function (month) {
    var label = MONTH_NAMES[month.getMonth()] + ' ' + month.getFullYear();
    var file = findNpsFile_(MONTH_NAMES[month.getMonth()], String(month.getFullYear()));
    if (!file) {
      if (month.getMonth() === thisMonth) {
        ctx.errors.push('NPS: no "' + label + ' New Patient Spreadsheet" visible to this account');
      }
      return;
    }
    var id = file.getId();
    inScope[id] = true;
    guarded_(ctx, 'NPS ' + label, function () {
      var prev = ctx.state.nps[id];
      var updated = file.getLastUpdated().getTime();
      if (prev && prev.updated === updated) return;

      var ss = SpreadsheetApp.openById(id);
      var tz = ss.getSpreadsheetTimeZone();
      // `credited`: rows already credited to a PCC this month, so clearing
      // and restoring a row (or a duplicate shifting) never credits it twice.
      var cur = {
        month: monthKey_(month), updated: updated, tabs: {},
        credited: (prev && prev.credited) || {}, backfilled: (prev && prev.backfilled) || {},
      };
      ss.getSheets().forEach(function (sheet) {
        var name = sheet.getName();
        if (!CONFIG.NPS_CLINIC_TABS[name]) return;
        var tab = readNpsTab_(sheet, tz, ctx.secret);
        if (!tab) return;
        cur.tabs[name] = tab.rows;
        if (prev && prev.tabs[name]) diffNpsTab_(ctx, prev.tabs[name], tab.rows, ss, sheet, cur.credited, cur.backfilled);
      });
      ctx.state.nps[id] = cur;
    });
  });
  // A month out of scope: drop its snapshot but keep which rows were
  // credited, so a later backfill() never credits them twice. Forgotten
  // after about four months.
  Object.keys(ctx.state.nps).forEach(function (id) {
    if (inScope[id]) return;
    var old = ctx.state.nps[id];
    if (old.month && old.month < oldestKept) {
      delete ctx.state.nps[id];
      return;
    }
    ctx.state.nps[id] = { month: old.month, tabs: {}, credited: old.credited || {}, backfilled: old.backfilled || {} };
  });
}

/** "2026-10" for any date in October 2026. */
function monthKey_(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

/** First of each month to watch: last month (early in the month), this month, next month. */
function npsMonths_(now) {
  var tz = Session.getScriptTimeZone();
  var d = parseIsoDate_(isoKey_(now, tz));
  var months = [];
  if (d.getDate() <= CONFIG.NPS_PREVIOUS_MONTH_DAYS) months.push(new Date(d.getFullYear(), d.getMonth() - 1, 1));
  months.push(new Date(d.getFullYear(), d.getMonth(), 1));
  months.push(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  return months;
}

/**
 * Snapshot of one NPS clinic tab: { rows: { key: { r, t, a, ie, st } }, mem },
 * or null if the tab isn't a clinic tab. `mem` (call date and, for web-form
 * rows, time; for backfill()) is never saved. key = HMAC(patient name + call date)
 * with an occurrence suffix for exact duplicates; r = sheet row; t =
 * normalized "Taken By"; a = 1 when the call date carries a time of day
 * (rows the web form writes, as opposed to typed rows); ie = FS/IE Date as
 * yyyy-MM-dd ('' if none); st = Status (Active / Pending / Inactive, or '').
 */
function readNpsTab_(sheet, tz, secret) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.min(sheet.getLastColumn(), 26);
  if (width < 1) return null;
  var head = sheet.getRange(1, 1, Math.min(last, CONFIG.HEADER_SEARCH_ROWS), width).getValues();
  var h = findHeaderRow_(head, {
    date: 'date', takenBy: 'taken by', patient: 'patient name', ie: 'fs/ie date', status: 'status',
  });
  if (!h) return null;

  var rows = {};
  var mem = {};
  var firstRow = h.row + 2;
  if (last < firstRow) return { rows: rows, mem: mem };
  var readWidth = 0;
  Object.keys(h.cols).forEach(function (k) {
    if (h.cols[k] !== null) readWidth = Math.max(readWidth, h.cols[k] + 1);
  });
  var values = sheet.getRange(firstRow, 1, last - firstRow + 1, readWidth).getValues();
  var occ = {};
  values.forEach(function (row, i) {
    var name = normalizeName_(row[h.cols.patient]);
    if (!name) return;
    var dateCell = row[h.cols.date];
    var iso = toIsoKey_(dateCell, tz);
    var day = iso || String(dateCell).trim().toLowerCase();
    var key = occurrenceKey_(occ, hmac_(secret, 'nps|' + name + '|' + day));
    mem[key] = { day: iso || '', at: isTimestamped_(dateCell, tz) ? dateCell.getTime() : null };
    rows[key] = {
      r: firstRow + i,
      t: normalizeTakenBy_(row[h.cols.takenBy]),
      a: isTimestamped_(dateCell, tz) ? 1 : 0,
      ie: h.cols.ie === null ? '' : toIsoKey_(row[h.cols.ie], tz) || '',
      st: h.cols.status === null ? '' : statusWord_(row[h.cols.status]),
    };
  });
  return { rows: rows, mem: mem };
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
 *   - A row is credited at most once (`credited`, kept for the month).
 */
function diffNpsTab_(ctx, before, now, ss, sheet, credited, backfilled) {
  var removedAtRow = {};
  Object.keys(before).forEach(function (k) {
    if (!now[k]) removedAtRow[before[k].r] = { row: before[k], k: k };
  });
  var tabName = sheet.getName();
  var tabClinic = CONFIG.NPS_CLINIC_TABS[tabName] || tabName;

  Object.keys(now).forEach(function (k) {
    var cur = now[k];
    var was = before[k];
    var type = null;
    var base = tabName + '|' + k.split('#')[0];
    var where = { link: rowLink_(ss, sheet, cur.r), linkLabel: tabName + ' row ' + cur.r };
    // The IE date filled in later on a row a PCC was credited for.
    if (was && credited[base] && cur.ie && !was.ie && cur.t === was.t) {
      var owner = attributeTakenBy_(ctx.roster, cur.t);
      if (owner) {
        owner.how = 'Taken By (row owner)';
        addEvent_(ctx, {
          type: 'ie_booked', who: owner, forClinic: tabClinic, ie: cur.ie, link: where.link, linkLabel: where.linkLabel,
          detail: 'IE ' + shortDate_(cur.ie) + (cur.st ? ' · ' + cur.st : ''),
        });
      }
      return;
    }
    if (!was) {
      var gone = removedAtRow[cur.r];
      if (gone && gone.row.t === cur.t) {
        var oldBase = tabName + '|' + gone.k.split('#')[0];
        if (credited[oldBase]) credited[base] = 1;
        if (backfilled[oldBase]) backfilled[base] = 1;
        return;
      }
      if (!cur.t) return;
      type = cur.a ? 'claimed_lead' : 'new_entry';
    } else if (cur.t === was.t) {
      return;
    } else if (!was.t) {
      type = cur.a ? 'claimed_lead' : 'new_entry';
    } else if (isChannelOnly_(was.t)) {
      type = 'claimed_lead';
    } else {
      return;
    }
    var who = attributeTakenBy_(ctx.roster, cur.t);
    if (!who) return;
    if (type === 'claimed_lead' && attributeTakenBy_(ctx.roster, was ? was.t : '')) return;
    if (credited[base]) return;
    credited[base] = 1;
    addEvent_(ctx, {
      type: type,
      who: who,
      forClinic: tabClinic,
      ie: cur.ie,
      detail: 'For ' + tabClinic + ' · ' + (cur.ie ? 'IE ' + shortDate_(cur.ie) : 'no IE date yet') +
        (cur.st ? ' · ' + cur.st : ''),
      link: where.link,
      linkLabel: where.linkLabel,
    });
  });
}

/** Most recently updated spreadsheet whose title matches an NPS pattern. */
function findNpsFile_(month, year) {
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
function watchUl_(ctx) {
  var monday = mondayOf_(ctx.now, ctx.tz);
  var lastWatched = addDays_(monday, 7 * CONFIG.UL_WEEKS_AHEAD);
  Object.keys(CONFIG.UL_FILES).forEach(function (clinic) {
    guarded_(ctx, 'UL ' + clinic, function () {
      var id = CONFIG.UL_FILES[clinic];
      var updated = DriveApp.getFileById(id).getLastUpdated().getTime();
      var prev = ctx.state.ul[clinic];
      if (prev && prev.updated === updated) return;

      var ss = SpreadsheetApp.openById(id);
      var tz = ss.getSpreadsheetTimeZone();
      var cur = { updated: updated, tabs: {} };
      ss.getSheets().forEach(function (sheet) {
        var name = sheet.getName();
        var week = parseUlTabDate_(name);
        if (!week || week < monday || week > lastWatched) return;
        var tab = readUlTab_(sheet, ctx.secret, tz);
        if (!tab) return;
        cur.tabs[name] = tab.rows;
        if (!prev) return;
        if (!prev.tabs[name]) {
          addEvent_(ctx, {
            type: 'info',
            who: clinicWho_(ctx.roster, clinic),
            detail: 'Started watching UL tab ' + name + ' (' + Object.keys(tab.rows).length + ' patients)',
            link: rowLink_(ss, sheet, 1),
            linkLabel: name,
          });
          return;
        }
        diffUlTab_(ctx, clinic, prev.tabs[name], tab, ss, sheet);
      });
      ctx.state.ul[clinic] = cur;
    });
    // Checked every run, not just when the file changed (e.g. the 2026 file
    // after the year ends): a UL with no tab for this week is a blind spot.
    var st = ctx.state.ul[clinic];
    if (st && !Object.keys(st.tabs).some(function (n) { return parseUlTabDate_(n) >= monday; })) {
      ctx.errors.push('UL ' + clinic + ': no tab for this week or later');
    }
  });
}

/**
 * Snapshot of one UL week tab: { rows: { key: { r, d, n, i, s } }, lines }
 * key = HMAC(patient name) with an occurrence suffix; r = sheet row;
 * d = # SCHED; n = hashes of each care-note line; i = reason not scheduled
 * (one of UL_REASONS or "Other"); s = hash of RX END + POC END DATE + RX
 * FREQ + IE, only when a date is filled (new rows have none), used to spot
 * a renamed row. `lines` holds each row's note lines with their hashes in
 * memory only (to read signature tags) and is never saved.
 */
function readUlTab_(sheet, secret, tz) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var width = Math.min(sheet.getLastColumn(), 26);
  if (width < 1) return null;
  var head = sheet.getRange(1, 1, Math.min(last, CONFIG.HEADER_SEARCH_ROWS), width).getValues();
  var h = findHeaderRow_(head, {
    patient: 'patient name', sched: '# sched', notes: 'patient care notes',
    reason: 'reason not scheduled', rxFreq: 'rx freq', rxEnd: 'rx end', pocEnd: 'poc end date', ie: 'ie',
  });
  if (!h) return null;

  var rows = {};
  var lines = {};
  var firstRow = h.row + 2;
  if (last < firstRow) return { rows: rows, lines: lines };
  var readWidth = 0;
  Object.keys(h.cols).forEach(function (k) {
    if (h.cols[k] !== null) readWidth = Math.max(readWidth, h.cols[k] + 1);
  });
  var values = sheet.getRange(firstRow, 1, last - firstRow + 1, readWidth).getValues();
  var occ = {};
  var cell = function (row, c) { return h.cols[c] === null ? '' : cellKey_(row[h.cols[c]], tz); };
  values.forEach(function (row, i) {
    var name = normalizeName_(row[h.cols.patient]);
    if (!name) return;
    var key = occurrenceKey_(occ, hmac_(secret, 'ul|' + name));
    var noteLinesHashed = noteLines_(row[h.cols.notes]).map(function (text) {
      return { text: text, h: hmac_(secret, 'note|' + text.toLowerCase()).substring(0, 8) };
    });
    var dates = cell(row, 'rxEnd') + cell(row, 'pocEnd');
    rows[key] = {
      r: firstRow + i,
      d: toNumber_(row[h.cols.sched]) || 0,
      n: noteLinesHashed.map(function (l) { return l.h; }),
      i: h.cols.reason === null ? '' : reasonWord_(row[h.cols.reason]),
      s: dates ? hmac_(secret, 'ulrow|' + [cell(row, 'rxFreq'), cell(row, 'rxEnd'), cell(row, 'pocEnd'),
        cell(row, 'ie')].join('|')).substring(0, 8) : '',
    };
    lines[key] = noteLinesHashed;
  });
  return { rows: rows, lines: lines };
}

/**
 * Compares two snapshots of one UL week tab. Rows are matched by key, so
 * re-sorting (Brick re-sorts by status after every edit) is harmless.
 *   - New patient row -> new_patient, once per clinic per day even if it's
 *     added to this week's and next week's tab (unless a row with the same
 *     dates disappeared at the same time: a corrected name).
 *   - # SCHED went up -> scheduled.
 *   - A care-note line that wasn't there before -> note.
 *   - Reason not scheduled filled or changed -> reason.
 * Who: the signer of a note line added with the change when it carries a
 * Roster tag; nobody when it's signed by non-PCC staff (OTHER_STAFF_TAGS);
 * otherwise the clinic's PCC.
 */
function diffUlTab_(ctx, clinic, before, tab, ss, sheet) {
  var name = sheet.getName();
  var removed = Object.keys(before).filter(function (k) { return !tab.rows[k]; }).map(function (k) {
    return before[k];
  });

  Object.keys(tab.rows).forEach(function (k) {
    var cur = tab.rows[k];
    var was = before[k];
    var lines = newNoteLines_(tab.lines[k] || [], was ? was.n : []);
    rememberLiveLines_(ctx, clinic, k, tab.lines[k] || [], was ? was.n : []);
    var who = attributeUlLines_(ctx.roster, clinic, lines);
    if (!who) return;
    var event = function (type, detail) {
      addEvent_(ctx, {
        type: type, who: who, detail: 'Week of ' + name + detail,
        link: rowLink_(ss, sheet, cur.r), linkLabel: clinic + ' UL ' + name + ' row ' + cur.r,
      });
    };

    if (!was) {
      if (takeRename_(removed, cur)) return;
      var dayKey = 'uln|' + clinic + '|' + k.split('#')[0];
      if (ctx.state.day.seen[dayKey]) return;
      ctx.state.day.seen[dayKey] = 1;
      event('new_patient', cur.d ? ' · # SCHED ' + cur.d : '');
      return;
    }
    if (cur.d > was.d) event('scheduled', ' · # SCHED ' + was.d + ' → ' + cur.d);
    if (lines.length) event('note', lines.tag ? ' · signed ' + lines.tag : '');
    if (cur.i && cur.i !== was.i) event('reason', ' · ' + cur.i);
  });
}

/**
 * Notes the new lines of a row that are dated on or before the day the
 * watcher started (typed after it started), so backfill() skips them.
 */
function rememberLiveLines_(ctx, clinic, key, lines, oldHashes) {
  var started = ctx.state.startedDay;
  if (!started) return;
  lines.forEach(function (l) {
    if (oldHashes.indexOf(l.h) !== -1) return;
    var day = noteLineDate_(l.text, ctx.today);
    if (day && day <= started) ctx.state.ulLive[clinic + '|' + key.split('#')[0] + '|' + l.h] = day;
  });
}

/** Removes and returns true for a vanished row with the same dates as `cur` (a renamed row). */
function takeRename_(removed, cur) {
  if (!cur.s) return false;
  for (var i = 0; i < removed.length; i++) {
    if (removed[i].s === cur.s) {
      removed.splice(i, 1);
      return true;
    }
  }
  return false;
}

/** "11.2.26" -> Date (local midnight), or null for any other tab name. */
function parseUlTabDate_(name) {
  var m = String(name).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  var d = new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return d.getMonth() === Number(m[1]) - 1 ? d : null;
}

/** Non-blank lines of a care note, whitespace collapsed. */
function noteLines_(text) {
  return String(text || '').split(/\r?\n/).map(function (s) {
    return s.replace(/\s+/g, ' ').trim();
  }).filter(function (s) { return s; });
}

/**
 * The note lines (from readUlTab_, in memory) whose hash isn't in
 * `oldHashes`, as text, with `.tag` = the last known signature tag in the
 * newest of them (a Roster tag or OTHER_STAFF_TAGS), or ''.
 */
function newNoteLines_(lines, oldHashes) {
  var added = lines.filter(function (l) { return oldHashes.indexOf(l.h) === -1; }).map(function (l) {
    return l.text;
  });
  added.tag = '';
  for (var i = added.length - 1; i >= 0 && !added.tag; i--) {
    added.tag = knownTag_(signatureTags_(added[i]));
  }
  return added;
}

/**
 * Candidate signature tags in a note line, left to right: [MARI] (any
 * case), "- BV" and "(PR 11/4)" (capitals only, so "- as discussed" or
 * "(as needed)" aren't read as initials).
 */
function signatureTags_(line) {
  var found = [];
  [/\[([A-Za-z]{2,12})\]/g, /(?:^|\s)[-–]\s?([A-Z]{2,3})\b/g, /\(([A-Z]{2,3})\b[^)]*\)/g].forEach(function (re) {
    var m;
    while ((m = re.exec(line)) !== null) found.push({ at: m.index, tag: m[1].toUpperCase() });
  });
  found.sort(function (a, b) { return a.at - b.at; });
  return found.map(function (f) { return f.tag; });
}

/** Last candidate that is a roster tag or a known other-staff tag, else ''. */
function knownTag_(candidates) {
  var others = CONFIG.OTHER_STAFF_TAGS.map(function (t) { return t.toUpperCase(); });
  for (var i = candidates.length - 1; i >= 0; i--) {
    var t = candidates[i];
    if (others.indexOf(t) !== -1 || rosterByTag_(t)) return t;
  }
  return '';
}

/** Who wrote these new note lines (null = non-PCC staff signed them). */
function attributeUlLines_(roster, clinic, lines) {
  var tag = lines && lines.tag;
  if (tag) {
    var pcc = rosterByTag_(tag, roster);
    if (!pcc) return null;
    return { pccs: [pcc], clinic: pcc.clinic, how: 'Signed note ' + tag };
  }
  return clinicWho_(roster, clinic);
}

/** The UL_REASONS value a cell starts with, "Other" for anything else, '' if blank. */
function reasonWord_(v) {
  var s = lc_(v);
  if (!s) return '';
  for (var i = 0; i < UL_REASONS.length; i++) {
    if (s.indexOf(UL_REASONS[i].toLowerCase()) === 0) return UL_REASONS[i];
  }
  return 'Other';
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
function watchHuddle_(ctx) {
  var st = ctx.state.huddle;
  var updated = DriveApp.getFileById(CONFIG.HUDDLE_ID).getLastUpdated().getTime();
  if (st.updated === updated) return;

  var ss = SpreadsheetApp.openById(CONFIG.HUDDLE_ID);
  var tz = ss.getSpreadsheetTimeZone();
  var summary = ss.getSheetByName('Summary');
  var summaryValues = summary ? summary.getDataRange().getValues() : [];
  var title = summaryValues.length ? String(summaryValues[0][0] || '').trim() : '';
  var clinics = rosterClinics_(ctx.roster);
  var marks = {};

  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (name === 'Summary') return;
    var isAll = name === HUDDLE_ALL_TAB;
    if (!isAll && clinics.indexOf(name) === -1) return;
    var values = sheet.getDataRange().getValues();
    readBookedSection_(values, isAll ? null : name, ctx.secret, marks, ss, sheet);
    if (!isAll) readPaySection_(values, name, ctx.secret, marks, ss, sheet, tz);
  });

  diffAfterRebuild_(ctx, st, title, marks);
  ctx.state.huddle = {
    title: title,
    date: titleDate_(title),
    updated: updated,
    targets: readHuddleSummary_(summaryValues),
    marks: storedMarks_(marks),
  };
}

/**
 * Nothing-booked list: header row has "Clinic" in A and a "Booked? (PCC)"
 * column; rows run until A is blank. `clinic` null = take it from column A
 * (the All PCC Clinics tab).
 */
function readBookedSection_(values, clinic, secret, marks, ss, sheet) {
  var h = null;
  for (var r = 0; r < Math.min(values.length, CONFIG.HEADER_SEARCH_ROWS) && !h; r++) {
    if (lc_(values[r][0]) !== 'clinic') continue;
    var bookedCol = indexWhere_(values[r], function (v) { return lc_(v).indexOf('booked?') === 0; });
    var acctCol = indexWhere_(values[r], function (v) { return lc_(v) === 'account #'; });
    if (bookedCol !== -1 && acctCol !== -1) h = { row: r, booked: bookedCol, acct: acctCol };
  }
  if (!h) return;
  for (var i = h.row + 1; i < values.length; i++) {
    var row = values[i];
    var rowClinic = clinic || String(row[0] || '').trim();
    if (!String(row[0] || '').trim()) break;
    var acct = String(row[h.acct] || '').trim();
    if (!acct) continue;
    var key = 'b|' + rowClinic + '|' + hmac_(secret, 'acct|' + acct);
    var mark = markClass_(row[h.booked], 'booked');
    if (!marks[key] || (!marks[key].m && mark)) {
      marks[key] = { m: mark, clinic: rowClinic, link: rowLink_(ss, sheet, i + 1), linkLabel: sheet.getName() + ' row ' + (i + 1) };
    }
  }
}

/**
 * Pay table: header row has "Time" in A and a "Collected?" column; data
 * rows have a time like "9:20 AM" in A. Keyed the same way as Patient
 * Responsibility's TODAY rows, so a mark in both places counts once.
 */
function readPaySection_(values, clinic, secret, marks, ss, sheet, tz) {
  for (var r = 0; r < values.length; r++) {
    if (lc_(values[r][0]) !== 'time') continue;
    var cols = payColumns_(values[r]);
    if (cols.collected === -1 || cols.acct === -1) continue;
    var occ = {};
    for (var i = r + 1; i < values.length; i++) {
      var row = values[i];
      if (!isTimeCell_(row[0], tz)) {
        if (String(row[0] || '').trim()) break;
        continue;
      }
      var key = payKey_(secret, clinic, row, cols, occ, tz);
      marks[key] = {
        m: markClass_(row[cols.collected], 'collected'),
        clinic: clinic,
        dollars: toNumber_(row[cols.total]) || 0,
        link: rowLink_(ss, sheet, i + 1),
        linkLabel: sheet.getName() + ' row ' + (i + 1),
      };
    }
  }
}

/** Summary tab: { clinic: { visits, nothingBooked, newIe, stillUnbooked, collectPts, collectDollars }, _label }. */
function readHuddleSummary_(values) {
  var out = {};
  for (var r = 0; r < values.length; r++) {
    if (lc_(values[r][0]) !== 'clinic') continue;
    var hdr = values[r].map(lc_);
    var col = function (test) { return indexWhere_(hdr, test); };
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
      Object.keys(c).forEach(function (k) { t[k] = c[k] === -1 ? null : toNumber_(values[i][c[k]]); });
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
function watchResponsibility_(ctx) {
  var st = ctx.state.pr;
  var updated = DriveApp.getFileById(CONFIG.RESPONSIBILITY_ID).getLastUpdated().getTime();
  if (st.updated === updated) return;

  var ss = SpreadsheetApp.openById(CONFIG.RESPONSIBILITY_ID);
  var tz = ss.getSpreadsheetTimeZone();
  var summary = ss.getSheetByName('Summary');
  var summaryValues = summary ? summary.getDataRange().getValues() : [];
  var title = summaryValues.length ? String(summaryValues[0][0] || '').trim() : '';
  var marks = {};

  rosterClinics_(ctx.roster).forEach(function (clinic) {
    var sheet = ss.getSheetByName(clinic);
    if (!sheet) return;
    var values = sheet.getDataRange().getValues();
    for (var r = 0; r < values.length; r++) {
      var a = String(values[r][0] || '').trim();
      var section = a.indexOf('TODAY (') === 0 ? 'today' : a.indexOf('TOMORROW (') === 0 ? 'tomorrow' : null;
      if (!section) continue;
      var hdr = -1;
      for (var j = r + 1; j < Math.min(values.length, r + 4); j++) {
        if (lc_(values[j][0]) === 'time') { hdr = j; break; }
      }
      if (hdr === -1) continue;
      var cols = payColumns_(values[hdr]);
      if (cols.collected === -1 || cols.acct === -1) continue;
      var occ = {};
      for (var i = hdr + 1; i < values.length && isTimeCell_(values[i][0], tz); i++) {
        var key = payKey_(ctx.secret, clinic, values[i], cols, occ, tz) + (section === 'tomorrow' ? '|t' : '');
        marks[key] = {
          m: markClass_(values[i][cols.collected], 'collected'),
          clinic: clinic,
          dollars: toNumber_(values[i][cols.total]) || 0,
          tomorrow: section === 'tomorrow',
          link: rowLink_(ss, sheet, i + 1),
          linkLabel: clinic + ' row ' + (i + 1),
        };
      }
    }
  });

  diffAfterRebuild_(ctx, st, title, marks);
  var sums = readResponsibilitySummary_(summaryValues);
  ctx.state.pr = {
    title: title, date: titleDate_(title), updated: updated, today: sums.today, yesterday: sums.yesterday,
    marks: storedMarks_(marks),
  };
}

/**
 * Summary tab -> { today: { clinic: { pts, dollars } }, yesterday: { clinic:
 * { label, should, collected, pct, notCollected } } }. The yesterday headers
 * carry the date ("11/03 Collected ($)"), so they're matched by suffix.
 */
function readResponsibilitySummary_(values) {
  var out = { today: {}, yesterday: {} };
  for (var r = 0; r < values.length; r++) {
    if (lc_(values[r][0]) !== 'clinic') continue;
    var hdr = values[r].map(lc_);
    var col = function (test) { return indexWhere_(hdr, test); };
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
      var get = function (k) { return c[k] === -1 ? null : toNumber_(values[i][c[k]]); };
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

function payColumns_(header) {
  var hdr = header.map(lc_);
  return {
    acct: hdr.indexOf('account #'),
    visit: hdr.indexOf('visit type'),
    total: hdr.indexOf('total to collect'),
    collected: indexWhere_(hdr, function (h) { return h.indexOf('collected?') === 0; }),
  };
}

function payKey_(secret, clinic, row, cols, occ, tz) {
  var raw = [String(row[cols.acct] || '').trim(), timeText_(row[0], tz),
    cols.visit === -1 ? '' : String(row[cols.visit] || '').trim().toLowerCase()].join('|');
  return 'c|' + clinic + '|' + occurrenceKey_(occ, hmac_(secret, 'pay|' + raw));
}

/**
 * The morning rebuild (title changes) starts every mark blank, so after a
 * rebuild every filled mark is new: made between the rebuild and this
 * check. The very first sighting of the sheet is a silent baseline.
 */
function diffAfterRebuild_(ctx, st, title, marks) {
  if (!st.title) return;
  diffMarks_(ctx, title === st.title ? (st.marks || {}) : {}, marks);
}

/**
 * Blank -> filled marks become events: Booked? "yes" -> booked, anything
 * else -> not_booked; Collected? "Yes - Full" / "Partial" / "Card on File"
 * -> collected (dollars counted only for Yes - Full on today's visits),
 * "No" / "$0 Owed" / anything else -> not_collected. A patient counts once
 * per day even if marked in two places (clinic tab and All PCC Clinics,
 * Huddle and Patient Responsibility) or re-marked after a rebuild.
 */
function diffMarks_(ctx, before, now) {
  Object.keys(now).forEach(function (key) {
    var cur = now[key];
    if (!cur.m || before[key]) return;
    var dayKey = key.replace(/\|t$/, '');
    if (ctx.state.day.seen[dayKey]) return;
    ctx.state.day.seen[dayKey] = 1;
    var isBooked = key.indexOf('b|') === 0;
    var said = cur.m === 'other' ? 'Marked with other text'
      : 'Marked "' + (isBooked ? cur.m : COLLECTED_LABELS[cur.m]) + '"';
    var e = { who: clinicWho_(ctx.roster, cur.clinic), link: cur.link, linkLabel: cur.linkLabel };
    if (isBooked) {
      e.type = cur.m === 'yes' ? 'booked' : 'not_booked';
      e.detail = said;
    } else {
      e.type = COLLECTED_COUNTS_AS_COLLECTED.indexOf(cur.m) !== -1 ? 'collected' : 'not_collected';
      e.dollars = cur.m === 'yes - full' && !cur.tomorrow ? cur.dollars : 0;
      e.detail = said + (cur.dollars ? ' · $' + cur.dollars.toFixed(2) + ' to collect' : '') +
        (cur.tomorrow ? ' · tomorrow\'s new patient' : '');
    }
    addEvent_(ctx, e);
  });
}

/**
 * Booked? -> 'yes' | 'no' | 'other'; Collected? -> one of
 * COLLECTED_CLASSES or 'other'; '' when blank. Only this class is stored
 * or shown, never the typed text.
 */
function markClass_(v, kind) {
  var s = lc_(v);
  if (!s) return '';
  var yes = /^y(es)?\b/.test(s);
  if (kind === 'booked') return yes ? 'yes' : /^no?\b/.test(s) ? 'no' : 'other';
  if (yes) return 'yes - full';
  for (var i = 0; i < COLLECTED_CLASSES.length; i++) {
    if (s.indexOf(COLLECTED_CLASSES[i]) === 0) return COLLECTED_CLASSES[i];
  }
  return 'other';
}

/** "PCC Daily Huddle - Wed 11/04/2026" -> "2026-11-04" ('' if no date). */
function titleDate_(title) {
  var m = String(title || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2) : '';
}

/** What's kept between runs: just the mark per key. */
function storedMarks_(marks) {
  var out = {};
  Object.keys(marks).forEach(function (k) { out[k] = marks[k].m; });
  return out;
}

// ---------------------------------------------------------------------------
// Roster and attribution
// ---------------------------------------------------------------------------

/** Active roster rows: [{ pcc, clinic, names: ['mariela'], tags: ['MARI'] }]. */
function loadRoster_(output) {
  var sheet = output.getSheetByName('Roster');
  var values = sheet.getDataRange().getValues();
  var roster = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var clinic = String(row[1] || '').trim();
    if (!clinic || lc_(row[4]) === 'n') continue;
    roster.push({
      pcc: String(row[0] || '').trim(),
      clinic: clinic,
      names: splitList_(row[2]).map(function (s) { return s.toLowerCase(); }),
      tags: splitList_(row[3]).map(function (s) { return s.replace(/[\[\]\-\s]/g, '').toUpperCase(); }),
    });
  }
  CURRENT_ROSTER = roster;
  return roster;
}
var CURRENT_ROSTER = [];

function rosterClinics_(roster) {
  var seen = {};
  roster.forEach(function (p) { seen[p.clinic] = true; });
  Object.keys(CONFIG.UL_FILES).forEach(function (c) { seen[c] = true; });
  return Object.keys(seen).sort();
}

function rosterByTag_(tag, roster) {
  roster = roster || CURRENT_ROSTER;
  for (var i = 0; i < roster.length; i++) {
    if (roster[i].tags.indexOf(tag) !== -1) return roster[i];
  }
  return null;
}

/** Everyone at a clinic (a clinic can have two PCCs, e.g. Metuchen). */
function clinicWho_(roster, clinic) {
  var pccs = roster.filter(function (p) { return p.clinic === clinic; });
  return { pccs: pccs, clinic: clinic, how: pccs.length > 1 ? 'Clinic (shared PCCs)' : 'Clinic' };
}

/**
 * Who a "Taken By" value names: a PCC by first name (any part of
 * "Auto/Emily", "Mariela/Lana", ...), or a clinic name typed instead of a
 * name ("Somerset", "EB Clinic") -> that clinic's PCC, "probable". null =
 * not a PCC (central schedulers, Auto, AI Agent, ...).
 */
function attributeTakenBy_(roster, takenBy) {
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
      var who = clinicWho_(roster, clinic);
      who.how = 'Probable (Taken By = clinic name)';
      return who;
    }
  }
  return null;
}

function isChannelOnly_(takenBy) {
  var tokens = takenBy.split('/').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  return tokens.length > 0 && tokens.every(function (t) { return CONFIG.NOT_PEOPLE.indexOf(t) !== -1; });
}

function whoLabel_(who) {
  var names = who.pccs.map(function (p) { return p.pcc; }).filter(function (n) { return n; });
  return names.length ? names.join(' / ') : who.clinic + ' PCC (name not set)';
}

// ---------------------------------------------------------------------------
// Events, Today tab, Activity tab
// ---------------------------------------------------------------------------

function addEvent_(ctx, e) {
  ctx.events.push({
    at: e.at || ctx.now.getTime(),
    backfilled: e.backfilled || '',
    type: e.type,
    pcc: whoLabel_(e.who),
    clinic: e.who.clinic,
    forClinic: e.forClinic || e.who.clinic,
    ie: e.ie || '',
    how: e.who.how,
    detail: e.detail || '',
    link: e.link || '',
    linkLabel: e.linkLabel || '',
    dollars: e.dollars || 0,
  });
}

function countEvents_(ctx) {
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

/** Newest first. Rows older than CONFIG.LOG_DAYS_KEPT are deleted (wherever they are). */
function writeActivity_(output, ctx) {
  var sheet = output.getSheetByName('Activity');
  if (ctx.events.length) {
    var rows = ctx.events.slice().reverse().map(activityRow_);
    sheet.insertRowsAfter(1, rows.length);
    // New rows copy the header's styling; reset it.
    sheet.getRange(2, 1, rows.length, ACTIVITY_HEADERS.length).setValues(rows)
      .setFontWeight('normal').setFontColor('#000000').setBackground(null);
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('ddd MM/dd h:mm am/pm');
  }
  var last = sheet.getLastRow();
  if (last < 2) return;
  var cutoff = ctx.now.getTime() - CONFIG.LOG_DAYS_KEPT * 24 * 60 * 60 * 1000;
  var whens = sheet.getRange(2, 1, last - 1, 1).getValues();
  // Bottom-up, deleting each run of old rows in one call.
  var i = whens.length - 1;
  while (i >= 0) {
    if (!isOld_(whens[i][0], cutoff)) { i--; continue; }
    var end = i;
    while (i >= 0 && isOld_(whens[i][0], cutoff)) i--;
    sheet.deleteRows(i + 3, end - i);
  }
}

function activityRow_(e) {
  return [
    new Date(e.at), e.pcc, e.clinic, EVENT_TYPES[e.type].source, EVENT_TYPES[e.type].label,
    e.detail, e.link ? '=HYPERLINK("' + e.link + '","' + e.linkLabel.replace(/"/g, '') + '")' : '', e.how,
    e.type, e.forClinic, e.ie, e.link, e.backfilled || '',
  ];
}

function isOld_(v, cutoff) {
  return v instanceof Date && v.getTime() < cutoff;
}

/**
 * Huddle and Patient Responsibility numbers, but only when the sheet has
 * already been rebuilt for today (before ~8 AM, and on days it isn't
 * rebuilt, yesterday's numbers would be misleading).
 */
function liveNumbers_(ctx) {
  var h = ctx.state.huddle || {};
  var pr = ctx.state.pr || {};
  var huddleToday = h.date === ctx.today;
  var prToday = pr.date === ctx.today;
  return {
    targets: huddleToday ? h.targets || {} : {},
    toCollect: prToday ? pr.today || {} : {},
    yesterday: prToday ? pr.yesterday || {} : {},
  };
}

/**
 * Today's numbers per PCC clinic, shared by the Today tab and the
 * dashboard. Counts are empty until the first check of the day.
 */
function todayModel_(ctx) {
  var day = ctx.state.day && ctx.state.day.date === ctx.today ? ctx.state.day : { counts: {}, last: {} };
  var live = liveNumbers_(ctx);
  var hour = Number(Utilities.formatDate(ctx.now, ctx.tz, 'H'));
  var quietHour = CONFIG.QUIET_CHECK_HOUR === null || !watchedSinceMorning_(ctx) ? 99 : CONFIG.QUIET_CHECK_HOUR;
  return rosterClinics_(ctx.roster).map(function (clinic) {
    var c = dayCounts_(ctx, clinic);
    var t = live.targets[clinic] || {};
    var pay = live.toCollect[clinic] || {};
    var y = live.yesterday[clinic] || {};
    var heads = [];
    if (!activityTotal_(c) && hour >= quietHour) heads.push('No activity yet today');
    if (t.nothingBooked && !c.booked && !c.bookedNo) heads.push(t.nothingBooked + ' on the nothing-booked list, none marked');
    var counts = {};
    COUNTERS.forEach(function (k) { counts[k] = c[k] || 0; });
    counts.collectedDollars = c.collectedDollars || 0;
    return {
      clinic: clinic,
      pcc: whoLabel_(clinicWho_(ctx.roster, clinic)),
      counts: counts,
      nothingBooked: blankToNull_(t.nothingBooked),
      nothingBookedLabel: live.targets._label || '',
      newIe: blankToNull_(t.newIe),
      collectPts: blankToNull_(pay.pts !== undefined ? pay.pts : t.collectPts),
      collectDollars: blankToNull_(pay.dollars !== undefined ? pay.dollars : t.collectDollars),
      yesterday: y.should === null || y.should === undefined ? null :
        { label: y.label || '', should: y.should, collected: y.collected || 0, pct: blankToNull_(y.pct) },
      last: day.last[clinic] || null,
      heads: heads,
    };
  });
}

/** Rebuilds the Today tab: one row per PCC clinic. */
function writeToday_(output, ctx) {
  var sheet = output.getSheetByName('Today');
  var tz = ctx.tz;
  var model = todayModel_(ctx);
  var rows = model.map(function (m) {
    var c = m.counts;
    var y = m.yesterday;
    return [
      m.clinic,
      m.pcc,
      c.npsNew, c.npsClaimed, c.ulNew, c.ulScheduled, c.ulNotes, c.ulReasons,
      blankIfNull_(m.nothingBooked),
      c.booked + (c.bookedNo ? ' (+' + c.bookedNo + ' not booked)' : ''),
      blankIfNull_(m.newIe),
      blankIfNull_(m.collectPts),
      blankIfNull_(m.collectDollars),
      c.collected + (c.collectedDollars ? ' ($' + c.collectedDollars.toFixed(2) + ' in full)' : '') +
        (c.collectedNo ? ' (+' + c.collectedNo + ' nothing collected)' : ''),
      !y ? '' : '$' + Number(y.collected).toFixed(2) + ' of $' + Number(y.should).toFixed(2) +
        (y.pct === null ? '' : ' (' + Math.round(y.pct * 100) + '%)'),
      m.last ? Utilities.formatDate(new Date(m.last), tz, 'h:mm a') : '',
      m.heads.join('; '),
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
  if (model.length && model[0].nothingBookedLabel) headers[8] = 'Huddle: ' + model[0].nothingBookedLabel;
  sheet.getRange(TODAY_HEADER_ROW, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff').setWrap(true);
  if (rows.length) sheet.getRange(TODAY_HEADER_ROW + 1, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(TODAY_HEADER_ROW);
  var notesRow = TODAY_HEADER_ROW + rows.length + 2;
  sheet.getRange(notesRow, 1, 3, 1).setValues([
    ['NPS counts are credited by the "Taken By" name. UL, Huddle and Collected? marks have no "entered by" column, so they are credited to the clinic\'s PCC (or to the signer of a UL note).'],
    ['Huddle and to-collect numbers appear once Danielle\'s morning rebuild for today has run; "Yesterday collected" is what Prompt recorded.'],
    ['Every event, with a link to its row, is on the Activity tab. The dashboard shows all of this live. Edit the Roster tab when PCCs change.'],
  ]).setFontColor('#666666');
}

/**
 * Has the watcher been running since early this morning? "No activity yet"
 * means nothing on the day you install it (or after a long outage).
 */
function watchedSinceMorning_(ctx) {
  var first = ctx.state.day.firstRun;
  return !!first && Number(Utilities.formatDate(new Date(first), ctx.tz, 'H')) < CONFIG.RUN_FROM_HOUR + 3;
}

/**
 * Today's counters for a clinic: live events plus any of today's history
 * added by backfill() (work done before the watcher started).
 */
function dayCounts_(ctx, clinic) {
  var day = ctx.state.day && ctx.state.day.date === ctx.today ? ctx.state.day : { counts: {} };
  var live = day.counts[clinic] || {};
  var bf = ctx.state.backfill && ctx.state.backfill.date === ctx.today ? (ctx.state.backfill.counts || {})[clinic] || {} : {};
  var out = {};
  COUNTERS.concat(['collectedDollars']).forEach(function (k) {
    if (live[k] || bf[k]) out[k] = (live[k] || 0) + (bf[k] || 0);
  });
  return out;
}

function activityTotal_(c) {
  return COUNTERS.reduce(function (sum, k) { return sum + (c[k] || 0); }, 0);
}

function isHeadline_(e) {
  return CONFIG.NOTIFY_ON.indexOf(e.type) !== -1;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Batches events into one email at most every NOTIFY_EVERY_MINUTES, sent
 * only when something in CONFIG.NOTIFY_ON happened (and always flushed
 * before the day's summary). Plus, on weekdays, one "no activity yet"
 * email at QUIET_CHECK_HOUR, one summary at DAY_SUMMARY_HOUR, and one
 * "can't read a source" email if a problem lasts two checks in a row. A
 * failed send leaves everything queued for the next run.
 */
function notify_(output, ctx) {
  var st = ctx.state.notify;
  st.pending = st.pending.concat(ctx.events.filter(function (e) { return e.type !== 'info'; }));
  st.errorRuns = ctx.errors.length ? (st.errorRuns || 0) + 1 : 0;
  if (!CONFIG.NOTIFY) {
    st.pending = [];
    return;
  }
  var url = dashboardUrl_() || output.getUrl();
  var tz = ctx.tz;
  var day = ctx.state.day;
  var hour = Number(Utilities.formatDate(ctx.now, tz, 'H'));
  var weekday = Number(Utilities.formatDate(ctx.now, tz, 'u')) <= 5;
  var summaryDue = weekday && CONFIG.DAY_SUMMARY_HOUR !== null && hour >= CONFIG.DAY_SUMMARY_HOUR && !day.summarySent;

  var due = !st.lastSent || ctx.now.getTime() - st.lastSent >= CONFIG.NOTIFY_EVERY_MINUTES * 60 * 1000;
  if (st.pending.some(isHeadline_) && (due || summaryDue) &&
      trySend_(ctx, digestSubject_(st.pending), digestBody_(st.pending, url, tz))) {
    st.lastSent = ctx.now.getTime();
    st.pending = [];
  }

  if (st.errorRuns >= 2 && day.errorSent !== ctx.errors.join('|') &&
      trySend_(ctx, 'PCC Watch: can\'t read part of its sources',
        'These have failed for the last ' + st.errorRuns + ' checks, so activity there isn\'t being seen:\n\n' +
        ctx.errors.map(function (e) { return '  • ' + e; }).join('\n') +
        '\n\nCheck that the file still exists and is shared with you. Today tab: ' + url)) {
    day.errorSent = ctx.errors.join('|');
  }

  if (weekday && CONFIG.QUIET_CHECK_HOUR !== null && hour >= CONFIG.QUIET_CHECK_HOUR && !day.quietSent &&
      watchedSinceMorning_(ctx) && !ctx.errors.length) {
    var quiet = rosterClinics_(ctx.roster).filter(function (c) {
      return !activityTotal_(dayCounts_(ctx, c));
    });
    if (!quiet.length || trySend_(ctx,
      'PCC Watch: no activity yet from ' + quiet.length + ' clinic' + (quiet.length > 1 ? 's' : ''),
      'As of ' + Utilities.formatDate(ctx.now, tz, 'h:mm a') + ', nothing new on the NPS, UL, Huddle or Collected? from:\n\n' +
      quiet.map(function (c) { return '  • ' + c + ' — ' + whoLabel_(clinicWho_(ctx.roster, c)); }).join('\n') +
      '\n\nToday by PCC: ' + url)) {
      day.quietSent = true;
    }
  }

  if (summaryDue && trySend_(ctx, 'PCC Watch: today\'s summary (' + Utilities.formatDate(ctx.now, tz, 'EEE MM/dd') + ')',
    summaryBody_(ctx, url))) {
    day.summarySent = true;
    st.pending = st.pending.filter(isHeadline_);
  }
}

function digestSubject_(events) {
  var parts = [];
  var seen = {};
  events.forEach(function (e) {
    if (!isHeadline_(e)) return;
    var k = e.pcc + '|' + EVENT_TYPES[e.type].source;
    if (seen[k]) { seen[k].n++; return; }
    seen[k] = { first: firstNames_(e.pcc), source: EVENT_TYPES[e.type].source, n: 1 };
    parts.push(seen[k]);
  });
  return 'PCC Watch: ' + parts.map(function (p) {
    return p.first + ' +' + p.n + ' ' + p.source;
  }).join(' · ');
}

/** Grouped by PCC; new patients listed one by one, other work counted. */
function digestBody_(events, url, tz) {
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
      if (isHeadline_(e)) {
        lines.push('  • ' + EVENT_TYPES[e.type].label + ' — ' + e.linkLabel + ' (' +
          Utilities.formatDate(new Date(e.at), tz, 'EEE h:mm a') + ')' + (e.link ? '\n    ' + e.link : ''));
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

function summaryBody_(ctx, url) {
  var day = ctx.state.day;
  var targets = liveNumbers_(ctx).targets;
  var lines = ['PCC activity today (' + Utilities.formatDate(ctx.now, ctx.tz, 'EEE MM/dd') + ')', ''];
  rosterClinics_(ctx.roster).forEach(function (clinic) {
    var c = dayCounts_(ctx, clinic);
    var t = targets[clinic] || {};
    lines.push(clinic + ' — ' + whoLabel_(clinicWho_(ctx.roster, clinic)));
    lines.push('  NPS: ' + (c.npsNew || 0) + ' new, ' + (c.npsClaimed || 0) + ' leads claimed');
    lines.push('  UL: ' + (c.ulNew || 0) + ' patients added, ' + (c.ulScheduled || 0) + ' scheduled, ' +
      (c.ulNotes || 0) + ' notes, ' + (c.ulReasons || 0) + ' reasons');
    lines.push('  Huddle: ' + (c.booked || 0) + ' marked booked' +
      (t.nothingBooked ? ' of ' + t.nothingBooked + ' on the list' : '') +
      (c.bookedNo ? ', ' + c.bookedNo + ' not booked' : '') +
      ' · Collected: ' + (c.collected || 0) + (c.collectedNo ? ', ' + c.collectedNo + ' nothing collected' : ''));
    lines.push('');
  });
  if (ctx.errors.length) lines.push('Not read this run: ' + ctx.errors.join(' | '), '');
  lines.push('Details: ' + url);
  return lines.join('\n');
}

function firstNames_(label) {
  return label.split(' / ').map(function (n) { return n.split(' ')[0]; }).join('/');
}

/** Sends to CONFIG.NOTIFY_EMAILS (or you). false + a Today-tab problem if it fails. */
function trySend_(ctx, subject, body) {
  try {
    var to = CONFIG.NOTIFY_EMAILS.length ? CONFIG.NOTIFY_EMAILS.join(',') : Session.getEffectiveUser().getEmail();
    MailApp.sendEmail({ to: to, subject: subject, body: body });
    return true;
  } catch (e) {
    ctx.errors.push('Email: ' + errorText_(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backfill: history from before the watcher started
// ---------------------------------------------------------------------------

/**
 * Run once after setup (safe to run again: it replaces what it added
 * before). Adds the history the sheets can date, from CONFIG.BACKFILL_FROM
 * (default: the first day of last month) up to when the watcher started:
 *   - NPS: every row a PCC entered ("Taken By"), dated by its call date,
 *     with its clinic and IE date — both last month's and this month's NPS.
 *   - UL: care-note lines that start with a date ("11/3 lm [MARI]"), credited
 *     to the signer, or to the clinic's PCC when unsigned.
 * UL scheduling changes and Huddle / Collected? marks carry no date, so they
 * only count from when the watcher started. Rows already credited live are
 * skipped, so nothing is counted twice.
 */
function backfill() {
  ownerOnly_();
  backfillAt_(new Date());
}

function backfillAt_(now) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 60 * 1000)) throw new Error('A check is running; try backfill again in a minute.');
  try {
    var tz = Session.getScriptTimeZone();
    var output = getOutputSpreadsheet_();
    ensureTabs_(output);
    var ctx = {
      now: now, tz: tz, today: isoKey_(now, tz), secret: getSecret_(), roster: loadRoster_(output),
      state: loadState_(), events: [], errors: [],
    };
    var startedDay = ctx.state.startedDay || isoKey_(new Date(installedAt_()), tz);
    ctx.state.startedDay = startedDay;
    var from = CONFIG.BACKFILL_FROM || isoKey_(new Date(now.getFullYear(), now.getMonth() - 1, 1), tz);

    guarded_(ctx, 'NPS', function () { backfillNps_(ctx, from, startedDay); });
    backfillUl_(ctx, from, startedDay);
    // All or nothing: a half-read backfill would replace good history with less.
    if (ctx.errors.length) {
      throw new Error('Backfill stopped; nothing was changed. Could not read: ' + ctx.errors.join(' | '));
    }

    replaceBackfilledRows_(output, ctx, from);
    var counts = {};
    ctx.events.forEach(function (e) {
      if (isoKey_(new Date(e.at), tz) !== ctx.today) return;
      var c = counts[e.clinic] = counts[e.clinic] || {};
      var counter = EVENT_TYPES[e.type].counter;
      c[counter] = (c[counter] || 0) + 1;
    });
    ctx.state.backfill = { at: now.getTime(), from: from, date: ctx.today, counts: counts, events: ctx.events.length };
    try {
      writeToday_(output, ctx);
    } catch (e) {
      Logger.log('Today tab not updated: ' + errorText_(e));
    }
    saveState_(ctx.state);
    Logger.log('Backfilled ' + ctx.events.length + ' events from ' + from + '.');
    return ctx.events.length;
  } finally {
    lock.releaseLock();
  }
}

/**
 * NPS rows a PCC entered between `from` and the day the watcher started, in
 * every monthly NPS that range touches. A call date typed in the future
 * (a typo already on the sheet at the start) is dated to the start day.
 */
function backfillNps_(ctx, from, startedDay) {
  var done = {};
  monthsBetween_(parseIsoDate_(from), parseIsoDate_(ctx.today)).forEach(function (month) {
    var label = MONTH_NAMES[month.getMonth()] + ' ' + month.getFullYear();
    var file = findNpsFile_(MONTH_NAMES[month.getMonth()], String(month.getFullYear()));
    if (!file) {
      ctx.errors.push('NPS: no "' + label + ' New Patient Spreadsheet" visible');
      return;
    }
    var ss = withRetry_(function () { return SpreadsheetApp.openById(file.getId()); });
    var tz = ss.getSpreadsheetTimeZone();
    var st = ctx.state.nps[file.getId()];
    if (!st) st = ctx.state.nps[file.getId()] = { month: monthKey_(month), tabs: {}, credited: {}, backfilled: {} };
    st.credited = st.credited || {};
    st.backfilled = st.backfilled || {};
    ss.getSheets().forEach(function (sheet) {
      var name = sheet.getName();
      var tabClinic = CONFIG.NPS_CLINIC_TABS[name];
      if (!tabClinic) return;
      var tab = readNpsTab_(sheet, tz, ctx.secret);
      if (!tab) return;
      Object.keys(tab.rows).forEach(function (k) {
        var row = tab.rows[k];
        var mem = tab.mem[k];
        var day = mem.day > startedDay ? startedDay : mem.day;
        if (!day || day < from) return;
        var who = attributeTakenBy_(ctx.roster, row.t);
        if (!who) return;
        var base = name + '|' + k.split('#')[0];
        if (st.credited[base] && !st.backfilled[base]) return;
        if (done[file.getId() + '|' + base]) return;
        done[file.getId() + '|' + base] = 1;
        st.credited[base] = 1;
        st.backfilled[base] = 1;
        // Only the call date is known (a web lead's time is when it came in,
        // not when the PCC claimed it).
        addEvent_(ctx, {
          type: row.a ? 'claimed_lead' : 'new_entry', who: who, forClinic: tabClinic, ie: row.ie,
          at: parseIsoDate_(day).getTime() + 12 * 60 * 60 * 1000, backfilled: 'date',
          detail: 'For ' + tabClinic + ' · ' + (row.ie ? 'IE ' + shortDate_(row.ie) : 'no IE date') +
            (row.st ? ' · ' + row.st : '') + ' · call ' + shortDate_(day),
          link: rowLink_(ss, sheet, row.r), linkLabel: name + ' row ' + row.r,
        });
      });
    });
  });
}

/**
 * UL care-note lines dated from `from` through the day the watcher started,
 * across the week tabs that range touches, except lines the watcher already
 * saw live (state.ulLive). A line carried into several week tabs counts once.
 */
function backfillUl_(ctx, from, startedDay) {
  var earliest = addDays_(parseIsoDate_(from), -6);
  var latest = addDays_(mondayOf_(ctx.now, ctx.tz), 7 * CONFIG.UL_WEEKS_AHEAD);
  Object.keys(CONFIG.UL_FILES).forEach(function (clinic) {
    guarded_(ctx, 'UL ' + clinic, function () {
      var ss = withRetry_(function () { return SpreadsheetApp.openById(CONFIG.UL_FILES[clinic]); });
      var tz = ss.getSpreadsheetTimeZone();
      var seen = {};
      ss.getSheets().forEach(function (sheet) {
        var name = sheet.getName();
        var week = parseUlTabDate_(name);
        if (!week || week < earliest || week > latest) return;
        var tab = readUlTab_(sheet, ctx.secret, tz);
        if (!tab) return;
        Object.keys(tab.rows).forEach(function (k) {
          (tab.lines[k] || []).forEach(function (l) {
            var day = noteLineDate_(l.text, ctx.today);
            if (!day || day < from || day > startedDay) return;
            var once = k.split('#')[0] + '|' + l.h;
            if (seen[once] || ctx.state.ulLive[clinic + '|' + once]) return;
            seen[once] = 1;
            var lines = [l.text];
            lines.tag = knownTag_(signatureTags_(l.text));
            var who = attributeUlLines_(ctx.roster, clinic, lines);
            if (!who) return;
            addEvent_(ctx, {
              type: 'note', who: who, at: parseIsoDate_(day).getTime() + 12 * 60 * 60 * 1000, backfilled: 'date',
              detail: 'Week of ' + name + ' · note dated ' + shortDate_(day) + (lines.tag ? ' · signed ' + lines.tag : ''),
              link: rowLink_(ss, sheet, tab.rows[k].r), linkLabel: clinic + ' UL ' + name + ' row ' + tab.rows[k].r,
            });
          });
        });
      });
    });
  });
}

/**
 * The date a note line starts with ("11/3 lm", "10/28/26 ..."), as
 * yyyy-MM-dd, or ''. Without a year it's the latest such date not after
 * today.
 */
function noteLineDate_(text, todayIso) {
  var m = String(text || '').match(/^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?!\d)/);
  if (!m) return '';
  var month = Number(m[1]);
  var day = Number(m[2]);
  var year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(todayIso.substring(0, 4));
  var d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return '';
  var iso = isoKey_(d, Session.getScriptTimeZone());
  if (!m[3] && iso > todayIso) iso = isoKey_(new Date(year - 1, month - 1, day), Session.getScriptTimeZone());
  return iso;
}

/**
 * Removes the rows an earlier backfill() added from `from` on (older ones
 * stay until the log trims them), adds this run's, and re-sorts newest first.
 */
function replaceBackfilledRows_(output, ctx, from) {
  var sheet = output.getSheetByName('Activity');
  var col = ACTIVITY_HEADERS.indexOf('Backfilled') + 1;
  var since = parseIsoDate_(from).getTime();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, col).getValues();
    var mine = function (r) { return r[col - 1] && r[0] instanceof Date && r[0].getTime() >= since; };
    var i = vals.length - 1;
    while (i >= 0) {
      if (!mine(vals[i])) { i--; continue; }
      var end = i;
      while (i >= 0 && mine(vals[i])) i--;
      sheet.deleteRows(i + 3, end - i);
    }
  }
  if (ctx.events.length) {
    var rows = ctx.events.map(activityRow_);
    sheet.insertRowsAfter(1, rows.length);
    sheet.getRange(2, 1, rows.length, ACTIVITY_HEADERS.length).setValues(rows)
      .setFontWeight('normal').setFontColor('#000000').setBackground(null);
  }
  last = sheet.getLastRow();
  if (last < 2) return;
  var body = sheet.getRange(2, 1, last - 1, ACTIVITY_HEADERS.length);
  body.sort({ column: 1, ascending: false });
  sheet.getRange(2, 1, last - 1, 1).setNumberFormat('ddd MM/dd h:mm am/pm');
  var dateOnly = [];
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (r, j) {
    if (r[0] === 'date') dateOnly.push('A' + (j + 2));
  });
  if (dateOnly.length) sheet.getRangeList(dateOnly).setNumberFormat('ddd MM/dd');
}

/** When the watcher started: the state file's creation time. */
function installedAt_() {
  var id = PropertiesService.getScriptProperties().getProperty(STATE_ID_PROPERTY);
  return id ? DriveApp.getFileById(id).getDateCreated().getTime() : Date.now();
}

/** First of each month from `from`'s month through `to`'s month. */
function monthsBetween_(from, to) {
  var months = [];
  var m = new Date(from.getFullYear(), from.getMonth(), 1);
  while (m <= to) {
    months.push(m);
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Dashboard (web app)
// ---------------------------------------------------------------------------

/**
 * The dashboard page. Deploy once: Deploy > New deployment > Web app,
 * Execute as "Me", Who has access "Only myself" or "Anyone within Trinity
 * Rehab" — never "Anyone". Visitors can only call getDashboardData().
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('PCC Watch')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called by the dashboard page: everything it shows for the last `days` days (1 = today). */
function getDashboardData(days) {
  return dashboardData_(new Date(), days);
}

/**
 * { today, days, now, lastRun, everyMinutes, sheetUrl, clinics, pccs,
 * events }. Events come from the Activity tab (newest first) and carry
 * only what the Activity tab shows: who, which clinic, what, when, and a
 * link to the row. Nothing here can identify a patient.
 */
function dashboardData_(now, days) {
  days = Math.max(1, Math.min(Math.round(Number(days) || 1), CONFIG.LOG_DAYS_KEPT));
  var tz = Session.getScriptTimeZone();
  var output = getOutputSpreadsheet_();
  ensureTabs_(output);
  var roster = loadRoster_(output);
  var state = loadState_();
  var today = isoKey_(now, tz);
  var ctx = { now: now, tz: tz, today: today, roster: roster, state: state };
  var from = addDays_(parseIsoDate_(today), -(days - 1)).getTime();

  var events = [];
  var sheet = output.getSheetByName('Activity');
  var last = sheet.getLastRow();
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, ACTIVITY_HEADERS.length).getValues();
    values.forEach(function (r) {
      var when = r[0];
      if (!(when instanceof Date) || when.getTime() < from) return;
      var type = String(r[8] || '');
      if (!EVENT_TYPES[type] || type === 'info') return;
      var link = String(r[11] || '');
      var dateOnly = String(r[12] || '') === 'date';
      events.push({
        at: when.getTime(),
        day: isoKey_(when, tz),
        hour: dateOnly ? null : Number(Utilities.formatDate(when, tz, 'H')),
        time: dateOnly ? '' : Utilities.formatDate(when, tz, 'h:mm a'),
        backfilled: !!r[12],
        type: type,
        source: EVENT_TYPES[type].source,
        what: EVENT_TYPES[type].label,
        pcc: String(r[1] || ''),
        clinic: String(r[2] || ''),
        forClinic: String(r[9] || r[2] || ''),
        detail: String(r[5] || ''),
        how: String(r[7] || ''),
        ie: r[10] instanceof Date ? isoKey_(r[10], tz) : String(r[10] || ''),
        link: /^https:\/\/docs\.google\.com\//.test(link) ? link : '',
      });
    });
  }
  events.sort(function (a, b) { return b.at - a.at; });

  var pccs = [];
  roster.forEach(function (p) { if (p.pcc && pccs.indexOf(p.pcc) === -1) pccs.push(p.pcc); });
  return {
    today: today,
    todayLabel: Utilities.formatDate(now, tz, 'EEEE, MMMM d'),
    days: days,
    now: now.getTime(),
    lastRun: state.lastRun && state.lastRun.at ? {
      at: state.lastRun.at,
      time: Utilities.formatDate(new Date(state.lastRun.at), tz, 'EEE h:mm a'),
      errors: state.lastRun.errors || [],
    } : null,
    everyMinutes: CONFIG.TRIGGER_EVERY_MINUTES,
    maxDays: CONFIG.LOG_DAYS_KEPT,
    backfill: state.backfill ? { from: state.backfill.from, events: state.backfill.events } : null,
    sheetUrl: output.getUrl(),
    clinics: todayModel_(ctx),
    pccs: pccs,
    events: events,
  };
}

/** The deployed dashboard's URL, or '' if it hasn't been deployed. */
function dashboardUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Output sheet, roster seed, state
// ---------------------------------------------------------------------------

/**
 * The PCC Watch sheet. Created only once (when no ID is stored); after
 * that, failing to open it retries and then aborts the run, so a passing
 * Google hiccup never starts a new sheet and loses the Roster.
 */
function getOutputSpreadsheet_() {
  if (CONFIG.OUTPUT_SPREADSHEET_ID) {
    return withRetry_(function () { return SpreadsheetApp.openById(CONFIG.OUTPUT_SPREADSHEET_ID); });
  }
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(OUTPUT_ID_PROPERTY);
  if (id) return withRetry_(function () { return SpreadsheetApp.openById(id); });

  var ss = SpreadsheetApp.create(CONFIG.OUTPUT_TITLE);
  ss.getSheets()[0].setName('Today');
  moveToFolder_(ss.getId());
  props.setProperty(OUTPUT_ID_PROPERTY, ss.getId());
  Logger.log('Created output spreadsheet: ' + ss.getUrl());
  return ss;
}

/** Creates the Today / Activity / Roster tabs if they're missing. Other tabs are left alone. */
function ensureTabs_(output) {
  if (!output.getSheetByName('Today')) output.insertSheet('Today', 0);
  var act = output.getSheetByName('Activity');
  if (!act) {
    act = output.insertSheet('Activity', 1);
    act.setFrozenRows(1);
  }
  var header = act.getRange(1, 1, 1, ACTIVITY_HEADERS.length);
  if (header.getValues()[0].join('|') !== ACTIVITY_HEADERS.join('|')) {
    header.setValues([ACTIVITY_HEADERS]).setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
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
}

function newState_() {
  return {
    v: STATE_VERSION,
    nps: {},
    ul: {},
    huddle: { marks: {}, targets: {} },
    pr: { marks: {}, today: {}, yesterday: {} },
    day: { date: '', firstRun: 0, counts: {}, last: {}, seen: {}, quietSent: false, summarySent: false },
    notify: { lastSent: 0, pending: [], errorRuns: 0 },
    lastRun: { at: 0, errors: [] },
    // UL note lines first seen live but dated on or before the day the
    // watcher started, so backfill() doesn't count them again.
    ulLive: {},
    startedDay: '',
  };
}

/** The state file. Created only once, like the output sheet. */
function stateFile_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(STATE_ID_PROPERTY);
  if (id) return withRetry_(function () { return DriveApp.getFileById(id); });

  var file = DriveApp.createFile(CONFIG.STATE_FILE_TITLE, JSON.stringify(newState_()), MimeType.PLAIN_TEXT);
  moveToFolder_(file.getId());
  props.setProperty(STATE_ID_PROPERTY, file.getId());
  return file;
}

/**
 * Last run's snapshots. A read or parse failure aborts the run (the next
 * one retries) instead of starting from an empty state, which would
 * silently re-baseline every source and lose today's counts.
 */
function loadState_() {
  var file = stateFile_();
  var state = JSON.parse(withRetry_(function () { return file.getBlob().getDataAsString(); }));
  if (!state || state.v !== STATE_VERSION) state = newState_();
  var fresh = newState_();
  Object.keys(fresh).forEach(function (k) { if (!state[k]) state[k] = fresh[k]; });
  return state;
}

function saveState_(state) {
  var file = stateFile_();
  var text = JSON.stringify(state);
  withRetry_(function () { file.setContent(text); });
}

/** fn(), retried twice (after 2 s and 4 s) when it throws; the last error is rethrown. */
function withRetry_(fn) {
  for (var attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      Utilities.sleep(2000 * attempt);
    }
  }
}

function moveToFolder_(fileId) {
  if (!CONFIG.FOLDER_ID) return;
  DriveApp.getFileById(fileId).moveTo(DriveApp.getFolderById(CONFIG.FOLDER_ID));
}

/** The HMAC secret, created on first use. It never leaves Script Properties. */
function getSecret_() {
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
function hmac_(secret, value) {
  var bytes = Utilities.computeHmacSha256Signature(value, secret);
  var hex = '';
  for (var i = 0; i < 6; i++) hex += ('0' + ((bytes[i] + 256) % 256).toString(16)).slice(-2);
  return hex;
}

/** base, base#2, base#3 ... for repeated identical rows. */
function occurrenceKey_(occ, base) {
  occ[base] = (occ[base] || 0) + 1;
  return occ[base] > 1 ? base + '#' + occ[base] : base;
}

/**
 * Header row within `values` whose cells include every label in `want`
 * ({ key: 'label' }, case-insensitive exact match). Returns { row, cols }
 * with cols[key] = column index, or null. A label missing from the row is
 * only allowed for keys after the first three.
 */
function findHeaderRow_(values, want) {
  var keys = Object.keys(want);
  var required = keys.slice(0, 3);
  for (var r = 0; r < values.length; r++) {
    var labels = values[r].map(lc_);
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
function normalizeName_(v) {
  var s = String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return '';
  var comma = s.indexOf(',');
  if (comma !== -1) s = s.substring(comma + 1).trim() + ' ' + s.substring(0, comma).trim();
  return s.replace(/[^a-z0-9' \-]/g, '').replace(/\s+/g, ' ').trim();
}

/** NPS Status -> "Active" / "Pending" / "Inactive", '' otherwise. */
function statusWord_(v) {
  var s = lc_(v);
  return s === 'active' ? 'Active' : s === 'pending' ? 'Pending' : s === 'inactive' ? 'Inactive' : '';
}

/** "2026-11-10" -> "Tue 11/10". */
function shortDate_(iso) {
  return Utilities.formatDate(parseIsoDate_(iso), Session.getScriptTimeZone(), 'EEE M/d');
}

/** "Mariela / Lana " -> "mariela/lana" */
function normalizeTakenBy_(v) {
  return String(v || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
}

/** A date cell with a time of day (rows the web form writes). */
function isTimestamped_(v, tz) {
  return v instanceof Date && !isNaN(v.getTime()) && Utilities.formatDate(v, tz, 'HH:mm:ss') !== '00:00:00';
}

/** A visit-time cell ("9:20 AM"); a real time value counts too. */
function isTimeCell_(v, tz) {
  return /^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(timeText_(v, tz));
}

/** Visit time as "9:20 AM" whether the cell holds text or a time value. */
function timeText_(v, tz) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'h:mm a').toUpperCase();
  return String(v || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Stable string for a cell (dates as yyyy-MM-dd in the sheet's time zone). */
function cellKey_(v, tz) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : isoKey_(v, tz);
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function splitList_(v) {
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
}

function lc_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function indexWhere_(arr, test) {
  for (var i = 0; i < arr.length; i++) if (test(arr[i])) return i;
  return -1;
}

function toNumber_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? null : n;
}

function blankToNull_(v) {
  return v === '' || v === undefined ? null : v;
}

function blankIfNull_(v) {
  return v === null || v === undefined ? '' : v;
}

function rowLink_(ss, sheet, row) {
  return ss.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + row;
}

function errorText_(e) {
  return String(e && e.message ? e.message : e).substring(0, 200);
}

function isoKey_(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/**
 * Cell value -> 'yyyy-MM-dd', or null. Accepts real dates and typed text
 * like "11/4/26" or "11/04/2026".
 */
function toIsoKey_(v, tz) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : isoKey_(v, tz);
  var m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  var year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return year + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

function parseIsoDate_(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function addDays_(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday (local midnight) of the week containing `now` in `tz`. */
function mondayOf_(now, tz) {
  var d = parseIsoDate_(isoKey_(now, tz));
  var dow = Number(Utilities.formatDate(now, tz, 'u'));
  return addDays_(d, -(dow - 1));
}
