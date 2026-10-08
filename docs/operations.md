# Launch operations

The repository implements request IDs, structured slow/error logs, versioned
content reports and a small aggregate activity report. It does not establish
production backup coverage, an always-running hosting tier or third-party alerts.
Verify those services in the hosting account before broad acquisition campaigns.

## Release verification

Run root lint, typecheck, app tests and server tests. Supply a dedicated local
`TEST_DATABASE_URL` for database integration tests; the tests require the
`athena_test` database on a loopback host and isolate their schemas. Export web,
Android and iOS bundles. Verify signup, account recovery, syllabus import,
first session, reconnect, account switching and a direct-route reload. Native
bundle export verifies compilation, not behavior on physical phones.

Deploy additive schema changes before expecting new clients to use their routes.
Bootstrapping `server/sql/schema.sql` applies migrations 0007 and 0008
idempotently. Old clients may continue authenticating with version-zero tokens
until the user revokes sessions or changes their password. Ship a production
signed native build before app-store distribution. Keep a known-working server
and web commit available for rollback; additive tables can remain in place.

## Email setup

Configure a verified sender through Resend and the three environment variables
in `server/.env.example`. `AUTH_PUBLIC_URL` must point to the actual web app;
reset and verification links use `/reset-password` and `/verify-email`.
Test delivery using an operator-controlled test account after configuration.
Never include reset tokens, email provider responses, passwords or JWT secrets
in support logs. Recovery requests intentionally do not reveal account existence.

## Content triage

Operators triage the same queue two ways: `server/scripts/review-reports.js`
from an operator shell, or the web app's `/admin/reports` screen. The screen is
allow-listed through `ADMIN_EMAILS` (comma-separated) in the API environment
and the routes behave as if they do not exist while it is unset. Either way,
resolve a report only after reviewing the issue and making any required content
correction. Reporter identity is never shown.

From `server/`, with the intended `DATABASE_URL` already set:

```bash
node scripts/check-content.js
node scripts/review-reports.js
node scripts/review-reports.js REPORT_UUID triaged
node scripts/review-reports.js REPORT_UUID resolved
node scripts/launch-metrics.js
```

Report output excludes reporter identity. It still contains user-written reports;
keep it in restricted operator tooling. Resolve a report only after reviewing
the issue and making any required content correction. Existing session snapshots
remain stable; publish corrections with a new pack version. A `reviewed` pack
requires `reviewed_by`, a valid `reviewed_at` date, a review note and documented
commercial distribution provenance. The current pack remains a draft.

## Backup and restore drill

Confirm the production database's actual backup schedule, retention, access and
recovery window in the provider account. Record when the last successful backup
was created. Store any exported backup encrypted with restricted access; never
commit it or send it through support logs.

Restore a recent backup into an isolated database with outgoing email and paid AI
disabled. Verify schema initialization, ownership boundaries, course enrollment,
session snapshots/answers and queued upload bytes. Measure restore time and
record the result. Do not test restoration over the production database. Database
backups must include durable upload chunks, not just book metadata.

## Monitoring and capacity

Alert on sustained HTTP failures, slow responses, old queued uploads, database
storage growth and AI spending. `X-Request-Id` correlates slow/error request logs;
logs intentionally exclude URL query strings, request bodies and account identity.
Free API hosting can sleep and pauses its inline workers. Durable generation
jobs queue in PostgreSQL: the worker leases one job at a time, heartbeats long
runs, retries transient failures once and keeps finished jobs for a week; the
app polls queued/running jobs and shows their stage.

AI budgets are persistent and shared: the limiter counts successful provider
calls (the `ai_calls` log, pruned after 90 days) over a sliding hour, so they
survive restarts and cover background job execution. `AI_REQUESTS_PER_HOUR`
(default 200) bounds one account; `AI_GLOBAL_REQUESTS_PER_HOUR` (default 400)
bounds all accounts together and is the main backstop against abuse through
fresh accounts. `AI_CONCURRENT_PER_USER` (default 2) limits in-flight work per
account. A budget read that fails lets the request through deliberately.

Aggregate library storage is bounded too: `LIBRARY_CHARS_PER_USER` (default
96M extracted characters) per account and `LIBRARY_CHARS_TOTAL` (default
400M) across all accounts, enforced before a book's chapters are written.
Each book records its extracted-text size (`books.total_chars`), so the sums
stay cheap; validate the global default against real database growth before
large acquisition campaigns.

An always-running API/worker remains subsequent
infrastructure work.
