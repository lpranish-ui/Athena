# Athena — medical study

Athena turns PDF, EPUB and TXT books into a readable chapter library, source-linked
quizzes, flashcards and summaries. The Expo SDK 57 app runs on web, Android and
iOS; a Node API and PostgreSQL store accounts and study progress.

## Features

- **Today study coach:** enroll in a pilot course, choose a daily time budget,
  follow a resumable lesson/practice session, and track syllabus coverage.
- **Mistake journal:** wrong answers retain the chosen option, confidence,
  targeted explanation and sources; later sessions prioritize repair with
  different question variants.
- **Personal library:** private uploads, shared starter material and subject filters.
- **Reader:** light/dark/sepia themes, adjustable typography, saved positions,
  highlights, notes and navigation to distant passages.
- **Chapter management:** automatic detection plus rename, split, merge and delete.
- **AI quizzes:** MCQs, clinical vignettes and true/false questions, difficulty
  selection, per-option explanations, supporting quotes and source PDF pages.
- **Tutor and exam modes:** feedback after each question or timed results at the end.
- **Question flagging:** hide unclear questions and request verified replacements.
- **Progress and smart review:** subject scores, weak chapters, due questions and
  a spaced review schedule.
- **Study kit:** source-checked flashcards, Anki CSV export and chapter summaries.
- **Ask this book:** relevant excerpts, checked citations and abstention when the
  source cannot support an answer.
- **Study planner and mock exams:** exam dates, targets and timed runs from existing questions.
- **Group study:** shared quiz rooms, server-timed answers and leaderboards.
- **Accounts:** email/password authentication, private data and account deletion.

## Local development

Use Node 22.13 or newer ([SDK 57 requirements](https://docs.expo.dev/versions/v57.0.0/)),
npm and Docker Desktop. From the repository root:

```powershell
npm ci
npm ci --prefix server
docker compose up -d
```

Compose runs PostgreSQL 17 on `127.0.0.1:5434` with a persistent Docker volume.
Create the ignored `server/.env.local`:

```dotenv
DATABASE_URL=postgresql://athena:athena-local-development@127.0.0.1:5434/athena
JWT_SECRET=replace-with-a-long-random-local-secret
PORT=10000
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VERIFY_MODEL=deepseek-flash
```

Create the ignored root `.env.local`:

```dotenv
EXPO_PUBLIC_API_URL=http://127.0.0.1:10000
```

Keep both files local. `JWT_SECRET` must be configured; a DeepSeek key is optional
for the local fixtures and is needed only for new AI generation. The server dev
command loads `server/.env.local` after `server/.env`, so local settings override
older configuration without modifying it.

Start the API in one terminal:

```powershell
npm --prefix server run dev
```

Startup applies `server/sql/schema.sql`. After the API is ready, use another terminal:

```powershell
node --env-file=server/.env.local server/scripts/seed-local.js
npm run web -- --port 8083
```

Open [the local preview](http://localhost:8083). Sign in with the synthetic account
`local@athena.test` / `AthenaLocal2026!`. The seed script refuses remote databases;
its reader and quiz fixtures require no AI calls. API health is
[http://localhost:10000/api/health](http://localhost:10000/api/health).

For mobile development, run `npm start` and use Expo Go or a development build.
On a physical phone, set `EXPO_PUBLIC_API_URL` to your computer's LAN address and
API port, then restart Expo. Default Expo ports also work; 8083 is the local
preview convention. Use `npx expo install <package>` for SDK-compatible dependency
versions, following the [Expo CLI documentation](https://docs.expo.dev/more/expo-cli/).

## Checks and tests

```powershell
npm run lint
npm run typecheck
npm test
npm run test:server
python -B -m unittest discover -s worker -p test_*.py
npm run audit:dependencies
npm audit --prefix server --omit=dev
```

Server unit/pipeline tests are local and make no provider calls. Database
integration tests are skipped unless `TEST_DATABASE_URL` points to a loopback
database named **athena_test**. Create that separate database once, then run the
full server suite:

```powershell
docker compose exec postgres createdb -U athena athena_test
$env:TEST_DATABASE_URL="postgresql://athena:athena-local-development@127.0.0.1:5434/athena_test"
npm run test:server
```

Integration tests create and remove an isolated schema in that test database.
The GitHub workflow runs lint, typecheck, app/server/Python tests, PostgreSQL
integration checks and dependency audits before building an APK. Manual tools
under `server/scripts/` include smoke/repro scripts that contact live services;
use the `tests/` suites for routine local verification.

## Upload and AI pipeline

Uploads use 8 MB chunks with explicit byte offsets. PostgreSQL stores chunks,
received byte counts and processing leases; repeated chunks are idempotent, the
final size is checked, and interrupted processing resumes after a restart.
The default file limit is **512 MB**, configurable through server
`MAX_UPLOAD_BYTES`; each account can have five active uploads.

Searchable PDFs use Poppler's `pdftotext` in the API Docker image. Local development
falls back to pdf.js when Poppler is absent. EPUB extraction inflates only package
metadata and spine text, excluding image payloads. Extracted text defaults to a
24-million-character limit, configurable through `MAX_EXTRACTED_TEXT_CHARS`
(up to 67,108,864 characters); oversized books fail with a request to split volumes
instead of silently losing later chapters. Chapter writes and the ready status
commit together, and replaying a completed job preserves existing chapter IDs.

Scanned PDFs attempt optional OCRmyPDF when it is installed on the API host,
with Tesseract, Ghostscript and the required language data. Set `OCR_LANG`
(default `eng`). Missing tools produce a readable upload error; OCR has a
ten-minute limit. See [optional OCR setup and the local diagnostic CLI](worker/README.md).
No Supabase account or service-role key is used.

AI prompts use bounded excerpts spread across the selected chapters; later quiz
batches rotate interior windows. Source page maps remain accurate after sampling
or chapter merges. Long chapters are sampled rather than sent in full.
Questions require strict option/key validation, an actual supporting quote,
duplicate filtering and a blind answer check. Missing or failed checks cannot
save unverified questions. Flashcards, summaries and book answers also require
matched source quotes and a separate fact check; unavailable evidence yields an
error or a book-answer abstention. Pages identify source PDF pages, which may
differ from printed page labels.

Per-user AI request limits use `AI_REQUESTS_PER_HOUR` (default 100) and
`AI_CONCURRENT_PER_USER` (default 2). Counters are held in each API process and
reset when that process restarts.

## Structure and deployment

```text
src/app/                 Expo Router screens; auth, library, reader and study tools
src/lib/                 API, authentication, uploads and review helpers
src/components/          Shared mobile UI
server/src/app.js        Testable route factory
server/src/index.js      Schema bootstrap, upload worker and API entry point
server/src/uploads.js    Durable chunk upload service and processing worker
server/src/ingest.js     PDF/EPUB/TXT extraction and chapter persistence
server/src/               AI generation, grounding, retrieval, auth and group modules
server/sql/              PostgreSQL schema and starter material
server/tests/            Local regression and dedicated-database integration tests
worker/                  Optional local PDF/OCR diagnostics and pure Python tests
compose.yaml             Local PostgreSQL
.github/workflows/       Validation and Android APK build
```

The configured hosted API is `athena-api` on Render, built from `server/Dockerfile`
(Node 22 plus Poppler). Set server-side `DATABASE_URL`, `JWT_SECRET` and optional
DeepSeek settings in the hosting environment; the API defaults to port 8787 unless
`PORT` is set.

The live web app is [athena-study.onrender.com](https://athena-study.onrender.com),
hosted by the Render static site **athena-study** from the `main` branch. Its
build command is `npm ci && npx expo export --platform web --clear`, and its
publish directory is `dist`. Configure `NODE_VERSION=22` and
`EXPO_PUBLIC_API_URL=https://athena-api-w018.onrender.com` on the static site.
The saved rewrite is `/*` to `/index.html` with action **Rewrite**, so direct
links and page reloads work. Clear Metro's export cache when changing the API
URL to avoid reusing a bundle with a previous environment value.

The API uses a free Render instance, which can sleep after inactivity and delay
the first request while it starts.

GitHub Actions publishes the development APK to the rolling
[apk-latest release](https://github.com/lpranish-ui/Athena/releases/tag/apk-latest).
That workflow uses a debug signing key; app-store distribution needs release
signing. For the existing EAS preview profile, use
`npx eas-cli@latest build --platform android --profile preview`
([EAS setup](https://docs.expo.dev/build/setup/)).

Future work includes broader reviewed course packs, an admin question-review
dashboard and durable AI-generation jobs. Offline book reading and downloaded
daily sessions with synchronization are available. Replace the Expo placeholder icons before release.
Ship original or appropriately licensed default content, and keep provider/JWT
secrets in the server environment.

## Study-coach MVP

The signed-in landing page is **Today**. Choose **Cardiovascular Foundations**,
set a daily budget and optional exam date, and start a session. The pilot has
eight objectives and 24 original questions; it runs without an AI key or book
upload. The course page contains the objective map, short lessons, sources and
plan settings. The mistake journal explains missed questions and shows which
mistakes have been repaired. Existing library, reader, quizzes and decks remain
available in the tabs.

Pilot material is explicitly marked **Editorial review pending**. It has not
received faculty approval, and the app does not predict examination pass rates.
Original content and linked references are recorded in
`server/data/course-packs/cardiovascular-foundations.json`. Downloaded PDFs on
the Desktop are not bundled into the app.

Enrollments, concept progress, session snapshots and answers are stored in
PostgreSQL. Session creation uses the enrollment's timezone; interrupted sessions
can resume, and repeated submissions do not create duplicate answers. Server-side
grading controls the result. The course API lives under `/api/study/` and requires
authentication. Its additive tables are bootstrapped by the existing schema
startup. Course-pack data is included in the API Docker image.

## Launch foundation

Choose an **MBBS**, **USMLE**, or **postgraduate entrance** track and save a
specific study goal in Today or Study preferences. All three currently share
the draft cardiovascular pilot; a track does not unlock exam-specific coverage.
The public `/preview` route demonstrates a lesson, confidence-based question
and explanatory feedback without creating an account or changing saved progress.

Paste a syllabus, one objective per line, in Study preferences or `/study/syllabus`.
Imports accept up to 100 objectives of 200 characters each. Importing replaces
the prior objective list and mappings, while preserving learning history.
Word-based suggestions require explicit confirmation. Unmatched objectives
remain visible as coverage gaps. Confirmed mappings prioritize new learning;
mistake repair and due review retain precedence. Saving syllabus text alone
does not replace confirmed mappings.

Private downloads and cached daily sessions are scoped to the signed-in account.
Legacy unscoped downloads are discarded. Logout, revoked sessions and account
deletion invalidate in-flight storage work and purge private local data. Only
network failures permit cached reading; authorization failures do not.
Downloaded sessions can save answers offline in order. Pending choices do not
earn grades or mastery until the server confirms them. Sync retries are
idempotent; differing answers from another device require an explicit decision.
Open the saved session to sync and read its feedback. Today also attempts a
bounded sync of its current cached session when the API becomes available.

Account security supports changing a password, signing out all devices and
requesting email verification. Password recovery uses hashed, expiring,
single-use email links. Configure `RESEND_API_KEY`, `AUTH_EMAIL_FROM` (verified
sender), and `AUTH_PUBLIC_URL` (the public web app URL) in the API environment
to enable account emails. Missing configuration returns an explicit unavailable
message; no reset token is returned through the API or printed in logs. Existing
accounts remain usable; verification is visible and is not yet a sign-in gate.

Course objectives and graded daily questions offer **Report an issue**. Reports
are versioned and private to the reporter, with open/triaged/resolved status in
Help & feedback. Operators can triage with `server/scripts/review-reports.js`;
there is no public administrator route. Publishing checks require reviewer/date
metadata and distribution provenance before a pack can declare itself reviewed.
These checks cannot replace a qualified medical editor's review.

Minimal first-party learning events record plan saves and session starts and
completions transactionally. They contain no book text, answer choices or email.
Run `server/scripts/launch-metrics.js` with the intended server database to see
aggregate activity and seven-day return to a completed session. Collection begins
with this release. Request IDs and structured slow/error logs support diagnosis;
external crash reporting and automated alerts still require operational setup.
See [operations and release checks](docs/operations.md).

## Run the whole app locally

With Docker Desktop running and dependencies installed in the root and `server/`:

```bash
npm run local
```

This starts the existing local PostgreSQL service, bootstraps its additive schema,
starts the watched API on port 8787, and opens Expo web on
`http://localhost:8081`. It does not read hosted API credentials or modify `.env`.
Paid AI generation and account emails are disabled in this local launcher.
The local JWT secret is regenerated on restart, so sign in again afterward.
Set `ATHENA_LOCAL_API_PORT` and `ATHENA_LOCAL_WEB_PORT` to choose different ports.
The PostgreSQL volume persists local accounts and progress between restarts.
