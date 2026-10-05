// Authentication: sign-up / sign-in / refresh with scrypt password hashing
// and stateless HMAC-SHA256 tokens (the JWT format, without any dependency).

import crypto from 'node:crypto';

import { one, query } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET ?? '';
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days — students stay signed in

if (!JWT_SECRET) {
  console.error('JWT_SECRET is missing — sign-in tokens cannot be created.');
}

// ── tokens ───────────────────────────────────────────────────────────────────

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function signToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyToken(token) {
  try {
    const [header, body, signature] = String(token).split('.');
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

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const derived = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
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

export function registerAuthRoutes(app) {
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? '');
      const fullName = String(req.body?.full_name ?? '').trim() || null;

      if (!EMAIL_RE.test(email)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ error: 'The password must be at least 6 characters.' });
        return;
      }

      const existing = await one('select id from users where lower(email) = $1', [email]);
      if (existing) {
        res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
        return;
      }

      const created = await one(
        'insert into users (email, password_hash) values ($1, $2) returning id, email',
        [email, hashPassword(password)],
      );
      if (!created) {
        res.status(500).json({ error: 'Could not create your account. Please try again.' });
        return;
      }

      await query(
        `insert into profiles (id, full_name) values ($1, $2)
         on conflict (id) do update set full_name = coalesce(excluded.full_name, profiles.full_name)`,
        [created.id, fullName],
      );

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

  app.post('/api/auth/signin', async (req, res) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password ?? '');

      const user = await one(
        'select id, email, password_hash from users where lower(email) = $1',
        [email],
      );
      if (!user || !verifyPassword(password, user.password_hash)) {
        res.status(401).json({ error: 'Incorrect email or password.' });
        return;
      }

      res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
    } catch (error) {
      console.error('signin failed:', error.message);
      res.status(500).json({ error: 'Could not sign you in. Please try again.' });
    }
  });

  app.post('/api/auth/refresh', requireAuth, async (req, res) => {
    const user = await one('select id, email from users where id = $1', [req.user.id]);
    if (!user) {
      res.status(401).json({ error: 'This account no longer exists.' });
      return;
    }
    res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
  });

  app.get('/api/me', requireAuth, async (req, res) => {
    const user = await one('select id, email from users where id = $1', [req.user.id]);
    if (!user) {
      res.status(401).json({ error: 'This account no longer exists.' });
      return;
    }
    const profile = await one('select * from profiles where id = $1', [user.id]);
    res.json({ user: { id: user.id, email: user.email }, profile });
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
