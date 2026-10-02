/**
 * Live case-law search via the Indian Kanoon API (https://api.indiankanoon.org), used for
 * open-ended research beyond the platform's own curated precedents. Every call costs money
 * (pay-per-request, prepaid balance) — callers must apply their own quota check before invoking
 * this, see routes/caseLaw.ts. Only ever fetches search results, never full judgment text.
 */
const API_KEY = process.env.INDIAN_KANOON_API_KEY;
const API_BASE = 'https://api.indiankanoon.org';

export interface CaseLawResult {
  title: string;
  docId: string;
  snippet: string;
  court: string | null;
  date: string | null;
  citation: string | null;
  indianKanoonUrl: string;
}

export async function searchCaseLaw(params: { query: string; pageNum?: number; doctypes?: string }): Promise<CaseLawResult[]> {
  if (!API_KEY) {
    throw new Error('INDIAN_KANOON_API_KEY is not configured');
  }

  const { query, pageNum = 0, doctypes } = params;
  // Despite being documented as a separate query param, Indian Kanoon's API only actually
  // honors doctypes as a `doctypes:value` operator inlined into formInput itself — confirmed
  // by testing directly against the live API, where a separate &doctypes= param is silently
  // ignored.
  const formInput = doctypes ? `${query} doctypes:${doctypes}` : query;
  const url = `${API_BASE}/search/?formInput=${encodeURIComponent(formInput)}&pagenum=${pageNum}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Indian Kanoon API request failed (${res.status})`);
  }

  const data = await res.json();
  const docs = Array.isArray(data?.docs) ? data.docs : [];

  return docs.map((doc: any) => ({
    title: doc.title ?? 'Untitled',
    docId: String(doc.tid),
    snippet: doc.headline ?? '',
    court: doc.docsource ?? null,
    date: doc.publishdate ?? null,
    citation: doc.citation ?? null,
    indianKanoonUrl: `https://indiankanoon.org/doc/${doc.tid}/`,
  }));
}
