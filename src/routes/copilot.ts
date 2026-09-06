import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { copilotLimiter } from '../middleware/rateLimit.js';
import {
  suggestClauses,
  checkForDefects,
  extractFirDetails,
  extractLegalNoticeSourceDetails,
  extractOaLoanRecallDetails,
  extractAppealOrderDetails,
  extractTribunalOrderDetails,
  extractOaDetails,
  extractConsumerComplaintDetails,
  analyzeJudgeStyle,
  streamTranslateDocument,
  type QaLanguage,
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

// Judgments run much longer than the single-document sources the other extractors above read
// (an FIR, a notice), and this route can take more than one — generous enough for 2-3 full
// judgments, bounded enough to keep a single call's cost/latency sane.
const MAX_JUDGE_STYLE_TEXT_LENGTH = 60000;

/** POST /api/copilot/analyze-judge-style  { texts: string[] } — one or more judgments by a
 *  specific judge, each already extracted client-side the same way every other extractor here
 *  reads text (never the file itself). Paid-subscription only — deliberately stricter than the
 *  free-draft allowance in routes/cases.ts (no free-trial fallback here), since this is an
 *  optional, on-demand paid feature rather than the core drafting flow every account gets a
 *  couple of free tries at. */
copilotRouter.post('/analyze-judge-style', async (req: AuthedRequest, res) => {
  const { rows } = await pool.query('SELECT subscription_status FROM users WHERE id = $1', [req.userId]);
  if (rows[0]?.subscription_status !== 'active') {
    return res.status(402).json({ error: 'Judge style analysis is available on a paid plan.', reason: 'subscription_required' });
  }

  const { texts } = req.body;
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((t) => typeof t !== 'string' || !t.trim())) {
    return res.status(400).json({ error: 'texts is required and must be a non-empty array of non-empty strings' });
  }
  const combined = texts.map((t: string) => t.trim()).join('\n\n---\n\n');
  if (combined.length > MAX_JUDGE_STYLE_TEXT_LENGTH) {
    return res.status(400).json({ error: `Combined judgment text is too long (max ${MAX_JUDGE_STYLE_TEXT_LENGTH} characters) — try fewer or shorter judgments` });
  }

  try {
    const profile = await analyzeJudgeStyle({ text: combined });
    res.json(profile);
  } catch (err) {
    console.error('Judge style analysis failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — try again shortly' });
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

/** POST /api/copilot/extract-tribunal-order  { text } — text from the existing order a
 *  Review/Restoration/Section 12A application concerns. */
copilotRouter.post('/extract-tribunal-order', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractTribunalOrderDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('Tribunal order extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

/** POST /api/copilot/extract-oa  { text } — text from the Original Application a Written
 *  Statement is replying to. */
copilotRouter.post('/extract-oa', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractOaDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('OA extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

/** POST /api/copilot/extract-consumer-complaint  { text } — text from the Consumer Complaint a
 *  Written Version is replying to. */
copilotRouter.post('/extract-consumer-complaint', async (req, res) => {
  const text = validateExtractionText(req, res);
  if (text === null) return;

  try {
    const extraction = await extractConsumerComplaintDetails({ text });
    res.json(extraction);
  } catch (err) {
    console.error('Consumer complaint extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please fill in the details manually' });
  }
});

const VALID_TRANSLATE_LANGUAGES: QaLanguage[] = ['en', 'hi', 'pa', 'gu', 'as', 'bn', 'mr', 'ta', 'te', 'kn', 'ml', 'or', 'ur'];

// A machine translation's output runs roughly as long as its input, unlike the /extract-* routes
// above (which read a similar amount of source text but only ever emit a handful of short
// fields) — so this cap is set well below MAX_EXTRACT_TEXT_LENGTH to keep the translated output
// comfortably inside a single response, even for scripts that tokenize less efficiently than
// English.
const MAX_TRANSLATE_TEXT_LENGTH = 12000;

/** POST /api/copilot/translate-document  { text, targetLanguage } — text already extracted
 *  client-side from an uploaded PDF (an Act, a judgment, or similar); the file itself is never
 *  received or stored here. Longer documents are translated only up to the cap; `truncated`
 *  tells the caller whether that happened so it can say so to the user. */
copilotRouter.post('/translate-document', async (req, res) => {
  const { text, targetLanguage } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!VALID_TRANSLATE_LANGUAGES.includes(targetLanguage)) {
    return res.status(400).json({ error: 'targetLanguage must be one of the supported site languages' });
  }

  const truncated = text.length > MAX_TRANSLATE_TEXT_LENGTH;
  const inputText = truncated ? text.slice(0, MAX_TRANSLATE_TEXT_LENGTH) : text;

  // Streamed as plain text so the frontend can render it incrementally instead of waiting for
  // the whole translation to finish generating — `truncated` is already known before generation
  // starts (it only depends on input length), so it goes in a header rather than the body.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Translation-Truncated', String(truncated));

  try {
    await streamTranslateDocument({ text: inputText, targetLanguage: targetLanguage as QaLanguage }, (chunk) => {
      res.write(chunk);
    });
    res.end();
  } catch (err) {
    console.error('Document translation failed', err);
    if (res.headersSent) {
      res.end();
    } else {
      res.status(502).json({ error: 'Translation is unavailable right now — please try again later' });
    }
  }
});
