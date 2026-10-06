import crypto from 'node:crypto';
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import * as defaultDatabase from './db.js';
import { ingestFileFromPath } from './ingest.js';
import { HttpError } from './http.js';

const TEMP_DIR = path.join(os.tmpdir(), 'athena-uploads');
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 512 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 5;
const LEASE_MS = 5 * 60 * 1000;

function failure(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error('upload failed:', error?.message ?? error);
  res.status(status).json({ error: status === 500 ? 'Could not process the upload.' : error.message,
    ...(Number.isFinite(error?.received) ? { received: error.received } : {}) });
}

function wrap(handler) {
  return async (req, res) => {
    try { await handler(req, res); } catch (error) { failure(res, error); }
  };
}

function publicState(session) {
  return { received: Number(session.received_bytes), fileSize: session.expected_size === null ? null : Number(session.expected_size), status: session.status };
}

export function createUploadService(database = defaultDatabase) {
  return {
    async create(userId, body) {
      const fileName = String(body?.fileName ?? '').trim();
      const extension = fileName.split('.').at(-1)?.toLowerCase();
      if (!['pdf', 'epub', 'txt'].includes(extension)) throw new HttpError(400, 'Please choose a PDF, EPUB or TXT file.');
      const expected = body.fileSize === undefined ? null : Number(body.fileSize);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_UPLOAD_BYTES)) {
        throw new HttpError(400, `Choose a file smaller than ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB.`);
      }
      return database.withTransaction(async (client) => {
        // Serialize per-user quota checks; sessions and books commit together.
        await client.query('select id from users where id=$1 for update', [userId]);
        const count = (await client.query("select count(*)::int as count from upload_sessions where user_id=$1 and status in ('uploading','queued','processing')", [userId])).rows[0]?.count ?? 0;
        if (count >= MAX_ACTIVE_UPLOADS) throw new HttpError(429, 'Finish or delete an existing upload before starting another.');
        const fallback = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g,' ').trim() || 'Untitled book';
        const book = (await client.query(`insert into books
          (title,subject,author,owner_id,is_default,status,status_message,file_type)
          values ($1,$2,$3,$4,false,'processing','Uploading…',$5) returning id`,
        [String(body.title ?? '').trim() || fallback, String(body.subject ?? '').trim() || 'General',
          String(body.author ?? '').trim() || null,userId,extension])).rows[0];
        await client.query('insert into upload_sessions (book_id,user_id,expected_size) values ($1,$2,$3)', [book.id,userId,expected]);
        return { bookId:book.id,fileType:extension,chunkSize:8*1024*1024 };
      });
    },
    async state(bookId, userId) {
      const session = await database.one('select * from upload_sessions where book_id=$1 and user_id=$2', [bookId,userId]);
      if (!session) throw new HttpError(404, 'Upload not found.');
      return publicState(session);
    },
    async append(bookId, userId, bytes, rawOffset) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'Empty chunk.');
      const offset = rawOffset === undefined ? null : Number(rawOffset);
      if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) throw new HttpError(400, 'Invalid upload offset.');
      return database.withTransaction(async (client) => {
        const session = (await client.query('select * from upload_sessions where book_id=$1 and user_id=$2 for update', [bookId,userId])).rows[0];
        if (!session) throw new HttpError(404, 'Upload not found.');
        if (session.status !== 'uploading') throw new HttpError(409, 'This upload is no longer accepting data.');
        const received = Number(session.received_bytes);
        const start = offset ?? received;
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (start < received) {
          const previous = (await client.query('select byte_length,sha256 from upload_chunks where book_id=$1 and byte_offset=$2', [bookId,start])).rows[0];
          if (previous && Number(previous.byte_length) === bytes.length && previous.sha256 === hash) return { received };
        }
        if (start !== received) {
          const error = new HttpError(409, 'The upload offset does not match. Resume at the received offset.');
          error.received = received;
          throw error;
        }
        const next = received + bytes.length;
        if (next > MAX_UPLOAD_BYTES || (session.expected_size !== null && next > Number(session.expected_size))) {
          throw new HttpError(413, 'This chunk would exceed the upload size.');
        }
        await client.query('insert into upload_chunks (book_id,byte_offset,byte_length,sha256,data) values ($1,$2,$3,$4,$5)',
          [bookId,start,bytes.length,hash,bytes]);
        await client.query('update upload_sessions set received_bytes=$2,updated_at=now() where book_id=$1', [bookId,next]);
        return { received:next };
      });
    },
    async finish(bookId, userId) {
      return database.withTransaction(async (client) => {
        const session = (await client.query('select * from upload_sessions where book_id=$1 and user_id=$2 for update', [bookId,userId])).rows[0];
        if (!session) throw new HttpError(404, 'Upload not found.');
        if (['queued','processing','done'].includes(session.status)) return { status:session.status==='done' ? 'ready' : 'processing' };
        if (session.status !== 'uploading') throw new HttpError(409, 'This upload failed. Start a new upload.');
        const received = Number(session.received_bytes);
        if (received === 0 || (session.expected_size !== null && received !== Number(session.expected_size))) {
          const error = new HttpError(409, 'The upload is incomplete. Upload the remaining bytes first.');
          error.received = received;
          throw error;
        }
        await client.query("update upload_sessions set status='queued',updated_at=now() where book_id=$1", [bookId]);
        await client.query("update books set status='processing',status_message='Processing…' where id=$1 and owner_id=$2", [bookId,userId]);
        return { status:'processing' };
      });
    },
  };
}

export function registerUploadRoutes(app, { database = defaultDatabase } = {}) {
  const service = createUploadService(database);
  app.post('/api/uploads', wrap(async (req,res) => { res.status(201).json(await service.create(req.user.id,req.body ?? {})); }));
  app.get('/api/uploads/:bookId', wrap(async (req,res) => { res.json(await service.state(req.params.bookId,req.user.id)); }));
  app.put('/api/uploads/:bookId/chunk', express.raw({ type:()=>true,limit:'16mb' }),
    wrap(async (req,res) => { res.json(await service.append(req.params.bookId,req.user.id,req.body,req.headers['x-upload-offset'])); }));
  app.post('/api/uploads/:bookId/finish', wrap(async (req,res) => { res.status(202).json(await service.finish(req.params.bookId,req.user.id)); }));
}

/** Database leases and byte chunks survive container restarts; temp files are disposable. */
export function createUploadWorker({ database = defaultDatabase, processFile = ingestFileFromPath, tempDir = TEMP_DIR,
  intervalMs = 2000, leaseMs = LEASE_MS } = {}) {
  let running = false;
  let stopped = false;
  let timer;
  let lastCleanup = 0;
  let activeTask;
  async function cleanup() {
    await database.withTransaction(async (client) => {
      const abandoned = (await client.query(`update upload_sessions set status='error',updated_at=now()
        where status='uploading' and updated_at < now()-interval '24 hours' returning book_id`)).rows;
      for (const row of abandoned) await client.query("update books set status='error',status_message='The upload expired. Please try again.' where id=$1 and status='processing'", [row.book_id]);
      await client.query("delete from upload_chunks where book_id in (select book_id from upload_sessions where status in ('done','error'))");
      await client.query("delete from upload_sessions where status in ('done','error') and updated_at < now()-interval '7 days'");
    });
    // A crashed process may leave reconstructed files; PostgreSQL holds the originals.
    for (const entry of await readdir(tempDir).catch(() => [])) {
      if (!/^[a-f0-9-]{36}-[a-f0-9-]{36}\.upload$/.test(entry)) continue;
      const candidate = path.join(tempDir,entry);
      const info = await stat(candidate).catch(()=>null);
      if (info && Date.now()-info.mtimeMs > 24*60*60*1000) await unlink(candidate).catch(()=>{});
    }
  }
  async function runOnce() {
    if (running || stopped) return false;
    running = true;
    let lease;
    let filePath;
    let heartbeat;
    try {
      if (Date.now()-lastCleanup > 60_000) { await cleanup(); lastCleanup=Date.now(); }
      lease = await database.withTransaction(async (client) => {
        const session = (await client.query(`select u.*,b.file_type from upload_sessions u join books b on b.id=u.book_id
          where u.status='queued' or (u.status='processing' and u.lease_at < now()-($1::int * interval '1 millisecond'))
          order by u.updated_at for update of u skip locked limit 1`, [leaseMs])).rows[0];
        if (!session) return null;
        if (session.attempts >= 3) {
          await client.query("update upload_sessions set status='error',updated_at=now() where book_id=$1", [session.book_id]);
          await client.query("update books set status='error',status_message='Processing was interrupted. Please upload again.' where id=$1", [session.book_id]);
          return null;
        }
        const token = crypto.randomUUID();
        await client.query("update upload_sessions set status='processing',lease_token=$2,lease_at=now(),attempts=attempts+1,updated_at=now() where book_id=$1", [session.book_id,token]);
        return {...session,token};
      });
      if (!lease) return false;
      heartbeat = setInterval(() => {
        void database.query("update upload_sessions set lease_at=now() where book_id=$1 and lease_token=$2 and status='processing'", [lease.book_id,lease.token]).catch(()=>{});
      },Math.max(1000, Math.floor(leaseMs/3)));
      heartbeat.unref?.();
      await mkdir(tempDir,{recursive:true});
      filePath = path.join(tempDir,`${lease.book_id}-${lease.token}.upload`);
      let offset = 0;
      while (offset < Number(lease.received_bytes)) {
        const chunk = await database.one('select data,byte_length from upload_chunks where book_id=$1 and byte_offset=$2', [lease.book_id,offset]);
        if (!chunk || chunk.data.length !== Number(chunk.byte_length)) throw new Error('The persisted upload is incomplete.');
        await appendFile(filePath,chunk.data);
        offset += chunk.data.length;
      }
      if ((await stat(filePath)).size !== Number(lease.received_bytes)) throw new Error('The persisted upload size does not match.');
      await processFile({userId:lease.user_id,bookId:lease.book_id,filePath,fileType:lease.file_type,
        onProgress:async (note)=> { await database.query(`update books set status_message=$2
          where id=$1 and owner_id=$3 and status='processing'
            and exists (select 1 from upload_sessions u where u.book_id=books.id and u.lease_token=$4 and u.status='processing')`,
          [lease.book_id,note,lease.user_id,lease.token]); }});
      await database.withTransaction(async (client) => {
        const finished = await client.query("update upload_sessions set status='done',updated_at=now(),lease_token=null where book_id=$1 and lease_token=$2 returning book_id", [lease.book_id,lease.token]);
        if (finished.rows.length) await client.query('delete from upload_chunks where book_id=$1', [lease.book_id]);
      });
      return true;
    } catch (error) {
      console.error('Durable upload worker failed:',error?.message ?? error);
      if (lease) await database.withTransaction(async (client) => {
        // Transient failures retain chunks for another lease; validation failures stop.
        const retry = !(error?.name === 'IngestError') && Number(lease.attempts)+1 < 3;
        const updated = await client.query("update upload_sessions set status=$3,updated_at=now(),lease_token=null where book_id=$1 and lease_token=$2 returning book_id",
          [lease.book_id,lease.token,retry?'queued':'error']);
        if (updated.rows.length) {
          await client.query('update books set status=$2,status_message=$3 where id=$1 and owner_id=$4',
            [lease.book_id,retry?'processing':'error',retry?'Retrying interrupted processing…':String(error?.message ?? 'Upload failed.').slice(0,500),lease.user_id]);
          if (!retry) await client.query('delete from upload_chunks where book_id=$1', [lease.book_id]);
        }
      }).catch(()=>{});
      return false;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (filePath) await unlink(filePath).catch(()=>{});
      running = false;
    }
  }
  return {
    runOnce,
    start() {
      if (timer || stopped) return;
      activeTask = runOnce();
      timer = setInterval(()=> { if (!running) activeTask=runOnce(); },intervalMs);
      timer.unref?.();
    },
    async stop() { stopped=true; if(timer) clearInterval(timer); await activeTask; },
  };
}
