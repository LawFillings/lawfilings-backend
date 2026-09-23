import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { advocateInquiryLimiter } from '../middleware/rateLimit.js';

export const advocatesRouter = Router();

const MAX_FORUMS = 12;
const MAX_LANGUAGES = 15;
const MAX_BIO_LENGTH = 800;
const MAX_MESSAGE_LENGTH = 2000;

function sanitizeStringArray(value: unknown, max: number, itemMaxLength = 40): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v.trim() || v.length > itemMaxLength) return null;
    out.push(v.trim());
  }
  return [...new Set(out)];
}

const PUBLIC_PROFILE_SELECT = `
  SELECT u.id, u.full_name AS "fullName", u.bar_council_no AS "barCouncilNo", u.bar_state AS "barState",
         ap.city, ap.practice_state AS "practiceState", ap.practice_forums AS "practiceForums",
         ap.languages, ap.bio, ap.practicing_since_year AS "practicingSinceYear"
  FROM advocate_profiles ap
  JOIN users u ON u.id = ap.user_id
  WHERE ap.listed = true AND u.verification_status = 'verified'
`;

/** GET /api/advocates — public directory. Never selects email/phone: contact happens by sending
 *  an inquiry (POST below), which carries the SENDER's contact to the advocate, not the reverse. */
advocatesRouter.get('/', async (req, res) => {
  const { forumType, state, language } = req.query;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (typeof forumType === 'string' && forumType) {
    params.push(forumType);
    clauses.push(`$${params.length} = ANY(ap.practice_forums)`);
  }
  if (typeof state === 'string' && state) {
    params.push(state);
    clauses.push(`ap.practice_state = $${params.length}`);
  }
  if (typeof language === 'string' && language) {
    params.push(language);
    clauses.push(`$${params.length} = ANY(ap.languages)`);
  }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `${PUBLIC_PROFILE_SELECT}${where} ORDER BY ap.practicing_since_year ASC NULLS LAST, u.full_name ASC`,
    params
  );
  res.json(rows);
});

/** GET /api/advocates/:id — a single listed advocate's public profile, for the directory's own
 *  profile/contact page. 404s (rather than revealing existence) for anyone not currently listed. */
advocatesRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`${PUBLIC_PROFILE_SELECT} AND u.id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'No such advocate listing' });
  res.json(rows[0]);
});

advocatesRouter.use(requireAuth);

/** GET /api/advocates/me/profile — the logged-in advocate's own directory profile (including
 *  `listed`, which the public routes above never expose), defaulted if they've never saved one. */
advocatesRouter.get('/me/profile', async (req: AuthedRequest, res) => {
  if (req.userRole !== 'advocate') return res.status(403).json({ error: 'Advocate accounts only' });
  const { rows } = await pool.query(
    `SELECT city, practice_state AS "practiceState", practice_forums AS "practiceForums",
            languages, bio, practicing_since_year AS "practicingSinceYear", listed
     FROM advocate_profiles WHERE user_id = $1`,
    [req.userId]
  );
  const profile =
    rows[0] ?? { city: null, practiceState: null, practiceForums: [], languages: [], bio: null, practicingSinceYear: null, listed: false };

  // A cheap, real suggestion for the "pre-fill, don't force" listing editor: forums this advocate
  // has actually drafted a filing in on LawFilings itself — not asked of them, just observed.
  // Always computed (it's one indexed query) so the frontend can offer it even on a first visit.
  const { rows: forumRows } = await pool.query(
    `SELECT DISTINCT ct.forum_type AS "forumType"
     FROM cases c JOIN case_types ct ON ct.id = c.case_type_id
     WHERE c.owner_id = $1 AND ct.forum_type IS NOT NULL`,
    [req.userId]
  );

  res.json({ ...profile, suggestedForums: forumRows.map((r) => r.forumType) });
});

/** PUT /api/advocates/me/profile — upsert. Refuses to set listed=true unless the account is
 *  currently verified — the one gate on who can appear in the public directory. */
advocatesRouter.put('/me/profile', async (req: AuthedRequest, res) => {
  if (req.userRole !== 'advocate') return res.status(403).json({ error: 'Advocate accounts only' });

  const { city, practiceState, practiceForums, languages, bio, practicingSinceYear, listed } = req.body;
  const forums = sanitizeStringArray(practiceForums, MAX_FORUMS);
  const langs = sanitizeStringArray(languages, MAX_LANGUAGES, 5);
  if (forums === null || langs === null) {
    return res.status(400).json({ error: `practiceForums (max ${MAX_FORUMS}) and languages (max ${MAX_LANGUAGES}) must be arrays of short strings` });
  }
  if (bio !== undefined && bio !== null && (typeof bio !== 'string' || bio.length > MAX_BIO_LENGTH)) {
    return res.status(400).json({ error: `bio must be at most ${MAX_BIO_LENGTH} characters` });
  }
  if (
    practicingSinceYear !== undefined &&
    practicingSinceYear !== null &&
    (typeof practicingSinceYear !== 'number' || practicingSinceYear < 1950 || practicingSinceYear > new Date().getFullYear())
  ) {
    return res.status(400).json({ error: 'practicingSinceYear is out of range' });
  }
  if (typeof listed !== 'boolean') {
    return res.status(400).json({ error: 'listed must be a boolean' });
  }

  if (listed) {
    const { rows } = await pool.query('SELECT verification_status FROM users WHERE id = $1', [req.userId]);
    if (rows[0]?.verification_status !== 'verified') {
      return res.status(403).json({ error: 'Only a verified advocate can be listed in the directory' });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO advocate_profiles (user_id, city, practice_state, practice_forums, languages, bio, practicing_since_year, listed, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET
       city = EXCLUDED.city, practice_state = EXCLUDED.practice_state, practice_forums = EXCLUDED.practice_forums,
       languages = EXCLUDED.languages, bio = EXCLUDED.bio, practicing_since_year = EXCLUDED.practicing_since_year,
       listed = EXCLUDED.listed, updated_at = now()
     RETURNING city, practice_state AS "practiceState", practice_forums AS "practiceForums",
               languages, bio, practicing_since_year AS "practicingSinceYear", listed`,
    [req.userId, city || null, practiceState || null, forums, langs, bio || null, practicingSinceYear || null, listed]
  );
  res.json(rows[0]);
});

/** POST /api/advocates/:id/inquiries — any logged-in user sends a message to one listed advocate. */
advocatesRouter.post('/:id/inquiries', advocateInquiryLimiter, async (req: AuthedRequest, res) => {
  const { message, forumType, caseTypeLabel, state } = req.body;
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message is required (max ${MAX_MESSAGE_LENGTH} characters)` });
  }
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: "You can't send an inquiry to yourself" });
  }

  const target = await pool.query(
    `SELECT 1 FROM advocate_profiles ap JOIN users u ON u.id = ap.user_id
     WHERE ap.user_id = $1 AND ap.listed = true AND u.verification_status = 'verified'`,
    [req.params.id]
  );
  if (target.rows.length === 0) {
    return res.status(404).json({ error: 'No such advocate listing' });
  }

  const { rows } = await pool.query(
    `INSERT INTO advocate_inquiries (advocate_id, from_user_id, forum_type, case_type_label, state, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at AS "createdAt"`,
    [req.params.id, req.userId, forumType || null, caseTypeLabel || null, state || null, message.trim()]
  );
  res.status(201).json(rows[0]);
});

/** GET /api/advocates/me/inquiries — the logged-in advocate's own inbox, newest first. Includes
 *  the sender's name/email/phone (whatever they have on file) so the advocate can get back to them. */
advocatesRouter.get('/me/inquiries', async (req: AuthedRequest, res) => {
  if (req.userRole !== 'advocate') return res.status(403).json({ error: 'Advocate accounts only' });
  const { rows } = await pool.query(
    `SELECT ai.id, ai.forum_type AS "forumType", ai.case_type_label AS "caseTypeLabel", ai.state,
            ai.message, ai.status, ai.created_at AS "createdAt",
            u.full_name AS "senderName", u.email AS "senderEmail", u.phone AS "senderPhone"
     FROM advocate_inquiries ai
     JOIN users u ON u.id = ai.from_user_id
     WHERE ai.advocate_id = $1
     ORDER BY ai.created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

/** PATCH /api/advocates/me/inquiries/:id/read */
advocatesRouter.patch('/me/inquiries/:id/read', async (req: AuthedRequest, res) => {
  if (req.userRole !== 'advocate') return res.status(403).json({ error: 'Advocate accounts only' });
  const { rows } = await pool.query(
    `UPDATE advocate_inquiries SET status = 'read' WHERE id = $1 AND advocate_id = $2 RETURNING id`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'No such inquiry' });
  res.status(204).send();
});
