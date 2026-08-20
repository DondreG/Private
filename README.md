# Authorization Tracking Report (weekly)

Automates the manual authorization check the offshore team currently does by
hand. Each week the script reads the latest raw authorization export, applies
the priority rule below, and writes a new dated section into one persistent
tracking Doc — **[Trinity Rehab - Authorization Tracking Report](https://docs.google.com/document/d/18_nrTmdQ1JQE88Wqajh0DsL-XL2_CombTwlMeGo8UVI)** —
so there's a single place to open, with this week's status plus history,
instead of juggling separate spreadsheets. It can optionally also email the
same digest.

## Rule

**Visit count is the priority signal; date range is a secondary factor.**

1. **Priority 1 — low visits**: fewer than `VISIT_THRESHOLD` (default **6**)
   visits remaining on the authorization.
2. **Priority 2 — expiring soon**: auth end date is within `DAYS_THRESHOLD`
   (default **7**) days. Only surfaced when the authorization *isn't* already
   flagged for low visits — an auth that's already low on visits doesn't need
   a second, lower-priority reason attached.

This matches what the [source analysis workbook](https://docs.google.com/spreadsheets/d/11uh4RFQcYxOeSAA1KIYSL_WzN88FfjW11Tpe1v00OGY)'s
own payer-level breakdown found: for Clover Health, Braven Health, and
BCBS/Horizon commercial, visits run out long before the end date (median
"dead calendar" of 55–147 days), so a date-only alert would fire far too
late for those payers. For Workers Comp, Auto/PIP, and Humana it's the
reverse — the date runs out first — which is why the date leg is kept as a
real, independent trigger rather than dropped.

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
stable file, the script does **not** use a fixed file ID for it.
`findSourceSpreadsheet()` searches Drive for the most recently modified
spreadsheet whose title starts with `CONFIG.SOURCE_FILE_TITLE_PREFIX`
(default `'Scrips_Auths'`) and opens that. It also filters to
`Case Active = "Yes"` (`CONFIG.CASE_ACTIVE_VALUE`) so closed/discharged
cases don't show up.

Note the analysis workbook is **not** an independent data source — its own
header says so directly: *"Source: Scrips_Auths 08-20-26 (Prompt)"*. It's a
derived snapshot of the same Scrips_Auths data, not separate records, so the
script only reads Scrips_Auths for per-auth rows. What it *does* pull from
the workbook is its payer categorization: `PAYER_GROUP_RULES` in `Code.gs`
reapplies the same prefix/substring rules the workbook used to bucket raw
`Provider/Payer` text (`"Bcbs 52 (Nj)"`, `"Wc-Streamline"`, `"Nf-Geico"`,
etc.) into clean groups (BCBS / Horizon commercial, Workers Comp, Auto /
PIP, Clover Health, Braven Health, Humana), so the tracking Doc reads the
same way the workbook does instead of showing raw entered text.

## Where the output goes

Unlike the source data, the **tracking Doc is a fixed, permanent file** —
created once, and referenced by ID (`CONFIG.TRACKING_DOC_ID`) so every run
updates the same Doc rather than creating new ones. Each run:

1. Ensures the Doc has its title/description intro (only rebuilt if missing).
2. Inserts a new `Week of MM/DD/YYYY` section right after the intro, with a
   Priority 1 table and a Priority 2 table (newest week always on top).
3. Trims sections beyond `CONFIG.MAX_WEEKS_KEPT` (default 12) so the Doc
   doesn't grow forever.

If `CONFIG.NOTIFY_EMAILS` has addresses in it, the same digest is also
emailed with a link back to the Doc. Leave it empty to rely on the Doc only.

## Setup

1. Open the analysis spreadsheet → **Extensions → Apps Script**. (The
   script just needs to run *somewhere* — it doesn't read or write that
   spreadsheet anymore, it only reads the Scrips_Auths export and writes to
   the tracking Doc. Binding it here is just a convenient home; a standalone
   Apps Script project at script.google.com works identically.)
2. Create/replace `Code.gs` and `appsscript.json` with the files in
   `apps-script/` in this repo (or `clasp push` if the project is clasp-linked).
3. In `Code.gs`, edit the `CONFIG` block:
   - `TRACKING_DOC_ID`: already set to the Doc created for this — change it
     only if you want output going to a different Doc.
   - `SOURCE_FILE_TITLE_PREFIX` / `SOURCE_SHEET_NAME`: adjust if the export
     file/tab naming ever changes.
   - `NOTIFY_EMAILS`: optional — add addresses to also get an email digest.
   - Adjust `VISIT_THRESHOLD` / `DAYS_THRESHOLD` / `MAX_WEEKS_KEPT` if those
     ever need to change.
4. Run `installWeeklyTrigger` once (from the Apps Script editor, or
   `clasp run installWeeklyTrigger`) to schedule it for Mondays at 7am.
   Authorize the requested Docs/Drive/Sheets (and Gmail, if emailing) scopes
   when prompted.

To change the schedule, edit `installWeeklyTrigger()` in `Code.gs` and
re-run it (it clears any existing trigger for `updateAuthTrackingReport`
first). To test immediately instead of waiting for Monday, just run
`updateAuthTrackingReport` directly from the function dropdown.
