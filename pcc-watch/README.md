# PCC Watch

Tells you when each PCC puts something new onto the sheets they work in —
the **NPS** and their clinic's **UL** first, plus the **PCC Daily Huddle**
"Booked?" marks and **Patient Responsibility** "Collected?" marks — without
anyone changing how they work.

Every 15 minutes (Mon–Sat, 7 AM–7 PM) a Google Apps Script running as you
takes a snapshot of those sheets, compares it with the last one, and writes
what changed into one **PCC Watch** spreadsheet:

| Tab | What's on it |
| --- | --- |
| **Today** | One row per PCC clinic: NPS entries, leads claimed, UL patients added / visits scheduled / notes / reasons, Huddle "nothing booked" target vs. marked booked, new IEs, $ to collect today vs. marked collected, yesterday's collection rate (from Prompt), last activity time, and a heads-up column. |
| **Activity** | Every event, newest first: when, PCC, clinic, what, detail, a link straight to the row, and how it was attributed. Kept 60 days. |
| **Roster** | Who the PCCs are. Edit this tab — not the code — when someone joins or leaves. |

You also get email (to yourself):

- **When a PCC puts a new patient on the NPS or UL**, batched so there's at most
  one email every 30 minutes. Any other work since the last email
  (scheduling, notes, marks) rides along as counts.
- **1 PM on weekdays:** one "no activity yet" email listing the PCC clinics with
  nothing new today. It's skipped on days the watcher didn't start before 10 AM.
- **4 PM on weekdays:** a summary of the day per PCC.

## What counts, and who gets credit

| Source | Event | Credited to |
| --- | --- | --- |
| NPS (this month; last month for the first 10 days; next month once it exists) | New row whose **Taken By** names a PCC (`Mariela`, `Auto/ Emily`, `Mariela/Lana` …) | That PCC, by name |
| | Taken By filled in later, or changed from `Auto` / `AI Agent` to a PCC | That PCC: **new entry**, or **claimed lead** |
| | Taken By is a clinic name (`Somerset`, `EB Clinic`) | That clinic's PCC, marked **probable** (Alexa and Tiago type the clinic, not their name) |
| UL (this week's tab and future weeks' tabs) | New patient row · **# SCHED** went up · new care-note line · **Reason not scheduled** set | The clinic's PCC. A note is credited to its signer when signed with a Roster tag (`[MARI]`, `-BV`, `[EMILY]`, `-TC`). Notes signed by non-PCC staff (`[JEROME]`, `[JIBRIL]`, `- AS` …) aren't credited to anyone. |
| PCC Daily Huddle | **Booked? (PCC)** filled on the nothing-booked list (clinic tab or All PCC Clinics; counted once) | The clinic's PCC |
| Patient Responsibility / Huddle pay table | **Collected?** filled (TODAY or TOMORROW; counted once across both sheets) | The clinic's PCC |

Not counted as PCC work: rows entered by Auto, AI Agent or central staff
(Lana, Elijah, Lynni, Tiffany, Pia …), Danielle's morning rebuilds of the
Huddle and Patient Responsibility sheets, a corrected name on the same row,
re-sorting, and a newly duplicated UL week tab. A new week tab is
baselined silently, and its creation appears once on the Activity tab.

**Limits to know.** The UL, Huddle and Patient Responsibility sheets have no
"entered by" column, and you only have view access, so the script can't see
who edited a cell. Those events go to the clinic's PCC. At Metuchen,
unsigned UL work is shared between Kim and Brandon. When something happens
between two checks, the time shown is when the script noticed it (within 15
minutes).

## Privacy

The watcher never writes to the sheets it watches. It needs only view
access. Nothing it stores or sends identifies a patient:

- Rows are matched by an HMAC (a keyed hash) of the patient name or account #.
  The key is random, created on first run, and lives only in this project's
  Script Properties.
- Care notes are stored only as hashes of each line. Note text is read in
  memory to find a signature tag, then discarded.
- The Activity tab, Today tab and emails name the PCC, clinic, what changed
  and a **link to the row**. They never contain a patient name, DOB, phone,
  account # or note text.

`node pcc-watch/test/run-tests.js` checks exactly this against made-up
patients. Among its other checks, it fails if any of their names, account
numbers or phones show up in the state file, the PCC Watch sheet, an email or
the log.

## Setup (about 5 minutes)

1. Go to <https://script.google.com> → **New project**, name it **PCC Watch**.
2. Replace `Code.gs` with [`Code.gs`](Code.gs). In **Project Settings**, tick
   "Show appsscript.json", then replace it with [`appsscript.json`](appsscript.json).
3. Check the `CONFIG` block at the top. The file IDs for the Huddle, Patient
   Responsibility and the 9 PCC clinic ULs are already filled in. Optional:
   set `FOLDER_ID` to the familiar's Drive folder so the output lives there.
4. Pick **`setup`** in the function dropdown → **Run** → approve the access it
   asks for:
   - read the sheets
   - create its own sheet and state file
   - send you email
   - run on a schedule

   This creates the **PCC Watch** sheet, takes a first snapshot (no alerts
   for anything already there) and schedules a check every 15 minutes. The
   log prints the sheet's link.
5. Open the sheet's **Roster** tab and fix anything that's off:
   - **Flemington** has no PCC yet. Add the name, plus the first name they
     type in the NPS "Taken By".
   - **Upper Dublin** is set to **Leah Carpenter**, from the PCC Regroup
     invite and the NPS. Confirm it.
   - The note tags for Kim (`KC`), Alexa (`AQ`), Chris (`CN`) and Leah (`LC`)
     are guesses. Today only Mariela (`MARI`), Brandon (`BV`), Emily (`EMILY`)
     and Tiago (`TC`) sign UL notes.

   Changes take effect on the next check.

Other functions you can run from the dropdown:

| Function | What it does |
| --- | --- |
| `runNow` | Run a check now, even outside the schedule. |
| `removeTriggers` | Stop the watcher. Keeps the sheet. |
| `installTrigger` | Start it again, or apply a new `TRIGGER_EVERY_MINUTES`. |
| `resetSnapshots` | Forget all snapshots. The next check re-baselines silently. Use it if a source sheet was restructured. |

To change the schedule, emails or retention, edit `CONFIG`:
- `RUN_DAYS`, `RUN_FROM_HOUR`, `RUN_TO_HOUR`
- `NOTIFY`, `NOTIFY_EMAILS`, `NOTIFY_ON`, `NOTIFY_EVERY_MINUTES`
- `QUIET_CHECK_HOUR`, `DAY_SUMMARY_HOUR`
- `LOG_DAYS_KEPT`

If a source moves (a new UL file, a new Huddle), update its ID in `CONFIG`.
New monthly NPS files are found by title automatically.

## Tests

```
node pcc-watch/test/run-tests.js
```

The tests run `Code.gs` under Node against fake Apps Script services
(`test/gas-mock.js`) and made-up sheets shaped like the real ones. They
simulate a full day plus the next morning's rebuilds and check:
- every event type and how it's credited
- re-sorting, corrected names and new week tabs
- the Huddle / Patient Responsibility dedupe and rebuilds
- email batching and the once-a-day emails
- an unreadable source
- the privacy check above
