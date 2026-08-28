import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

export interface AuthedRequest extends Request {
  userId?: string;
  userRole?: string;
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verifies a bearer session token against the sessions table.
 * Tokens are stored as SHA-256 hashes, never in plaintext — the raw token only ever
 * exists in the client's possession and in transit over TLS.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length);

  try {
    const result = await pool.query(
      `SELECT s.user_id, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.userId = result.rows[0].user_id;
    req.userRole = result.rows[0].role;
    next();
  } catch (err) {
    console.error('Auth check failed', err);
    res.status(500).json({ error: 'Internal error during authentication' });
  }
}

/**
 * Gates admin-only routes to a single operator account, identified by email via ADMIN_EMAIL —
 * there's no admin role in the schema, since this platform has exactly one operator today. Must
 * run after requireAuth so req.userId is already set. Revisit as a real role/permission if a
 * second admin is ever needed.
 */
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!process.env.ADMIN_EMAIL) {
    return res.status(503).json({ error: 'Admin access is not configured on this server' });
  }
  try {
    const result = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0 || result.rows[0].email !== process.env.ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    console.error('Admin check failed', err);
    res.status(500).json({ error: 'Internal error during authentication' });
  }
}
