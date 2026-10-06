// Authentication: sign-up / sign-in / refresh with scrypt password hashing
// and stateless HMAC-SHA256 tokens (the JWT format, without any dependency).

import crypto from 'node:crypto';
import { promisify } from 'node:util';

import * as defaultDatabase from './db.js';

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days — students stay signed in

export function assertAuthConfigured() {
  if (!JWT_SECRET.trim()) throw new Error('JWT_SECRET must be configured before starting the API.');
}

// ── tokens ───────────────────────────────────────────────────────────────────

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signToken(userId) {
  assertAuthConfigured();
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyToken(token) {
  if (!JWT_SECRET.trim()) return null;
  try {
    const parts=String(token).split('.');
    if (parts.length!==3) return null;
    const [header, body, signature]=parts;
    if (!header || !body || !signature) return null;

    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload?.sub !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── passwords (scrypt, Node built-in — no native dependencies) ──────────────

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 32, SCRYPT_PARAMS)).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = await scrypt(password, salt, 32, SCRYPT_PARAMS);
    const expected = Buffer.from(hash, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ── middleware ───────────────────────────────────────────────────────────────

/** Attaches `req.user = { id }` or answers 401. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'You must be signed in.' });
    return;
  }
  req.user = { id: payload.sub };
  next();
}

// ── routes ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function createAuthLimiter({maxAttempts=60,maxAccountAttempts=15,maxConcurrent=16,windowMs=15*60*1000,now=Date.now}={}) {
  const attempts=new Map();
  let active=0;
  return (req,res,next)=> {
    const time=now();
    for(const [key,value] of attempts) if(value.until<=time) attempts.delete(key);
    const ip=req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const keys=[['ip:'+ip,maxAttempts],['account:'+normalizeEmail(req.body?.email),maxAccountAttempts]];
    if(active>=maxConcurrent || keys.some(([key,max])=>(attempts.get(key)?.count ?? 0)>=max)) {
      res.set('Retry-After',active>=maxConcurrent?'5':String(Math.ceil(windowMs/1000)));
      res.status(429).json({error:'Too many sign-in attempts. Please try again later.'});
      return;
    }
    for(const [key] of keys) {
      const entry=attempts.get(key) ?? {count:0,until:time+windowMs};
      entry.count++; attempts.set(key,entry);
    }
    active++;
    let released=false;
    const release=()=> { if(!released) {released=true;active=Math.max(0,active-1);} };
    // A disconnected client does not cancel scrypt or database work. Retain
    // the slot until the handler ends its response, including a closed socket.
    const end=res.end;
    res.end=function (...args) {
      try { return end.apply(this,args); }
      finally { release(); }
    };
    res.once('finish',release);
    next();
  };
}

export function registerAuthRoutes(app, { database=defaultDatabase, limiter=createAuthLimiter() }={}) {
  const {one,query,withTransaction}=database;
  app.post('/api/auth/signup', limiter, async (req, res) => {
    try {
      assertAuthConfigured();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? '');
      const fullName = String(req.body?.full_name ?? '').trim() || null;

      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      if (password.length < 6 || password.length > 1024) {
        res.status(400).json({ error: 'The password must be between 6 and 1024 characters.' });
        return;
      }

      const existing = await one('select id from users where lower(email) = $1', [email]);
      if (existing) {
        res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
        return;
      }

      const passwordHash=await hashPassword(password);
      const created=await withTransaction(async (client)=> {
        const user=(await client.query('insert into users(email,password_hash) values ($1,$2) returning id,email',
          [email,passwordHash])).rows[0];
        await client.query('insert into profiles(id,full_name) values ($1,$2)',[user.id,fullName]);
        return user;
      });

      res.status(201).json({
        token: signToken(created.id),
        user: { id: created.id, email: created.email },
        needsConfirmation: false,
      });
    } catch (error) {
      if (error?.code === '23505') {
        res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
        return;
      }
      console.error('signup failed:', error.message);
      res.status(500).json({ error: 'Could not create your account. Please try again.' });
    }
  });

  app.post('/api/auth/signin', limiter, async (req, res) => {
    try {
      assertAuthConfigured();
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? '');
      if(password.length>1024) {res.status(400).json({error:'The password is too long.'});return;}
      const user = await one(
        'select id, email, password_hash from users where lower(email) = $1',
        [email],
      );
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        res.status(401).json({ error: 'Incorrect email or password.' });
        return;
      }

      res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
    } catch (error) {
      console.error('signin failed:', error.message);
      res.status(500).json({ error: 'Could not sign you in. Please try again.' });
    }
  });

  app.post('/api/auth/refresh', requireAuth, async (req,res)=> {
    try {
      const user=await one('select id,email from users where id=$1',[req.user.id]);
      if(!user) {res.status(401).json({error:'This account no longer exists.'});return;}
      res.json({token:signToken(user.id),user:{id:user.id,email:user.email}});
    } catch(error) {
      console.error('token refresh failed:',error?.message ?? error);
      res.status(503).json({error:'Could not refresh your session. Please try again.'});
    }
  });

  app.get('/api/me', requireAuth, async (req,res)=> {
    try {
      const user=await one('select id,email from users where id=$1',[req.user.id]);
      if(!user) {res.status(401).json({error:'This account no longer exists.'});return;}
      const profile=await one('select * from profiles where id=$1',[user.id]);
      res.json({user:{id:user.id,email:user.email},profile});
    } catch(error) {
      console.error('session lookup failed:',error?.message ?? error);
      res.status(503).json({error:'Could not load your session. Please try again.'});
    }
  });

  // Saves the study profile (name, school, exam target + date, …).
  app.put('/api/profile', requireAuth, async (req, res) => {
    try {
      const body = req.body ?? {};
      const allowed = ['full_name', 'school', 'year_of_study', 'country', 'target_exam', 'exam_date'];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (key in body) {
          values.push(body[key] === '' ? null : body[key]);
          sets.push(`${key} = $${values.length}`);
        }
      }
      if (sets.length === 0) {
        res.status(400).json({ error: 'Nothing to update.' });
        return;
      }

      await query(
        `insert into profiles (id) values ($1) on conflict (id) do nothing`,
        [req.user.id],
      );
      values.push(req.user.id);
      const updated = await one(
        `update profiles set ${sets.join(', ')}, updated_at = now()
          where id = $${values.length} returning *`,
        values,
      );
      res.json(updated);
    } catch (error) {
      console.error('profile update failed:', error.message);
      res.status(500).json({ error: 'Could not save your profile. Please try again.' });
    }
  });

  // Deletes the caller's account and every row that belongs to it (FK cascades).
  app.delete('/api/account', requireAuth, async (req, res) => {
    try {
      await query('delete from users where id = $1', [req.user.id]);
      res.json({ ok: true });
    } catch (error) {
      console.error('account deletion failed:', error.message);
      res.status(500).json({ error: 'Could not delete your account. Please try again.' });
    }
  });
}
