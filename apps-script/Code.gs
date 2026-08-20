/**
 * Trinity Rehab — Authorization Tracking Report
 *
 * Replaces manual offshore-team verification of authorization end dates
 * and remaining visit counts. Each run reads the latest raw per-auth
 * export, applies the priority rule below, and writes a new dated section
 * into ONE persistent Google Doc (CONFIG.TRACKING_DOC_ID) so there's a
 * single place to open and see current + historical status — no jumping
 * between spreadsheets. Optionally also emails the same digest.
 *
 * Trigger rule (visit count takes priority over date range, per request):
 *   1. PRIORITY 1 — remaining visits < VISIT_THRESHOLD (default 6)
 *   2. PRIORITY 2 — auth end date within DAYS_THRESHOLD (default 7) days,
 *      only evaluated/shown when the visit rule above did NOT already fire.
 * An authorization can still fire on date alone (e.g. Workers Comp / Auto-PIP,
 * where the date typically runs out before visits do), it just won't get
 * flagged as "critical" if it's already flagged for low visits.
 *
 * Known data-quality caveats (see "What to fix before any of this can be
 * automated" tab in the source workbook) that this script works around:
 *   - Some auths carry a 12/31 placeholder end date that is not a real
 *     expiration. Rows matching PLACEHOLDER_END_DATES are excluded from the
 *     date leg of the rule (the visit leg still applies normally).
 *   - Auth *start* date is unreliable (mass 8/4 go-live migration date) and
 *     is intentionally not used anywhere in this script.
 *
 * Source data lives in a periodically re-exported spreadsheet named like
 * "Scrips_Auths - 08-20-26" (tab "Scripts Auths"). Since the filename's
 * date changes each export, this script finds it by title prefix +
 * most-recent-modified instead of a fixed file ID.
 */

// ---------------------------------------------------------------------------
// CONFIG — edit these before running
// ---------------------------------------------------------------------------
var CONFIG = {
  // The Google Doc this script writes into. Fixed ID because, unlike the
  // Scrips_Auths export, this Doc is a stable, permanent artifact you keep
  // reopening — create it once, put its ID here.
  TRACKING_DOC_ID: '18_nrTmdQ1JQE88Wqajh0DsL-XL2_CombTwlMeGo8UVI',

  // How many "Week of ..." sections to keep in the Doc before trimming the oldest.
  MAX_WEEKS_KEPT: 12,

  // Drive is searched for the most recently modified spreadsheet whose
  // title starts with this prefix — matches "Scrips_Auths - 08-20-26", etc.
  SOURCE_FILE_TITLE_PREFIX: 'Scrips_Auths',

  // Tab name within that file. Falls back to the first sheet if not found.
  SOURCE_SHEET_NAME: 'Scripts Auths',

  // Only alert on rows where the "Case Active" column is this value
  // (case-insensitive). Set to null to disable the filter.
  CASE_ACTIVE_VALUE: 'yes',

  // Optional: also email the digest. Leave empty to skip email entirely
  // and rely on the tracking Doc only.
  NOTIFY_EMAILS: [
    // 'offshore-team@example.com',
    // 'billing-lead@trinity-rehab.com',
  ],

  VISIT_THRESHOLD: 6,   // "under 6 visits" -> remaining < 6 fires
  DAYS_THRESHOLD: 7,    // "7 days prior" -> days-to-end <= 7 fires

  // End dates that are known placeholders, not real expirations (MM/DD, any year).
  PLACEHOLDER_END_DATES: ['12/31'],

  // If true, a run that finds zero alerts still sends a short "all clear" email.
  SEND_ON_EMPTY: false,
};

var INTRO_TITLE = 'Trinity Rehab — Authorization Tracking';

// Header text this script looks for, matched case-insensitively as a
// substring against the source sheet's header row. First match wins.
// Order matters where headers overlap (e.g. "Patient Account #" vs
// "Patient First" both contain "patient" — explicit column names avoid that).
var HEADER_ALIASES = {
  patientFirst: ['patient first'],
  patientLast: ['patient last'],
  account: ['patient account #', 'account #'],
  payer: ['provider/payer', 'payer group', 'payer'],
  authEnd: ['end date'],
  totalVisits: ['total visits'],
  arrivedVisits: ['arrived visits'],
  remainingVisits: ['remaining visits', 'visits left'],
  clinic: ['clinic', 'location of last visit'],
  caseActive: ['case active'],
};

// ---------------------------------------------------------------------------
// Entry point — wire this to a weekly time-based trigger via installWeeklyTrigger()
// ---------------------------------------------------------------------------
function updateAuthTrackingReport() {
  var file = findSourceSpreadsheet();
  var sourceSs = SpreadsheetApp.openById(file.getId());
  var sourceSheet = sourceSs.getSheetByName(CONFIG.SOURCE_SHEET_NAME) || sourceSs.getSheets()[0];

  var data = sourceSheet.getDataRange().getValues();
  if (data.length < 2) return; // header only, nothing to do

  var headers = data[0];
  var col = mapHeaders(headers);

  var today = startOfDay(new Date());
  var alerts = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var alert = evaluateRow(row, col, today);
    if (alert) alerts.push(alert);
  }

  alerts.sort(compareAlerts);

  updateTrackingDoc(alerts, today, file.getName());

  if (alerts.length > 0 || CONFIG.SEND_ON_EMPTY) {
    sendDigest(alerts, today);
  }
}

function findSourceSpreadsheet() {
  var files = DriveApp.searchFiles(
    "title contains '" + CONFIG.SOURCE_FILE_TITLE_PREFIX.replace(/'/g, "\\'") + "'" +
    " and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false"
  );
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().indexOf(CONFIG.SOURCE_FILE_TITLE_PREFIX) !== 0) continue; // prefix, not just contains
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) {
    throw new Error('No spreadsheet found in Drive titled starting with "' +
      CONFIG.SOURCE_FILE_TITLE_PREFIX + '". Update CONFIG.SOURCE_FILE_TITLE_PREFIX.');
  }
  return newest;
}

function evaluateRow(row, col, today) {
  var first = col.patientFirst >= 0 ? row[col.patientFirst] : '';
  var last = col.patientLast >= 0 ? row[col.patientLast] : '';
  var patient = (String(first || '') + ' ' + String(last || '')).trim();
  if (!patient) return null; // blank row

  if (CONFIG.CASE_ACTIVE_VALUE && col.caseActive >= 0) {
    var activeVal = String(row[col.caseActive] || '').trim().toLowerCase();
    if (activeVal !== CONFIG.CASE_ACTIVE_VALUE.toLowerCase()) return null;
  }

  var payer = col.payer >= 0 ? row[col.payer] : '';
  var account = col.account >= 0 ? row[col.account] : '';
  var clinic = col.clinic >= 0 ? row[col.clinic] : '';

  var remaining = getRemainingVisits(row, col);
  var authEndDate = col.authEnd >= 0 ? asDate(row[col.authEnd]) : null;
  var daysToEnd = authEndDate ? diffDays(authEndDate, today) : null;
  var isPlaceholderDate = authEndDate ? isPlaceholder(authEndDate) : false;

  var reasons = [];
  var priority = null;

  if (remaining !== null && remaining < CONFIG.VISIT_THRESHOLD) {
    reasons.push('Only ' + remaining + ' visit(s) remaining');
    priority = 1;
  }

  if (authEndDate && !isPlaceholderDate && daysToEnd !== null && daysToEnd <= CONFIG.DAYS_THRESHOLD) {
    reasons.push(daysToEnd < 0
      ? 'Auth already expired (' + formatDate(authEndDate) + ')'
      : 'Auth expires in ' + daysToEnd + ' day(s) (' + formatDate(authEndDate) + ')');
    if (priority === null) priority = 2;
  }

  if (priority === null) return null;

  return {
    patient: patient,
    account: account,
    payer: payer,
    clinic: clinic,
    remaining: remaining,
    authEndDate: authEndDate,
    daysToEnd: daysToEnd,
    priority: priority,
    reasons: reasons,
  };
}

function getRemainingVisits(row, col) {
  if (col.remainingVisits >= 0) {
    var v = toNumber(row[col.remainingVisits]);
    if (v !== null) return v;
  }
  if (col.totalVisits >= 0 && col.arrivedVisits >= 0) {
    var total = toNumber(row[col.totalVisits]);
    var arrived = toNumber(row[col.arrivedVisits]);
    if (total !== null && arrived !== null) return total - arrived;
  }
  return null;
}

function compareAlerts(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.priority === 1) {
    var remA = a.remaining === null ? Infinity : a.remaining;
    var remB = b.remaining === null ? Infinity : b.remaining;
    if (remA !== remB) return remA - remB;
  }
  var daysA = a.daysToEnd === null ? Infinity : a.daysToEnd;
  var daysB = b.daysToEnd === null ? Infinity : b.daysToEnd;
  return daysA - daysB;
}

// ---------------------------------------------------------------------------
// Tracking Doc
// ---------------------------------------------------------------------------
function updateTrackingDoc(alerts, today, sourceFileName) {
  var doc = DocumentApp.openById(CONFIG.TRACKING_DOC_ID);
  var body = doc.getBody();

  ensureIntro(body);
  insertWeekSection(body, alerts, today, sourceFileName);
  trimOldWeeks(body, CONFIG.MAX_WEEKS_KEPT);

  doc.saveAndClose();
}

function ensureIntro(body) {
  var first = body.getNumChildren() > 0 ? body.getChild(0) : null;
  var hasIntro = first &&
    first.getType() === DocumentApp.ElementType.PARAGRAPH &&
    first.asParagraph().getText().indexOf(INTRO_TITLE) === 0;
  if (hasIntro) return;

  body.clear();
  body.appendParagraph(INTRO_TITLE).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(
    'Auto-updated weekly. Visit count is the priority signal; auth end date ' +
    'within ' + CONFIG.DAYS_THRESHOLD + ' days is the secondary factor. ' +
    'Priority 1 = fewer than ' + CONFIG.VISIT_THRESHOLD + ' visits remaining. ' +
    'Priority 2 = date-only, shown only when Priority 1 doesn\'t already apply.'
  ).setItalic(true);
}

// Intro is always exactly 2 paragraphs (title + description), so new weekly
// sections always get inserted starting right after them, at index 2.
function insertWeekSection(body, alerts, today, sourceFileName) {
  var critical = alerts.filter(function (a) { return a.priority === 1; });
  var dateOnly = alerts.filter(function (a) { return a.priority === 2; });

  var idx = 2;
  body.insertParagraph(idx++, 'Week of ' + formatDate(today)).setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.insertParagraph(idx++, 'Source: ' + sourceFileName + '  |  ' +
    critical.length + ' low-visit, ' + dateOnly.length + ' expiring-soon').setItalic(true);

  body.insertParagraph(idx++, 'Priority 1 — Low visits (fewer than ' + CONFIG.VISIT_THRESHOLD + ' remaining)')
    .setHeading(DocumentApp.ParagraphHeading.HEADING3);
  idx = insertAlertTable(body, idx, critical);

  body.insertParagraph(idx++, 'Priority 2 — Expiring soon, visits OK (≤ ' + CONFIG.DAYS_THRESHOLD + ' days)')
    .setHeading(DocumentApp.ParagraphHeading.HEADING3);
  idx = insertAlertTable(body, idx, dateOnly);

  body.insertParagraph(idx++, '──────────────────────────────');
}

function insertAlertTable(body, idx, list) {
  if (list.length === 0) {
    body.insertParagraph(idx, 'None.');
    return idx + 1;
  }
  var values = [['Patient', 'Payer', 'Clinic', 'Reason']];
  list.forEach(function (a) {
    values.push([
      a.patient + (a.account ? ' (' + a.account + ')' : ''),
      a.payer || '',
      a.clinic || '',
      a.reasons.join('; '),
    ]);
  });
  body.insertTable(idx, values);
  return idx + 1;
}

function trimOldWeeks(body, maxWeeks) {
  var headingIndices = [];
  for (var i = 2; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var p = child.asParagraph();
      if (p.getHeading() === DocumentApp.ParagraphHeading.HEADING2 && p.getText().indexOf('Week of ') === 0) {
        headingIndices.push(i);
      }
    }
  }
  if (headingIndices.length > maxWeeks) {
    var cutoff = headingIndices[maxWeeks];
    for (var j = body.getNumChildren() - 1; j >= cutoff; j--) {
      body.removeChild(body.getChild(j));
    }
  }
}

// ---------------------------------------------------------------------------
// Optional email digest
// ---------------------------------------------------------------------------
function sendDigest(alerts, today) {
  if (!CONFIG.NOTIFY_EMAILS || CONFIG.NOTIFY_EMAILS.length === 0) return;

  var critical = alerts.filter(function (a) { return a.priority === 1; });
  var dateOnly = alerts.filter(function (a) { return a.priority === 2; });

  var subject = 'Auth tracking update for ' + formatDate(today) + ': ' +
    critical.length + ' low-visit, ' + dateOnly.length + ' expiring-soon';

  var lines = [];
  lines.push('Weekly authorization check — ' + formatDate(today));
  lines.push('Full history: https://docs.google.com/document/d/' + CONFIG.TRACKING_DOC_ID);
  lines.push('Rule: visit count takes priority over date range.');
  lines.push('  Priority 1: fewer than ' + CONFIG.VISIT_THRESHOLD + ' visits remaining');
  lines.push('  Priority 2: auth end date within ' + CONFIG.DAYS_THRESHOLD + ' days (only shown if not already Priority 1)');
  lines.push('');

  lines.push('=== PRIORITY 1 — LOW VISITS (' + critical.length + ') ===');
  if (critical.length === 0) lines.push('None.');
  critical.forEach(function (a) { lines.push(formatAlertLine(a)); });
  lines.push('');

  lines.push('=== PRIORITY 2 — EXPIRING SOON, VISITS OK (' + dateOnly.length + ') ===');
  if (dateOnly.length === 0) lines.push('None.');
  dateOnly.forEach(function (a) { lines.push(formatAlertLine(a)); });

  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAILS.join(','),
    subject: subject,
    body: lines.join('\n'),
  });
}

function formatAlertLine(a) {
  return '- ' + a.patient +
    (a.account ? ' (' + a.account + ')' : '') +
    ' | ' + (a.payer || 'Payer unknown') +
    (a.clinic ? ' | ' + a.clinic : '') +
    ' | ' + a.reasons.join('; ');
}

// ---------------------------------------------------------------------------
// Trigger management
// ---------------------------------------------------------------------------
function installWeeklyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('updateAuthTrackingReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .everyWeeks(1)
    .create();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateAuthTrackingReport') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapHeaders(headers) {
  var col = {};
  Object.keys(HEADER_ALIASES).forEach(function (key) {
    col[key] = findColumn(headers, HEADER_ALIASES[key]);
  });
  return col;
}

function findColumn(headers, aliases) {
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]).toLowerCase();
    for (var j = 0; j < aliases.length; j++) {
      if (h.indexOf(aliases[j]) !== -1) return i;
    }
  }
  return -1;
}

function toNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function asDate(v) {
  if (v instanceof Date) return startOfDay(v);
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : startOfDay(d);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function diffDays(date, today) {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);
}

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'America/New_York', 'MM/dd/yyyy');
}

function isPlaceholder(date) {
  var mmdd = ('0' + (date.getMonth() + 1)).slice(-2) + '/' + ('0' + date.getDate()).slice(-2);
  return CONFIG.PLACEHOLDER_END_DATES.indexOf(mmdd) !== -1;
}
