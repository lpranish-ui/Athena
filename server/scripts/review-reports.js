// Operator-only triage. Read: node scripts/review-reports.js
// Update: node scripts/review-reports.js <report UUID> <triaged|resolved|open>
import { pool, many, one } from '../src/db.js';
try {
  const [id, status] = process.argv.slice(2);
  if (id || status) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '') || !['open', 'triaged', 'resolved'].includes(status)) throw new Error('Supply a report UUID and open, triaged or resolved.');
    const result = await one('update course_reports set status=$2,updated_at=now() where id=$1 returning id,status', [id, status]);
    if (!result) throw new Error('Report not found.');
    console.log(JSON.stringify(result));
  } else {
    // Deliberately exclude reporter identity and email.
    console.log(JSON.stringify(await many("select id,course_id,pack_version,concept_id,question_id,category,message,status,created_at from course_reports where status<>'resolved' order by created_at limit 100"), null, 2));
  }
} finally { await pool.end(); }
