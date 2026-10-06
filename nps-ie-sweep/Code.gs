/**
 * Trinity Rehab — NPS "IE Scheduled Out" Sweep
 *
 * Sweeps the monthly New Patient Spreadsheet (NPS) for patients whose
 * initial evaluation (FS/IE Date) was booked in a LATER week than the week
 * they called — i.e. called this week, not seen until next week or beyond.
 * Those are the patients worth reviewing for an earlier slot.
 *
 * Two views, one tab per week each:
 *   - "Week of 10-04-26"     CALL week: called Sun–Sat, IE after Saturday.
 *   - "IEs Week of 10-11-26" IE week: IE booked Sun–Sat, but the patient
 *                            called in an earlier week (who's coming in
 *                            that week who could have been seen sooner).
 *
 * Source: the NPS is one Google Sheet per month, named like
 * "October 2026 New Patient Spreadsheet" (older months: "March 2026 NPS").
 * Every clinic tab (BR, SHRW, MAN, ... Warren) has the same layout — a
 * header row with "Date" (call date), "Patient Name", "FS/IE Date", etc.
 * Tabs without that header (CONSOLIDATED, DIGITAL TRACKING, DDB, ELLAAGENT)
 * are skipped automatically. Each sweep opens every monthly NPS its date
 * range touches, found by title — no file IDs to update each month.
 *
 * Output: ONE persistent spreadsheet. Each daily run rebuilds the call-week
 * tabs for last week, this week and next week, and the IE-week tabs for this
 * week and next week, so every week rolls forward on its own. Whatever the team typed in
 * Follow-up / Follow-up Notes is kept; a row with follow-up that drops off
 * the sweep (e.g. IE moved up) stays on the tab, marked resolved.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit these before running
// ---------------------------------------------------------------------------
var CONFIG = {
  // Output spreadsheet. Leave '' and the first run creates
  // "NPS — IE Scheduled Out Sweep" in your Drive and remembers its ID
  // (Script Properties). Set an ID here to point at an existing sheet instead.
  OUTPUT_SPREADSHEET_ID: '',
  OUTPUT_TITLE: 'NPS — IE Scheduled Out Sweep',

  // First day of the week: 0 = Sunday, 1 = Monday. A week runs 7 days from
  // here, so with Sunday the week is Sun–Sat (weekend calls included) and
  // "scheduled out" means the FS/IE Date is the following Sunday or later.
  WEEK_START_DAY: 0,

  // Monthly NPS titles. {MONTH} = "October", {YEAR} = "2026". Matched
  // case-insensitively, ignoring leading/trailing spaces (several of the
  // existing files have trailing spaces in their titles).
  NPS_TITLE_PATTERNS: [
    '{MONTH} {YEAR} New Patient Spreadsheet',
    '{MONTH} {YEAR} NPS',
  ],

  // Header names on the clinic tabs (matched case-insensitively). A tab is
  // treated as a clinic tab only if it has all three required headers in
  // its first HEADER_SEARCH_ROWS rows.
  HEADERS: {
    CALL_DATE: 'Date',
    PATIENT: 'Patient Name',
    IE_DATE: 'FS/IE Date',
    TAKEN_BY: 'Taken By',
    REFERRAL: 'Referral Source',
    DIAGNOSIS: 'Diagnosis',
    PRIMARY_INS: 'Primary Insurance',
    NOTES: 'Notes',
    STATUS: 'Status',
  },
  HEADER_SEARCH_ROWS: 10,

  // Rows whose Status is one of these are left out (case-insensitive).
  // Set to [] to include everything.
  EXCLUDE_STATUSES: ['Inactive'],

  // NPS tab name -> clinic name shown in the sweep. Every clinic listed here
  // appears in each weekly tab's count-by-clinic summary, with 0 if it had
  // no patients that week. A clinic tab not listed here still gets swept and
  // shows under its title from cell A2.
  CLINIC_NAMES: {
    BR: 'Brick',
    CherryHill: 'Cherry Hill',
    CLRK: 'Clark',
    CLFTN: 'Clifton',
    CLIFTN: 'Clifton',
    Doylestown: 'Doylestown',
    EB: 'East Brunswick',
    EW: 'East Windsor',
    EMRSN: 'Emerson',
    Flemington: 'Flemington',
    HAM: 'Hamilton',
    HWL: 'Howell',
    MAN: 'Manalapan',
    MAT: 'Matawan',
    MET: 'Metuchen',
    Middletown: 'Middletown',
    Newtown: 'Newtown',
    Piscataway: 'Piscataway',
    SEWELL: 'Sewell',
    SHRW: 'Shrewsbury',
    SMST: 'Somerset',
    SMRVL: 'Somerville',
    SPRTA: 'Sparta',
    TR: 'Toms River',
    UpperDublin: 'Upper Dublin',
    Warren: 'Warren',
    WayneNJ: 'Wayne',
    WDBRDGE: 'Woodbridge',
  },

  // How far back the IE-week view looks for the original call. Calls older
  // than this many days before the IE week are not included.
  IE_LOOKBACK_DAYS: 60,

  // How many weekly tabs of each kind to keep before deleting the oldest.
  MAX_WEEKS_KEPT: 12,

  // Choices offered in the Follow-up dropdown.
  FOLLOW_UP_OPTIONS: [
    'Moved up to this week',
    'Offered earlier — pt declined',
    'No earlier availability',
    'Left message',
    'Pt requested later date',
  ],

  // Optional: email a short digest with a link to the output sheet after
  // each run. Leave empty to rely on the sheet only.
  NOTIFY_EMAILS: [
    // 'frontdesk-lead@trinity-rehab.com',
  ],

  // Hour (script time zone) the daily trigger runs.
  RUN_HOUR: 18,
};

var OUTPUT_ID_PROPERTY = 'NPS_IE_SWEEP_OUTPUT_ID';
var TABLE_HEADER_ROW = 4;
var OUTPUT_HEADERS = [
  'Clinic', 'Call Date', 'Patient Name', 'Taken By', 'Referral Source',
  'Diagnosis', 'Primary Insurance', 'FS/IE Date', 'Days Call → IE',
  'Days Past Call Week', 'Status', 'NPS Notes', 'Source', 'Follow-up',
  'Follow-up Notes',
];
var STATUS_COL = OUTPUT_HEADERS.indexOf('Status') + 1;
var SOURCE_COL = OUTPUT_HEADERS.indexOf('Source') + 1;
// Columns the team fills in — preserved across re-runs.
var FOLLOW_UP_COL = OUTPUT_HEADERS.indexOf('Follow-up') + 1;
var FOLLOW_UP_NOTES_COL = OUTPUT_HEADERS.indexOf('Follow-up Notes') + 1;
var RESOLVED_STATUS = 'No longer scheduled out (IE date or status changed)';
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// The two kinds of weekly tab. IE-week tabs sort ahead of call-week tabs.
var VIEWS = {
  CALLS: {
    prefix: 'Week of ',
    order: 1,
    title: function (range) { return 'Called ' + range + ' — IE scheduled after the week'; },
    empty: 'No patients scheduled out for this week.',
  },
  IES: {
    prefix: 'IEs Week of ',
    order: 0,
    title: function (range) { return 'IE booked ' + range + ' — patient called in an earlier week'; },
    empty: 'No IEs this week from patients who called in an earlier week.',
  },
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Daily job: call-week tabs for last, this and next week, plus IE-week tabs
 * for this week and next week.
 */
function runSweep() {
  var thisWeek = weekRange(new Date());
  var lastWeek = weekRange(addDays(thisWeek.start, -7));
  var nextWeek = weekRange(addDays(thisWeek.start, 7));
  var output = getOutputSpreadsheet();
  var cache = {};

  var results = [lastWeek, thisWeek, nextWeek].map(function (week) {
    var rows = sweepCallWeek(week, cache);
    writeWeekTab(output, VIEWS.CALLS, week, rows);
    return { view: VIEWS.CALLS, week: week, rows: rows };
  });
  [thisWeek, nextWeek].forEach(function (week) {
    var ieRows = sweepIeWeek(week, cache);
    writeWeekTab(output, VIEWS.IES, week, ieRows);
    results.push({ view: VIEWS.IES, week: week, rows: ieRows });
  });

  trimOldTabs(output);
  notify(output, results);
}

/**
 * Manual helper: build both tabs for the week containing a specific date,
 * e.g. sweepWeekContaining('2026-09-30'). Handy for back-filling past weeks.
 */
function sweepWeekContaining(isoDate) {
  var week = weekRange(parseIsoDate(isoDate));
  var output = getOutputSpreadsheet();
  var cache = {};
  writeWeekTab(output, VIEWS.CALLS, week, sweepCallWeek(week, cache));
  writeWeekTab(output, VIEWS.IES, week, sweepIeWeek(week, cache));
  trimOldTabs(output);
}

/** Run once to schedule runSweep daily at CONFIG.RUN_HOUR. */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSweep') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSweep').timeBased().everyDays(1).atHour(CONFIG.RUN_HOUR).create();
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Patients who called within `week` and whose IE is after the week. */
function sweepCallWeek(week, cache) {
  return sweep(week.start, week.end, cache, function (values, tz) {
    return extractScheduledOut(values, week, tz);
  });
}

/**
 * Patients whose IE falls within `week` but who called in an earlier week.
 * Calls up to CONFIG.IE_LOOKBACK_DAYS before the week are considered.
 */
function sweepIeWeek(week, cache) {
  return sweep(addDays(week.start, -CONFIG.IE_LOOKBACK_DAYS), week.end, cache, function (values, tz) {
    return extractLandingInWeek(values, week, tz);
  });
}

/**
 * Runs `extract` over every clinic tab of every monthly NPS between `from`
 * and `to`, dedupes by clinic + patient + call date, and sorts the result.
 */
function sweep(from, to, cache, extract) {
  var byKey = {};
  monthsBetween(from, to).forEach(function (month) {
    var nps = loadNps(month, cache);
    if (!nps) return;
    nps.tabs.forEach(function (tab) {
      extract(tab.values, nps.tz).forEach(function (r) {
        r.clinicTab = tab.name;
        r.clinic = clinicName(tab.values, tab.name);
        r.sourceUrl = nps.url + '#gid=' + tab.gid + '&range=A' + r.rowNumber;
        // Later months overwrite earlier ones if a patient was carried over.
        byKey[rowKey(r.clinic, r.patient, r.callDate)] = r;
      });
    });
  });

  return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
    return a.clinic.localeCompare(b.clinic) || a.callDate.localeCompare(b.callDate) ||
      a.patient.localeCompare(b.patient);
  });
}

/** Reads one month's NPS once per run: { url, tz, tabs: [{ name, gid, values }] }. */
function loadNps(month, cache) {
  var key = month.getFullYear() + '-' + month.getMonth();
  if (key in cache) return cache[key];

  var file = findNpsFile(MONTH_NAMES[month.getMonth()], String(month.getFullYear()));
  if (!file) {
    Logger.log('No NPS found for ' + MONTH_NAMES[month.getMonth()] + ' ' + month.getFullYear());
    return (cache[key] = null);
  }
  var ss = SpreadsheetApp.openById(file.getId());
  return (cache[key] = {
    url: ss.getUrl(),
    tz: ss.getSpreadsheetTimeZone(),
    tabs: ss.getSheets().map(function (sheet) {
      return { name: sheet.getName(), gid: sheet.getSheetId(), values: sheet.getDataRange().getValues() };
    }),
  });
}

/** First day of each month from `from`'s month through `to`'s month. */
function monthsBetween(from, to) {
  var months = [];
  var m = new Date(from.getFullYear(), from.getMonth(), 1);
  while (m <= to) {
    months.push(m);
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }
  return months;
}

/** Call-week view: called inside `week`, IE after the week's last day. */
function extractScheduledOut(values, week, tz) {
  var weekStart = isoKey(week.start, Session.getScriptTimeZone());
  var weekEnd = isoKey(week.end, Session.getScriptTimeZone());
  return extractRows(values, tz, function (callDate, ieDate) {
    return callDate >= weekStart && callDate <= weekEnd && ieDate > weekEnd;
  });
}

/** IE-week view: IE inside `week`, called before the week started. */
function extractLandingInWeek(values, week, tz) {
  var weekStart = isoKey(week.start, Session.getScriptTimeZone());
  var weekEnd = isoKey(week.end, Session.getScriptTimeZone());
  return extractRows(values, tz, function (callDate, ieDate) {
    return ieDate >= weekStart && ieDate <= weekEnd && callDate < weekStart;
  });
}

/**
 * Pure filter over one clinic tab's values (2-D array from getValues()).
 * Dates are compared as 'yyyy-MM-dd' strings in the source sheet's time
 * zone so a midnight timestamp can never slip into the wrong day. Rows
 * need a patient, a call date and an IE date, and a status not in
 * CONFIG.EXCLUDE_STATUSES. Returns [] for tabs that aren't clinic tabs.
 */
function extractRows(values, tz, matches) {
  var h = findHeader(values);
  if (!h) return [];

  var excluded = CONFIG.EXCLUDE_STATUSES.map(function (s) { return s.toLowerCase(); });
  var out = [];

  for (var i = h.row + 1; i < values.length; i++) {
    var row = values[i];
    var patient = String(row[h.cols.PATIENT] || '').trim();
    if (!patient) continue;

    var callDate = toIsoKey(row[h.cols.CALL_DATE], tz);
    var ieDate = toIsoKey(row[h.cols.IE_DATE], tz);
    if (!callDate || !ieDate || !matches(callDate, ieDate)) continue;

    var status = cell(row, h.cols.STATUS);
    if (excluded.indexOf(status.toLowerCase()) !== -1) continue;

    out.push({
      rowNumber: i + 1,
      patient: patient,
      callDate: callDate,
      ieDate: ieDate,
      takenBy: cell(row, h.cols.TAKEN_BY),
      referral: cell(row, h.cols.REFERRAL),
      diagnosis: cell(row, h.cols.DIAGNOSIS),
      primaryIns: cell(row, h.cols.PRIMARY_INS),
      notes: cell(row, h.cols.NOTES),
      status: status,
      daysCallToIe: diffIsoDays(callDate, ieDate),
      daysPastCallWeek: diffIsoDays(callWeekEnd(callDate), ieDate),
    });
  }
  return out;
}

/** Last day ('yyyy-MM-dd') of the week a call date falls in. */
function callWeekEnd(callIso) {
  return isoKey(weekRange(parseIsoDate(callIso)).end, Session.getScriptTimeZone());
}

/** Locates the header row and the column index of each CONFIG.HEADERS entry. */
function findHeader(values) {
  var limit = Math.min(values.length, CONFIG.HEADER_SEARCH_ROWS);
  for (var r = 0; r < limit; r++) {
    var labels = values[r].map(function (v) { return String(v).trim().toLowerCase(); });
    var cols = {};
    Object.keys(CONFIG.HEADERS).forEach(function (k) {
      var idx = labels.indexOf(CONFIG.HEADERS[k].toLowerCase());
      cols[k] = idx === -1 ? null : idx;
    });
    if (cols.CALL_DATE !== null && cols.PATIENT !== null && cols.IE_DATE !== null) {
      return { row: r, cols: cols };
    }
  }
  return null;
}

/**
 * Clinic display name: CONFIG.CLINIC_NAMES for the tab, else the title in A2
 * ("EAST WINDS"), else the tab name. Always passed through canonicalClinic so
 * spelling and capitalization match the CONFIG list.
 */
function clinicName(values, tabName) {
  if (CONFIG.CLINIC_NAMES[tabName]) return CONFIG.CLINIC_NAMES[tabName];
  var title = values.length > 1 ? String(values[1][0] || '').trim() : '';
  return canonicalClinic(title || tabName);
}

// A2 titles that are abbreviated in the NPS -> clinic name.
var CLINIC_TITLE_ALIASES = { 'east winds': 'East Windsor', 'east bruns': 'East Brunswick' };

/**
 * Maps any spelling of a clinic ("BRICK", "Brick", "EAST WINDS", "EW") to
 * its CONFIG.CLINIC_NAMES name, so rows written before a rename still match.
 */
function canonicalClinic(name) {
  var n = String(name || '').trim();
  if (CONFIG.CLINIC_NAMES[n]) return CONFIG.CLINIC_NAMES[n];
  var lower = n.toLowerCase();
  if (CLINIC_TITLE_ALIASES[lower]) return CLINIC_TITLE_ALIASES[lower];
  var names = allClinicNames();
  for (var i = 0; i < names.length; i++) {
    if (names[i].toLowerCase() === lower) return names[i];
  }
  return n;
}

/** Unique clinic names from CONFIG.CLINIC_NAMES, A–Z. */
function allClinicNames() {
  var seen = {};
  Object.keys(CONFIG.CLINIC_NAMES).forEach(function (k) { seen[CONFIG.CLINIC_NAMES[k]] = true; });
  return Object.keys(seen).sort();
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
// Output
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
  props.setProperty(OUTPUT_ID_PROPERTY, ss.getId());
  Logger.log('Created output spreadsheet: ' + ss.getUrl());
  return ss;
}

/**
 * Rebuilds one weekly tab. Follow-up columns the team already filled in are
 * carried over; rows with follow-up that are no longer on the sweep are kept
 * at the bottom, greyed out and marked resolved.
 */
function writeWeekTab(output, view, week, rows) {
  var tz = Session.getScriptTimeZone();
  var name = view.prefix + Utilities.formatDate(week.start, tz, 'MM-dd-yy');
  var sheet = output.getSheetByName(name);
  var saved = sheet ? readSavedRows(sheet) : {};

  if (!sheet) {
    sheet = output.insertSheet(name);
    sortTabs(output);
  }
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  sheet.clear();
  sheet.setConditionalFormatRules([]);

  var data = rows.map(function (r) {
    var key = rowKey(r.clinic, r.patient, r.callDate);
    var prior = saved[key];
    delete saved[key];
    return [
      r.clinic, parseIsoDate(r.callDate), r.patient, r.takenBy, r.referral, r.diagnosis,
      r.primaryIns, parseIsoDate(r.ieDate), r.daysCallToIe, r.daysPastCallWeek, r.status,
      r.notes, '=HYPERLINK("' + r.sourceUrl + '","' + r.clinicTab + ' row ' + r.rowNumber + '")',
      prior ? prior[FOLLOW_UP_COL - 1] : '', prior ? prior[FOLLOW_UP_NOTES_COL - 1] : '',
    ];
  });
  var resolved = Object.keys(saved).map(function (k) {
    var row = saved[k].slice();
    row[STATUS_COL - 1] = RESOLVED_STATUS;
    return row;
  });

  var range = Utilities.formatDate(week.start, tz, 'EEE MM/dd/yyyy') + ' – ' +
    Utilities.formatDate(week.end, tz, 'EEE MM/dd/yyyy');
  sheet.getRange(1, 1).setValue(view.title(range)).setFontWeight('bold').setFontSize(13);
  sheet.getRange(2, 1).setValue(rows.length + ' patient(s)' +
    (resolved.length ? ' + ' + resolved.length + ' resolved' : '') + ' · refreshed ' +
    Utilities.formatDate(new Date(), tz, 'MM/dd/yyyy h:mm a')).setFontColor('#666666');

  sheet.getRange(TABLE_HEADER_ROW, 1, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS])
    .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
  sheet.setFrozenRows(TABLE_HEADER_ROW);

  var all = data.concat(resolved);
  if (all.length) {
    var first = TABLE_HEADER_ROW + 1;
    sheet.getRange(first, 1, all.length, OUTPUT_HEADERS.length).setValues(all)
      .setVerticalAlignment('top');
    sheet.getRange(first, 2, all.length, 1).setNumberFormat('MM/dd/yyyy');
    sheet.getRange(first, 8, all.length, 1).setNumberFormat('MM/dd/yyyy');
    sheet.getRange(first, 12, all.length, 1).setWrap(true);
    sheet.getRange(first, FOLLOW_UP_COL, all.length, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.FOLLOW_UP_OPTIONS, true)
        .setAllowInvalid(true).build());
    if (data.length) shadeByDaysOut(sheet, data.length);
    if (resolved.length) {
      sheet.getRange(first + data.length, 1, resolved.length, FOLLOW_UP_COL - 1)
        .setFontColor('#999999').setBackground('#f3f3f3');
    }
  } else {
    sheet.getRange(TABLE_HEADER_ROW + 1, 1).setValue(view.empty);
  }

  writeClinicSummary(sheet, rows);
  sheet.autoResizeColumns(1, 11);
  sheet.setColumnWidth(12, 320);
  sheet.setColumnWidth(FOLLOW_UP_NOTES_COL, 260);
}

/**
 * Map of rowKey -> full row (Source kept as its HYPERLINK formula) for
 * every row on an existing tab where Follow-up or Follow-up Notes is filled.
 */
function readSavedRows(sheet) {
  var last = sheet.getLastRow();
  if (last <= TABLE_HEADER_ROW) return {};
  var range = sheet.getRange(TABLE_HEADER_ROW + 1, 1, last - TABLE_HEADER_ROW, OUTPUT_HEADERS.length);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var tz = Session.getScriptTimeZone();
  var map = {};
  values.forEach(function (v, i) {
    if (!v[FOLLOW_UP_COL - 1] && !v[FOLLOW_UP_NOTES_COL - 1]) return;
    var callDate = toIsoKey(v[1], tz);
    if (!v[0] || !v[2] || !callDate) return;
    var row = v.slice();
    if (formulas[i][SOURCE_COL - 1]) row[SOURCE_COL - 1] = formulas[i][SOURCE_COL - 1];
    row[0] = canonicalClinic(v[0]);
    map[rowKey(row[0], String(v[2]), callDate)] = row;
  });
  return map;
}

/** Amber for 1–6 days past the call week, red for 7+ (pushed two weeks or more). */
function shadeByDaysOut(sheet, count) {
  var col = OUTPUT_HEADERS.indexOf('Days Past Call Week') + 1;
  var target = sheet.getRange(TABLE_HEADER_ROW + 1, col, count, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(7)
      .setBackground('#f4c7c3').setRanges([target]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(1, 6)
      .setBackground('#fce8b2').setRanges([target]).build(),
  ]);
}

/**
 * Per-clinic counts to the right of the table: every clinic in
 * CONFIG.CLINIC_NAMES (0 if none that week), most first.
 */
function writeClinicSummary(sheet, rows) {
  var col = OUTPUT_HEADERS.length + 2;
  var counts = {};
  allClinicNames().forEach(function (c) { counts[c] = 0; });
  rows.forEach(function (r) { counts[r.clinic] = (counts[r.clinic] || 0) + 1; });
  var clinics = Object.keys(counts).sort(function (a, b) {
    return counts[b] - counts[a] || a.localeCompare(b);
  });
  sheet.getRange(TABLE_HEADER_ROW, col, 1, 2).setValues([['Clinic', 'Count']])
    .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
  if (clinics.length) {
    sheet.getRange(TABLE_HEADER_ROW + 1, col, clinics.length, 2)
      .setValues(clinics.map(function (c) { return [c, counts[c]]; }));
  }
}

/** The view a tab belongs to, or null for any other tab. */
function viewOfTab(name) {
  if (name.indexOf(VIEWS.IES.prefix) === 0) return VIEWS.IES;
  if (name.indexOf(VIEWS.CALLS.prefix) === 0) return VIEWS.CALLS;
  return null;
}

/** IE-week tabs first, then call-week tabs; newest first within each. */
function sortTabs(output) {
  var weekTabs = output.getSheets().filter(function (s) {
    return viewOfTab(s.getName());
  }).sort(function (a, b) {
    var va = viewOfTab(a.getName());
    var vb = viewOfTab(b.getName());
    return va.order - vb.order ||
      tabWeekKey(b.getName(), vb).localeCompare(tabWeekKey(a.getName(), va));
  });
  weekTabs.forEach(function (s, i) {
    output.setActiveSheet(s);
    output.moveActiveSheet(i + 1);
  });
  // Drop the blank default tab a new spreadsheet comes with.
  output.getSheets().forEach(function (s) {
    if (!viewOfTab(s.getName()) && s.getLastRow() === 0 && output.getSheets().length > 1) {
      output.deleteSheet(s);
    }
  });
}

/** Keeps the newest CONFIG.MAX_WEEKS_KEPT tabs of each view. */
function trimOldTabs(output) {
  [VIEWS.CALLS, VIEWS.IES].forEach(function (view) {
    output.getSheets().filter(function (s) {
      return viewOfTab(s.getName()) === view;
    }).sort(function (a, b) {
      return tabWeekKey(b.getName(), view).localeCompare(tabWeekKey(a.getName(), view));
    }).slice(CONFIG.MAX_WEEKS_KEPT).forEach(function (s) { output.deleteSheet(s); });
  });
}

/** "Week of 10-05-26" -> "26-10-05" so tab names sort chronologically. */
function tabWeekKey(name, view) {
  var m = name.substring(view.prefix.length).split('-');
  return m.length === 3 ? m[2] + '-' + m[0] + '-' + m[1] : '';
}

function notify(output, results) {
  if (!CONFIG.NOTIFY_EMAILS.length) return;
  var tz = Session.getScriptTimeZone();
  var lines = results.map(function (r) {
    var when = Utilities.formatDate(r.week.start, tz, 'MM/dd');
    return r.view === VIEWS.IES
      ? 'IEs week of ' + when + ': ' + r.rows.length + ' patient(s) called in an earlier week'
      : 'Calls week of ' + when + ': ' + r.rows.length + ' patient(s) with an IE booked in a later week';
  });
  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAILS.join(','),
    subject: 'NPS sweep — IEs scheduled out past the call week',
    body: lines.join('\n') + '\n\nOpen the sweep: ' + output.getUrl(),
  });
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** { start, end } for the week containing `date` (local midnight, inclusive). */
function weekRange(date) {
  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  var back = (d.getDay() - CONFIG.WEEK_START_DAY + 7) % 7;
  var start = addDays(d, -back);
  return { start: start, end: addDays(start, 6) };
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function isoKey(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/**
 * Cell value -> 'yyyy-MM-dd', or null. Accepts real dates (the normal
 * case) and typed text like "10/5/26" or "10/05/2026".
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

function diffIsoDays(fromIso, toIso) {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((parseIsoDate(toIso).getTime() - parseIsoDate(fromIso).getTime()) / MS_PER_DAY);
}

function rowKey(clinic, patient, callDate) {
  return [clinic, patient, callDate].map(function (s) {
    return String(s).trim().toLowerCase();
  }).join('|');
}

function cell(row, idx) {
  return idx === null || idx === undefined ? '' : String(row[idx] || '').trim();
}
