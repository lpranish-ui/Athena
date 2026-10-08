// Operator-only aggregate report. Run with the intended DATABASE_URL, never expose it as a public route.
import { pool, one } from '../src/db.js';
try {
  const funnel = await one(`select
    (select count(*)::int from users where created_at>=now()-interval '14 days') as new_accounts_14d,
    (select count(distinct user_id)::int from learning_events where event_name='plan_saved' and created_at>=now()-interval '14 days') as learners_saving_plan_14d,
    (select count(distinct user_id)::int from learning_events where event_name='session_started' and created_at>=now()-interval '14 days') as learners_starting_session_14d,
    (select count(distinct user_id)::int from learning_events where event_name='session_completed' and created_at>=now()-interval '14 days') as learners_completing_session_14d,
    (select count(*)::int from course_reports where status<>'resolved') as unresolved_content_reports`);
  const returnStudy = await one(`with first_completion as (
    select user_id,min(created_at) as first_at from learning_events where event_name='session_completed' group by user_id
  ), eligible as (
    select * from first_completion where first_at<=now()-interval '7 days' and first_at>=now()-interval '30 days'
  ) select count(*)::int as eligible_learners,
    count(*) filter (where exists (select 1 from learning_events e where e.user_id=eligible.user_id
      and e.event_name='session_completed' and e.created_at>=eligible.first_at+interval '1 day'
      and e.created_at<eligible.first_at+interval '8 days'))::int as returned_to_complete_session_within_7d
    from eligible`);
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), activity: funnel, seven_day_return: returnStudy,
    note: 'Activity counts use separate populations; do not interpret them as one cohort conversion funnel. Learning events begin with this release.' }, null, 2));
} finally { await pool.end(); }
