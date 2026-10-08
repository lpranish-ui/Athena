# Athena — project status (for Copilot sessions)

Expo (React Native) + TypeScript app (web + Android + iOS) with a Node API on
Render and Postgres. No Supabase anymore — that architecture was fully replaced.

## Current architecture

- **App**: Expo SDK 57, Expo Router, routes in `src/app/`, alias `@/*` → `src/*`,
  web output `single` (SPA). Typecheck: `npm run typecheck`.
- **API**: `server/` → Render web service `athena-api`
  (Docker, `server/Dockerfile` = node:22-slim + poppler-utils; poppler's
  `pdftotext` handles any-size PDFs). URL: `https://athena-api-w018.onrender.com`,
  health `/api/health`. It runs `server/sql/schema.sql` on every boot
  (idempotent — new tables deploy automatically).
- **DB**: `athena` database in the "LA carte" Render Postgres. The service
  connects via the INTERNAL url; external access is IP-allowlisted (empty).
- **Auth**: own `users` table, scrypt, HS256 JWT (60-day), `JWT_SECRET` env.
- **Web**: Render static site "Athena" → `https://athena-27wx.onrender.com`
  (`npm install && npx expo export --platform web`, publish `dist`, rewrite
  `/* → /index.html`, env `EXPO_PUBLIC_API_URL`).
- **APK**: GitHub Actions (`build-apk.yml`, free, no Expo account) — pushes to
  `src/**`/`server/**`/config rebuild it (~13–18 min); rolling release `apk-latest`:
  `https://github.com/lpranish-ui/Athena/releases/download/apk-latest/app-release.apk`.
- **AI**: DeepSeek via `server/src/ai.js` — thinking mode stays ON for verbatim
  quotes; generation budgets are large (24k) so reasoning can't starve the
  answer; 3 attempts + timeouts + salvage logic in `chatJson`; every call logs
  `ai call ok/empty/failed` (visible in Render logs). Quiz/study-kit generation
  runs through a durable Postgres queue (`server/src/jobs.js`, `generation_jobs`
  table + in-process worker started in `server/src/index.js`); the client polls
  `/api/ai/jobs`. AI budgets (`server/src/ai-limit.js`) are persistent and
  shared, counted from the `ai_calls` log over a sliding hour: 200 calls/user +
  400 global by default (`AI_REQUESTS_PER_HOUR`, `AI_GLOBAL_REQUESTS_PER_HOUR`).
  Aggregate library storage quotas live in `server/src/ingest.js`
  (`LIBRARY_CHARS_PER_USER` 96M chars, `LIBRARY_CHARS_TOTAL` 400M;
  `books.total_chars`, backfilled at boot).
- **Operator/email (optional env)**: the `/admin/reports` triage screen activates
  for emails in `ADMIN_EMAILS` (404 when unset); password reset/verification
  emails need `RESEND_API_KEY` + `AUTH_EMAIL_FROM` + `AUTH_PUBLIC_URL` (unset →
  explicit "unavailable" message, never a silent failure).

## Key flows

- **Upload (any size)**: `POST /api/uploads` → `PUT /api/uploads/:id/chunk`
  (8 MB raw chunks appended to a temp file) → `POST /api/uploads/:id/finish`
  (background extract via `ingestFileFromPath`; status_message updated:
  Uploading… → Processing… → Extracting text… → Detecting chapters… → ready).
  Client: `src/lib/files.ts` (web = Blob slices, native = expo-file-system
  `File.open()`/`readBytes`, ArrayBuffer bodies) + `upload.tsx` polls
  `waitForBookReady`.
- **Reader**: `src/app/reader/[bookId].tsx` — themes/fonts/spacing, resume via
  `reading_progress` (chapter + offset ratio; re-applied over a 1.5s settle
  window; user scroll cancels). Library shows a "Continue reading" shelf
  (`GET /api/reading`).
- **Quiz generation**: `server/src/generate.js` — quote validation (`locateQuote`
  tolerant of PDF spacing), near-dup filter, blind verify, retry-once on a
  zero-valid draft. Client chunks large sets via `addToSetId`.
- **Durable generation**: `POST /api/ai/jobs` (202, cap 3 active/user) enqueues;
  the worker leases one job at a time (heartbeat, retry transient once, reclaim
  expired leases, 7-day retention) and streams stage text. Client `waitForJob`
  in `src/lib/api.ts` polls; the Quizzes tab lists active jobs. Inline
  `/api/ai/*` endpoints remain for older APKs.

## Commands on this machine

- Use `npm.cmd` / `npx.cmd` (PowerShell script policy); keep terminal commands
  ASCII-only (an em-dash once wedged the sync shell).
- Push to `main` = deploys API + web + APK workflows.
- Render API for status/logs (key kept out of this file; ask the user):
  `GET https://api.render.com/v1/services/srv-db1p8o142hec73dnn0m0/deploys?limit=1`
  headers `Authorization: Bearer <RENDER_API_KEY>`; logs via
  `/v1/logs?ownerId=tea-d6a2fifgi27c73corti0&resource=<serviceId>&type=app|build`.
- `gh run list -R lpranish-ui/Athena` for APK builds.

## Conventions

- Keep mobile-first patterns; prefer Expo modules.
- Never put secrets in the app bundle; the DeepSeek key is server-side only.
- New DB tables: append idempotent DDL to `server/sql/schema.sql`.
- Run `npm run typecheck` and `npx expo lint` before declaring work done.
- The demo account `demo@athena.app` / `athena123` exists for testing.

## Roadmap

- Always-on API/worker hosting (the free tier sleeps and pauses inline workers)
  and reviewed course packs (requires a qualified medical editor).
- OCR for scanned PDFs (prototype in `worker/`; needs more CPU/RAM hosting).
- A licensed starter library.
