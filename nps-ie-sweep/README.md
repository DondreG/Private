# NPS Sweep: IEs Scheduled Out Past the Call Week

This sweeps the monthly **New Patient Spreadsheet (NPS)** and finds patients
who **called during a week** but whose **initial evaluation (FS/IE Date) was
booked in a later week**. In other words, they called this week and won't be
seen until next week or later. Those are the patients to review for an
earlier slot.

## Rule

Weeks run **Sunday–Saturday**, so weekend calls are included (set by
`WEEK_START_DAY`). There are two weekly views:

**Call week** (tab `Week of 10-04-26`): patients who **called** that week and
whose **FS/IE Date** is *after* that Saturday (the next Sunday or later).

**IE week** (tab `IEs Week of 10-11-26`): patients whose **FS/IE Date** falls
in that week but who **called in an earlier week**. This shows who is coming
in that week who could have been seen sooner. It looks back up to 60 days
for the original call (`IE_LOOKBACK_DAYS`).

In both views, rows with status `Inactive` are left out (`EXCLUDE_STATUSES`).
So are rows with no FS/IE Date, because those patients haven't been
scheduled.

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
`OUTPUT_SPREADSHEET_ID`. IE-week tabs come first, then call-week tabs, each
with the newest week first. 12 weeks of each are kept. Each tab has:

- Clinic, call date, patient, taken by, referral source, diagnosis, primary
  insurance, FS/IE date, **Days Call → IE**, **Days Past Call Week**: how far the IE
  is past the Saturday of the week they called (amber = 1–6 days, red = 7+), status, NPS notes, and a **Source** link that
  jumps to the exact row in the NPS.
- **Follow-up** (dropdown: Moved up to this week / Offered earlier — pt
  declined / No earlier availability / Left message / Pt requested later
  date) and **Follow-up Notes**, for the team to fill in.
- A count by clinic to the right of the table, listing **all 27 clinics** (0 when a clinic had none that week). Clinic names come from `CLINIC_NAMES` in `CONFIG` (for example tab `EW` is East Windsor).

Each daily run rebuilds these tabs, so they roll forward every week on their own:

| Tab | Weeks |
| --- | --- |
| Call week | last week, this week and next week (next week's tab fills in once its calls start on Sunday) |
| IE week | this week and next week |

**Anything typed in Follow-up or Follow-up Notes is kept** across re-runs. It
is matched by clinic + patient + call date. If a patient with follow-up later
drops off the sweep (for example, their IE was moved up), the row is **not
deleted**. It moves to the bottom of the tab, greyed out, with the status
"No longer scheduled out (IE date or status changed)".

## Web app

`WebApp.gs` + `Index.html` turn the tracking sheet into a page you can open
from a link in a browser or on a phone. The page shows each weekly tab as a
list grouped by clinic, with a clinic filter, search, and a "Hide worked"
toggle. It has a **Follow-up** dropdown and notes field that save straight
into the sheet, and a **Refresh now** button that runs the full sweep.

The page reads the tracking sheet, so it opens instantly. Saves find the
patient by clinic + name + call date, so they still land on the right row
after a refresh reorders the tab.

Setup, in the same Apps Script project:

1. **Files → + → Script**, name it `WebApp`, and paste `WebApp.gs`.
2. **Files → + → HTML**, name it exactly `Index`, and paste `Index.html`.
3. Save, then go to **Deploy → New deployment**. Click the gear icon, choose
   **Web app**, set *Execute as* to **Me** and *Who has access* to **Anyone
   within Trinity Rehab**, and click **Deploy**.
4. Copy the **Web app URL**. That's the link to share.

After changing the code, use **Deploy → Manage deployments → ✏️ → Version:
New version → Deploy** so the same link picks up the change.

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
takes any date in that week and builds both its call-week and IE-week tabs. You can run it from the editor by temporarily
calling it from a small wrapper function.

The Google account that runs the script needs at least view access to the
monthly NPS files. They're currently owned by jenny@ and shared with you.

## Checked against real data

The filter logic was run against the September and October 2026 NPS files:

| View | Week | Flagged |
| --- | --- | --- |
| Call week | Sun 9/27 – Sat 10/3 (spans two months) | 97 (1 more was excluded as Inactive) |
| Call week | Sun 10/4 – Tue 10/6 (week in progress) | 13 |
| Call week | Sun 10/11 – Sat 10/17 | 0 (calls haven't happened yet) |
| IE week | Sun 10/11 – Sat 10/17 | 26 |

These counts match an independent check of the same files.
