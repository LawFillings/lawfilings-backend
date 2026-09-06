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

export type QaLanguage = 'en' | 'hi' | 'pa' | 'gu' | 'as' | 'bn' | 'mr' | 'ta' | 'te' | 'kn' | 'ml' | 'or' | 'ur';

const LANGUAGE_NAMES: Record<QaLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
  pa: 'Punjabi',
  gu: 'Gujarati',
  as: 'Assamese',
  bn: 'Bengali',
  mr: 'Marathi',
  ta: 'Tamil',
  te: 'Telugu',
  kn: 'Kannada',
  ml: 'Malayalam',
  or: 'Odia',
  ur: 'Urdu',
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

/**
 * Translates the text of an uploaded document (an Act, a judgment, an order — whatever the
 * caller extracted client-side from a PDF) into the requested language. This is a plain machine
 * translation, not a certified one — the frontend is responsible for showing that caveat
 * prominently next to the output; this function's only job is to produce the best-effort
 * translation faithfully, without summarising, adding commentary, or dropping content.
 *
 * Streams text deltas to `onChunk` as they arrive from the model, rather than returning the full
 * translation only once generation finishes — a full document can take a while to generate, and
 * without this the caller sees nothing at all for that whole stretch.
 */
export async function streamTranslateDocument(
  params: { text: string; targetLanguage: QaLanguage },
  onChunk: (textDelta: string) => void
): Promise<void> {
  const { text, targetLanguage } = params;

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 8192,
    system:
      `Translate the following legal document text into ${LANGUAGE_NAMES[targetLanguage]}. Translate faithfully ` +
      'and completely — do not summarise, omit passages, add commentary, or explain anything. Preserve the ' +
      'original paragraph, numbering, and section structure as closely as the target language allows. Keep ' +
      'proper names, dates, section/case numbers, and citations as they appear in the original unless a ' +
      'standard translated form is unambiguous and widely used. If the text is already in the target language, ' +
      'return it unchanged. Respond with only the translated text — no preamble, no notes, no markdown fencing.',
    messages: [{ role: 'user', content: text }],
  });

  stream.on('text', onChunk);
  await stream.finalMessage();
}

export interface FirExtraction {
  applicantName: string;
  applicantAge: string;
  applicantAddress: string;
  firNumber: string;
  policeStation: string;
  bnsSections: string;
  firFacts: string;
}

const EMPTY_FIR_EXTRACTION: FirExtraction = {
  applicantName: '',
  applicantAge: '',
  applicantAddress: '',
  firNumber: '',
  policeStation: '',
  bnsSections: '',
  firFacts: '',
};

/**
 * Shared plumbing behind every "read a document, fill in these wizard fields" extractor below:
 * call Claude with a schema-demanding system prompt, parse its JSON reply (stripping a markdown
 * fence if present), and fall back to `emptyValue` — with every field defaulted to '' — on any
 * failure, the same "an empty field beats a wrong one" discipline as answerActQuestion.
 */
async function extractStructuredFields<T extends object>(params: {
  text: string;
  systemPrompt: string;
  emptyValue: T;
}): Promise<T> {
  const { text, systemPrompt, emptyValue } = params;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return emptyValue;

  try {
    const parsed = JSON.parse(stripJsonFence(textBlock.text)) as Record<string, string>;
    const defaults = emptyValue as Record<string, string>;
    const result: Record<string, string> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      result[key] = parsed[key] ?? defaults[key];
    }
    return result as T;
  } catch {
    console.error('Failed to parse structured-extraction response:', textBlock.text);
    return emptyValue;
  }
}

/**
 * Pulls the fields the Bail Application wizard's "Case & FIR details" step asks for out of an
 * FIR's text (already extracted client-side from a text-layer PDF — this never sees the file
 * itself). The bail applicant is always the person the FIR names as the accused/suspect, never
 * the complainant/informant — getting that swapped would put the wrong person's details into the
 * application, so the prompt is explicit about it.
 */
export async function extractFirDetails(params: { text: string }): Promise<FirExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_FIR_EXTRACTION,
    systemPrompt:
      'You extract specific fields from the text of an FIR (First Information Report, an Indian police ' +
      'complaint document) for use in a bail application. Respond only with JSON matching this schema: ' +
      '{"applicantName": "string", "applicantAge": "string", "applicantAddress": "string", "firNumber": ' +
      '"string", "policeStation": "string", "bnsSections": "string", "firFacts": "string"}. ' +
      'applicantName/applicantAge/applicantAddress must be the person the FIR names as the ACCUSED or ' +
      'SUSPECT — never the complainant/informant who filed the FIR; a bail application is always filed by ' +
      'or for the accused, so naming the complainant here would be a serious, embarrassing error. If the FIR ' +
      'names more than one accused, use the first one named. bnsSections should list the Bharatiya Nyaya ' +
      'Sanhita (or other) offence sections cited, exactly as written (e.g. "318(4), 336(3)"). firFacts should ' +
      'be a brief plain-language summary of what the FIR alleges, drawn only from the text given. For any ' +
      'field you cannot confidently find in the text, return an empty string for it rather than guessing or ' +
      'inferring — an empty field the user fills in themselves is far better than a wrong one they miss.',
  });
}

export interface JudgeStyleProfile {
  structuralPreference: 'facts_first' | 'law_first' | 'neutral';
  citationDensity: 'high' | 'low' | 'neutral';
  summary: string;
}

const EMPTY_JUDGE_STYLE_PROFILE: JudgeStyleProfile = {
  structuralPreference: 'neutral',
  citationDensity: 'neutral',
  summary: '',
};

/**
 * Analyzes one or more judgments by a specific judge for *writing and procedural* style only —
 * never how the judge tends to rule. That distinction matters: adapting how a filing is
 * structured/phrased for a bench's known drafting preferences is a legitimate, common advocacy
 * practice; profiling how a judge tends to decide on the merits (leniency, grant/dismissal
 * patterns) is not something this platform does, and the prompt refuses it explicitly rather than
 * leaving it to chance. Used to reorder (never rewrite) a draft's already-templated sections — see
 * `applyJudgeStyleToSections` on the frontend.
 */
const STRUCTURAL_PREFERENCES = ['facts_first', 'law_first', 'neutral'] as const;
const CITATION_DENSITIES = ['high', 'low', 'neutral'] as const;

export async function analyzeJudgeStyle(params: { text: string }): Promise<JudgeStyleProfile> {
  const result = await extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_JUDGE_STYLE_PROFILE,
    systemPrompt:
      "You analyze the WRITING and PROCEDURAL style of a judge's own judgments, to help an " +
      'advocate structure a filing the way that judge is accustomed to reading one — never to ' +
      'predict how the judge might rule. Respond only with JSON matching this schema: ' +
      '{"structuralPreference": "facts_first" | "law_first" | "neutral", "citationDensity": ' +
      '"high" | "low" | "neutral", "summary": "string"}. structuralPreference: "facts_first" if ' +
      "the judge's own reasoning typically restates the factual narrative before addressing the " +
      'governing law/precedent; "law_first" if the judge typically leads with the law before ' +
      'applying it to facts; "neutral" if there is no clear consistent pattern, or the text given ' +
      "is too short to tell. citationDensity: \"high\" if the judge's judgments cite precedent or " +
      'statutory provisions extensively and in detail; "low" if citations are sparse or purely ' +
      'functional; "neutral" otherwise. summary must be 2-3 plain sentences describing only ' +
      "observable writing/structural tendencies (tone, formality, how arguments are organised) — " +
      'never comment on sentencing, relief granted or denied, leniency, or any other indication of ' +
      'how this judge tends to rule on the merits; that is out of scope no matter how the text ' +
      'might seem to suggest it. If the text does not clearly support a confident read, use ' +
      '"neutral" for both fields and say so plainly in summary rather than guessing.',
  });

  // extractStructuredFields treats every field as a plain string — validate the two enum fields
  // actually landed on one of the allowed values (Claude could in principle return something
  // else) before trusting the narrower TS type; fall back to 'neutral' rather than pass through
  // an unexpected value, same "empty/safe beats wrong" discipline as every extractor above.
  return {
    structuralPreference: (STRUCTURAL_PREFERENCES as readonly string[]).includes(result.structuralPreference)
      ? result.structuralPreference
      : 'neutral',
    citationDensity: (CITATION_DENSITIES as readonly string[]).includes(result.citationDensity)
      ? result.citationDensity
      : 'neutral',
    summary: result.summary,
  };
}

export interface LegalNoticeSourceExtraction {
  recipientName: string;
  recipientAddress: string;
  subject: string;
  factsNarrative: string;
  demandAction: string;
}

const EMPTY_LEGAL_NOTICE_EXTRACTION: LegalNoticeSourceExtraction = {
  recipientName: '',
  recipientAddress: '',
  subject: '',
  factsNarrative: '',
  demandAction: '',
};

/**
 * Pulls fields for the Legal Notice wizard's "Parties" and "Facts and demand" steps out of a
 * source document, which the user may upload as either (a) the underlying agreement/contract the
 * dispute concerns, or (b) a notice/letter the recipient already sent them. The prompt has to
 * handle both without being told which: for (b), the "recipient" of the notice being drafted is
 * unambiguous — it's whoever sent the received letter. For (a), a plain two-party agreement gives
 * no way to tell which party is "us" and which is the recipient this notice should go to, so the
 * model is told to leave recipientName/recipientAddress blank rather than guess in that case —
 * sending a legal notice to the wrong party is a serious error, not a minor inconvenience.
 */
export async function extractLegalNoticeSourceDetails(params: { text: string }): Promise<LegalNoticeSourceExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_LEGAL_NOTICE_EXTRACTION,
    systemPrompt:
      'You extract fields from a document to help draft an outgoing legal notice. The document given may ' +
      'be EITHER (a) a notice/letter someone already sent the user, which this new notice responds to or ' +
      'follows up on, OR (b) the underlying agreement/contract/invoice the dispute concerns — you are not ' +
      'told which. Respond only with JSON matching this schema: {"recipientName": "string", ' +
      '"recipientAddress": "string", "subject": "string", "factsNarrative": "string", "demandAction": ' +
      '"string"}. recipientName/recipientAddress are whoever the NEW notice should be sent to: if the ' +
      'document is itself a notice/letter (case a), that is unambiguously whoever sent it. If the document ' +
      'is a two-party agreement (case b) with no indication of which party is the user and which is the ' +
      'other side, leave recipientName/recipientAddress EMPTY rather than guessing — sending a legal ' +
      'notice to the wrong party is a serious error, not a minor one. subject is a short line describing ' +
      'the matter (e.g. "Recovery of outstanding dues under Rent Agreement dated ..."). factsNarrative is a ' +
      'brief factual summary of the relationship/dispute drawn only from the text given. demandAction is ' +
      'what the document itself demands or requires — fill this in only if the source document is itself a ' +
      'notice making a demand; for a plain agreement, leave it empty (a fresh notice’s own demand is the ' +
      'user’s decision, not something to infer from a contract). Leave any field empty rather than guess.',
  });
}

export interface OaLoanRecallExtraction {
  loanAgreementPlace: string;
  loanAgreementNo1: string;
  loanAgreementDate1: string;
  defaultDate1: string;
  loanRecallNoticePlace: string;
  loanRecallNoticeDate: string;
  principalAmount: string;
  interestRate: string;
  interestAmount: string;
  totalAmount: string;
  calculationDate: string;
  loanAmount: string;
  sanctionDate: string;
  securityDescription: string;
  npaDate: string;
  propertyDetails: string;
  factsNarrative: string;
  defendantName: string;
  defendantAddress: string;
  /** 'individual' or 'institution' — always one of those two, defaulting to 'individual' if
   *  genuinely unclear, since that's the wizard's own field default. */
  defendantType: string;
}

const EMPTY_OA_LOAN_RECALL_EXTRACTION: OaLoanRecallExtraction = {
  loanAgreementPlace: '',
  loanAgreementNo1: '',
  loanAgreementDate1: '',
  defaultDate1: '',
  loanRecallNoticePlace: '',
  loanRecallNoticeDate: '',
  principalAmount: '',
  interestRate: '',
  interestAmount: '',
  totalAmount: '',
  calculationDate: '',
  loanAmount: '',
  sanctionDate: '',
  securityDescription: '',
  npaDate: '',
  propertyDetails: '',
  factsNarrative: '',
  defendantName: '',
  defendantAddress: '',
  defendantType: 'individual',
};

/**
 * Pulls fields for the DRT OA wizard out of a loan recall/demand notice — typically the richest
 * single document available for this: it usually states the loan agreement number/date, the
 * default date, the outstanding principal/interest, the NPA date, and is addressed to the
 * defaulting borrower (who becomes the OA's defendant). Every *Date field must come back as
 * YYYY-MM-DD (or empty) — the wizard's date inputs are native <input type="date"> fields that
 * silently reject any other format.
 */
export async function extractOaLoanRecallDetails(params: { text: string }): Promise<OaLoanRecallExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_OA_LOAN_RECALL_EXTRACTION,
    systemPrompt:
      'You extract fields from the text of a loan recall/demand notice (sent by a bank/NBFC to a ' +
      'defaulting borrower) for use in a DRT Original Application. Respond only with JSON matching this ' +
      'schema: {"loanAgreementPlace": "string", "loanAgreementNo1": "string", "loanAgreementDate1": ' +
      '"string", "defaultDate1": "string", "loanRecallNoticePlace": "string", "loanRecallNoticeDate": ' +
      '"string", "principalAmount": "string", "interestRate": "string", "interestAmount": "string", ' +
      '"totalAmount": "string", "calculationDate": "string", "loanAmount": "string", "sanctionDate": ' +
      '"string", "securityDescription": "string", "npaDate": "string", "propertyDetails": "string", ' +
      '"factsNarrative": "string", "defendantName": "string", "defendantAddress": "string", ' +
      '"defendantType": "individual | institution"}. defendantName/defendantAddress are the borrower this ' +
      'notice is ADDRESSED TO (the recipient) — never the bank/lender issuing it. defendantType must be ' +
      'exactly "institution" if the defendant\'s name indicates a company/firm/LLP/trust (e.g. contains ' +
      '"Pvt. Ltd.", "LLP", "& Co.", "M/s", "Ltd.", or is otherwise clearly a business entity rather than a ' +
      'named person) and "individual" otherwise — this changes how the OA refers to the opposite party ' +
      'throughout, so get it right rather than defaulting blindly. Every field ending in "Date" (loanAgreementDate1, defaultDate1, ' +
      'loanRecallNoticeDate, calculationDate, sanctionDate, npaDate) MUST be formatted as YYYY-MM-DD if ' +
      'found, or an empty string if not — never any other date format, since these feed native date ' +
      'inputs that silently reject anything else. principalAmount/interestAmount/totalAmount/loanAmount ' +
      'should include the currency figure as written (e.g. "₹12,50,000"). factsNarrative is a brief ' +
      'factual summary of the loan and how the default arose, drawn only from the text given. For any ' +
      'field you cannot confidently find, return an empty string rather than guessing.',
  });
}

export interface TribunalOrderExtraction {
  orderDate: string;
  applicantName: string;
  respondentName: string;
  caseNumber: string;
}

const EMPTY_TRIBUNAL_ORDER_EXTRACTION: TribunalOrderExtraction = {
  orderDate: '',
  applicantName: '',
  respondentName: '',
  caseNumber: '',
};

/**
 * Pulls fields for a Review/Restoration/Section 12A application out of the existing
 * order/judgment the application concerns. Unlike an Appeal (extractAppealOrderDetails), these
 * don't reverse party roles — a review, restoration, or withdrawal is normally sought by
 * continuing in the same role the party already held in the original case, so applicantName/
 * respondentName are simply the order's own two named parties in their original order, not a
 * "who lost" determination. The order date feeds the wizard's deadline calculator where one
 * exists (Review Application); Restoration/Section 12A have no deadline step, so it's still
 * extracted for completeness but may go unused.
 */
export async function extractTribunalOrderDetails(params: { text: string }): Promise<TribunalOrderExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_TRIBUNAL_ORDER_EXTRACTION,
    systemPrompt:
      'You extract fields from the text of a Tribunal/Commission order or judgment, for use in a follow-on ' +
      'application (a review, a restoration, or a withdrawal application) concerning that same order. ' +
      'Respond only with JSON matching this schema: {"orderDate": "string", "applicantName": "string", ' +
      '"respondentName": "string", "caseNumber": "string"}. orderDate is the date the order/judgment was ' +
      'passed or pronounced, formatted YYYY-MM-DD if found or an empty string if not — never any other date ' +
      'format, since this may feed a native date input that silently rejects anything else. applicantName ' +
      'and respondentName are simply the two parties named in the order\'s own cause title, in the same ' +
      'order/roles the order itself uses (the first-named party as applicant, the second as respondent) — ' +
      'do NOT try to determine who "won" or "lost"; unlike an appeal, this application is normally filed by ' +
      'a party continuing in their existing role, not someone switching sides. caseNumber is the order\'s ' +
      'own case number exactly as written (e.g. "OA No. 245/2025", "CP(IB) No. 123/2025"). For any field ' +
      'you cannot confidently find, return an empty string rather than guessing.',
  });
}

export interface OaExtraction {
  bankName: string;
  oaNumber: string;
  defendantName: string;
  defendantAge: string;
  defendantAddress: string;
  allegations: string[];
}

const EMPTY_OA_EXTRACTION: OaExtraction = {
  bankName: '',
  oaNumber: '',
  defendantName: '',
  defendantAge: '',
  defendantAddress: '',
  allegations: [],
};

/**
 * Pulls fields for a DRT Written Statement out of the Original Application (OA) it's replying
 * to. Unlike the other extractors, this one also returns `allegations` — the OA's own key
 * factual averments, as plain sentences without numbering or a "That" prefix (the wizard adds
 * both) — meant to replace the wizard's default 4-item mock allegation list with the real ones
 * from this specific OA, so the para-wise reply actually responds to what was pleaded rather
 * than a generic stand-in. defendantName/defendantAge/defendantAddress are the party the OA is
 * filed AGAINST (who will file this Written Statement) — never the bank/FI applicant.
 */
export async function extractOaDetails(params: { text: string }): Promise<OaExtraction> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1536,
    system:
      'You extract fields from the text of a DRT Original Application (OA), filed by a bank/financial ' +
      'institution against a borrower/guarantor, for use in drafting that defendant\'s Written Statement ' +
      'reply. Respond only with JSON matching this schema: {"bankName": "string", "oaNumber": "string", ' +
      '"defendantName": "string", "defendantAge": "string", "defendantAddress": "string", "allegations": ' +
      '["string", ...]}. bankName is the applicant bank/FI. oaNumber is the OA\'s own case number exactly ' +
      'as written. defendantName/defendantAge/defendantAddress are the party the OA is filed AGAINST (the ' +
      'borrower/guarantor being sued) — never the bank. allegations should be 3-8 of the OA\'s own key ' +
      'factual averments (e.g. loan sanction, default, notice, amount claimed), each as a plain declarative ' +
      'sentence in second person addressed to the defendant (e.g. "A loan of Rs. 10,00,000 was sanctioned ' +
      'to you on 12.03.2023.", "You defaulted on repayment starting 01.09.2024.") — do NOT include a ' +
      'leading number or the word "That"; the app adds both. Only include substantive factual claims, not ' +
      'procedural or jurisdictional boilerplate. If you cannot confidently identify distinguishable numbered ' +
      'allegations, return an empty array rather than inventing generic ones. For any other field you ' +
      'cannot confidently find, return an empty string rather than guessing.',
    messages: [{ role: 'user', content: params.text }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return EMPTY_OA_EXTRACTION;
  try {
    const parsed = JSON.parse(stripJsonFence(textBlock.text)) as Record<string, unknown>;
    return {
      bankName: typeof parsed.bankName === 'string' ? parsed.bankName : '',
      oaNumber: typeof parsed.oaNumber === 'string' ? parsed.oaNumber : '',
      defendantName: typeof parsed.defendantName === 'string' ? parsed.defendantName : '',
      defendantAge: typeof parsed.defendantAge === 'string' ? parsed.defendantAge : '',
      defendantAddress: typeof parsed.defendantAddress === 'string' ? parsed.defendantAddress : '',
      allegations: Array.isArray(parsed.allegations) ? parsed.allegations.filter((a): a is string => typeof a === 'string') : [],
    };
  } catch {
    console.error('Failed to parse OA-extraction response:', textBlock.text);
    return EMPTY_OA_EXTRACTION;
  }
}

export interface ConsumerComplaintExtraction {
  complainantName: string;
  oppositePartyName: string;
  complaintNumber: string;
}

const EMPTY_CONSUMER_COMPLAINT_EXTRACTION: ConsumerComplaintExtraction = {
  complainantName: '',
  oppositePartyName: '',
  complaintNumber: '',
};

/**
 * Pulls fields for a Consumer Commission "Written Version" reply out of the Consumer Complaint
 * it's replying to. complainantName is who filed the original complaint (this filing's own cause
 * title keeps them as "Complainant" throughout, per real Commission convention, regardless of who
 * is filing this reply). oppositePartyName is who the complaint names as the party being
 * complained against (the user filing this reply, typically already known to them, but extracted
 * too so the wizard can confirm/cross-check rather than only relying on what the user types).
 */
export async function extractConsumerComplaintDetails(params: { text: string }): Promise<ConsumerComplaintExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_CONSUMER_COMPLAINT_EXTRACTION,
    systemPrompt:
      'You extract fields from the text of a Consumer Complaint filed before a Consumer Commission, for use ' +
      'in drafting the opposite party\'s "Written Version" reply. Respond only with JSON matching this ' +
      'schema: {"complainantName": "string", "oppositePartyName": "string", "complaintNumber": "string"}. ' +
      'complainantName is whoever filed the complaint. oppositePartyName is whoever the complaint names as ' +
      'the party it is against. complaintNumber is the complaint\'s own case/CP number exactly as written. ' +
      'For any field you cannot confidently find, return an empty string rather than guessing.',
  });
}

export interface AppealOrderExtraction {
  orderDate: string;
  appellantName: string;
  respondentName: string;
  appellantAge: string;
  appellantAddress: string;
}

const EMPTY_APPEAL_ORDER_EXTRACTION: AppealOrderExtraction = {
  orderDate: '',
  appellantName: '',
  respondentName: '',
  appellantAge: '',
  appellantAddress: '',
};

/**
 * Pulls fields for the Appeal wizard out of the order/judgment being appealed against. The order
 * date feeds the wizard's deadline calculator directly — its single most valuable output — so
 * it's worth getting even when nothing else can be confidently extracted. appellantName is NOT
 * simply "whoever the user is" — it has to be whichever of the order's two named parties actually
 * lost/was aggrieved (they're the one who'd file this appeal), determined from the order's own
 * stated outcome. Getting that backwards would misname both parties throughout the appeal, so the
 * model is told to leave both names empty rather than guess when the outcome isn't clear.
 */
export async function extractAppealOrderDetails(params: { text: string }): Promise<AppealOrderExtraction> {
  return extractStructuredFields({
    text: params.text,
    emptyValue: EMPTY_APPEAL_ORDER_EXTRACTION,
    systemPrompt:
      'You extract fields from the text of a judgment/order that is being appealed, for use in filing that ' +
      'appeal. Respond only with JSON matching this schema: {"orderDate": "string", "appellantName": ' +
      '"string", "respondentName": "string", "appellantAge": "string", "appellantAddress": "string"}. ' +
      'orderDate is the date the order/judgment was passed or pronounced, formatted YYYY-MM-DD if found or ' +
      'an empty string if not — never any other date format, since this feeds a native date input that ' +
      'silently rejects anything else. appellantName is whichever of the order\'s two named parties the ' +
      'order\'s own text indicates LOST — the one whose application/petition/suit was dismissed, rejected, ' +
      'or ruled against, since that is who would file this appeal; respondentName is the opposing (winning) ' +
      'party. If the order\'s outcome is mixed, unclear, or you cannot confidently tell which party lost, ' +
      'leave BOTH appellantName and respondentName empty rather than guessing which of the two is which — ' +
      'swapping them would misname both parties throughout the appeal, a serious error, not a minor one. ' +
      'appellantAge/appellantAddress should be filled in only if the order text happens to state them for ' +
      'the losing party (uncommon for a court order to include) — leave empty otherwise. Never guess.',
  });
}

export interface CauseListEntry {
  itemNo: string;
  caseNo: string;
  parties: string;
  advocates: string;
}

const CAUSE_LIST_MODEL = 'claude-haiku-4-5';
// Each model's real output ceiling (confirmed live against the API, not assumed) — a busy court's
// list can run to dozens of matters with long multi-line case numbers/advocate lists, and a
// response cut off mid-JSON by hitting max_tokens silently drops every remaining matter, which is
// worse than the extra cost/latency of asking for the model's full ceiling. Anything above ~32K
// requires a streaming response rather than `messages.create`, hence `callCauseListModel` streams.
const CAUSE_LIST_MODEL_MAX_TOKENS = 64_000;

/**
 * Transcribes every matter listed on a court's daily cause list (one or more PDFs/photos of one)
 * into a structured table. Unlike the extract-* functions above, this reads the source document(s)
 * themselves via vision content blocks — cause-list uploads are frequently scans or phone photos
 * with no text layer, so there's no client-side text-extraction step to lean on first.
 *
 * Accepts more than one source because some tribunals (NCLT, NCLAT) publish a separate PDF per
 * court sitting that day rather than one combined list — the caller fetches whichever PDFs are
 * published for the requested bench/date and this transcribes all of them into one merged table.
 *
 * Deliberately returns every entry it can read rather than trying to pick out only the requesting
 * advocate's own matters — name-matching (spelling variants, associate counsel, firm names) is
 * left to the caller instead of trusting the model to silently filter rows a person might expect
 * to see but that were dropped by an imperfect match.
 */
// Haiku 4.5's 200K context window caps documents at 100 PDF pages (Anthropic's own limit — larger
// only on 1M-context models). Most cause lists are well under that, but some courts (e.g.
// Jharkhand HC's daily list runs 150+ pages) genuinely exceed it — silently truncating would drop
// real matters from the list, which is worse than the extra cost, so this retries the exact same
// request on a bigger-context model rather than ever cutting a document down.
const CAUSE_LIST_LARGE_DOC_MODEL = 'claude-sonnet-5';
const CAUSE_LIST_LARGE_DOC_MODEL_MAX_TOKENS = 128_000;

async function callCauseListModel(
  model: string,
  maxTokens: number,
  sourceBlocks: (Anthropic.DocumentBlockParam | Anthropic.ImageBlockParam)[],
  focusInstruction?: string
) {
  const stream = anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system:
      'You transcribe every matter listed across one or more cause-list documents (they may be several ' +
      'court-wise lists for the same bench and date) into one merged structured table. Respond only with ' +
      'JSON matching this schema: {"entries": [{"itemNo": "string", "caseNo": "string", "parties": ' +
      '"string", "advocates": "string"}]}. Include every row you can read from every document given, in ' +
      'the order they appear — do not filter, summarise, or omit rows because they look unimportant. ' +
      'itemNo is the serial/item number as printed (if any). caseNo is the case/matter number as printed. ' +
      'parties is the party names as printed (e.g. "A vs B"), kept as one string. advocates is the advocate ' +
      'name(s) for the matter as printed, kept as one string — if a row lists advocates for both sides, ' +
      'include both. Read only what is actually printed on the page — never invent or infer a row that is ' +
      'not there, and never guess at illegible text; use an empty string for a field you cannot read rather ' +
      'than guessing. If a document is not a cause list, skip it. If nothing is legible across all documents ' +
      'given, return {"entries": []}.' +
      (focusInstruction ? ` ${focusInstruction}` : ''),
    messages: [
      {
        role: 'user',
        content: [...sourceBlocks, { type: 'text', text: 'Transcribe every cause list given above.' }],
      },
    ],
  });
  return stream.finalMessage();
}

export interface CauseListExtractionResult {
  entries: CauseListEntry[];
  /** Real token counts from the actual API response — logged per-request by the route so real
   *  per-court/per-advocate cost can be worked out from production data later, rather than
   *  guessed at (a real day-one gap: development testing burned real credits with no per-request
   *  breakdown of what actually drove the cost, only Anthropic's own account-wide usage graph). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function extractCauseList(params: {
  sources: { base64: string; mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' }[];
  /** Restricts transcription to one section of a larger merged document (e.g. "only the Supreme
   *  Court's Court No. 5 section") — appended to the system prompt as-is. Every other extraction
   *  call already sends only the relevant document(s), so this is unused outside that one case. */
  focusInstruction?: string;
}): Promise<CauseListExtractionResult> {
  const sourceBlocks: (Anthropic.DocumentBlockParam | Anthropic.ImageBlockParam)[] = params.sources.map((s) =>
    s.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: s.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: s.mediaType, data: s.base64 } }
  );

  let response;
  try {
    response = await callCauseListModel(CAUSE_LIST_MODEL, CAUSE_LIST_MODEL_MAX_TOKENS, sourceBlocks, params.focusInstruction);
  } catch (err) {
    const isPageLimitError = err instanceof Anthropic.APIError && /PDF pages/i.test(err.message);
    if (!isPageLimitError) throw err;
    response = await callCauseListModel(
      CAUSE_LIST_LARGE_DOC_MODEL,
      CAUSE_LIST_LARGE_DOC_MODEL_MAX_TOKENS,
      sourceBlocks,
      params.focusInstruction
    );
  }

  // A response cut off mid-JSON by hitting max_tokens is not "nothing legible" — it's a real
  // matters getting silently dropped, and JSON.parse would fail on it anyway. Caught explicitly
  // (rather than left to fall into the parse-failure branch below) so this specific cause is never
  // confused with a genuinely garbled/unreadable response.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      "This cause list has too many matters to transcribe in one response — please narrow the request (e.g. by court/judge) or try again."
    );
  }

  const usage = {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return { entries: [], ...usage };

  try {
    const parsed = JSON.parse(stripJsonFence(textBlock.text)) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return { entries: [], ...usage };
    return {
      entries: parsed.entries.map((e) => ({
        itemNo: typeof e?.itemNo === 'string' ? e.itemNo : '',
        caseNo: typeof e?.caseNo === 'string' ? e.caseNo : '',
        parties: typeof e?.parties === 'string' ? e.parties : '',
        advocates: typeof e?.advocates === 'string' ? e.advocates : '',
      })),
      ...usage,
    };
  } catch {
    console.error('Failed to parse cause-list extraction response:', textBlock.text);
    return { entries: [], ...usage };
  }
}
