import * as defaultDatabase from './db.js';
import { HttpError } from './http.js';

export function validPageMarks(value, length = Infinity) {
  return (Array.isArray(value) ? value : [])
    .filter((mark) => Number.isInteger(mark?.page) && mark.page > 0 &&
      Number.isInteger(mark.char_start) && mark.char_start >= 0 && mark.char_start < length)
    .sort((a, b) => a.char_start - b.char_start);
}

/** Keep the page active at the cut as the new chapter's zero offset. */
export function splitChapterContent(chapter, cut) {
  if (!Number.isInteger(cut) || cut <= 0 || cut >= chapter.content.length ||
      !chapter.content.slice(0, cut).trim() || !chapter.content.slice(cut).trim()) {
    throw new HttpError(400, 'Choose a split inside the chapter with text on both sides.');
  }
  const marks = validPageMarks(chapter.page_map, chapter.content.length);
  const headMap = marks.filter((mark) => mark.char_start < cut);
  const active = marks.filter((mark) => mark.char_start <= cut).at(-1);
  const tailMap = marks.filter((mark) => mark.char_start >= cut)
    .map((mark) => ({ page: mark.page, char_start: mark.char_start - cut }));
  if (active && tailMap[0]?.char_start !== 0) {
    tailMap.unshift({ page: active.page, char_start: 0 });
  }
  return {
    head: { content: chapter.content.slice(0, cut), page_map: headMap.length ? headMap : null,
      first_page: headMap[0]?.page ?? chapter.first_page ?? null,
      last_page: headMap.at(-1)?.page ?? null },
    tail: { content: chapter.content.slice(cut), page_map: tailMap.length ? tailMap : null,
      first_page: tailMap[0]?.page ?? null,
      last_page: tailMap.at(-1)?.page ?? chapter.last_page ?? null },
  };
}

// Mirrors the reader's blank-line-aware paragraph boundaries, preserving offsets.
function paragraphStarts(content) {
  const text = content.trim();
  if (!text) return [];
  const leading = content.indexOf(text);
  const delimiter = text.split(/\n{2,}/).length >= 3 ? /\n{2,}/g : /\n/g;
  const starts = [];
  let start = 0;
  for (const match of text.matchAll(delimiter)) {
    if (text.slice(start, match.index).trim()) starts.push(leading + start);
    start = match.index + match[0].length;
  }
  if (text.slice(start).trim()) starts.push(leading + start);
  return starts;
}

function paragraphAt(starts, offset) {
  return Math.max(0, starts.findLastIndex((start) => start <= offset));
}

async function lockedBookAndChapter(client, chapterId, userId) {
  const result = await client.query('select book_id from chapters where id = $1', [chapterId]);
  const bookId = result.rows[0]?.book_id;
  if (!bookId) throw new HttpError(404, 'Chapter not found.');
  // The book lock serializes split/merge/delete/reorder and avoids lock-order deadlocks.
  const book = (await client.query('select id, owner_id from books where id = $1 for update', [bookId])).rows[0];
  if (!book || book.owner_id !== userId) throw new HttpError(403, 'You can only change your own chapters.');
  const chapter = (await client.query('select * from chapters where id = $1 for update', [chapterId])).rows[0];
  if (!chapter) throw new HttpError(404, 'Chapter not found.');
  return chapter;
}

async function renumber(client, bookId) {
  await client.query(`with ordered as (
    select id, row_number() over (order by number, created_at, id)::int as number
    from chapters where book_id = $1
  ) update chapters c set number = o.number from ordered o where c.id = o.id`, [bookId]);
}

export function createChapterService(database = defaultDatabase) {
  return {
    async split(chapterId, userId, cut) {
      return database.withTransaction(async (client) => {
        const chapter = await lockedBookAndChapter(client, chapterId, userId);
        const { head, tail } = splitChapterContent(chapter, cut);
        await client.query('update chapters set number = number + 1 where book_id = $1 and number > $2',
          [chapter.book_id, chapter.number]);
        const next = (await client.query(`insert into chapters
          (book_id, number, title, content, page_map, first_page, last_page)
          values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning *`,
        [chapter.book_id, chapter.number + 1, `${chapter.title} (continued)`, tail.content,
          tail.page_map ? JSON.stringify(tail.page_map) : null, tail.first_page, tail.last_page])).rows[0];
        await client.query(`update chapters set content=$2,page_map=$3::jsonb,first_page=$4,last_page=$5 where id=$1`,
          [chapter.id, head.content, head.page_map ? JSON.stringify(head.page_map) : null, head.first_page, head.last_page]);
        // Keep existing quizzes' full source coverage and move individual tail citations.
        await client.query(`update mcq_sets set chapter_ids =
          array_append(coalesce(chapter_ids, array[chapter_id]::uuid[]), $2::uuid)
          where (chapter_id=$1 or $1=any(chapter_ids)) and not ($2=any(coalesce(chapter_ids,'{}'::uuid[])))`,
        [chapter.id, next.id]);
        const questions = (await client.query('select id, supporting_quote from mcqs where chapter_id=$1', [chapter.id])).rows;
        for (const question of questions) {
          const offset = question.supporting_quote ? chapter.content.indexOf(question.supporting_quote) : -1;
          if (offset >= cut) await client.query('update mcqs set chapter_id=$2 where id=$1', [question.id, next.id]);
        }
        const oldStarts = paragraphStarts(chapter.content);
        const headStarts = paragraphStarts(head.content);
        const tailStarts = paragraphStarts(tail.content);
        const notes = (await client.query('select id, paragraph_index from reader_notes where chapter_id=$1', [chapter.id])).rows;
        for (const note of notes) {
          const offset = oldStarts[note.paragraph_index] ?? 0;
          const inTail = offset >= cut;
          await client.query('update reader_notes set chapter_id=$2,paragraph_index=$3 where id=$1',
            [note.id, inTail ? next.id : chapter.id, paragraphAt(inTail ? tailStarts : headStarts, inTail ? offset-cut : offset)]);
        }
        await renumber(client, chapter.book_id);
        return { ok: true, keptChapterId: chapter.id, newChapterId: next.id };
      });
    },
    async merge(chapterId, userId, intoId) {
      if (!intoId || intoId === chapterId) throw new HttpError(400, 'intoId must be another chapter.');
      return database.withTransaction(async (client) => {
        const source = await lockedBookAndChapter(client, chapterId, userId);
        const target = (await client.query('select * from chapters where id=$1 and book_id=$2 for update', [intoId, source.book_id])).rows[0];
        if (!target) throw new HttpError(400, 'Chapters from different books cannot be merged.');
        const prefix = `${target.content}\n\n${source.title}\n`;
        const content = prefix + source.content;
        const marks = [...validPageMarks(target.page_map, target.content.length),
          ...validPageMarks(source.page_map, source.content.length).map((mark) => ({ ...mark, char_start: mark.char_start + prefix.length }))];
        await client.query('update chapters set content=$2,page_map=$3::jsonb,first_page=$4,last_page=$5 where id=$1',
          [target.id, content, marks.length ? JSON.stringify(marks) : null,
            target.first_page ?? source.first_page ?? null,
            Math.max(target.last_page ?? 0, source.last_page ?? 0) || null]);
        await client.query('update mcq_sets set chapter_id=$2 where chapter_id=$1', [source.id, target.id]);
        await client.query(`update mcq_sets set chapter_ids = array(
          select mapped.id from unnest(array_replace(chapter_ids,$1::uuid,$2::uuid)) with ordinality mapped(id,ord)
          group by mapped.id order by min(mapped.ord)
        ) where $1=any(chapter_ids)`, [source.id, target.id]);
        await client.query('update mcqs set chapter_id=$2 where chapter_id=$1', [source.id, target.id]);
        const sourceStarts = paragraphStarts(source.content);
        const targetStarts = paragraphStarts(target.content);
        const newStarts = paragraphStarts(content);
        const notes = (await client.query('select id,chapter_id,paragraph_index from reader_notes where chapter_id=any($1::uuid[])', [[source.id,target.id]])).rows;
        for (const note of notes) {
          const fromSource=note.chapter_id===source.id;
          const oldStarts=fromSource ? sourceStarts : targetStarts;
          await client.query('update reader_notes set chapter_id=$2,paragraph_index=$3 where id=$1',
            [note.id, target.id, paragraphAt(newStarts, (fromSource ? prefix.length : 0) + (oldStarts[note.paragraph_index] ?? 0))]);
        }
        await client.query('update reading_progress set chapter_id=$2,offset_ratio=0 where chapter_id=$1', [source.id,target.id]);
        await client.query('delete from chapters where id=$1', [source.id]);
        await renumber(client, source.book_id);
        return { ok: true, keptChapterId: target.id };
      });
    },
    async remove(chapterId, userId) {
      return database.withTransaction(async (client) => {
        const chapter = await lockedBookAndChapter(client, chapterId, userId);
        await client.query('delete from chapters where id=$1', [chapter.id]);
        await renumber(client, chapter.book_id);
        return { ok: true };
      });
    },
  };
}
