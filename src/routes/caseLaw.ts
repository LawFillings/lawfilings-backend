import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { searchCaseLaw } from '../services/indianKanoon.js';

export const caseLawRouter = Router();

caseLawRouter.use(requireAuth);

const DAILY_QUOTA = process.env.INDIAN_KANOON_DAILY_QUOTA_PER_USER
  ? Number(process.env.INDIAN_KANOON_DAILY_QUOTA_PER_USER)
  : 20;

// Maps the category picker in the UI to Indian Kanoon's documented `doctypes` aggregate values
// (https://api.indiankanoon.org/documentation/) — validated against an allow-list since this
// value is passed straight through to an external API call.
const COURT_CATEGORY_DOCTYPES: Record<string, string> = {
  supreme_court: 'supremecourt',
  high_courts: 'highcourts',
  tribunals: 'tribunals',
};

/**
 * POST /api/case-law/search  { query, pageNum? }
 * Live-searches Indian Kanoon. Login-gated and quota-limited (unlike the free curated-precedent
 * endpoint in catalog.ts) because every call has a real cost and the backend has no general
 * rate-limiting to fall back on.
 */
caseLawRouter.post('/search', async (req: AuthedRequest, res) => {
  const { query, pageNum, courtCategory } = req.body;
  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (courtCategory !== undefined && !Object.hasOwn(COURT_CATEGORY_DOCTYPES, courtCategory)) {
    return res.status(400).json({ error: 'Invalid courtCategory' });
  }
  const doctypes = courtCategory ? COURT_CATEGORY_DOCTYPES[courtCategory] : undefined;

  const { rows } = await pool.query(
    `SELECT count(*) FROM audit_log
     WHERE user_id = $1 AND action = 'case_law_search' AND created_at > now() - interval '1 day'`,
    [req.userId]
  );
  if (Number(rows[0].count) >= DAILY_QUOTA) {
    return res.status(429).json({ error: `Daily case-law search limit reached (${DAILY_QUOTA}/day)` });
  }

  try {
    const results = await searchCaseLaw({ query, pageNum, doctypes });
    await pool.query(
      `INSERT INTO audit_log (user_id, action, metadata) VALUES ($1, 'case_law_search', $2)`,
      [req.userId, JSON.stringify({ query, courtCategory })]
    );
    res.json(results);
  } catch (err) {
    console.error('Case law search failed', err);
    res.status(502).json({ error: 'Case law search is unavailable right now — try again shortly' });
  }
});
