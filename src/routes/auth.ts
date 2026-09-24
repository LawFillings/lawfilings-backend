import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { pool } from '../db/pool.js';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';
import { sendPasswordResetEmail } from '../services/email.js';

export const authRouter = Router();

const SESSION_TTL_DAYS = 30;
const PASSWORD_RESET_TTL_MINUTES = 60;
const MIN_PASSWORD_LENGTH = 8;

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

/**
 * POST /api/auth/forgot-password — always answers 200 with the same body whether or not the email
 * exists, so it can't be used to discover which emails have accounts.
 */
authRouter.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const { email, language } = req.body;
  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ error: 'email is required' });
  }

  const { rows } = await pool.query('SELECT id, full_name, email FROM users WHERE email = $1', [email]);
  if (rows.length > 0) {
    const user = rows[0];
    const resetToken = issueToken();
    await pool.query(
      'UPDATE users SET password_reset_token_hash = $1, password_reset_expires_at = $2 WHERE id = $3',
      [hashToken(resetToken), new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000), user.id]
    );
    try {
      await sendPasswordResetEmail(user.email, user.full_name, resetToken, typeof language === 'string' ? language : undefined);
    } catch (err) {
      console.error('Failed to send password reset email', err);
    }
  }

  res.json({ ok: true });
});

/** POST /api/auth/reset-password — single-use token; also signs the account out everywhere. */
authRouter.post('/reset-password', passwordResetLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (typeof token !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `UPDATE users SET password_hash = $1, password_reset_token_hash = NULL, password_reset_expires_at = NULL
     WHERE password_reset_token_hash = $2 AND password_reset_expires_at > now()
     RETURNING id`,
    [passwordHash, hashToken(token)]
  );
  if (rows.length === 0) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }

  await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
  res.json({ ok: true });
});
