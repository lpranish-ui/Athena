# Athena 🏛️ — medical study, powered up

Athena turns any medical book into an interactive quiz — and into a book you can
actually read. Upload a PDF / EPUB / TXT of **any size**, Athena extracts the
text and splits it into chapters, DeepSeek AI writes exam-style MCQs with
verified word-for-word quotes, and a built-in reader (themes, fonts, resume)
makes studying a pleasure.

Built as one codebase that runs **on the web, Android and iOS** (Expo + React
Native), backed by a small Node API.

## Features

- **📚 Personal library** — upload books or start from built-in study material;
  filter by subject (auto-suggested on upload). Uploads are private to your
  account; built-in books are shared with everyone.
- **🌊 Any-size uploads** — books stream to the server in 8 MB chunks (flat
  memory on phone and server). A 500-page textbook is no different from a
  5-page one. PDFs are extracted with `pdftotext` (poppler) for low-memory,
  any-size processing; EPUB/TXT also supported.
- **✂️ Automatic chapter splitting** — bookmarks → printed contents page (with
  page-offset correction) → "Chapter N" headings → size-based parts. Fix any
  wrong split yourself (rename, split, merge, delete) from the book screen.
- **📖 Reader** — read any book inside Athena: Dark / Sepia / Light themes,
  adjustable text size (14–32), line spacing, serif/sans typefaces, a chapter
  drawer, and **resume exactly where you left off** (synced per account, so
  it follows you between phone and web). The Library shows a *Continue
  reading* shelf with your latest position.
- **🤖 AI quiz generation** — pick chapters, question type (MCQ, vignette,
  true/false), difficulty and count; DeepSeek writes fresh questions with
  per-option explanations. Big books are fine — the model's thinking budget is
  tuned for chapter-sized prompts, with automatic retries.
- **📝 Quiz mode** — Tutor mode (feedback after each question) or Exam mode
  (timed, answers at the end).
- **🔗 Page-linked questions** — every question cites the book page and shows a
  word-for-word supporting quote, verified against the extracted text before
  you see it; a blind second pass answers each question to catch bad keys.
- **🚩 Flagging** — report a wrong or unclear question; it is hidden for you and
  one tap builds a replacement.
- **📈 Progress tracking** — best score per quiz, scores by subject,
  weak-chapter suggestions, average score on your profile.
- **🔁 Smart review** — missed questions return on a spaced schedule until they
  stick; the Quizzes tab shows what's due.
- **🃏 Study kit** — flashcards (Anki CSV export) and one-page chapter
  summaries, both with page references.
- **🗓️ Study planner** — exam date + target exam in your profile; the Quizzes
  tab shows days to go.
- **⏱️ Mock exams** — timed runs assembled from your existing questions.
- **🎓 Group study** — live quiz rooms for friends: same questions, fastest
  correct answer wins, global leaderboard.
- **🔐 Accounts** — email/password sign-up and sign-in, per-user data, in-app
  account deletion.

## Architecture

```
 Phone (APK)  /  Web (browser)  /  Expo Go
        │
        ▼
 athena-api  — Render web service (Docker: Node 22 + poppler), oregon
   │   auth (scrypt + JWT), library, uploads, reader progress, quizzes,
   │   group study, AI routes (DeepSeek), schema auto-migration on boot
   ▼
 Postgres (Render "LA carte" instance, internal connection)
        ▲
 athena web — Render static site (Expo web export, SPA)  → https://athena-27wx.onrender.com
```

- **APK builds** run free on GitHub Actions (`.github/workflows/build-apk.yml`)
  — no Expo account needed. The newest build is published to the rolling
  release `apk-latest`:
  `https://github.com/lpranish-ui/Athena/releases/download/apk-latest/app-release.apk`

## Project structure

```
src/                     # the Expo app (web + Android + iOS)
  app/                   # Expo Router routes (screens)
    (auth)/              #   sign-in, sign-up
    (tabs)/              #   library (incl. Continue reading), quizzes, profile
    book/[id].tsx        #   book detail: Read book, quizzes, chapters, fix splits
    reader/[bookId].tsx  #   the reader (themes, fonts, resume, drawer)
    chapter/[id].tsx     #   chapter tools + generate MCQs
    quiz/[id].tsx        #   quiz runner + results
    upload.tsx           #   add a book (chunked upload UI, any size)
    group*.tsx           #   group study rooms
    ...
  lib/                   # apiClient (REST), auth, api helpers, files (chunked
                         # uploader), review scheduler, subjects, format
  components/, theme/, types/
server/                  # the API (deployed on Render as a Docker service)
  src/index.js           #   every route
  src/auth.js            #   scrypt + JWT auth
  src/ingest.js          #   PDF (poppler/pdfjs) · EPUB · TXT → chapters
  src/generate.js        #   quiz generation pipeline (quotes, dedupe, blind check)
  src/ai.js              #   DeepSeek client (timeouts, retries, call logging)
  src/group.js           #   live group quiz rooms
  src/studykit.js        #   flashcards + summaries
  sql/schema.sql         #   full schema (idempotent; runs on every boot)
  Dockerfile             #   node:22-slim + poppler-utils
  scripts/               #   smoke tests, upload tests, repro helpers
.github/workflows/       # build-apk.yml — free APK builds on GitHub runners
worker/                  # optional local OCR worker (scanned PDFs — future)
```

## Local development

### 1. App

```bash
npm install
cp .env.example .env     # then set:
# EXPO_PUBLIC_API_URL=https://athena-api-w018.onrender.com   (or a local server)
npm start                # press w (web) / a (android) / i (ios)
```

### 2. API (optional — only if you're changing the server)

```bash
cd server
npm install
# server/.env:
#   DATABASE_URL=postgresql://…    (Render Postgres internal URL in prod)
#   JWT_SECRET=…                   (any long random string)
#   DEEPSEEK_API_KEY=sk-…          (never goes in the app)
#   DEEPSEEK_MODEL=deepseek-flash  (optional; default deepseek-flash)
node src/index.js
```

The server runs its schema bootstrap on every boot — `server/sql/schema.sql` is
idempotent, so new tables roll out with each deploy.

> Local note: PDF extraction falls back to `pdfjs-dist` when `pdftotext` is not
> installed (the Docker image includes poppler; Windows dev machines usually
> don't).

## Deployment

Everything auto-deploys from `main`:

1. **API** — Render web service `athena-api` (Docker, `server/Dockerfile`).
   Env vars live in Render: `DATABASE_URL`, `JWT_SECRET`, `DEEPSEEK_API_KEY`,
   `DEEPSEEK_MODEL`, `DEEPSEEK_VERIFY_MODEL`. Health: `/api/health`.
2. **Web app** — Render static site `Athena` → `https://athena-27wx.onrender.com`
   (build: `npm install && npx expo export --platform web`, publish `dist`,
   SPA rewrite `/* → /index.html`, env `EXPO_PUBLIC_API_URL`).
3. **Android APK** — GitHub Actions on pushes that touch `src/**` / config.
   Download the newest: releases → tag `apk-latest`.

## How uploads work (any size)

1. The app asks the API to create the book, then streams the file in **8 MB
   chunks** (`PUT /api/uploads/:id/chunk`) — each chunk is appended to a temp
   file on the server; memory stays flat for any file size.
2. `POST /api/uploads/:id/finish` starts background extraction: `pdftotext`
   (PDF, tiny memory), EPUB unzip, or plain text.
3. The app polls the book row and shows live progress
   ("Uploading… 45%" → "Extracting text…" → "Detecting chapters…").
4. Chapters are stored with page maps; the temp file is deleted immediately.
   Interrupted uploads are swept clean a short while later.

## How a quiz gets made

1. Chapter text is sent to the API with `[p. N]` page markers.
2. DeepSeek drafts questions (with retries if a sample comes back empty or
   stalls — the client enforces timeouts and re-samples).
3. Quality gates before you see anything:
   - exactly one correct option, no “all of the above”;
   - the supporting quote must appear **word for word** in the chapter (page
     located from the text itself; PDF spacing artifacts tolerated);
   - near-duplicates of stored stems are dropped;
   - if a whole draft fails the quote check, the server re-asks once
     automatically;
   - a blind second pass answers everything without seeing the key —
     disagreements are dropped.
4. Passing questions are saved with page, quote and per-option explanations.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| App shows “Almost there” setup screen | `.env` missing `EXPO_PUBLIC_API_URL` — restart the dev server after fixing |
| Upload stuck on “Uploading…” | Check your connection; interrupted uploads are marked failed after an hour — delete and retry |
| “This PDF is a scan” | Scanned PDFs have no text layer — OCR is on the roadmap; use a text PDF/EPUB/TXT |
| “Already uploaded this file” | Duplicate detection — delete the older copy first |
| Quiz generation failed | The server retries automatically; if a sample still fails, tap generate again — every AI call is logged (`ai call ok/empty/failed`) for debugging |
| Web app shows old version | Render rebuilds on push; check the static site's deploys |
| APK out of date | Every push to `src/**` rebuilds it; grab the newest from the `apk-latest` release |

## Useful commands

```bash
npm start                 # dev server (w/a/i)
npm run typecheck         # TypeScript check
npx expo lint             # lint
gh run list -R lpranish-ui/Athena    # APK build status
gh run watch <id> -R lpranish-ui/Athena
node server/scripts/test-big-upload.js <file> <pdf|txt>   # any-size pipeline test
node server/scripts/make-test-files.js pdf <out> 600      # generate a big test PDF
```

## Roadmap

Next milestones:
- OCR for scanned books (Tesseract + Ghostscript; the local `worker/` prototype
  exists — needs a home with more CPU/RAM than the free tier).
- Highlights + notes in the reader.
- Public starter library with licensed content.
- Admin flag-review dashboard (`ai_calls` already logs every AI call).
- Offline mode with on-device caching.

## Notes

- App icons and splash images in `assets/images/` are Expo template
  placeholders — replace with Athena branding before release.
- Write your own built-in study material, or use public-domain sources; never
  ship copyrighted books as defaults.
- Rotate `DEEPSEEK_API_KEY` / `JWT_SECRET` periodically in the Render dashboard.
