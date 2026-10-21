# Production kit: Gojo vs Sukuna, The One Detail Everyone Missed

Everything here is generated from the locked script one folder up. Use the files in this order.

| Step | File | What it saves you |
|---|---|---|
| 1. Voice | `01-narration-tts.txt` | Narration split into 254 numbered lines in 13 beat blocks, with ElevenLabs `<break>` pause tags at every scripted hold and a pronunciation guide. Paste one beat block at a time; retake a single line by number. |
| 2. Assets | `03-capture-list.md` | The 47 distinct manga panels and 6 anime clips to capture, deduplicated, each with the official page to screenshot from and the posts that show the exact panel. |
| 3. Edit | `02-asset-pull-sheet.csv` | All 99 visual cues in timeline order: beat, kind, what to pull, edit direction, reference IDs, URLs, optional fan-animation swap, plus `status`, `file_name` and `notes` columns to track progress. Open it in Sheets or Excel. |
| 4. Graphics | `04-graphics-build-list.md` | The 8 reusable templates to build once (captions, chapter tags, the Infinity diagram, progress bar, flowchart, bypass list, wheel SFX, the arm flash) and every text card and motion graphic in order. |
| 5. Publish | `05-upload-sheet.md` | Copy-paste title, five A/B titles, description, tags, pinned comment, thumbnail text, and the upload settings to tick. |

## The shortened pipeline

1. Click through the links in `03-capture-list.md` and screenshot the 47 panels from the VIZ or MANGA Plus app; capture the 6 clips from Crunchyroll or a Blu-ray you own. Name files by the `#` in the pull sheet and fill in `file_name`.
2. Generate the voice from `01-narration-tts.txt`, one beat per file (13 files).
3. Build the 8 templates from `04-graphics-build-list.md`.
4. Lay the 13 voice files on the timeline, then place assets by walking the pull sheet top to bottom.
5. Thumbnail from the three concepts, then paste `05-upload-sheet.md` into YouTube Studio.

## Before lock (from the script's fact-check log)

- Eyeball the VIZ pages for chapter 221 and 236 to confirm the two exact quotes.
- Confirm the two timing figures (< 0.01 s in 229, under 0.1 s in 230) on the VIZ pages.
- Regenerate chapter timestamps from the finished cut, not from the script.
- If any fan animation is used: corner label, muted audio, creator credit in the description and on the outro card.
