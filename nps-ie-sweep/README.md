# NPS Sweep: IEs Scheduled Out Past the Call Week

This sweeps the monthly **New Patient Spreadsheet (NPS)** and finds patients
who **called during a week** but whose **initial evaluation (FS/IE Date) was
booked in a later week**. In other words, they called this week and won't be
seen until next week or later. Those are the patients to review for an
earlier slot.

## Rule

For each week (**Sunday–Saturday**, so weekend calls are included; set by
`WEEK_START_DAY`), a patient row is flagged when:

1. **Call date** (`Date` column) falls inside the week, Sunday through Saturday, **and**
2. **FS/IE Date** is *after* that Saturday (the next Sunday or later), **and**
3. **Status** is not `Inactive` (set by `EXCLUDE_STATUSES`).

Rows with no FS/IE Date (still pending) are not flagged, because they haven't
been scheduled.

## Where the data comes from

The NPS is one Google Sheet per month, named like `October 2026 New Patient
Spreadsheet` (older months were named like `March 2026 NPS`). Each clinic tab
(BR, SHRW, MAN, MAT, HWL, Middletown, … Warren) has the same header row:
`Date, Taken By, Email?, Patient Name, Referral Source, Diagnosis, Town,
Primary Insurance, Secondary Insurance, FS/IE Date, Days to FS/IE, Notes,
Status, Inactive Reason`.

- **No file IDs to update each month.** The script finds each month's file
  by title (`NPS_TITLE_PATTERNS`). If more than one file matches, it uses the
  most recently updated one.
- **Weeks that span two months are covered.** For example, Sun 9/27 – Sat
  10/3 reads both the September and October files. If a patient appears in
  both, the row is counted once.
- **Clinic tabs are detected by their headers**, not by a list of tab names.
  New clinics are picked up automatically. Summary tabs such as
  `CONSOLIDATED`, `DIGITAL TRACKING`, `DDB` and `ELLAAGENT` are skipped.

## Where the output goes

All output goes to one spreadsheet, **NPS — IE Scheduled Out Sweep**. The
first run creates it in your Drive. To use an existing sheet instead, set
`OUTPUT_SPREADSHEET_ID`. The spreadsheet has one tab per week (for example
`Week of 10-04-26`), with the newest week first and 12 weeks kept. Each tab has:

- Clinic, call date, patient, taken by, referral source, diagnosis, primary
  insurance, FS/IE date, **Days Call → IE**, **Days Past Week End** (amber =
  1–6 days, red = 7+ days), status, NPS notes, and a **Source** link that
  jumps to the exact row in the NPS.
- **Follow-up** (dropdown: Moved up to this week / Offered earlier — pt
  declined / No earlier availability / Left message / Pt requested later
  date) and **Follow-up Notes**, for the team to fill in.
- A count by clinic to the right of the table.

Each run rebuilds **this week's and last week's** tabs, so the current week
grows day by day and late data entry for last week is still picked up.
**Anything typed in Follow-up or Follow-up Notes is kept** across re-runs. It
is matched by clinic + patient + call date.

## Setup

1. Go to [script.google.com](https://script.google.com) → **New project**
   (standalone), and name it something like "NPS IE Sweep".
2. Paste `Code.gs` from this folder. Then turn on **Project Settings → Show
   "appsscript.json"** and paste `appsscript.json` from this folder (time
   zone America/New_York).
3. Optional: edit the `CONFIG` block. You can add `NOTIFY_EMAILS` for a
   daily email digest or change `RUN_HOUR`.
4. Run **`runSweep`** once from the function dropdown and approve the
   Drive/Sheets permissions when asked. The log prints the URL of the new
   output spreadsheet.
5. Run **`installDailyTrigger`** once to schedule the sweep for every day at
   6 PM.

To back-fill an earlier week, run `sweepWeekContaining('2026-09-14')`. It
takes any date in that week. You can run it from the editor by temporarily
calling it from a small wrapper function.

The Google account that runs the script needs at least view access to the
monthly NPS files. They're currently owned by jenny@ and shared with you.

## Checked against real data

The filter logic was run against the September and October 2026 NPS files:

| Week | Flagged |
| --- | --- |
| Sun 9/27 – Sat 10/3 (spans two months) | 97 (1 more was excluded as Inactive) |
| Sun 10/4 – Tue 10/6 (week in progress) | 13 |

These counts match an independent check of the same files.
