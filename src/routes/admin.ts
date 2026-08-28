import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, requireAdmin, type AuthedRequest } from '../middleware/auth.js';

export const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(requireAdmin);

/** GET /api/admin/library-gaps — questions the Ask tool couldn't answer from sourced text,
 *  newest first. The prioritized backlog of what to source into the Law Library next. */
adminRouter.get('/library-gaps', async (_req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    'SELECT id, question, reason, created_at FROM library_question_gaps ORDER BY created_at DESC'
  );
  res.json(rows);
});

/** DELETE /api/admin/library-gaps/:id — dismiss a gap once it's been sourced (or judged not
 *  worth sourcing), so the backlog only ever shows what's still outstanding. */
adminRouter.delete('/library-gaps/:id', async (req: AuthedRequest, res) => {
  const deleted = await pool.query('DELETE FROM library_question_gaps WHERE id = $1 RETURNING id', [req.params.id]);
  if (deleted.rows.length === 0) return res.status(404).json({ error: 'Gap not found' });
  res.status(204).end();
});
