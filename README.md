# Athena — medical study

Athena turns PDF, EPUB and TXT books into a readable chapter library, source-linked
quizzes, flashcards and summaries. The Expo SDK 57 app runs on web, Android and
iOS; a Node API and PostgreSQL store accounts and study progress.

## Features

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
metadata and spine text, excluding image payloads. Extracted text is limited to
six million characters; oversized books fail with a request to split volumes
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
`PORT` is set. A web export uses `npx expo export --platform web`, publishes `dist`
and needs a SPA rewrite to `/index.html` plus `EXPO_PUBLIC_API_URL`.

GitHub Actions publishes the development APK to the rolling
[apk-latest release](https://github.com/lpranish-ui/Athena/releases/tag/apk-latest).
That workflow uses a debug signing key; app-store distribution needs release
signing. For the existing EAS preview profile, use
`npx eas-cli@latest build --platform android --profile preview`
([EAS setup](https://docs.expo.dev/build/setup/)).

Future work includes broader licensed starter material, an admin question-review
dashboard and offline study. Replace the Expo placeholder icons before release.
Ship original or appropriately licensed default content, and keep provider/JWT
secrets in the server environment.
