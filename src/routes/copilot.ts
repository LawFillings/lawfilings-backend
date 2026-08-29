import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { copilotLimiter } from '../middleware/rateLimit.js';
import { suggestClauses, checkForDefects, extractFirDetails } from '../services/aiCopilot.js';

export const copilotRouter = Router();

copilotRouter.use(requireAuth);
copilotRouter.use(copilotLimiter);

// Mirrors the section-text cap in routes/lawLibrary.ts — an FIR is a couple of pages at most, so
// this is generous headroom while still bounding the cost of a single call.
const MAX_FIR_TEXT_LENGTH = 20000;

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

/** POST /api/copilot/extract-fir  { text } — text already extracted client-side from a
 *  text-layer FIR PDF; this endpoint never receives or stores the file itself. */
copilotRouter.post('/extract-fir', async (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_FIR_TEXT_LENGTH) {
    return res.status(400).json({ error: `text is too long (max ${MAX_FIR_TEXT_LENGTH} characters)` });
  }

  try {
    const extraction = await extractFirDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('FIR extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});
