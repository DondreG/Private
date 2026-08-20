# Authorization Expiration & Low-Visit Notifications

Automates the manual authorization check the offshore team currently does by
hand against the [Authorization Analysis workbook](https://docs.google.com/spreadsheets/d/11uh4RFQcYxOeSAA1KIYSL_WzN88FfjW11Tpe1v00OGY).
Sends a daily digest email flagging authorizations that need action.

## Rule

**Visit count is the priority signal; date range is a secondary factor.**

1. **Priority 1 — low visits**: fewer than `VISIT_THRESHOLD` (default **6**)
   visits remaining on the authorization.
2. **Priority 2 — expiring soon**: auth end date is within `DAYS_THRESHOLD`
   (default **7**) days. Only surfaced when the authorization *isn't* already
   flagged for low visits — an auth that's already low on visits doesn't need
   a second, lower-priority reason attached.

This matches what the workbook's own payer-level analysis found: for Clover
Health, Braven Health, and BCBS/Horizon commercial, visits run out long
before the end date (median "dead calendar" of 55–147 days), so a date-only
alert would fire far too late for those payers. For Workers Comp, Auto/PIP,
and Humana it's the reverse — the date runs out first — which is why the
date leg is kept as a real, independent trigger rather than dropped.

## Known data-quality caveats (from the workbook's "what to fix" tab)

- **12/31 placeholder end dates** (mostly Workers Comp) aren't real
  expirations — the date leg of the rule ignores them (`PLACEHOLDER_END_DATES`
  in `Code.gs`). The visit leg still applies normally to those rows.
- **Auth start date is unreliable** (mass 8/4 migration date) — this script
  never reads or depends on the start date.
- Fix these upstream in Prompt/Scrips_Auths when possible; the placeholder
  workaround here is a stopgap, not a substitute.

## Where the data comes from

The raw per-authorization rows are **not** a tab in the analysis workbook —
they live in a separate, periodically re-exported spreadsheet named like
`Scrips_Auths - 08-20-26` (tab `Scripts Auths`), with columns: `Patient
Account #, Patient First, Patient Last, Case Name, Script or Auth, Start
Date, End Date, Script Reference, Auth Mode, Total Visits, Arrived Visits,
Remaining Visits, Visits Scheduled, Scheduled Visits Remaining,
Provider/Payer, Location of Last Visit, Case Therapist, Date of Next Visit,
Scheduled Through, Phone, Fax, Email, Internal Notes, Case Active`.

Because each export creates a new dated file rather than overwriting one
stable file, the script does **not** use a fixed file ID. `findSourceSpreadsheet()`
searches Drive for the most recently modified spreadsheet whose title starts
with `CONFIG.SOURCE_FILE_TITLE_PREFIX` (default `'Scrips_Auths'`) and opens
that. It also filters to `Case Active = "Yes"` (`CONFIG.CASE_ACTIVE_VALUE`)
so closed/discharged cases don't show up in the digest.

## Setup

1. Open the analysis spreadsheet → **Extensions → Apps Script**. (The
   script is bound to this workbook — it just *reads* the Scrips_Auths file
   from Drive rather than living in it, so it survives that file being
   re-exported under a new name.)
2. Create/replace `Code.gs` and `appsscript.json` with the files in
   `apps-script/` in this repo (or `clasp push` if the project is clasp-linked).
3. In `Code.gs`, edit the `CONFIG` block:
   - `SOURCE_FILE_TITLE_PREFIX` / `SOURCE_SHEET_NAME`: adjust if the export
     file/tab naming ever changes.
   - `NOTIFY_EMAILS`: who gets the digest (offshore team, billing lead, etc).
   - Adjust `VISIT_THRESHOLD` / `DAYS_THRESHOLD` if 6 visits / 7 days ever
     need to change.
4. Run `installDailyTrigger` once (from the Apps Script editor, or
   `clasp run installDailyTrigger`) to schedule a 7am daily check. Authorize
   the requested Gmail/Sheets/Drive scopes when prompted — Drive read access
   is new as of this version, needed to locate the latest Scrips_Auths export.
5. Each run also appends every alert to an **Auth Alerts Log** tab in the
   analysis workbook (auto-created) so there's an audit trail of what fired
   and when.

To change the schedule, edit `installDailyTrigger()` in `Code.gs` and re-run
it (it clears any existing trigger for `checkAuthorizations` first).
