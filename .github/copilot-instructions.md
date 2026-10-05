# Athena — project setup status

Workspace: Expo (React Native) + TypeScript + Expo Router app that runs on web,
Android and iOS, backed by Supabase with DeepSeek-powered quiz generation.

## Setup checklist

- [x] Verify that the copilot-instructions.md file in the .github directory is created.
- [x] Clarify Project Requirements — cross-platform (web + mobile) medical study app;
      students upload books, AI generates MCQs per subject/chapter, built-in default
      books, accounts from the start. Stack chosen: Expo + Supabase + DeepSeek.
- [x] Scaffold the Project — created with `create-expo-app` (SDK 57 default
      template, TypeScript + Expo Router); template demo files removed.
- [x] Customize the Project — built the full Athena app: auth screens, library,
      upload + chapter splitting, DeepSeek MCQ generation, quiz mode with scoring,
      profile/progress; Supabase schema, RLS policies, storage bucket, seed books,
      and two edge functions (`generate-mcqs`, `ingest-book`).
- [x] Install Required Extensions — installed `expo.vscode-expo-tools` (the
      extension recommended by the project's `.vscode/extensions.json`).
- [x] Compile the Project — `npm run typecheck` passes; web export
      (`npx expo export --platform web`) builds successfully in SPA mode.
- [x] Create and Run Task — "Athena: Web dev server" task created in
      `.vscode/tasks.json` and started (`npx expo start --web`).
- [x] Launch the Project — web dev server runs at http://localhost:8081 and
      renders the setup screen until Supabase credentials are added to `.env`.
- [x] Ensure Documentation is Complete — README.md contains the full setup
      walkthrough (Supabase project, SQL, edge function deploy, DeepSeek secret,
      `.env`, run commands); this file cleaned up.

## Notes for future work

- Commands on this machine: use `npm.cmd` / `npx.cmd` (PowerShell script policy).
- Run `npx expo lint`, `npm run typecheck` and `npx expo-doctor` before shipping changes.
- Secrets: `DEEPSEEK_API_KEY` (plus optional `DEEPSEEK_MODEL`, default
  `deepseek-v4-pro`) live only in Supabase secrets — never in `.env`.
- v1.1 plan upgrades: also run `0002_plan_upgrades.sql`; deploy three functions
  (generate-mcqs, ingest-book, delete-account). Questions carry page citations
  and word-for-word quotes; the flags table hides reported questions per student.
- v1.2: chapter split editing (`src/app/manage-chapters.tsx`, opened from the
  book screen's "Fix splits" button for owned uploads; merges re-point mcq_sets
  so quizzes survive), library subject filter chips, and upload subject
  auto-suggest (`src/lib/subjects.ts`).
- v1.3: multi-chapter quizzes (`mcq_sets.chapter_ids`, per-question
  `mcqs.chapter_id`, `/generate` screen), `replace-question` function (one-tap
  replacement after a flag), PDF-bookmark chapter detection in `ingest-book`,
  and the OCR pipeline: `0003_jobs_and_multi_chapter.sql` (jobs table +
  `claim_job()`), Python worker in `worker/` (needs Tesseract + Ghostscript;
  run `python worker.py`). Deploy FOUR functions: generate-mcqs, ingest-book,
  replace-question, delete-account.
- v1.4: contents-page chapter detection (edge + worker port); blind second-model
  answer check (`DEEPSEEK_VERIFY_MODEL`, default `deepseek-flash`) + near-dup
  detection in generate-mcqs; 10/20/50-question sets (client chunks of 20 via
  `addToSetId`); Google sign-in on native (expo-web-browser + `athena://`
  scheme, session from the deep-link fragment); spaced repetition — run
  `0004_reviews.sql`, scheduler in `src/lib/review.ts`, `/review` screen, due
  card on the Quizzes tab.
- v1.5: study kit (`study-kit` function + `study_materials` — flashcards and
  page-validated summaries; Anki CSV export from `/flashcards`); study planner
  (`profiles.exam_date`, card on the Quizzes tab); mock exams (`/mock-exam`
  samples existing questions into a fresh set); AI usage log (`ai_calls`, written
  by `_shared/ai.ts` via its `meta` option). Run
  `0005_study_tools_and_planner.sql`; deploy FIVE functions (add `study-kit`).
- Web output mode is `single` (SPA) because the Supabase client touches `window`
  during static rendering — do not switch back to `static` without guarding SSR.
