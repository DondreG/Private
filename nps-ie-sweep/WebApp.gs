/**
 * Trinity Rehab — NPS IE Sweep web app
 *
 * A browser/phone view of the tracking sheet that Code.gs builds. It reads
 * the weekly tabs straight from the output spreadsheet (no re-sweep on page
 * load), saves Follow-up / Follow-up Notes back into the same cells, and
 * offers a "Refresh now" button that runs the full sweep.
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me    Who has access: Anyone within Trinity Rehab
 */

var APP_TITLE = 'NPS IE Sweep';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Everything the page needs: every weekly tab with its rows. */
function getDashboardData() {
  var output = getOutputSpreadsheet();
  var tabs = output.getSheets().filter(function (s) {
    return viewOfTab(s.getName());
  }).map(readTabForApp);

  return {
    sheetUrl: output.getUrl(),
    followUpOptions: CONFIG.FOLLOW_UP_OPTIONS,
    clinics: allClinicNames(),
    loadedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy h:mm a'),
    tabs: tabs,
  };
}

/**
 * Saves Follow-up and Follow-up Notes for one patient. The row is found by
 * clinic + patient + call date (not just row number), because a refresh can
 * reorder the tab between page load and save.
 */
function saveFollowUp(tabName, key, followUp, notes) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOutputSpreadsheet().getSheetByName(tabName);
    if (!sheet) throw new Error('Tab "' + tabName + '" no longer exists. Reload the page.');
    var row = findRowByKey(sheet, key);
    if (!row) throw new Error('That patient is no longer on "' + tabName + '". Reload the page.');
    sheet.getRange(row, FOLLOW_UP_COL, 1, 2).setValues([[followUp || '', notes || '']]);
    return { ok: true, savedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'h:mm a') };
  } finally {
    lock.releaseLock();
  }
}

/** "Refresh now" button: runs the full sweep, then returns fresh data. */
function refreshNow() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    runSweep();
  } finally {
    lock.releaseLock();
  }
  return getDashboardData();
}

/** One weekly tab as plain data for the page. */
function readTabForApp(sheet) {
  var view = viewOfTab(sheet.getName());
  var last = sheet.getLastRow();
  var rows = [];
  if (last > TABLE_HEADER_ROW) {
    var range = sheet.getRange(TABLE_HEADER_ROW + 1, 1, last - TABLE_HEADER_ROW, OUTPUT_HEADERS.length);
    var shown = range.getDisplayValues();
    var formulas = range.getFormulas();
    shown.forEach(function (v, i) {
      if (!v[0] || !v[2] || !v[1]) return; // empty-week message, blank rows
      rows.push({
        key: appRowKey(v[0], v[2], v[1]),
        clinic: v[0],
        callDate: v[1],
        patient: v[2],
        takenBy: v[3],
        referral: v[4],
        diagnosis: v[5],
        primaryIns: v[6],
        ieDate: v[7],
        daysCallToIe: v[8],
        daysPastCallWeek: v[9],
        status: v[10],
        notes: v[11],
        sourceLabel: v[SOURCE_COL - 1],
        sourceUrl: linkFromFormula(formulas[i][SOURCE_COL - 1]),
        followUp: v[FOLLOW_UP_COL - 1],
        followUpNotes: v[FOLLOW_UP_NOTES_COL - 1],
        resolved: v[STATUS_COL - 1] === RESOLVED_STATUS,
      });
    });
  }
  return {
    name: sheet.getName(),
    kind: view === VIEWS.IES ? 'ies' : 'calls',
    title: String(sheet.getRange(1, 1).getDisplayValue()),
    subtitle: String(sheet.getRange(2, 1).getDisplayValue()),
    rows: rows,
  };
}

/** Sheet row number (1-based) whose clinic + patient + call date match `key`. */
function findRowByKey(sheet, key) {
  var last = sheet.getLastRow();
  if (last <= TABLE_HEADER_ROW) return null;
  var shown = sheet.getRange(TABLE_HEADER_ROW + 1, 1, last - TABLE_HEADER_ROW, 3).getDisplayValues();
  for (var i = 0; i < shown.length; i++) {
    if (appRowKey(shown[i][0], shown[i][2], shown[i][1]) === key) return TABLE_HEADER_ROW + 1 + i;
  }
  return null;
}

/** Same idea as rowKey() in Code.gs, but on the sheet's displayed date text. */
function appRowKey(clinic, patient, callDateText) {
  return [clinic, patient, callDateText].map(function (s) {
    return String(s).trim().toLowerCase();
  }).join('|');
}

/** '=HYPERLINK("url","label")' -> url */
function linkFromFormula(formula) {
  var m = String(formula || '').match(/^=HYPERLINK\("([^"]+)"/i);
  return m ? m[1] : '';
}
