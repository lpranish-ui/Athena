# Athena 🏛️ — medical study, powered up

Athena turns any medical book into an interactive quiz. Students upload their own
books (PDF / EPUB / TXT or pasted text), Athena splits them into chapters, and
DeepSeek AI writes exam-style MCQs from any chapter in seconds.

Built as a single codebase that runs **on the web, Android and iOS** (Expo + React Native).

## Features

- **📚 Personal library** — upload books or start from built-in study material;
  filter by subject (auto-suggested when you upload). Uploads are private to
  your account; built-in books are shared with everyone.
- **✂️ Automatic chapter splitting** — PDF bookmarks are used when present, then
  the printed contents page (with page-offset correction), then "Chapter N"
  headings; fix any wrong split yourself (rename, split at a page, merge,
  delete) from the book screen.
- **🤖 AI quiz generation** — pick one or more chapters, question type (standard
  MCQ, clinical vignette, true/false), difficulty and count; DeepSeek writes
  fresh questions with per-option explanations.
- **📝 Quiz mode** — Tutor mode (feedback + explanations after each question) or
  Exam mode (timed, answers at the end).
- **🔗 Page-linked questions** — every question cites the book page it came from
  and shows a word-for-word supporting quote, verified before you see it.
- **🚩 Flagging** — report a wrong or unclear question; it is hidden for you and
  queued for review, and you can generate a replacement question with one tap.
- **📈 Progress tracking** — best score per quiz, scores by subject, weak-chapter
  suggestions, and average score on your profile.
- **🔁 Smart review** — missed questions return on a spaced schedule
  (simplified FSRS) until they stick; the Quizzes tab shows what's due.
- **🃏 Study kit** — auto-made flashcards (exportable to Anki as CSV) and
  one-page high-yield chapter summaries, both with page references.
- **🗓️ Study planner** — set your exam date and target exam in your profile;
  the Quizzes tab shows days to go and today's targets.
- **⏱️ Mock exams** — timed runs assembled from your existing questions,
  mixed across a book's chapters.
- **🔐 Accounts** — email/password sign-up and sign-in (plus Google on web once
  enabled in Supabase); per-user data protected by Postgres Row-Level Security.
  In-app account deletion included.

## Tech stack

| Layer     | Choice                                                        |
| --------- | ------------------------------------------------------------- |
| App       | Expo SDK 57 · React Native · TypeScript · Expo Router         |
| Backend   | Supabase (Auth, Postgres, Storage, Edge Functions)            |
| AI        | DeepSeek API (`deepseek-chat`) — key stored server-side only  |
| Text ext. | `pdfjs-dist` (PDF) · `fflate` (EPUB) — runs in edge functions |

## Project structure

```
src/
  app/                 # Screens (Expo Router file-based routes)
    (auth)/            #   sign-in, sign-up
    (tabs)/            #   library, quizzes, profile
    book/[id].tsx      #   book detail + chapter list
    chapter/[id].tsx   #   read a chapter + generate MCQs
    quiz/[id].tsx      #   take a quiz + results + review
    upload.tsx         #   add a book (file or pasted text)
  components/          # UI primitives, book card, brand, setup screen
  lib/                 # Supabase client, auth, API wrappers, file helpers
  theme/               # Colors, spacing, subject colors
  types/               # Shared TypeScript types
supabase/
  migrations/0001_init.sql   # Schema, RLS policies, storage bucket
  seed.sql                   # Built-in demo books
  functions/
    generate-mcqs/       # DeepSeek → MCQs → database
    ingest-book/         # file/text → extracted text → chapters
  config.toml
```

## Getting started

### 0. Prerequisites

- Node.js 20+ and npm
- A free [Supabase](https://supabase.com) account
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) (for quiz generation)

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Open the **SQL Editor** and run, in order:
   - `supabase/migrations/0001_init.sql` — tables, security policies, storage bucket
   - `supabase/migrations/0002_plan_upgrades.sql` — page citations, flags, quiz modes, profile fields
   - `supabase/migrations/0003_jobs_and_multi_chapter.sql` — OCR job queue, multi-chapter quizzes
   - `supabase/migrations/0004_reviews.sql` — spaced-repetition state
   - `supabase/migrations/0005_study_tools_and_planner.sql` — flashcards/summaries, exam date, AI cost log
   - `supabase/seed.sql` — the two built-in demo books
3. All scripts are safe to run again.

### 3. Deploy the edge functions

Install the Supabase CLI (`npm install -g supabase` or use `npx supabase@latest`),
then from the project root:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy generate-mcqs
supabase functions deploy ingest-book
supabase functions deploy replace-question
supabase functions deploy study-kit
supabase functions deploy delete-account
supabase secrets set DEEPSEEK_API_KEY=sk-your-deepseek-key
# optional: models (defaults: generator deepseek-v4-pro, blind checker deepseek-flash)
# supabase secrets set DEEPSEEK_MODEL=deepseek-flash
# supabase secrets set DEEPSEEK_VERIFY_MODEL=deepseek-flash
```

> `YOUR-PROJECT-REF` is the subdomain of your project URL — for
> `https://abcd1234.supabase.co` it is `abcd1234`.

Prefer the dashboard? You can instead create each function under
**Edge Functions → Deploy new function**, paste the code from
`supabase/functions/<name>/index.ts`, and add the `DEEPSEEK_API_KEY` secret under
**Project Settings → Edge Functions → Secrets** (the `_shared` helper is bundled
automatically by the CLI; with manual deploys, paste the shared helpers' contents
into each function file).

### 4. Configure the app

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Fill in **Project Settings → API** values:

```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

The DeepSeek key is **never** placed in `.env` — it lives only in Supabase secrets.

### 5. Run

```bash
npm run web        # browser
npm run android    # Android emulator/device
npm run ios        # iOS (needs macOS; on Windows use Expo Go or EAS builds)
```

Open the app, create an account and start studying. 🎉

> **Tip — faster testing:** if email confirmation is enabled, sign-ups must
> confirm via email before signing in. For quick local testing you can disable it
> in **Authentication → Sign In / Providers → Email → Confirm email**.

> **Google sign-in:** enable the Google provider in Supabase
> (Authentication → Providers → Google, using a Google OAuth client) and add
> your web origin plus `athena://` to the redirect URLs. The button then works
> on web and mobile.

## How a quiz gets made

1. You open a chapter, choose question type, difficulty and count.
2. The app calls the `generate-mcqs` edge function with your login token.
3. The chapter text is sent with `[p. N]` page markers, and your target exam
   shapes the question style. Request options come last so the prompt prefix is
   cache-friendly within a chapter (cheaper repeat generations).
4. Every returned question must pass quality checks before you see it:
   - exactly one correct option, no “all of the above”;
   - the supporting quote must appear **word for word** in the chapter — the
     page shown is located from the text itself;
   - near-duplicates of stored stems are dropped;
   - a second, cheaper model answers every question blind (without seeing the
     key) from the same passages — disagreements are dropped.
5. Passing questions are saved with source page, quote and per-option
   explanations; only then is the quiz created.
6. The quiz runs in Tutor or Exam mode; scores, timing and answers are stored.

A 10-question quiz typically takes 10–30 seconds. Prefer 10–20 per run: very
large sets need the background worker planned in the roadmap.

## Built-in library

`supabase/seed.sql` ships two original demo books (Cardiovascular Essentials ·
Microbiology: First Principles) with five short chapters so you can try the
full flow immediately. Add your own built-in books the same way — insert a row
into `books` with `is_default = true` and `owner_id = null`, plus its chapters.
Use only content you have the rights to distribute.

## OCR for scanned books (worker)

Edge functions cannot run OCR, so scanned PDFs are queued in the `jobs` table
and processed by a small Python worker in `worker/`:

1. Upload a PDF with no text layer → the app saves it as **queued** and adds a job.
2. Start the worker (`worker/README.md` explains the one-time install of
   Tesseract + Ghostscript, then `pip install -r requirements.txt` and
   `python worker.py`). It claims the job, OCRs the file (OCRmyPDF), extracts
   text page by page and splits it into chapters — same pipeline as the edge
   function.
3. The book flips to **ready**; reopen the book screen to see it.

The worker uses the Supabase **service-role key** locally — never put that key
in the app. Failed jobs retry up to 3 times, then surface their error on the
book screen.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| App shows "Almost there…" setup screen | `.env` missing/invalid — see step 4, then restart the dev server |
| "missing DEEPSEEK_API_KEY secret" | Run `supabase secrets set DEEPSEEK_API_KEY=sk-…` and redeploy |
| AI error mentions an unknown/retired model | Set a current model: `supabase secrets set DEEPSEEK_MODEL=deepseek-v4-pro` (or `deepseek-flash`) |
| "You have already uploaded this file" | Duplicate detection — delete the older copy first, or upload a different edition |
| Book stuck on "Waiting for OCR…" | Start the worker (`worker/README.md`) — it picks up the queued job automatically |
| Questions rejected by quality checks | The model must quote the chapter word-for-word; retry, or use a chapter with cleaner text |
| Upload fails: "does not contain selectable text" | Scanned PDFs need OCR (not supported yet) — use a text PDF/EPUB/TXT or paste text |
| Sign-up works but can't sign in | Email confirmation is on — confirm via the email, or disable it (step 5 tip) |
| Edge function errors | Inspect logs: `supabase functions logs generate-mcqs` |
| Types out of date | `npm run typecheck`; regenerate routes with `npx expo start` |

## Useful commands

```bash
npm start            # Expo dev server (press w/a/i for web/android/ios)
npm run web          # web directly
npm run typecheck    # TypeScript check
npx expo-doctor      # dependency/config health check
```

## Roadmap (aligned with the product plan)

Already in this build: page-linked questions with quotes, flagging (+ one-tap
replacement questions), tutor/exam modes, duplicate detection, account deletion,
progress by subject + weak chapters, target-exam profile, chapter split editing,
subject filters, multi-chapter quizzes, PDF-bookmark + contents-page chapter
detection, the OCR job queue with a Python worker (`worker/`), blind
second-model verification, near-duplicate detection, 10/20/50-question sets,
Google sign-in on web and mobile, spaced repetition ("Smart review"), the study
kit (flashcards + summaries with Anki export), the exam-date study planner, and
mock exams.

Next milestones:
- Admin flag-review dashboard (the `ai_calls` cost log already records usage).
- Offline mode with on-device caching.
- Starter library: license-checked content (Athena-written notes + public-domain
  sources such as Gray's Anatomy 1918).
## Notes

- App icons and splash images in `assets/images/` are Expo template placeholders —
  replace them with Athena branding before release.
- Demo book texts are original summaries written for this project; always verify
  medical information against official textbooks.
- Built-in books carry `license` / `license_url` columns — record the license
  before shipping any starter content (see the product plan's licensing table).
