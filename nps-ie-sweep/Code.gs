/**
 * Trinity Rehab — NPS "IE Scheduled Out" Sweep
 *
 * Sweeps the monthly New Patient Spreadsheet (NPS) for patients who CALLED
 * during a given week but whose initial evaluation (FS/IE Date) wasn't
 * booked until a LATER week — i.e. called this week, not seen until next
 * week or beyond. Those are the patients worth reviewing for an earlier
 * slot.
 *
 * Source: the NPS is one Google Sheet per month, named like
 * "October 2026 New Patient Spreadsheet" (older months: "March 2026 NPS").
 * Every clinic tab (BR, SHRW, MAN, ... Warren) has the same layout — a
 * header row with "Date" (call date), "Patient Name", "FS/IE Date", etc.
 * Tabs without that header (CONSOLIDATED, DIGITAL TRACKING, DDB, ELLAAGENT)
 * are skipped automatically. Because a week can straddle two months
 * (e.g. Mon 9/28 – Sun 10/4), the script opens every monthly NPS the week
 * touches, found by title — no file IDs to update each month.
 *
 * Output: ONE persistent spreadsheet with a tab per week ("Week of
 * 10-05-26"), newest first. Each run rebuilds the current week's and the
 * previous week's tabs (so late data entry gets picked up), while keeping
 * whatever the team typed into the Follow-up / Follow-up Notes columns.
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
  // here, so with Monday the week is Mon–Sun and "scheduled out" means the
  // FS/IE Date is the following Monday or later.
  WEEK_START_DAY: 1,

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

  // How many weekly tabs to keep in the output before deleting the oldest.
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
var TAB_PREFIX = 'Week of ';
var TABLE_HEADER_ROW = 4;
var OUTPUT_HEADERS = [
  'Clinic', 'Call Date', 'Patient Name', 'Taken By', 'Referral Source',
  'Diagnosis', 'Primary Insurance', 'FS/IE Date', 'Days Call → IE',
  'Days Past Week End', 'Status', 'NPS Notes', 'Source', 'Follow-up',
  'Follow-up Notes',
];
// Columns the team fills in — preserved across re-runs.
var FOLLOW_UP_COL = OUTPUT_HEADERS.indexOf('Follow-up') + 1;
var FOLLOW_UP_NOTES_COL = OUTPUT_HEADERS.indexOf('Follow-up Notes') + 1;
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Daily job: refresh this week's and last week's tabs. */
function runSweep() {
  var today = new Date();
  var thisWeek = weekRange(today);
  var lastWeek = weekRange(addDays(thisWeek.start, -7));
  var output = getOutputSpreadsheet();

  var results = [lastWeek, thisWeek].map(function (week) {
    var rows = sweepWeek(week);
    writeWeekTab(output, week, rows);
    return { week: week, rows: rows };
  });

  trimOldTabs(output);
  notify(output, results);
}

/**
 * Manual helper: sweep the week containing a specific date, e.g.
 * sweepWeekContaining('2026-09-30'). Handy for back-filling past weeks.
 */
function sweepWeekContaining(isoDate) {
  var week = weekRange(parseIsoDate(isoDate));
  var output = getOutputSpreadsheet();
  writeWeekTab(output, week, sweepWeek(week));
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

/**
 * Returns every patient who called within `week` and whose FS/IE Date is
 * after the week's last day, across all monthly NPS files the week touches.
 */
function sweepWeek(week) {
  var byKey = {};
  findNpsFilesForWeek(week).forEach(function (file) {
    var ss = SpreadsheetApp.openById(file.getId());
    var tz = ss.getSpreadsheetTimeZone();
    ss.getSheets().forEach(function (sheet) {
      var values = sheet.getDataRange().getValues();
      var rows = extractScheduledOut(values, week, tz);
      rows.forEach(function (r) {
        r.clinicTab = sheet.getName();
        r.clinic = clinicName(values, sheet.getName());
        r.sourceUrl = ss.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + r.rowNumber;
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

/**
 * Pure filter over one clinic tab's values (2-D array from getValues()).
 * Dates are compared as 'yyyy-MM-dd' strings in the source sheet's time
 * zone so a midnight timestamp can never slip into the wrong day.
 * Returns [] for tabs that aren't clinic tabs.
 */
function extractScheduledOut(values, week, tz) {
  var h = findHeader(values);
  if (!h) return [];

  // Week bounds in the script's zone; cell dates in the source sheet's zone.
  var weekStart = isoKey(week.start, Session.getScriptTimeZone());
  var weekEnd = isoKey(week.end, Session.getScriptTimeZone());
  var excluded = CONFIG.EXCLUDE_STATUSES.map(function (s) { return s.toLowerCase(); });
  var out = [];

  for (var i = h.row + 1; i < values.length; i++) {
    var row = values[i];
    var patient = String(row[h.cols.PATIENT] || '').trim();
    if (!patient) continue;

    var callDate = toIsoKey(row[h.cols.CALL_DATE], tz);
    if (!callDate || callDate < weekStart || callDate > weekEnd) continue;

    var ieDate = toIsoKey(row[h.cols.IE_DATE], tz);
    if (!ieDate || ieDate <= weekEnd) continue;

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
      daysPastWeekEnd: diffIsoDays(weekEnd, ieDate),
    });
  }
  return out;
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

/** Clinic display name: the title in A2 ("EAST WINDS"), else the tab name. */
function clinicName(values, tabName) {
  var title = values.length > 1 ? String(values[1][0] || '').trim() : '';
  return title || tabName;
}

/** Monthly NPS spreadsheets covering the week's start and end months. */
function findNpsFilesForWeek(week) {
  var months = [week.start, week.end].map(function (d) {
    return { month: MONTH_NAMES[d.getMonth()], year: String(d.getFullYear()) };
  });
  if (months[0].month === months[1].month) months.pop();

  var files = [];
  months.forEach(function (m) {
    var file = findNpsFile(m.month, m.year);
    if (file) {
      files.push(file);
    } else {
      Logger.log('No NPS found for ' + m.month + ' ' + m.year);
    }
  });
  return files;
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

/** Rebuilds the week's tab, keeping Follow-up columns the team already filled in. */
function writeWeekTab(output, week, rows) {
  var tz = Session.getScriptTimeZone();
  var name = TAB_PREFIX + Utilities.formatDate(week.start, tz, 'MM-dd-yy');
  var sheet = output.getSheetByName(name);
  var saved = sheet ? readFollowUps(sheet) : {};

  if (!sheet) {
    sheet = output.insertSheet(name);
    sortTabsNewestFirst(output);
  }
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  sheet.clear();
  sheet.setConditionalFormatRules([]);

  var range = Utilities.formatDate(week.start, tz, 'EEE MM/dd/yyyy') + ' – ' +
    Utilities.formatDate(week.end, tz, 'EEE MM/dd/yyyy');
  sheet.getRange(1, 1).setValue('Called ' + range + ' — IE scheduled after the week')
    .setFontWeight('bold').setFontSize(13);
  sheet.getRange(2, 1).setValue(rows.length + ' patient(s) · refreshed ' +
    Utilities.formatDate(new Date(), tz, 'MM/dd/yyyy h:mm a')).setFontColor('#666666');

  sheet.getRange(TABLE_HEADER_ROW, 1, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS])
    .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
  sheet.setFrozenRows(TABLE_HEADER_ROW);

  if (rows.length) {
    var data = rows.map(function (r) {
      var prior = saved[rowKey(r.clinic, r.patient, r.callDate)] || ['', ''];
      return [
        r.clinic, parseIsoDate(r.callDate), r.patient, r.takenBy, r.referral, r.diagnosis,
        r.primaryIns, parseIsoDate(r.ieDate), r.daysCallToIe, r.daysPastWeekEnd, r.status,
        r.notes, '=HYPERLINK("' + r.sourceUrl + '","' + r.clinicTab + ' row ' + r.rowNumber + '")',
        prior[0], prior[1],
      ];
    });
    var body = sheet.getRange(TABLE_HEADER_ROW + 1, 1, data.length, OUTPUT_HEADERS.length);
    body.setValues(data).setVerticalAlignment('top');
    sheet.getRange(TABLE_HEADER_ROW + 1, 2, data.length, 1).setNumberFormat('MM/dd/yyyy');
    sheet.getRange(TABLE_HEADER_ROW + 1, 8, data.length, 1).setNumberFormat('MM/dd/yyyy');
    sheet.getRange(TABLE_HEADER_ROW + 1, 12, data.length, 1).setWrap(true);
    sheet.getRange(TABLE_HEADER_ROW + 1, FOLLOW_UP_COL, data.length, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(CONFIG.FOLLOW_UP_OPTIONS, true)
        .setAllowInvalid(true).build());
    shadeByDaysOut(sheet, data.length);
  } else {
    sheet.getRange(TABLE_HEADER_ROW + 1, 1).setValue('No patients scheduled out for this week.');
  }

  writeClinicSummary(sheet, rows);
  sheet.autoResizeColumns(1, 11);
  sheet.setColumnWidth(12, 320);
  sheet.setColumnWidth(FOLLOW_UP_NOTES_COL, 260);
}

/** Map of rowKey -> [Follow-up, Follow-up Notes] from an existing week tab. */
function readFollowUps(sheet) {
  var last = sheet.getLastRow();
  if (last <= TABLE_HEADER_ROW) return {};
  var values = sheet.getRange(TABLE_HEADER_ROW + 1, 1, last - TABLE_HEADER_ROW, OUTPUT_HEADERS.length)
    .getValues();
  var tz = Session.getScriptTimeZone();
  var map = {};
  values.forEach(function (v) {
    var followUp = v[FOLLOW_UP_COL - 1];
    var notes = v[FOLLOW_UP_NOTES_COL - 1];
    if (!followUp && !notes) return;
    var callDate = toIsoKey(v[1], tz);
    if (!v[0] || !v[2] || !callDate) return;
    map[rowKey(String(v[0]), String(v[2]), callDate)] = [followUp, notes];
  });
  return map;
}

/** Amber for 1–6 days past week end, red for 7+ (pushed two weeks or more). */
function shadeByDaysOut(sheet, count) {
  var col = OUTPUT_HEADERS.indexOf('Days Past Week End') + 1;
  var target = sheet.getRange(TABLE_HEADER_ROW + 1, col, count, 1);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(7)
      .setBackground('#f4c7c3').setRanges([target]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(1, 6)
      .setBackground('#fce8b2').setRanges([target]).build(),
  ]);
}

/** Per-clinic counts to the right of the table. */
function writeClinicSummary(sheet, rows) {
  var col = OUTPUT_HEADERS.length + 2;
  var counts = {};
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

function sortTabsNewestFirst(output) {
  var weekTabs = output.getSheets().filter(function (s) {
    return s.getName().indexOf(TAB_PREFIX) === 0;
  }).sort(function (a, b) {
    return tabWeekKey(b.getName()).localeCompare(tabWeekKey(a.getName()));
  });
  weekTabs.forEach(function (s, i) {
    output.setActiveSheet(s);
    output.moveActiveSheet(i + 1);
  });
  // Drop the blank default tab a new spreadsheet comes with.
  output.getSheets().forEach(function (s) {
    if (s.getName().indexOf(TAB_PREFIX) !== 0 && s.getLastRow() === 0 &&
        output.getSheets().length > 1) {
      output.deleteSheet(s);
    }
  });
}

function trimOldTabs(output) {
  var weekTabs = output.getSheets().filter(function (s) {
    return s.getName().indexOf(TAB_PREFIX) === 0;
  }).sort(function (a, b) {
    return tabWeekKey(b.getName()).localeCompare(tabWeekKey(a.getName()));
  });
  weekTabs.slice(CONFIG.MAX_WEEKS_KEPT).forEach(function (s) { output.deleteSheet(s); });
}

/** "Week of 10-05-26" -> "26-10-05" so tab names sort chronologically. */
function tabWeekKey(name) {
  var m = name.substring(TAB_PREFIX.length).split('-');
  return m.length === 3 ? m[2] + '-' + m[0] + '-' + m[1] : '';
}

function notify(output, results) {
  if (!CONFIG.NOTIFY_EMAILS.length) return;
  var tz = Session.getScriptTimeZone();
  var lines = results.map(function (r) {
    return 'Week of ' + Utilities.formatDate(r.week.start, tz, 'MM/dd') + ': ' +
      r.rows.length + ' patient(s) called that week with an IE booked in a later week';
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
