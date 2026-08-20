/**
 * Trinity Rehab — Authorization Expiration & Low-Visit Notifier
 *
 * Replaces manual offshore-team verification of authorization end dates
 * and remaining visit counts with a scheduled digest email.
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
 */

// ---------------------------------------------------------------------------
// CONFIG — edit these before running
// ---------------------------------------------------------------------------
var CONFIG = {
  // Name of the tab holding one row per authorization (raw Scrips_Auths
  // export, or an equivalent per-auth tab). Must have a header row.
  SOURCE_SHEET_NAME: 'Scrips_Auths',

  // Where the digest gets sent. Add the offshore team + local billing lead.
  NOTIFY_EMAILS: [
    // 'offshore-team@example.com',
    // 'billing-lead@trinity-rehab.com',
  ],

  VISIT_THRESHOLD: 6,   // "under 6 visits" -> remaining < 6 fires
  DAYS_THRESHOLD: 7,    // "7 days prior" -> days-to-end <= 7 fires

  // End dates that are known placeholders, not real expirations (MM/DD, any year).
  PLACEHOLDER_END_DATES: ['12/31'],

  // Sheet tab this script appends an audit trail to (created if missing).
  LOG_SHEET_NAME: 'Auth Alerts Log',

  // If true, a run that finds zero alerts still sends a short "all clear" email.
  SEND_ON_EMPTY: false,
};

// Header text this script looks for, matched case-insensitively as a
// substring against the source sheet's header row. First match wins.
var HEADER_ALIASES = {
  patient: ['patient'],
  account: ['account #', 'account'],
  payer: ['payer group', 'payer'],
  authEnd: ['auth end', 'end date'],
  totalVisits: ['total visits', 'visits authorized', 'auths'],
  arrivedVisits: ['arrived'],
  remainingVisits: ['remaining', 'visits left'],
  clinic: ['clinic'],
};

// ---------------------------------------------------------------------------
// Entry point — wire this to a daily time-based trigger via installDailyTrigger()
// ---------------------------------------------------------------------------
function checkAuthorizations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sourceSheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
  if (!sourceSheet) {
    throw new Error('Source sheet "' + CONFIG.SOURCE_SHEET_NAME + '" not found. ' +
      'Update CONFIG.SOURCE_SHEET_NAME to match your raw authorizations tab.');
  }

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

  if (alerts.length > 0 || CONFIG.SEND_ON_EMPTY) {
    sendDigest(alerts, today);
  }
  logAlerts(ss, alerts, today);
}

function evaluateRow(row, col, today) {
  var patient = col.patient >= 0 ? row[col.patient] : '';
  if (!patient) return null; // blank row

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
// Email digest
// ---------------------------------------------------------------------------
function sendDigest(alerts, today) {
  if (!CONFIG.NOTIFY_EMAILS || CONFIG.NOTIFY_EMAILS.length === 0) {
    Logger.log('CONFIG.NOTIFY_EMAILS is empty — skipping send. Alerts found: ' + alerts.length);
    return;
  }

  var critical = alerts.filter(function (a) { return a.priority === 1; });
  var dateOnly = alerts.filter(function (a) { return a.priority === 2; });

  var subject = 'Auth alerts for ' + formatDate(today) + ': ' +
    critical.length + ' low-visit, ' + dateOnly.length + ' expiring-soon';

  var lines = [];
  lines.push('Automated authorization check — ' + formatDate(today));
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

  var body = lines.join('\n');

  MailApp.sendEmail({
    to: CONFIG.NOTIFY_EMAILS.join(','),
    subject: subject,
    body: body,
    htmlBody: toHtml(subject, critical, dateOnly, today),
  });
}

function formatAlertLine(a) {
  return '- ' + a.patient +
    (a.account ? ' (' + a.account + ')' : '') +
    ' | ' + (a.payer || 'Payer unknown') +
    (a.clinic ? ' | ' + a.clinic : '') +
    ' | ' + a.reasons.join('; ');
}

function toHtml(subject, critical, dateOnly, today) {
  function rows(list) {
    if (list.length === 0) return '<tr><td colspan="4"><em>None</em></td></tr>';
    return list.map(function (a) {
      return '<tr>' +
        '<td>' + escapeHtml(a.patient) + (a.account ? ' (' + escapeHtml(a.account) + ')' : '') + '</td>' +
        '<td>' + escapeHtml(a.payer || '') + '</td>' +
        '<td>' + escapeHtml(a.clinic || '') + '</td>' +
        '<td>' + escapeHtml(a.reasons.join('; ')) + '</td>' +
        '</tr>';
    }).join('');
  }
  return '<h3>' + escapeHtml(subject) + '</h3>' +
    '<p>Rule: visit count takes priority over date range. Priority 1 = fewer than ' +
    CONFIG.VISIT_THRESHOLD + ' visits remaining. Priority 2 = auth end date within ' +
    CONFIG.DAYS_THRESHOLD + ' days (only when not already Priority 1).</p>' +
    '<h4>Priority 1 — Low visits (' + critical.length + ')</h4>' +
    '<table border="1" cellpadding="4" cellspacing="0"><tr><th>Patient</th><th>Payer</th><th>Clinic</th><th>Reason</th></tr>' +
    rows(critical) + '</table>' +
    '<h4>Priority 2 — Expiring soon, visits OK (' + dateOnly.length + ')</h4>' +
    '<table border="1" cellpadding="4" cellspacing="0"><tr><th>Patient</th><th>Payer</th><th>Clinic</th><th>Reason</th></tr>' +
    rows(dateOnly) + '</table>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
function logAlerts(ss, alerts, today) {
  var sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
    sheet.appendRow(['Run date', 'Priority', 'Patient', 'Account', 'Payer', 'Clinic', 'Remaining visits', 'Days to end', 'Reason']);
  }
  alerts.forEach(function (a) {
    sheet.appendRow([
      formatDate(today),
      a.priority === 1 ? 'Low visits' : 'Expiring soon',
      a.patient,
      a.account,
      a.payer,
      a.clinic,
      a.remaining === null ? '' : a.remaining,
      a.daysToEnd === null ? '' : a.daysToEnd,
      a.reasons.join('; '),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Trigger management
// ---------------------------------------------------------------------------
function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('checkAuthorizations')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkAuthorizations') {
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
