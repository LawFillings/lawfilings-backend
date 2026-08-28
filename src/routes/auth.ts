import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { pool } from '../db/pool.js';
import { authLimiter } from '../middleware/rateLimit.js';

export const authRouter = Router();

const SESSION_TTL_DAYS = 30;

function issueToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** POST /api/auth/signup */
authRouter.post('/signup', authLimiter, async (req, res) => {
  const { fullName, email, password, role } = req.body;

  if (!fullName || !email || !password || !role) {
    return res.status(400).json({ error: 'fullName, email, password, and role are required' });
  }
  if (!['justice_seeker', 'advocate', 'authorised_agent'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, password_hash, role, verification_status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, full_name, email, role, verification_status`,
    [fullName, email, passwordHash, role, role === 'advocate' ? 'pending' : 'not_applicable']
  );

  const user = rows[0];
  const token = issueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await pool.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    user.id,
    hashToken(token),
    expiresAt,
  ]);

  res.status(201).json({ user, token });
});

/** POST /api/auth/login */
authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { rows } = await pool.query(
    'SELECT id, full_name, email, role, verification_status, password_hash FROM users WHERE email = $1',
    [email]
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = issueToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    user.id,
    hashToken(token),
    expiresAt,
  ]);

  delete user.password_hash;
  res.json({ user, token });
});

/** POST /api/auth/logout — requires Authorization header */
authRouter.post('/logout', async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length);
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  res.status(204).send();
});
