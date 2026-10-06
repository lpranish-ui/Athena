// Synthetic preview fixtures. Refuse every database outside this machine.
import { readFile } from 'node:fs/promises';
import { hashPassword } from '../src/auth.js';
import { pool, query, one, withTransaction } from '../src/db.js';

const address = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.pathname !== '/athena') {
  throw new Error('Local preview seeding requires the isolated local athena database.');
}
try {
  await query(await readFile(new URL('../sql/seed.sql', import.meta.url), 'utf8'));
  const email = 'local@athena.test';
  const user = await one(`insert into users (email,password_hash) values ($1,$2)
    on conflict (lower(email)) do update set email=excluded.email returning id`,
  [email, await hashPassword('AthenaLocal2026!')]);
  await query(`insert into profiles (id,full_name) values ($1,'Local Preview') on conflict (id) do nothing`, [user.id]);
  const existing = await one('select id from books where owner_id=$1 and title=$2', [user.id, 'Local Reader Demo']);
  if (!existing) {
    await withTransaction(async (client) => {
      const book = (await client.query(`insert into books (title,subject,author,owner_id,status)
        values ('Local Reader Demo','General','Athena local fixtures',$1,'ready') returning id`, [user.id])).rows[0];
      const paragraphs = Array.from({ length: 180 }, (_, index) =>
        `Paragraph ${index + 1}. This original local preview passage checks chapter reading, saved positions, search, highlights and notes. Each paragraph has its own number so a jump to a distant passage can be verified. Text stays in the isolated local database.`);
      const content = paragraphs.join('\n\n');
      const chapter = (await client.query(`insert into chapters (book_id,number,title,content,first_page,last_page,page_map)
        values ($1,1,'Reader, progress and notes',$2,1,18,$3::jsonb) returning id`,
      [book.id, content, JSON.stringify(Array.from({ length: 18 }, (_, index) => ({ page: index + 1,
        char_start: paragraphs.slice(0, index * 10).join('\n\n').length + (index ? 2 : 0) })))])).rows[0];
      await client.query(`insert into reading_progress (user_id,book_id,chapter_id,offset_ratio) values ($1,$2,$3,0.6)`, [user.id,book.id,chapter.id]);
      await client.query(`insert into reader_notes (user_id,book_id,chapter_id,paragraph_index,kind,text,note,color)
        values ($1,$2,$3,120,'note',$4,'Distant passage jump fixture','yellow')`, [user.id,book.id,chapter.id,paragraphs[120]]);
      const set = (await client.query(`insert into mcq_sets (chapter_id,chapter_ids,user_id,title,difficulty,status)
        values ($1,ARRAY[$1::uuid],$2,'Local preview quiz','easy','ready') returning id`, [chapter.id,user.id])).rows[0];
      for (let index = 0; index < 24; index++) {
        await client.query(`insert into mcqs (set_id,chapter_id,position,question,options,correct_index,explanation,question_type)
          values ($1,$2,$3,$4,$5::jsonb,0,'This is a local UI fixture.','mcq')`,
        [set.id,chapter.id,index+1,`Local fixture ${index+1}: where is preview data stored?`,JSON.stringify(['An isolated local database','The production database','A third party website','Only the clipboard'])]);
      }
    });
  }
  console.log('Local fixtures ready. Sign in: local@athena.test / AthenaLocal2026!');
} finally {
  await pool.end();
}
