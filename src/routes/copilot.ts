import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { copilotLimiter } from '../middleware/rateLimit.js';
import { suggestClauses, checkForDefects } from '../services/aiCopilot.js';

export const copilotRouter = Router();

copilotRouter.use(requireAuth);
copilotRouter.use(copilotLimiter);

/** POST /api/copilot/suggest-clauses  { caseTypeId, factsEntered } */
copilotRouter.post('/suggest-clauses', async (req, res) => {
  const { caseTypeId, factsEntered } = req.body;
  if (!caseTypeId || !factsEntered) {
    return res.status(400).json({ error: 'caseTypeId and factsEntered are required' });
  }

  const caseTypeResult = await pool.query('SELECT name, governing_law FROM case_types WHERE id = $1', [caseTypeId]);
  if (caseTypeResult.rows.length === 0) return res.status(404).json({ error: 'Case type not found' });

  const clausesResult = await pool.query('SELECT code, title, category FROM clauses WHERE case_type_id = $1', [caseTypeId]);

  try {
    const suggestions = await suggestClauses({
      caseTypeName: caseTypeResult.rows[0].name,
      governingLaw: caseTypeResult.rows[0].governing_law,
      availableClauseCodes: clausesResult.rows,
      factsEntered,
    });
    res.json(suggestions);
  } catch (err) {
    console.error('Clause suggestion failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — it degrades gracefully; drafting can continue without it' });
  }
});

/** POST /api/copilot/check-defects  { caseTypeId, draftContent } */
copilotRouter.post('/check-defects', async (req, res) => {
  const { caseTypeId, draftContent } = req.body;
  if (!caseTypeId || !draftContent) {
    return res.status(400).json({ error: 'caseTypeId and draftContent are required' });
  }

  const caseTypeResult = await pool.query('SELECT name, governing_law FROM case_types WHERE id = $1', [caseTypeId]);
  if (caseTypeResult.rows.length === 0) return res.status(404).json({ error: 'Case type not found' });

  const rulesResult = await pool.query('SELECT resulting_flag FROM complexity_rules WHERE case_type_id = $1', [caseTypeId]);

  try {
    const defects = await checkForDefects({
      caseTypeName: caseTypeResult.rows[0].name,
      governingLaw: caseTypeResult.rows[0].governing_law,
      draftContent,
      knownComplexityFlags: rulesResult.rows.map((r) => r.resulting_flag),
    });
    res.json(defects);
  } catch (err) {
    console.error('Defect check failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — it degrades gracefully; drafting can continue without it' });
  }
});
