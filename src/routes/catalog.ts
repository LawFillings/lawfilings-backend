import { Router } from 'express';
import { pool } from '../db/pool.js';

export const catalogRouter = Router();

/** GET /api/forums */
catalogRouter.get('/forums', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM forums ORDER BY name');
  res.json(rows);
});

/** GET /api/case-types?forumType=DRT */
catalogRouter.get('/case-types', async (req, res) => {
  const { forumType } = req.query;
  const query = forumType
    ? pool.query('SELECT * FROM case_types WHERE forum_type = $1 ORDER BY name', [forumType])
    : pool.query('SELECT * FROM case_types ORDER BY forum_type, name');
  const { rows } = await query;
  res.json(rows);
});

/** GET /api/case-types/:id/clauses */
catalogRouter.get('/case-types/:id/clauses', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clauses WHERE case_type_id = $1', [req.params.id]);
  res.json(rows);
});

/** GET /api/case-types/:id/complexity-rules */
catalogRouter.get('/case-types/:id/complexity-rules', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM complexity_rules WHERE case_type_id = $1', [req.params.id]);
  res.json(rows);
});
