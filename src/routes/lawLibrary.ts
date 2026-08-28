import { Router } from 'express';
import { pool } from '../db/pool.js';
import { answerActQuestion, answerGeneralLegalQuestion, type ActQaSection, type QaLanguage } from '../services/aiCopilot.js';
import { lawLibraryAiLimiter } from '../middleware/rateLimit.js';

export const lawLibraryRouter = Router();

// This endpoint is deliberately reachable without an account (the Library is free, no login
// needed) — so unlike the copilot routes, request-shape limits matter as much as the rate limit
// itself, since there's no per-user budget backstopping a single request that's unusually large.
// Every request here is a real, billed Anthropic call — a request with 500 sections attached or a
// 50-turn history would cost far more than a normal one even while staying under the hourly cap.
const MAX_SECTIONS = 60;
const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_LENGTH_IN_HISTORY = 4000;
const MAX_SECTION_TEXT_LENGTH = 20000;
const VALID_LANGUAGES: QaLanguage[] = ['en', 'hi', 'pa'];

function parseLanguage(raw: unknown): QaLanguage {
  return VALID_LANGUAGES.includes(raw as QaLanguage) ? (raw as QaLanguage) : 'en';
}

async function logGap(question: string, reason: 'no_search_matches' | 'model_declined') {
  try {
    await pool.query('INSERT INTO library_question_gaps (question, reason) VALUES ($1, $2)', [question, reason]);
  } catch (err) {
    // Never let logging failure break the actual user-facing request that triggered it.
    console.error('Failed to log library question gap', err);
  }
}

/** POST /api/law-library/ask */
lawLibraryRouter.post('/ask', lawLibraryAiLimiter, async (req, res) => {
  const { sections, question, history, language } = req.body ?? {};

  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({ error: `question is too long (max ${MAX_QUESTION_LENGTH} characters)` });
  }
  if (!Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'sections must be a non-empty array' });
  }
  if (sections.length > MAX_SECTIONS) {
    return res.status(400).json({ error: `too many sections (max ${MAX_SECTIONS})` });
  }
  for (const s of sections as ActQaSection[]) {
    if (typeof s?.text !== 'string' || typeof s?.sectionNo !== 'string' || typeof s?.actShortTitle !== 'string') {
      return res.status(400).json({ error: 'each section requires actShortTitle, sectionNo, and text' });
    }
    if (s.text.length > MAX_SECTION_TEXT_LENGTH) {
      return res.status(400).json({ error: `a section's text exceeds the maximum length (${MAX_SECTION_TEXT_LENGTH} characters)` });
    }
  }

  const historyInput = Array.isArray(history) ? history : [];
  if (historyInput.length > MAX_HISTORY_TURNS) {
    return res.status(400).json({ error: `too much conversation history (max ${MAX_HISTORY_TURNS} turns)` });
  }
  for (const turn of historyInput) {
    if (typeof turn?.question !== 'string' || typeof turn?.answer !== 'string') {
      return res.status(400).json({ error: 'each history turn requires question and answer strings' });
    }
    if (turn.answer.length > MAX_ANSWER_LENGTH_IN_HISTORY || turn.question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ error: 'a history turn exceeds the maximum length' });
    }
  }

  try {
    const result = await answerActQuestion({
      sections,
      question,
      history: historyInput,
      language: parseLanguage(language),
    });
    if (!result.answeredFromProvidedText) {
      await logGap(question, 'model_declined');
    }
    res.json(result);
  } catch (err) {
    console.error('Act Q&A failed', err);
    res.status(502).json({ error: 'This tool is unavailable right now — please try again in a moment' });
  }
});

/** POST /api/law-library/log-gap — records a question the client-side search found zero
 *  candidate sections for, so it never even reached /ask. No AI call; just a backlog entry. */
lawLibraryRouter.post('/log-gap', async (req, res) => {
  const { question } = req.body ?? {};
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  await logGap(question.slice(0, MAX_QUESTION_LENGTH), 'no_search_matches');
  res.status(204).end();
});

/** POST /api/law-library/ask-general — the general-info mode: answers from the model's own
 *  knowledge rather than sourced text, for questions the grounded /ask tool couldn't cover. A
 *  separate endpoint (not a fallback branch inside /ask) so the trust distinction stays legible
 *  end to end, not just in the UI. */
lawLibraryRouter.post('/ask-general', lawLibraryAiLimiter, async (req, res) => {
  const { question, history, language } = req.body ?? {};

  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({ error: `question is too long (max ${MAX_QUESTION_LENGTH} characters)` });
  }

  const historyInput = Array.isArray(history) ? history : [];
  if (historyInput.length > MAX_HISTORY_TURNS) {
    return res.status(400).json({ error: `too much conversation history (max ${MAX_HISTORY_TURNS} turns)` });
  }
  for (const turn of historyInput) {
    if (typeof turn?.question !== 'string' || typeof turn?.answer !== 'string') {
      return res.status(400).json({ error: 'each history turn requires question and answer strings' });
    }
    if (turn.answer.length > MAX_ANSWER_LENGTH_IN_HISTORY || turn.question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ error: 'a history turn exceeds the maximum length' });
    }
  }

  try {
    const result = await answerGeneralLegalQuestion({
      question,
      history: historyInput,
      language: parseLanguage(language),
    });
    res.json(result);
  } catch (err) {
    console.error('General legal Q&A failed', err);
    res.status(502).json({ error: 'This tool is unavailable right now — please try again in a moment' });
  }
});
