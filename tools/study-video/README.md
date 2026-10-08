# Athena study-video

Render a flashcard deck or a quiz set from your Athena account into a shareable
MP4: an intro cover, then per item a question card followed by an answer/reveal
card, then an outro. Everything is drawn locally with the app's dark theme and
encoded by a bundled ffmpeg - no system installs, no uploads, no external
services beyond the Athena API you already use.

![pipeline](https://img.shields.io/badge/no-system-deps-brightgreen) (plain Node + npm only)

## Install (once)

```powershell
cd tools/study-video
npm install        # installs @napi-rs/canvas + ffmpeg-static (prebuilt binaries)
```

## Quick start

From the repo root (or from this folder):

```powershell
npm run video -- --list                 # list decks and quiz sets on the demo account
npm run video -- --deck 1               # render the first flashcard deck
npm run video -- --set 15               # render a quiz set
npm run video -- --json sample-deck.json   # render a local file (offline)
```

Output lands in `tools/study-video/out/athena-<title>-<timestamp>.mp4`
(portrait 1080x1920 by default - sized for Reels/Shorts/TikTok).

## What the videos look like

- **Cover**: app icon, wordmark, deck/set title and item count.
- **Flashcards**: card front (large, centered), then a reveal with the question
  dimmed and the answer in a card with a teal accent bar.
- **Quiz**: the question with lettered options, then a reveal where the correct
  option is highlighted teal and the explanation appears in a "WHY" panel.
- A segmented progress bar runs across the top; counter and title in the header.

All text is auto-wrapped and auto-sized (long questions and answers shrink until
they fit); the app icon is drawn from `assets/images/icon.png`.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--deck <n\|bookId>` | first deck | flashcard deck (index from `--list`, or a book id) |
| `--set <n\|setId>` | - | quiz set (index from `--list`, or a set id) |
| `--json <file>` | - | local file, see schema below (offline mode) |
| `--list` | - | print decks/sets on the account and exit |
| `--limit <n\|all>` | 15 | max items per video (hard cap 40) |
| `--format <name>` | portrait | `portrait` 1080x1920, `landscape` 1920x1080, `square` 1080x1080 |
| `--fps <n>` | 30 | output frame rate |
| `--intro / --hold / --reveal / --outro <s>` | 3 / 4 / 6.5 / 3 | seconds per phase |
| `--out <file>` | `out/athena-...mp4` | output path |
| `--keep-frames` | off | keep PNG stills in `.frames/` for inspection |
| `--api <url>` | `$ATHENA_API_URL` or Render URL | API base URL |
| `--email / --password` | demo account | sign-in (or `$ATHENA_EMAIL` / `$ATHENA_PASSWORD`) |

## Local JSON schema

```jsonc
// a deck
{ "title": "Cell Biology Essentials", "subtitle": "optional",
  "cards": [ { "front": "...", "back": "...", "topic": "optional" } ] }

// or a quiz
{ "title": "Rapid Fire",
  "questions": [ { "question": "...", "options": ["A", "B", "C", "D"],
                   "correctIndex": 1, "explanation": "optional" } ] }
```

## How it works

1. Signs in to the API (`POST /api/auth/signin`) and pulls content from
   `GET /api/decks[/:bookId/cards]` or `GET /api/sets/:id`.
2. Draws one PNG still per phase with `@napi-rs/canvas` (real text measurement,
   so wrapping/shrinking is exact).
3. Writes an ffmpeg concat script with per-still durations and encodes a single
   H.264 MP4 (`yuv420p`, `+faststart`) using the `ffmpeg-static` binary.

Videos are silent by design (works on every platform, upload-friendly). See
`scripts/video/` for the separate narrated-lesson renderer (Python + Pillow).

## Troubleshooting

- **First API call is slow**: the free Render service sleeps after idle; the
  first sign-in can take ~1 minute.
- **`npm install` warns about ffmpeg-static's install script**: npm's
  `allow-scripts` gate may block the binary download. If
  `node_modules/ffmpeg-static/ffmpeg.exe` is missing, run
  `npm approve-scripts ffmpeg-static` and re-install, or fetch the release
  asset manually.
- **Demo account has no decks**: the demo account currently has quiz sets but
  no flashcard decks. Generate cards in the app first, or use `--json`.

## Ideas / roadmap

- Optional TTS narration per card (Windows SAPI / a TTS API) + burned-in captions.
- Ken Burns / slide transitions via ffmpeg zoompan.
- Auto-split sets into multiple shorter videos.
- An in-app "Export video" button that calls this script.
