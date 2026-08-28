/**
 * AI drafting copilot service.
 *
 * Two responsibilities, kept deliberately separate:
 *  1. suggestClauses — given case facts, suggest which clauses from the case type's library apply
 *  2. checkForDefects — flag missing mandatory elements, limitation issues, or jurisdiction mismatches
 *
 * Neither function ever tells the user what to do — they surface possibilities and risks for a human
 * (the justice seeker or the advocate) to decide on. This mirrors the platform's core compliance
 * commitment: an AI-assisted drafting aid, not a source of legal advice.
 */
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-5';

/**
 * Claude sometimes wraps JSON responses in a markdown code fence (```json ... ```) even when
 * told to respond with only JSON. Strip that fence, if present, before JSON.parse.
 */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

export interface ClauseSuggestion {
  clauseCode: string;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface DraftDefect {
  severity: 'info' | 'warning' | 'blocking';
  description: string;
  relatedField?: string;
}

/**
 * Suggests which clauses from the case type's library are likely relevant, given the facts
 * entered so far. Returns clause codes the caller looks up against the `clauses` table —
 * this function never invents clause text itself.
 */
export async function suggestClauses(params: {
  caseTypeName: string;
  governingLaw: string;
  availableClauseCodes: { code: string; title: string; category: string }[];
  factsEntered: Record<string, string>;
}): Promise<ClauseSuggestion[]> {
  const { caseTypeName, governingLaw, availableClauseCodes, factsEntered } = params;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You suggest which pre-existing legal clauses apply to a filing, based on facts a user has entered. ' +
      'You do not draft new clause text and you do not give legal advice \u2014 you only select from the ' +
      'clause list provided and explain briefly why each might apply. Respond only with JSON matching ' +
      'the requested schema, no other text.',
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          caseType: caseTypeName,
          governingLaw,
          availableClauses: availableClauseCodes,
          facts: factsEntered,
          responseSchema: [{ clauseCode: 'string', reason: 'string', confidence: 'low | medium | high' }],
        }),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  try {
    return JSON.parse(stripJsonFence(textBlock.text)) as ClauseSuggestion[];
  } catch {
    console.error('Failed to parse clause suggestion response:', textBlock.text);
    return [];
  }
}

/**
 * Checks a draft-in-progress for missing mandatory elements, limitation risk, or jurisdiction
 * mismatches, informed by the case type's complexity_rules. This is additive to — not a
 * replacement for — the hardcoded complexity_rules already in the schema; those remain the
 * authoritative blocking gates. This function catches softer, fact-specific issues rules can't.
 */
export async function checkForDefects(params: {
  caseTypeName: string;
  governingLaw: string;
  draftContent: Record<string, string>;
  knownComplexityFlags: string[];
}): Promise<DraftDefect[]> {
  const { caseTypeName, governingLaw, draftContent, knownComplexityFlags } = params;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You review a legal filing draft for missing mandatory elements, obvious limitation/deadline ' +
      'risk, or jurisdiction mismatches, based only on what is in the draft \u2014 you never assert ' +
      'legal conclusions the user hasn\u2019t supported with facts, and you never give legal advice. ' +
      'Flag concerns, don\u2019t resolve them. Respond only with JSON matching the requested schema.',
    messages: [
      {
        role: 'user',
        content: JSON.stringify({
          caseType: caseTypeName,
          governingLaw,
          draftContent,
          alreadyFlaggedByRules: knownComplexityFlags,
          responseSchema: [{ severity: 'info | warning | blocking', description: 'string', relatedField: 'string (optional)' }],
        }),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  try {
    return JSON.parse(stripJsonFence(textBlock.text)) as DraftDefect[];
  } catch {
    console.error('Failed to parse defect-check response:', textBlock.text);
    return [];
  }
}

export type QaLanguage = 'en' | 'hi';

const LANGUAGE_NAMES: Record<QaLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
};

export interface ActQaSection {
  actShortTitle: string;
  actNumber: string;
  sectionNo: string;
  heading: string;
  text: string;
}

export interface ActQaAnswer {
  answer: string;
  citedSections: { actShortTitle: string; sectionNo: string }[];
  answeredFromProvidedText: boolean;
}

/**
 * Answers a Law Library question strictly from the section text the caller provides — this is
 * the one guarantee the whole Library is built on (see AskTheLibrary.tsx), so the model is
 * instructed to say plainly when the provided sections don't cover the question rather than
 * fill the gap from its own training data. `answeredFromProvidedText: false` is exactly that
 * case — the frontend appends its own "not covered by the sourced text" caveat when it sees it,
 * so the model doesn't need to phrase that itself, just flag it accurately.
 *
 * `sections` is the sole grounding source — there is no distinguished "primary Act" any more;
 * the caller (a single global search box, not a per-Act panel) finds the most relevant sections
 * across the whole Library and passes exactly those.
 */
export async function answerActQuestion(params: {
  sections: ActQaSection[];
  question: string;
  history: { question: string; answer: string }[];
  language?: QaLanguage;
}): Promise<ActQaAnswer> {
  const { sections, question, history, language = 'en' } = params;

  const historyMessages = history.flatMap((turn) => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, content: turn.answer },
  ]);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You answer questions about Indian law using ONLY the Act section text provided in the sections list below — ' +
      'you never use outside knowledge, training data, or general legal knowledge beyond what is given, even if you ' +
      'are confident it is correct. If the provided sections do not contain enough to answer the question, say so ' +
      'plainly instead of guessing or filling the gap — that is a valid, expected answer here, not a failure. ' +
      'You are not a substitute for legal advice and must not present yourself as one. Respond only with JSON matching ' +
      'the schema: {"answer": "string", "citedSections": [{"actShortTitle": "string", "sectionNo": "string"}], ' +
      '"answeredFromProvidedText": boolean}. Set answeredFromProvidedText to true only when the answer is actually ' +
      'supported by the provided section text and cite exactly the sections it draws from; set it to false — with ' +
      `citedSections empty — whenever the provided sections do not cover the question. Write the "answer" field in ` +
      `${LANGUAGE_NAMES[language]}, regardless of what language the section text or the question is in — keep Act ` +
      'names, section numbers, and legal terms of art in their standard form rather than translating those.',
    messages: [
      ...historyMessages,
      {
        role: 'user',
        content: JSON.stringify({ sections, question }),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { answer: 'Something went wrong generating an answer.', citedSections: [], answeredFromProvidedText: false };
  }

  try {
    const parsed = JSON.parse(stripJsonFence(textBlock.text)) as ActQaAnswer;
    return {
      answer: parsed.answer ?? '',
      citedSections: Array.isArray(parsed.citedSections) ? parsed.citedSections : [],
      answeredFromProvidedText: Boolean(parsed.answeredFromProvidedText),
    };
  } catch {
    console.error('Failed to parse Act Q&A response:', textBlock.text);
    return { answer: 'Something went wrong generating an answer.', citedSections: [], answeredFromProvidedText: false };
  }
}

/**
 * Deliberately separate from answerActQuestion above, not a fallback path inside it. That
 * function's entire value is the guarantee that every answer is traceable to verbatim, sourced
 * Act text — blending an ungrounded "best guess" into the same function (or the same-looking
 * response) would quietly erode that guarantee. This is for the general-info mode: draws on the
 * model's own general knowledge of Indian law when a question falls outside what's been sourced
 * into the Library, clearly caveated as unverified rather than presented as equivalent to a
 * grounded answer. The caller is responsible for visually distinguishing the two in the UI.
 */
export async function answerGeneralLegalQuestion(params: {
  question: string;
  history: { question: string; answer: string }[];
  language?: QaLanguage;
}): Promise<{ answer: string }> {
  const { question, history, language = 'en' } = params;

  const historyMessages = history.flatMap((turn) => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, content: turn.answer },
  ]);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system:
      'You answer general questions about Indian law, drawing on your own knowledge — unlike the Library’s ' +
      'primary Q&A tool, this is NOT restricted to specific verified source text, so you may be wrong about a ' +
      'specific section number, a recent amendment, or a repealed/renumbered provision, and you must say so. Every ' +
      'answer must: (1) open with a single brief clause naming that this isn’t verified Library text, then move ' +
      'straight into the substance in that same sentence — e.g. "While there is no verified text in the Library ' +
      'for this, as per unverified sources, Section 5 broadly requires that: …" — never a standalone disclaimer ' +
      'paragraph before the content starts; (2) be clearly hedged where you are not certain, especially about ' +
      'exact section numbers, dates, or whether a provision is still in force; (3) name the specific Act (and ' +
      'section, if identifiable) the question concerns, then point the user to where they can read the actual ' +
      'text themselves — for a central Act, that is indiacode.nic.in (India’s official repository of central ' +
      'legislation); for a matter with its own dedicated ministry portal you are confident about (e.g. ' +
      'incometaxindia.gov.in for tax, mca.gov.in for company law), name that instead. Only name a domain you are ' +
      'actually confident hosts that Act — never invent or guess a specific deep link/URL, since a fabricated ' +
      'link is worse than none; a bare domain name the user can search on themselves is the safe form here; (4) ' +
      'end with a short reminder that this is general information, not verified against primary legal text, and ' +
      'not a substitute for a lawyer’s advice; (5) never claim a false degree of confidence. Write your answer in ' +
      `${LANGUAGE_NAMES[language]}. Respond with plain text, not JSON.`,
    messages: [...historyMessages, { role: 'user', content: question }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return { answer: textBlock?.type === 'text' ? textBlock.text : 'Something went wrong generating an answer.' };
}
