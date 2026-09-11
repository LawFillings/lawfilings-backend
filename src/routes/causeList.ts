import { Router } from 'express';
import { Agent } from 'undici';
import crypto from 'node:crypto';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { copilotLimiter } from '../middleware/rateLimit.js';
import { requireProTier, checkProBudget } from '../middleware/proBudget.js';
import { extractCauseList, type CauseListEntry } from '../services/aiCopilot.js';
import { pool } from '../db/pool.js';

/** Records one real lookup attempt (success or failure) so per-court/per-advocate cost can be
 *  worked out from real production data once this is live — never awaited by the caller in a way
 *  that could fail the actual response; a logging problem should never break a real lookup. */
async function logCauseListUsage(entry: {
  userId?: string;
  courtId: string;
  date: string;
  source: 'fetch' | 'upload';
  scope?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  entriesCount?: number;
  success: boolean;
  errorMessage?: string;
}): Promise<void> {
  if (!entry.userId) return;
  try {
    await pool.query(
      `INSERT INTO cause_list_usage
         (user_id, court_id, causelist_date, source, scope, model, input_tokens, output_tokens, entries_count, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.userId,
        entry.courtId,
        entry.date,
        entry.source,
        entry.scope ?? null,
        entry.model ?? null,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.entriesCount ?? null,
        entry.success,
        entry.errorMessage ?? null,
      ]
    );
  } catch (err) {
    console.error('Failed to log cause-list usage (non-fatal)', err);
  }
}

/** Thrown by an `AUTO_FETCH_COURTS` entry when the advocate's `scope` (judge name / court-hall
 *  number) is missing or doesn't match anything on the day's list — a user-fixable input problem,
 *  not a "site is down" failure, so the route surfaces this message directly rather than the
 *  generic fetch-failed one. */
class ScopeRequiredError extends Error {}

// Several Indian .gov.in/.nic.in court sites serve an incomplete certificate chain (missing
// intermediate cert) — browsers and curl tolerate this by building the chain from other trusted
// sources, but Node's strict fetch does not, and fails with "unable to verify the first
// certificate". Some of the same sites (confirmed via openssl s_client: Calcutta HC, Bombay HC)
// also disable secure TLS renegotiation, which Node rejects with a bare "fetch failed" even with
// rejectUnauthorized off — SSL_OP_LEGACY_SERVER_CONNECT tolerates that the same way curl does.
// Scoped to only this file's outgoing requests (a fixed, curated list of official court domains
// this route fetches from — never a user-supplied URL), not applied globally, since disabling
// certificate verification for arbitrary requests would be a real security regression.
const relaxedTlsDispatcher = new Agent({
  connect: { rejectUnauthorized: false, secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT },
});

export const causeListRouter = Router();

causeListRouter.use(requireAuth);
causeListRouter.use(copilotLimiter);
// Cause-list is a Pro-only feature (see requireProTier's own comment for why: its per-call cost
// runs far above what the Base tier's price was ever sized to absorb) with a combined monthly
// spend cap shared with document translation, since the real cost driver is $ spent, not calls.
causeListRouter.use(requireProTier);
causeListRouter.use(checkProBudget);

// The larger body-size limit this route needs (a base64 scanned PDF/photo) is applied in
// index.ts, scoped to the /api/cause-list path — see the comment there for why it has to be
// registered ahead of the app-wide express.json() rather than layered on here.
// Kept comfortably under the 15mb express.json() limit (index.ts) rather than Anthropic's own
// 32MB cap — the JSON body also carries courtId/date/mediaType alongside this string, and a
// request that trips the express.json() limit first gets a raw 413 instead of this route's own
// clear, JSON-formatted error, so this check needs to be the one that actually fires.
const MAX_BASE64_LENGTH = 14_000_000;

const ALLOWED_MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

async function fetchWithTimeout(url: string, timeoutMs = 15_000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // @ts-expect-error -- `dispatcher` is a Node/undici-specific fetch extension, not in the
    // standard lib.dom.d.ts RequestInit type, but is a real, supported option at runtime.
    return await fetch(url, { ...init, signal: controller.signal, dispatcher: relaxedTlsDispatcher });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPdfBuffer(url: string, headers?: HeadersInit): Promise<Buffer> {
  const response = await fetchWithTimeout(url, 15_000, headers ? { headers } : undefined);
  if (!response.ok) {
    throw new Error(`Court site returned ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf')) {
    // A captcha page, an empty-list notice, or an error page all come back as HTML — forwarding
    // that to Claude as if it were a PDF would produce a confusing, wrong extraction instead of a
    // clear error, so this is caught here before it ever reaches the model.
    throw new Error('Court site did not return a PDF (list may not be published yet for this date)');
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Fetches every URL and returns only the ones that resolved to a real PDF — a court's own listing
 *  page sometimes links a mix of PDFs and other content (e.g. a broader date match than intended,
 *  or a stale/withdrawn entry), and one bad link shouldn't take down every other genuine result in
 *  the same batch. Throws only if literally none of the URLs produced a PDF. `headers` (e.g. a
 *  session `Cookie`) is passed through unchanged to every URL — only needed by courts whose display
 *  step requires session continuity, like Calcutta HC. */
async function fetchPdfBuffersTolerant(urls: string[], headers?: HeadersInit): Promise<Buffer[]> {
  const results = await Promise.allSettled(urls.map((url) => fetchPdfBuffer(url, headers)));
  const buffers = results.filter((r): r is PromiseFulfilledResult<Buffer> => r.status === 'fulfilled').map((r) => r.value);
  if (buffers.length === 0) {
    throw new Error('No cause list found for this date');
  }
  return buffers;
}

/** Fetches a Drupal "Views" listing page filtered to one bench/court and one date, collects every
 *  distinct PDF link matching `linkPattern` from the result HTML, and fetches all of them — a
 *  bench occasionally publishes more than one PDF for the same day (a main list plus a
 *  supplementary one), and this returns every one found rather than guessing which is "the" list. */
async function fetchDrupalViewsPdfs(url: string, linkPattern: RegExp): Promise<Buffer[]> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Site returned ${response.status}`);
  }
  const html = await response.text();
  const hrefs = new Set<string>();
  for (const match of html.matchAll(linkPattern)) {
    hrefs.add(match[0]);
  }
  if (hrefs.size === 0) {
    throw new Error('No cause list found for this date');
  }
  return fetchPdfBuffersTolerant([...hrefs].map((href) => new URL(href, url).toString()));
}

/** NCLT: `field_nclt_benches_list_target_id` value per bench/court, from the live filter dropdown
 *  at nclt.gov.in/all-cause-list (verified live; excludes value 116 "Registrar NCLT Court-I",
 *  which is an administrative registry listing, not a physical bench). Kolkata Bench Court-I has
 *  a duplicate stale dropdown entry (104 and 138) — 104 is used here. */
const NCLT_BENCH_IDS: Record<string, number> = {
  'nclt-principal-bench': 115,
  'nclt-new-delhi-2': 110,
  'nclt-new-delhi-3': 111,
  'nclt-new-delhi-4': 112,
  'nclt-new-delhi-5': 113,
  'nclt-new-delhi-6': 114,
  'nclt-ahmedabad-1': 88,
  'nclt-ahmedabad-2': 89,
  'nclt-allahabad-1': 90,
  'nclt-amaravati-1': 91,
  'nclt-bengaluru-1': 92,
  'nclt-chandigarh-1': 93,
  'nclt-chandigarh-2': 137,
  'nclt-chennai-1': 94,
  'nclt-chennai-2': 95,
  'nclt-cuttack-1': 96,
  'nclt-guwahati-1': 97,
  'nclt-hyderabad-1': 98,
  'nclt-hyderabad-2': 99,
  'nclt-indore-1': 100,
  'nclt-jaipur-1': 101,
  'nclt-kochi-1': 102,
  'nclt-kolkata-1': 104,
  'nclt-kolkata-2': 103,
  'nclt-kolkata-3': 139,
  'nclt-mumbai-1': 105,
  'nclt-mumbai-2': 106,
  'nclt-mumbai-3': 107,
  'nclt-mumbai-4': 108,
  'nclt-mumbai-5': 109,
  'nclt-mumbai-6': 128,
};

/** NCLAT: `field_court_name_target_id` value per court, from the live filter dropdown at
 *  nclat.nic.in/daily-cause-list (verified live; excludes value 47 "Registrar Court" for the same
 *  reason as NCLT's Registrar entry). */
const NCLAT_BENCH_IDS: Record<string, number> = {
  'nclat-chairperson-court': 42,
  'nclat-court-2': 44,
  'nclat-court-3': 45,
  'nclat-court-4': 46,
  'nclat-chennai': 43,
};

/**
 * Tier-1 "auto-fetch" courts: no captcha, no advocate action needed. Every other court in the
 * frontend catalog is tier-2 (manual upload) and never reaches this file.
 *
 * Only Delhi High Court qualifies for this pilot batch. The Supreme Court was investigated too —
 * `api.sci.gov.in/jonew/cl/{date}/M_R_{n}.pdf` is a real, captcha-free, date-substitutable PDF —
 * but it is the *Registrar's* miscellaneous/admission list for a specific Registrar Court number,
 * not the Judge-wise merits cause list an advocate actually wants; the latter's URL pattern (if
 * one exists) wasn't confirmed. Rather than auto-fetch a narrower list than the name implies, the
 * Supreme Court stays tier-2 (manual) in the frontend catalog until that's resolved.
 */
const AUTO_FETCH_COURTS: Record<
  string,
  {
    /** Fetches the day's PDF(s), forwarded to Claude via `extractCauseList` same as an upload. */
    fetchPdf?: (date: string, scope?: string) => Promise<Buffer[]>;
    /** For courts whose scoped-search response is already structured (not a PDF) — parsed directly
     *  into entries, bypassing `extractCauseList`/Claude entirely. Takes priority over `fetchPdf`
     *  when both are present (neither currently is on the same entry). */
    fetchEntries?: (date: string, scope?: string) => Promise<CauseListEntry[]>;
    /** For a court whose `fetchPdf` always returns the same whole merged document regardless of
     *  scope (fetching a court-specific slice isn't possible at the source) — builds the sentence
     *  telling Claude which section of that document to actually transcribe. */
    buildFocusInstruction?: (scope: string) => string;
  }
> = {
  'delhi-high-court': {
    // Previously scraped the day's cause-list index page for a "combined_cause_list_..." link —
    // but that index only shows the most recent ~10 entries on its first page (paginated), so any
    // date more than a couple of days old was never found even though the real PDF was still live
    // (confirmed live: 2026-09-02, 3 days old, still 200s). Also, that old filename pattern
    // ("combined_cause_list_DD.MM.YYYY_<dow>.pdf") no longer matches anything the site actually
    // publishes — a real naming-convention change since this was written, not just a pagination
    // issue. The current "Cause List of Sitting of Benches" entry (the big, all-benches merged
    // document this is meant to fetch) is now named plainly `c_DDMMYYYY.pdf` (no separators, no
    // day-of-week suffix) — confirmed live across multiple dates — so this constructs that URL
    // directly instead of scraping for it at all.
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}${month}${year}`;
      const pdfUrl = `https://delhihighcourt.nic.in/files/${year}-${month}/cause-list/c_${ddmmyyyy}.pdf`;
      const response = await fetchWithTimeout(pdfUrl);
      if (response.status === 404) {
        throw new Error(`No cause list found for ${date} yet`);
      }
      if (!response.ok) {
        throw new Error(`Court site returned ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('pdf')) {
        throw new Error('Court site did not return a PDF (list may not be published yet for this date)');
      }
      return [Buffer.from(await response.arrayBuffer())];
    },
  },

  // Pure date-substitution — no scrape step needed at all, the PDF's own URL is a direct function
  // of the date. Live-verified.
  'gauhati-high-court': {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const pdfUrl = `https://ghconline.gov.in/NewCList/dl-${day}-${month}-${year}.pdf`;
      return [await fetchPdfBuffer(pdfUrl)];
    },
  },
  'himachal-pradesh-high-court': {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const pdfUrl = `https://highcourt.hp.gov.in/causelistpdf/uploaded_causelist/${year}/pdf/Daily_${day}-${month}-${year}.pdf`;
      return [await fetchPdfBuffer(pdfUrl)];
    },
  },
  // jharkhand-high-court removed: the direct-PDF-URL pattern that used to work (still serves
  // stale pre-migration dates) has been abandoned by the court in favor of the captcha-gated
  // hcservices.ecourts.gov.in portal — confirmed via the site's own current nav link. Moved to
  // 'manual' in the frontend catalog; don't re-add here without re-verifying against a live date.
  // Moved to auto-scoped 2026-09-05: the native calcuttahighcourt.gov.in merged Appellate Side
  // list is 528 pages / 1.5M+ tokens (over Sonnet 5's context window, see project memory), but the
  // site's own "(From CIS)" link goes to a *different*, eCourts-hosted per-bench report
  // (hcservices.ecourts.gov.in) that lists one row per judge/bench with its own small PDF — 14
  // pages / ~150KB for a single-judge bench, confirmed live. No captcha on this specific endpoint
  // (the `refreshCaptcha()` call in its own JS is dead code for an unrelated error path — no
  // captcha element actually exists on the page). Needs a session cookie from the initial GET
  // (confirmed live: the display step 404s with just a Referer, no cookie).
  'calcutta-high-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "Calcutta HC's full Appellate Side list is too large to process — please enter the judge's surname to fetch just their bench's list."
        );
      }
      const searchUrl =
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist.php?state_cd=16&dist_cd=1&court_code=3&stateNm=Calcutta';
      const searchResponse = await fetchWithTimeout(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(`Court site returned ${searchResponse.status}`);
      }
      const cookies = searchResponse.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');

      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;
      const qryResponse = await fetchWithTimeout(
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist_qry.php',
        15_000,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
          body: `action_code=pulishedCauselist&causelist_dt=${ddmmyyyy}&state_code=16&dist_code=1&court_code=3`,
        }
      );
      if (!qryResponse.ok) {
        throw new Error(`Court site returned ${qryResponse.status}`);
      }
      const raw = (await qryResponse.text()).replace(/^﻿/, '');
      if (raw.toUpperCase().startsWith('ERROR') || !raw.trim()) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const scopeLower = scope.trim().toLowerCase();
      const filenames = new Set<string>();
      for (const row of raw.split('^#')) {
        const fields = row.split('~');
        const bench = fields[1]?.replace(/&#039;/g, "'").toLowerCase() ?? '';
        if (!bench.includes(scopeLower)) continue;
        if (fields[4]) filenames.add(fields[4]);
      }
      if (filenames.size === 0) {
        throw new ScopeRequiredError(
          `No judge matching "${scope}" found on today's Calcutta HC cause list — check spelling, or try just the surname.`
        );
      }

      return fetchPdfBuffersTolerant(
        [...filenames].map(
          (filename) => `https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/display_causelist.php?filename=${filename}`
        ),
        { Cookie: cookies }
      );
    },
  },

  // Same eCourts-CIS mechanism as Calcutta above (Manipur's own current nav now points here too,
  // superseding the old hcmimphal.nic.in link, which was blocked by decoy commented-out markup) —
  // confirmed live: 9 benches for a real date, no captcha.
  'manipur-high-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "Please enter the judge's surname to fetch just their bench's list from today's Manipur HC cause list."
        );
      }
      const searchUrl =
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist.php?state_cd=25&dist_cd=1&court_code=1&stateNm=Manipur';
      const searchResponse = await fetchWithTimeout(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(`Court site returned ${searchResponse.status}`);
      }
      const cookies = searchResponse.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');

      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;
      const qryResponse = await fetchWithTimeout(
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist_qry.php',
        15_000,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
          body: `action_code=pulishedCauselist&causelist_dt=${ddmmyyyy}&state_code=25&dist_code=1&court_code=1`,
        }
      );
      if (!qryResponse.ok) {
        throw new Error(`Court site returned ${qryResponse.status}`);
      }
      const raw = (await qryResponse.text()).replace(/^﻿/, '');
      if (raw.toUpperCase().startsWith('ERROR') || !raw.trim()) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const scopeLower = scope.trim().toLowerCase();
      const filenames = new Set<string>();
      for (const row of raw.split('^#')) {
        const fields = row.split('~');
        const bench = fields[1]?.replace(/&#039;/g, "'").toLowerCase() ?? '';
        if (!bench.includes(scopeLower)) continue;
        if (fields[4]) filenames.add(fields[4]);
      }
      if (filenames.size === 0) {
        throw new ScopeRequiredError(
          `No judge matching "${scope}" found on today's Manipur HC cause list — check spelling, or try just the surname.`
        );
      }

      return fetchPdfBuffersTolerant(
        [...filenames].map(
          (filename) => `https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/display_causelist.php?filename=${filename}`
        ),
        { Cookie: cookies }
      );
    },
  },

  // Same eCourts-CIS mechanism as Calcutta/Manipur above. Previously flagged captcha-gated — that
  // check was against thc.nic.in's older Lawazima/Archive Cause List links; the site's current
  // "Main Cause List" link now routes through this eCourts-hosted report instead. Confirmed live:
  // 3 benches for a real date, no captcha.
  'tripura-high-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "Please enter the judge's surname to fetch just their bench's list from today's Tripura HC cause list."
        );
      }
      const searchUrl =
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist.php?state_cd=20&dist_cd=1&court_code=1&stateNm=Tripura';
      const searchResponse = await fetchWithTimeout(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(`Court site returned ${searchResponse.status}`);
      }
      const cookies = searchResponse.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');

      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;
      const qryResponse = await fetchWithTimeout(
        'https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/highcourt_causelist_qry.php',
        15_000,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
          body: `action_code=pulishedCauselist&causelist_dt=${ddmmyyyy}&state_code=20&dist_code=1&court_code=1`,
        }
      );
      if (!qryResponse.ok) {
        throw new Error(`Court site returned ${qryResponse.status}`);
      }
      const raw = (await qryResponse.text()).replace(/^﻿/, '');
      if (raw.toUpperCase().startsWith('ERROR') || !raw.trim()) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const scopeLower = scope.trim().toLowerCase();
      const filenames = new Set<string>();
      for (const row of raw.split('^#')) {
        const fields = row.split('~');
        const bench = fields[1]?.replace(/&#039;/g, "'").toLowerCase() ?? '';
        if (!bench.includes(scopeLower)) continue;
        if (fields[4]) filenames.add(fields[4]);
      }
      if (filenames.size === 0) {
        throw new ScopeRequiredError(
          `No judge matching "${scope}" found on today's Tripura HC cause list — check spelling, or try just the surname.`
        );
      }

      return fetchPdfBuffersTolerant(
        [...filenames].map(
          (filename) => `https://hcservices.ecourts.gov.in/ecourtindiaHC/cases/display_causelist.php?filename=${filename}`
        ),
        { Cookie: cookies }
      );
    },
  },

  // Two-step scrape (Delhi-HC style): the PDF lives under a weekly folder keyed by that week's
  // Monday, which is computable but shifts around holidays — scraping the index page for the
  // day's actual link is safer than reconstructing the folder name. Only the Srinagar wing is
  // covered; the Jammu wing (causelistj.php) presumably mirrors this but wasn't verified.
  'jk-ladakh-high-court-srinagar': {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}${month}${year}`;
      const indexUrl = 'https://jkhighcourt.nic.in/causelistk.php';
      const indexResponse = await fetchWithTimeout(indexUrl);
      if (!indexResponse.ok) {
        throw new Error(`Court site returned ${indexResponse.status}`);
      }
      const html = await indexResponse.text();
      // The site's own links use backslashes as path separators.
      const linkPattern = new RegExp(`\\\\upload\\\\causelist\\\\sgr\\\\[^"'\\s]*causelist_${ddmmyyyy}\\.pdf`, 'i');
      const match = html.match(linkPattern);
      if (!match) {
        throw new Error(`No cause list found for ${date} yet`);
      }
      const pdfUrl = new URL(match[0].replace(/\\/g, '/'), indexUrl).toString();
      return [await fetchPdfBuffer(pdfUrl)];
    },
  },

  // Moved to auto-scoped 2026-09-05: the "Entire List" link this used to fetch is 729 pages (over
  // the platform's absolute 600-page limit, see project memory), but the same search response also
  // lists one row per Court Room with its own small PDF (confirmed live: 6 pages / ~100KB for one
  // room) — no cookie needed for the display step, just the same Referer header already used for
  // the search itself.
  'kerala-high-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "Kerala HC's entire list runs 700+ pages — please enter the Court Room No. to fetch just that room's list."
        );
      }
      const searchUrl = 'https://hckinfo.keralacourts.in/digicourt/index.php/Casedetailssearch/clistbyDate';
      const searchResponse = await fetchWithTimeout(searchUrl, 15_000, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://hckinfo.keralacourts.in/digicourt/Casedetailssearch/viewCauselist',
        },
        body: `clist_date=${encodeURIComponent(date)}`,
      });
      if (!searchResponse.ok) {
        throw new Error(`Court site returned ${searchResponse.status}`);
      }
      const html = await searchResponse.text();
      const rows = html.match(/<tr>[\s\S]*?<\/tr>/gi) ?? [];

      const scopeLower = scope.trim().toLowerCase();
      const links = new Set<string>();
      for (const row of rows) {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
        // The "Court/Room" cell prints as e.g. "3B / 3B" (court and room duplicated with a slash
        // when they match, confirmed live) — split and match either side exactly, not the whole
        // cell, so an advocate typing just "3B" (as the UI asks for) actually matches.
        const courtRoomParts = (cells[2] ?? '').toLowerCase().split('/').map((p) => p.trim());
        if (!courtRoomParts.includes(scopeLower)) continue;
        const linkMatch = row.match(/href="(https:\/\/hckinfo\.keralacourts\.in\/digicourt\/Casedetailssearch\/viewlist\/[^"]+)"/i);
        if (linkMatch) links.add(linkMatch[1].trim());
      }
      if (links.size === 0) {
        throw new ScopeRequiredError(`No Court Room matching "${scope}" found on today's Kerala HC cause list.`);
      }

      return fetchPdfBuffersTolerant([...links], {
        Referer: 'https://hckinfo.keralacourts.in/digicourt/Casedetailssearch/viewCauselist',
      });
    },
  },

  // POST a plain date (no captcha) and get back HTML rows, each carrying a base64-encoded
  // server-side file path in a data-pdfpath attribute (not a public URL by itself) — the same
  // endpoint accepts that value back as a ?path= query param to serve the actual PDF. A date can
  // have more than one row (different courts/list types sitting that day); all are fetched.
  'rajasthan-high-court-jodhpur': {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const searchUrl = 'https://hcraj.nic.in/quick-causelist-jdp/';
      const searchResponse = await fetchWithTimeout(searchUrl, 15_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `day=${Number(day)}&month=${Number(month)}&year=${year}`,
      });
      if (!searchResponse.ok) {
        throw new Error(`Court site returned ${searchResponse.status}`);
      }
      const html = await searchResponse.text();
      const paths = new Set<string>();
      for (const m of html.matchAll(/data-pdfpath='([^']+)'/gi)) {
        paths.add(m[1]);
      }
      if (paths.size === 0) {
        throw new Error(`No cause list found for ${date} yet`);
      }
      // A busy day at this bench can return 20+ distinct court/list-type PDFs, all genuinely dated
      // this day (verified) — some of the returned paths 404/expire server-side independently of
      // that, hence the tolerant fetch rather than Promise.all.
      return fetchPdfBuffersTolerant([...paths].map((p) => `${searchUrl}?path=${encodeURIComponent(p)}`));
    },
  },

  // Three-step POST chain, no captcha at any step — courtNo=-99/location=A requests the "Entire
  // List" (every court combined) rather than one court at a time, so a single request covers the
  // whole day. Step 2 (fetching the court-number dropdown) turned out to be unnecessary — step 3
  // accepts courtNo=-99 directly without it.
  'allahabad-high-court': {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;
      const response = await fetchWithTimeout('https://allahabadhighcourt.in/causelist/viewlistA.jsp', 15_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `courtNo=-99&location=A&listType=Z&listDate=${ddmmyyyy}`,
      });
      if (!response.ok) {
        throw new Error(`Court site returned ${response.status}`);
      }
      const html = await response.text();
      const match = html.match(/href="(https:\/\/www2\.allahabadhighcourt\.in\/clist\/[^"]+\.pdf)"/i);
      if (!match) {
        throw new Error(`No cause list found for ${date} yet`);
      }
      return [await fetchPdfBuffer(match[1])];
    },
  },

  // Bombay HC's full merged daily list runs 2,168+ pages (confirmed live) — far beyond any
  // model's page limit. But the site's own search response is one row per Coram/judge, each with
  // its own small, directly-downloadable PDF — no merge needed if the advocate names their judge.
  // The follow-up POST is CSRF-protected against the session it was issued to (confirmed live: it
  // 419s without replaying the GET's cookies), so this is the one auto-fetch court that needs a
  // session cookie carried between two requests, not just token values.
  'bombay-high-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "Bombay HC's cause list runs 2,000+ pages — please enter the judge's surname to fetch just their courtroom's list."
        );
      }
      const formUrl = 'https://bombayhighcourt.gov.in/bhc/causelistFinal';
      const formResponse = await fetchWithTimeout(formUrl);
      if (!formResponse.ok) {
        throw new Error(`Court site returned ${formResponse.status}`);
      }
      const formHtml = await formResponse.text();
      const cookies = formResponse.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
      const token = formHtml.match(/name="_token" value="([^"]+)"/)?.[1];
      const formSecret = formHtml.match(/name="form_secret" value="([^"]+)"/)?.[1];
      const passphrase = formHtml.match(/name="chkpassphrase" value="([^"]+)"/)?.[1];
      if (!token || !formSecret || !passphrase) {
        throw new Error('Court site form has changed — could not find expected fields');
      }

      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;
      const dataResponse = await fetchWithTimeout('https://bombayhighcourt.gov.in/bhc/causelist/get-data', 15_000, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-TOKEN': token,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: cookies,
        },
        body: new URLSearchParams({
          _token: token,
          form_secret: formSecret,
          chkpassphrase: passphrase,
          m_juris: 'B',
          m_causedt: ddmmyyyy,
        }).toString(),
      });
      if (!dataResponse.ok) {
        throw new Error(`Court site returned ${dataResponse.status}`);
      }
      const data = (await dataResponse.json()) as { status?: boolean; page?: string };
      if (!data.status || !data.page) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const scopeLower = scope.trim().toLowerCase();
      const rows = data.page.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
      const links = new Set<string>();
      for (const row of rows) {
        const coramCell = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '';
        const coramText = coramCell.replace(/<[^>]+>/g, ' ').trim().toLowerCase();
        if (!coramText || !coramText.includes(scopeLower)) continue;
        for (const linkMatch of row.matchAll(/<a href="([^"]+)"[^>]*>\s*(Daily Main|Daily Supplementary)\s*<\/a>/gi)) {
          links.add(linkMatch[1].replace(/&amp;/g, '&'));
        }
      }
      if (links.size === 0) {
        throw new ScopeRequiredError(
          `No judge matching "${scope}" found on today's Bombay HC cause list — check spelling, or try just the surname.`
        );
      }
      return fetchPdfBuffersTolerant([...links]);
    },
  },

  // Karnataka HC's "Search by Court Hall" mode returns clean, already-structured HTML for exactly
  // one hall (confirmed live for Court Hall 5) — parsed directly below, no PDF/Claude call needed.
  // The request itself is a two-step encrypt-then-fetch: the site encrypts a pipe-delimited plain
  // string server-side (no client-side crypto to replicate) and the resulting opaque token is
  // passed back as a query param — no cookies or captcha involved at either step.
  'karnataka-high-court': {
    fetchEntries: async (date, scope) => {
      const hallNo = scope?.trim();
      if (!hallNo) {
        throw new ScopeRequiredError('Karnataka HC requires a Court Hall No. (1–40) to fetch automatically.');
      }
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}/${month}/${year}`;
      const plaintext =
        `flg::2|so::1|bench::B|SearchType::1|keyWord::${hallNo}` + `|fromDt::${ddmmyyyy}|toDt::${ddmmyyyy}|radioc::D`;
      const encryptResponse = await fetchWithTimeout('https://judiciary.karnataka.gov.in/encrypt.php', 15_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `url=${encodeURIComponent(plaintext)}`,
      });
      if (!encryptResponse.ok) {
        throw new Error(`Court site returned ${encryptResponse.status}`);
      }
      const token = (await encryptResponse.text()).trim();
      if (!token) {
        throw new Error('Court site did not return an expected token');
      }
      const listResponse = await fetchWithTimeout(
        `https://judiciary.karnataka.gov.in/causeListSearchResp.php?dataset=${encodeURIComponent(token)}`
      );
      if (!listResponse.ok) {
        throw new Error(`Court site returned ${listResponse.status}`);
      }
      const html = await listResponse.text();
      const rows = html.match(/<tr class="trbor bgcol">[\s\S]*?<\/tr>/gi) ?? [];
      if (rows.length === 0) {
        throw new Error(`No cause list found for Court Hall ${hallNo} on ${date} yet`);
      }

      const cellText = (row: string, label: string): string => {
        const re = new RegExp(`data-label=['"]${label}['"][^>]*>([\\s\\S]*?)<\\/td>`, 'i');
        const raw = row.match(re)?.[1] ?? '';
        return raw
          .replace(/<a[^>]*>/gi, '')
          .replace(/<\/a>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      };

      return rows.map((row, i) => {
        const petitioner = cellText(row, 'Pet\\./Appl\\./Comp\\. & Adv\\.');
        const respondent = cellText(row, 'Resp\\. & Adv\\.');
        return {
          itemNo: cellText(row, 'Sl\\.No\\.') || String(i + 1),
          caseNo: cellText(row, 'Case No\\.'),
          parties: [petitioner, respondent].filter(Boolean).join(' vs '),
          advocates: [petitioner, respondent].filter(Boolean).join(' / '),
        };
      });
    },
  },

  // AP's own "Daily Cause List → Court Wise" flow (aphc.gov.in, a plain JSP/servlet app) is a
  // cookie-less, stateless POST — confirmed live with `credentials: 'omit'` — returning clean,
  // already-structured HTML with `data-label` attributes (same idea as Karnataka above). Previously
  // flagged captcha-gated; that finding doesn't hold up on live retest of this specific flow.
  'andhra-pradesh-high-court': {
    fetchEntries: async (date, scope) => {
      const courtNo = scope?.trim();
      if (!courtNo) {
        throw new ScopeRequiredError('Andhra Pradesh HC requires a Court No. to fetch automatically.');
      }
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;

      const datesResponse = await fetchWithTimeout('https://aphc.gov.in/Hcdbs/getdates.jsp?listtype=D');
      if (!datesResponse.ok) {
        throw new Error(`Court site returned ${datesResponse.status}`);
      }
      const publishedDates = (await datesResponse.text())
        .trim()
        .split('@')
        .map((d) => d.trim());
      if (!publishedDates.includes(ddmmyyyy)) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const listResponse = await fetchWithTimeout('https://aphc.gov.in/Hcdbs/searchtype.action', 15_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `caset=courtsearch&listdate=${ddmmyyyy}&causelisttype=D&court=${encodeURIComponent(courtNo)}`,
      });
      if (!listResponse.ok) {
        throw new Error(`Court site returned ${listResponse.status}`);
      }
      const html = await listResponse.text();
      const rows = (html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).filter((row) => row.includes('data-label="S.No"'));
      if (rows.length === 0) {
        throw new ScopeRequiredError(`No cause list found for Court No. ${courtNo} on ${date} — check the court number.`);
      }

      const cellText = (row: string, label: string): string => {
        const re = new RegExp(`data-label="${label.replace(/\./g, '\\.')}"[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
        const raw = row.match(re)?.[1] ?? '';
        return raw
          .replace(/<a[^>]*>/gi, '')
          .replace(/<\/a>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      return rows.map((row, i) => ({
        itemNo: cellText(row, 'S.No') || String(i + 1),
        caseNo: cellText(row, 'Case Det'),
        parties: cellText(row, 'Party'),
        advocates: [cellText(row, 'Pet Adv'), cellText(row, 'Res Adv')].filter(Boolean).join(' / '),
      }));
    },
  },

  // Same "Daily Cause List → Court Wise" idea as Andhra Pradesh (the two split from one NIC
  // codebase in 2014), but this is a separate, more modern Spring/Thymeleaf app underneath —
  // confirmed live as an equally cookie-less, stateless POST. The response carries leftover dead
  // template comments (unresolved `th:each`/`th:text` blocks wrapped in real HTML comments, never
  // executed) around otherwise-plain rows, so comments are stripped first; cells aren't
  // `data-label`-tagged like Andhra Pradesh's, so this reads them positionally instead (Sl.No /
  // Case / Party / Pet Adv / Res Adv, in that fixed column order).
  'telangana-high-court': {
    fetchEntries: async (date, scope) => {
      const courtInput = scope?.trim();
      if (!courtInput) {
        throw new ScopeRequiredError('Telangana HC requires a Court No. to fetch automatically.');
      }
      const courtNo = /^\d+$/.test(courtInput) ? `COURT NO. ${courtInput}` : courtInput.toUpperCase();
      const [year, month, day] = date.split('-');
      const ddmmyyyy = `${day}-${month}-${year}`;

      const datesResponse = await fetchWithTimeout('https://causelist.tshc.gov.in/showDailyCauseList');
      if (!datesResponse.ok) {
        throw new Error(`Court site returned ${datesResponse.status}`);
      }
      const publishedDates = [...(await datesResponse.text()).matchAll(/<option value="(\d{2}-\d{2}-\d{4})"/g)].map(
        (m) => m[1]
      );
      if (!publishedDates.includes(ddmmyyyy)) {
        throw new Error(`No cause list found for ${date} yet`);
      }

      const listResponse = await fetchWithTimeout('https://causelist.tshc.gov.in/courtWiseView', 15_000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `listDate=${ddmmyyyy}&court=${encodeURIComponent(courtNo)}`,
      });
      if (!listResponse.ok) {
        throw new Error(`Court site returned ${listResponse.status}`);
      }
      const html = (await listResponse.text()).replace(/<!--[\s\S]*?-->/g, '');
      const stripTags = (cell: string): string =>
        cell
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const entries: CauseListEntry[] = [];
      for (const row of html.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []) {
        if (row.includes('colspan="6"')) continue; // section header row (e.g. "FOR PRONOUNCEMENT OF JUDGMENT")
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
        if (cells.length < 5 || !cells[0]) continue;
        entries.push({
          itemNo: cells[0],
          caseNo: cells[1],
          parties: cells[2],
          advocates: [cells[3], cells[4]].filter(Boolean).join(' / '),
        });
      }
      if (entries.length === 0) {
        throw new ScopeRequiredError(`No cause list found for ${courtNo} on ${date} — check the court number.`);
      }
      return entries;
    },
  },

  // The site's newer portal (new.phhc.gov.in) resolves the old highcourtchd.gov.in list-type
  // ambiguity by simply not needing it: its backend (livedb9010.phhc.gov.in) is a plain,
  // cookie-less, captcha-free JSON API, and its `getCauseListByAdvocate` endpoint (confirmed live)
  // returns just one advocate's own matters for the day across every bench directly — already
  // structured, no PDF/Claude call and no judge/bench name-matching needed at all. `scope` is the
  // advocate's Bar Council enrollment number and year, e.g. "1234 2015" or "P-1234/2015".
  'punjab-haryana-high-court': {
    fetchEntries: async (date, scope) => {
      const raw = scope?.trim();
      if (!raw) {
        throw new ScopeRequiredError(
          'Punjab and Haryana HC requires a Bar Council enrollment number and year to fetch automatically.'
        );
      }
      const match = raw.match(/^(.+?)[\s/-]+(\d{4})$/);
      if (!match) {
        throw new ScopeRequiredError(
          `Couldn't read "${raw}" as an enrollment number and year — enter them as e.g. "1234 2015".`
        );
      }
      const [, enrollmentNo, enrollmentYear] = match;

      const url = new URL('https://livedb9010.phhc.gov.in/cis_filing/public/getCauseListByAdvocate');
      url.searchParams.set('cause_list_date', date);
      url.searchParams.set('enrollment_no', enrollmentNo.trim());
      url.searchParams.set('advocate_enrollment_year', enrollmentYear);
      url.searchParams.set('limit', '100');
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) {
        throw new Error(`Court site returned ${response.status}`);
      }
      const records = (await response.json()) as Array<{
        sr_no?: number | string | null;
        case_type?: string | null;
        case_no?: string | null;
        case_year?: number | null;
        pet_name?: string | null;
        res_name?: string | null;
        pet_adv_name?: string | null;
        res_adv_name?: string | null;
        adv_name?: string | null;
      }>;
      if (records.length === 0) {
        throw new ScopeRequiredError(
          `No matters found on today's Punjab and Haryana HC cause list for enrollment no. "${enrollmentNo.trim()}/${enrollmentYear}" — check the number and year.`
        );
      }
      return records.map((r, i) => ({
        itemNo: r.sr_no != null ? String(r.sr_no) : String(i + 1),
        caseNo: [r.case_type, r.case_no, r.case_year].filter(Boolean).join('/'),
        parties: [r.pet_name, r.res_name].filter(Boolean).join(' vs '),
        advocates: [r.pet_adv_name, r.res_adv_name, r.adv_name].filter(Boolean).join(' / '),
      }));
    },
  },

  // Supreme Court publishes one merged, all-courts Judge-wise PDF per day (not a per-court-number
  // resource like Bombay/Karnataka) — confirmed live: 234 pages for a Miscellaneous day, 73 for a
  // Regular-hearing day, well within Sonnet 5's 600-page cap either way, so no splitting is needed.
  // Each court's matters sit under their own "COURT NO. : N" heading (Court No. 1 is headed
  // "CHIEF JUSTICE'S COURT" instead) in one continuous, ascending-order document — so instead of
  // fetching a narrower resource, this fetches the same whole PDF every time and tells Claude via
  // `buildFocusInstruction` to only transcribe the requested court's section. This is exactly the
  // scenario that kept Supreme Court off auto-fetch before: a real, working court-number endpoint
  // existed (the Registrar's `M_R_{n}.pdf`) but auto-picking one court without being asked would
  // misrepresent a narrow slice as "the" Supreme Court list — moot once the advocate names one.
  'supreme-court': {
    fetchPdf: async (date, scope) => {
      if (!scope?.trim()) {
        throw new ScopeRequiredError(
          "The Supreme Court's merged list covers every court and runs 200+ pages — please enter a Court No. to narrow it down."
        );
      }
      // Previously scraped `https://www.sci.gov.in/cause-list/` for a link matching the exact
      // date — but that index only ever displays a forward-looking window of upcoming dates (a
      // handful of days out), never past ones, so any date more than a couple of days old always
      // failed here even though the PDF itself was still live at its own predictable URL
      // (confirmed live: .../2026-09-02/M_J_1.pdf still 200s three days after publication, with no
      // link to it anywhere on the current index page). The main merged list lives at a fixed
      // `.../jonew/cl/{date}/[M|F]_J_1.pdf` path (M for a Miscellaneous-hearing day, F for
      // Regular), so this now probes both prefixes directly instead of depending on what the index
      // happens to be showing today. Also fixes a second, latent bug: some days genuinely publish
      // *both* an M and an F list (confirmed live for 2026-09-01) — the old single `html.match()`
      // would have silently picked only whichever appeared first in the scraped page, missing the
      // other list type's matters entirely; this fetches every prefix that actually exists.
      const candidateUrls = ['M', 'F'].map((prefix) => `https://api.sci.gov.in/jonew/cl/${date}/${prefix}_J_1.pdf`);
      const existing = (
        await Promise.all(
          candidateUrls.map(async (url) => {
            const response = await fetchWithTimeout(url, 15_000, { method: 'HEAD' });
            return response.ok ? url : null;
          })
        )
      ).filter((url): url is string => url !== null);
      if (existing.length === 0) {
        throw new Error(`No cause list found for ${date} yet`);
      }
      return fetchPdfBuffersTolerant(existing);
    },
    buildFocusInstruction: (scope) => {
      const heading = scope.trim() === '1' ? "CHIEF JUSTICE'S COURT" : `COURT NO. : ${scope.trim()}`;
      return (
        `This document merges every court's cause list for the day. Only transcribe matters listed ` +
        `under the heading "${heading}" — skip every other court's section entirely. If no section ` +
        `with that heading exists in the document, return {"entries": []}.`
      );
    },
  },
};

for (const [courtId, benchId] of Object.entries(NCLT_BENCH_IDS)) {
  // NCLT's own date filter expects MM/DD/YYYY (confirmed live against its actual <input> field
  // description and by testing a real query), unlike everything else on this platform which uses
  // ISO YYYY-MM-DD — converted here, once, rather than at every call site.
  AUTO_FETCH_COURTS[courtId] = {
    fetchPdf: async (date) => {
      const [year, month, day] = date.split('-');
      const mmddyyyy = `${month}/${day}/${year}`;
      const url =
        'https://nclt.gov.in/all-cause-list' +
        `?field_nclt_benches_list_target_id=${benchId}` +
        `&field_cause_date_value=${encodeURIComponent(mmddyyyy)}` +
        `&field_cause_date_value_1=${encodeURIComponent(mmddyyyy)}`;
      return fetchDrupalViewsPdfs(url, /\/sites\/default\/files\/pdf_cause_list\/[^"'\s]+\.pdf/gi);
    },
  };
}

for (const [courtId, courtNameId] of Object.entries(NCLAT_BENCH_IDS)) {
  // NCLAT's date filter expects ISO YYYY-MM-DD (its <input type="date"> declares
  // data-drupal-date-format="Y-m-d") — the platform's own date format already, no conversion.
  AUTO_FETCH_COURTS[courtId] = {
    fetchPdf: async (date) => {
      const url =
        'https://nclat.nic.in/daily-cause-list' +
        `?field_court_name_target_id=${courtNameId}` +
        `&field_final_date_value=${date}` +
        `&field_final_date_value_1=${date}`;
      return fetchDrupalViewsPdfs(url, /\/sites\/default\/files\/[^"'\s]*Causelist[^"'\s]*\.pdf/gi);
    },
  };
}

/** All 5 DRATs (confirmed live via drt.gov.in's own "Select DRAT" filter, which has no captcha)
 *  share one JSON API — `schemeNameDrtId` is the same id the site's own dropdown uses. The API
 *  needs a real `multipart/form-data` body (not JSON): the axios instance backing this endpoint
 *  is hard-coded to that content type in the site's own bundle, and a JSON body just gets a
 *  generic "Record Not Fund" response instead of a clear error. It returns every notice (public
 *  notices, vacancy circulars, holiday declarations, cause lists — no per-type filter server-side),
 *  so the actual cause list for a date has to be picked out client-side by matching "causelist" in
 *  the title against the requested date, e.g. "Causelist Dated_11.09.2026 (Adjournment)" or
 *  "CAUSELIST_28.05.2026" — both forms confirmed live. */
const DRAT_SCHEME_IDS: Record<string, number> = {
  'drat-delhi': 100,
  'drat-allahabad': 101,
  'drat-chennai': 102,
  'drat-mumbai': 103,
  'drat-kolkata': 104,
};

async function fetchDratCauseListPdf(schemeId: number, date: string): Promise<Buffer[]> {
  const form = new FormData();
  form.append('schemeNameDrtId', String(schemeId));
  const response = await fetchWithTimeout('https://drt.gov.in/drtapi/getPublicNotice', 15_000, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Court site returned ${response.status}`);
  }
  const notices = (await response.json()) as Array<{ massage?: string; auctionurl?: string }>;

  const [year, month, day] = date.split('-');
  // Not `\b` before the day digits — titles like "Dated_11.09.2026" put an underscore right
  // before them, and `\b` doesn't fire between two word characters (underscore counts as one).
  const ddmmyyyy = new RegExp(`(?<!\\d)${day}[.\\-]${month}[.\\-]${year}(?!\\d)`);
  const match = notices.find((n) => n.massage && /cause\s*list/i.test(n.massage) && ddmmyyyy.test(n.massage) && n.auctionurl);
  if (!match?.auctionurl) {
    throw new Error(`No cause list found for ${date} yet`);
  }
  return [await fetchPdfBuffer(match.auctionurl)];
}

for (const [courtId, schemeId] of Object.entries(DRAT_SCHEME_IDS)) {
  AUTO_FETCH_COURTS[courtId] = {
    fetchPdf: (date) => fetchDratCauseListPdf(schemeId, date),
  };
}

/** POST /api/cause-list/extract
 *  { courtId, date, source: 'fetch' | 'upload', scope?, fileBase64?, mediaType? } → { entries: CauseListEntry[] }
 *  'fetch': courtId must be a tier-1 (auto-fetch) court; the PDF is fetched server-side. `scope`
 *  (a judge name / court-hall number) is required for 'auto-scoped' courts and ignored otherwise.
 *  'upload': fileBase64/mediaType come from a file the advocate downloaded and picked themselves —
 *  this never stores the file, only forwards it to Claude for one extraction call. */
causeListRouter.post('/extract', async (req: AuthedRequest, res) => {
  const { courtId, date, source, scope: rawScope } = req.body ?? {};
  if (typeof courtId !== 'string' || !courtId) {
    return res.status(400).json({ error: 'courtId is required' });
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date is required and must be YYYY-MM-DD' });
  }
  if (source !== 'fetch' && source !== 'upload') {
    return res.status(400).json({ error: "source must be 'fetch' or 'upload'" });
  }
  const scope = typeof rawScope === 'string' ? rawScope.trim().slice(0, 100) || undefined : undefined;

  if (source === 'fetch') {
    const court = AUTO_FETCH_COURTS[courtId];
    if (!court) {
      return res.status(400).json({ error: 'This court is not available for automatic fetching' });
    }
    try {
      let entries: CauseListEntry[];
      let usage: { model?: string; inputTokens?: number; outputTokens?: number } = {};
      if (court.fetchEntries) {
        entries = await court.fetchEntries(date, scope);
      } else {
        const result = await extractCauseList({
          sources: (await court.fetchPdf!(date, scope)).map((pdf) => ({
            base64: pdf.toString('base64'),
            mediaType: 'application/pdf' as const,
          })),
          focusInstruction: scope && court.buildFocusInstruction ? court.buildFocusInstruction(scope) : undefined,
        });
        entries = result.entries;
        usage = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      }
      await logCauseListUsage({
        userId: req.userId,
        courtId,
        date,
        source: 'fetch',
        scope,
        ...usage,
        entriesCount: entries.length,
        success: true,
      });
      return res.json({ entries });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await logCauseListUsage({ userId: req.userId, courtId, date, source: 'fetch', scope, success: false, errorMessage });
      if (err instanceof ScopeRequiredError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('Cause-list auto-fetch failed', err);
      return res.status(502).json({
        error: "Couldn't fetch today's list automatically — it may not be published yet, or try the court's own site directly",
      });
    }
  }

  const { fileBase64, mediaType } = req.body ?? {};
  if (typeof fileBase64 !== 'string' || !fileBase64) {
    return res.status(400).json({ error: 'fileBase64 is required' });
  }
  if (fileBase64.length > MAX_BASE64_LENGTH) {
    return res.status(400).json({ error: 'File is too large' });
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({ error: `mediaType must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` });
  }

  try {
    const result = await extractCauseList({
      sources: [{ base64: fileBase64, mediaType: mediaType as AllowedMediaType }],
    });
    await logCauseListUsage({
      userId: req.userId,
      courtId,
      date,
      source: 'upload',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      entriesCount: result.entries.length,
      success: true,
    });
    res.json({ entries: result.entries });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await logCauseListUsage({ userId: req.userId, courtId, date, source: 'upload', success: false, errorMessage });
    console.error('Cause-list extraction failed', err);
    res.status(502).json({ error: 'This feature is unavailable right now — please check the document manually' });
  }
});
