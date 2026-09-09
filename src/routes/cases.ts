import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

export const casesRouter = Router();

casesRouter.use(requireAuth);

const CASE_LIST_SELECT = `
  SELECT c.*,
    ct.name AS case_type_name,
    EXISTS (SELECT 1 FROM drafts d WHERE d.case_id = c.id) AS has_draft,
    (SELECT su.status_label FROM status_updates su WHERE su.case_id = c.id ORDER BY su.created_at DESC LIMIT 1) AS latest_status_label,
    (SELECT su.hearing_date FROM status_updates su WHERE su.case_id = c.id AND su.hearing_date >= CURRENT_DATE ORDER BY su.hearing_date ASC LIMIT 1) AS next_hearing_date
  FROM cases c
  LEFT JOIN case_types ct ON ct.id = c.case_type_id
`;

/** GET /api/cases — cases owned by the authenticated user */
casesRouter.get('/', async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    `${CASE_LIST_SELECT} WHERE c.owner_id = $1 ORDER BY c.created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

/** POST /api/cases — create a new case (starts a wizard) */
casesRouter.post('/', async (req: AuthedRequest, res) => {
  const { forumId, caseTypeId, title, ownerRole, parentCaseId, roleInProceeding } = req.body;

  if (!title || !ownerRole) {
    return res.status(400).json({ error: 'title and ownerRole are required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO cases (owner_id, owner_role, forum_id, case_type_id, parent_case_id, title, role_in_proceeding)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'applicant'))
       RETURNING *`,
      [req.userId, ownerRole, forumId ?? null, caseTypeId ?? null, parentCaseId ?? null, title, roleInProceeding]
    );

    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id) VALUES ($1, 'case_created', 'case', $2)`,
      [req.userId, rows[0].id]
    );

    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23503') return res.status(400).json({ error: 'Invalid forumId, caseTypeId, or parentCaseId' });
    console.error('Case creation failed', err);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

/** GET /api/cases/:id — including its drafts */
casesRouter.get('/:id', async (req: AuthedRequest, res) => {
  const caseResult = await pool.query(
    `${CASE_LIST_SELECT} WHERE c.id = $1 AND c.owner_id = $2`,
    [req.params.id, req.userId]
  );
  if (caseResult.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

  const draftsResult = await pool.query('SELECT * FROM drafts WHERE case_id = $1 ORDER BY updated_at DESC', [req.params.id]);
  res.json({ ...caseResult.rows[0], drafts: draftsResult.rows });
});

/** PUT /api/cases/:id — update title and/or case type (partial update: send only what's changing).
 * caseTypeId and customTypeLabel are mutually exclusive — sending either one clears the other, so
 * the frontend should send both keys together (one of them null) whenever the type selection changes. */
casesRouter.put('/:id', async (req: AuthedRequest, res) => {
  const { title, caseTypeId, customTypeLabel } = req.body;
  if (title !== undefined && !title.trim()) {
    return res.status(400).json({ error: 'title cannot be empty' });
  }
  if (title === undefined && caseTypeId === undefined && customTypeLabel === undefined) {
    return res.status(400).json({ error: 'title, caseTypeId, or customTypeLabel is required' });
  }

  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  if (title !== undefined) {
    values.push(title.trim());
    sets.push(`title = $${values.length}`);
  }
  if (caseTypeId !== undefined || customTypeLabel !== undefined) {
    values.push(caseTypeId || null);
    sets.push(`case_type_id = $${values.length}`);
    values.push(customTypeLabel?.trim() || null);
    sets.push(`custom_type_label = $${values.length}`);
  }
  values.push(req.params.id, req.userId);

  try {
    const updated = await pool.query(
      `UPDATE cases SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND owner_id = $${values.length} RETURNING id`,
      values
    );
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

    const { rows } = await pool.query(`${CASE_LIST_SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json(rows[0]);
  } catch (err: any) {
    if (err.code === '23503') return res.status(400).json({ error: 'Invalid caseTypeId' });
    console.error('Case update failed', err);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

/** DELETE /api/cases/:id — cascades to drafts and status_updates via FK */
casesRouter.delete('/:id', async (req: AuthedRequest, res) => {
  try {
    const deleted = await pool.query('DELETE FROM cases WHERE id = $1 AND owner_id = $2 RETURNING id', [
      req.params.id,
      req.userId,
    ]);
    if (deleted.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.status(204).end();
  } catch (err: any) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'This case has other cases linked to it (e.g. an appeal) and cannot be deleted' });
    }
    console.error('Case delete failed', err);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

/** GET /api/cases/:id/status-updates — history for one case */
casesRouter.get('/:id/status-updates', async (req: AuthedRequest, res) => {
  const owned = await pool.query('SELECT 1 FROM cases WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
  if (owned.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

  const { rows } = await pool.query(
    'SELECT * FROM status_updates WHERE case_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json(rows);
});

/** POST /api/cases/:id/status-updates — log a status update (and optionally a hearing date/note) */
casesRouter.post('/:id/status-updates', async (req: AuthedRequest, res) => {
  const { statusLabel, note, hearingDate } = req.body;
  if (!statusLabel) return res.status(400).json({ error: 'statusLabel is required' });

  const owned = await pool.query('SELECT 1 FROM cases WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
  if (owned.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

  const { rows } = await pool.query(
    `INSERT INTO status_updates (case_id, updated_by, status_label, note, hearing_date)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [req.params.id, req.userId, statusLabel, note ?? null, hearingDate ?? null]
  );
  await pool.query('UPDATE cases SET updated_at = now() WHERE id = $1', [req.params.id]);

  res.status(201).json(rows[0]);
});

/** PUT /api/cases/:id/status-updates/:statusUpdateId — edit a status update */
casesRouter.put('/:id/status-updates/:statusUpdateId', async (req: AuthedRequest, res) => {
  const { statusLabel, note, hearingDate } = req.body;
  if (!statusLabel) return res.status(400).json({ error: 'statusLabel is required' });

  const owned = await pool.query('SELECT 1 FROM cases WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
  if (owned.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

  const updated = await pool.query(
    `UPDATE status_updates SET status_label = $1, note = $2, hearing_date = $3
     WHERE id = $4 AND case_id = $5 RETURNING *`,
    [statusLabel, note ?? null, hearingDate ?? null, req.params.statusUpdateId, req.params.id]
  );
  if (updated.rows.length === 0) return res.status(404).json({ error: 'Status update not found' });
  await pool.query('UPDATE cases SET updated_at = now() WHERE id = $1', [req.params.id]);

  res.json(updated.rows[0]);
});

/** DELETE /api/cases/:id/status-updates/:statusUpdateId */
casesRouter.delete('/:id/status-updates/:statusUpdateId', async (req: AuthedRequest, res) => {
  const owned = await pool.query('SELECT 1 FROM cases WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
  if (owned.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

  const deleted = await pool.query('DELETE FROM status_updates WHERE id = $1 AND case_id = $2 RETURNING id', [
    req.params.statusUpdateId,
    req.params.id,
  ]);
  if (deleted.rows.length === 0) return res.status(404).json({ error: 'Status update not found' });
  await pool.query('UPDATE cases SET updated_at = now() WHERE id = $1', [req.params.id]);

  res.status(204).end();
});

const FREE_DRAFTS = 2;

/** POST /api/cases/:id/drafts — create the first draft for a case.
 *  Gated by the uniform tariff: an active subscription means unlimited drafts; otherwise the
 *  first 2 drafts an account ever creates are free, then this returns 402 until they subscribe.
 *  The eligibility check and the free-draft-count increment happen inside one transaction with
 *  the user row locked (SELECT ... FOR UPDATE), so two rapid parallel requests can't both slip
 *  through on the last free draft. */
casesRouter.post('/:id/drafts', async (req: AuthedRequest, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const owned = await client.query('SELECT 1 FROM cases WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (owned.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Case not found' });
    }

    const userRow = await client.query(
      'SELECT subscription_status, free_drafts_used FROM users WHERE id = $1 FOR UPDATE',
      [req.userId]
    );
    const { subscription_status: subscriptionStatus, free_drafts_used: freeDraftsUsed } = userRow.rows[0];
    const hasActiveSubscription = subscriptionStatus === 'active';

    if (!hasActiveSubscription && freeDraftsUsed >= FREE_DRAFTS) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'Your free drafts are used — subscribe to keep drafting.', reason: 'subscription_required' });
    }

    if (!hasActiveSubscription) {
      await client.query('UPDATE users SET free_drafts_used = free_drafts_used + 1 WHERE id = $1', [req.userId]);
    }

    const { rows } = await client.query(
      `INSERT INTO drafts (case_id, title, content) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, title, content]
    );
    await client.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id) VALUES ($1, 'draft_created', 'draft', $2)`,
      [req.userId, rows[0].id]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Draft creation failed', err);
    res.status(500).json({ error: 'Failed to create draft' });
  } finally {
    client.release();
  }
});

/** PUT /api/cases/:id/drafts/:draftId — save draft content, versioning the previous state */
casesRouter.put('/:id/drafts/:draftId', async (req: AuthedRequest, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT * FROM drafts WHERE id = $1', [req.params.draftId]);
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Draft not found' });
    }

    // Archive the current version before overwriting
    await client.query(
      `INSERT INTO draft_versions (draft_id, version, content, edited_by) VALUES ($1, $2, $3, $4)`,
      [req.params.draftId, current.rows[0].version, current.rows[0].content, req.userId]
    );

    const updated = await client.query(
      `UPDATE drafts SET content = $1, version = version + 1, updated_at = now() WHERE id = $2 RETURNING *`,
      [content, req.params.draftId]
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Draft save failed', err);
    res.status(500).json({ error: 'Failed to save draft' });
  } finally {
    client.release();
  }
});
