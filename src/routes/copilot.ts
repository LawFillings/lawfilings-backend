import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { copilotLimiter } from '../middleware/rateLimit.js';
import {
  suggestClauses,
  checkForDefects,
  extractFirDetails,
  extractLegalNoticeSourceDetails,
  extractOaLoanRecallDetails,
  extractAppealOrderDetails,
} from '../services/aiCopilot.js';

export const copilotRouter = Router();

copilotRouter.use(requireAuth);
copilotRouter.use(copilotLimiter);

// Mirrors the section-text cap in routes/lawLibrary.ts — the source documents these endpoints
// read (an FIR, a notice, a loan recall letter) are a handful of pages at most, so this is
// generous headroom while still bounding the cost of a single call.
const MAX_EXTRACT_TEXT_LENGTH = 20000;

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

/** Every /extract-* route below shares this shape: validate `text` (never a file — extraction
 *  happens client-side), call the matching service function, degrade to 502 on failure. */
function validateExtractionText(req: import('express').Request, res: import('express').Response): string | null {
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return null;
  }
  if (text.length > MAX_EXTRACT_TEXT_LENGTH) {
    res.status(400).json({ error: `text is too long (max ${MAX_EXTRACT_TEXT_LENGTH} characters)` });
    return null;
  }
  return text;
}

/** POST /api/copilot/extract-fir  { text } — text already extracted client-side from a
 *  text-layer FIR PDF; this endpoint never receives or stores the file itself. */
copilotRouter.post('/extract-fir', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractFirDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('FIR extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

/** POST /api/copilot/extract-legal-notice-source  { text } — text from either a source
 *  agreement/contract or a notice already received; see extractLegalNoticeSourceDetails for how
 *  the two are told apart. */
copilotRouter.post('/extract-legal-notice-source', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractLegalNoticeSourceDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('Legal notice source extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

/** POST /api/copilot/extract-oa-loan-recall  { text } — text from a loan recall/demand notice. */
copilotRouter.post('/extract-oa-loan-recall', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractOaLoanRecallDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('OA loan recall notice extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

/** POST /api/copilot/extract-appeal-order  { text } — text from the order/judgment being
 *  appealed against. */
copilotRouter.post('/extract-appeal-order', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractAppealOrderDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('Appeal order extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});
