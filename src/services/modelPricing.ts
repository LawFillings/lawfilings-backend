/**
 * USD list price per million tokens, input/output — verified live against claude.com/pricing on
 * 2026-09-11. Keyed by the un-dated model prefix; `costUsdCents` matches by prefix since the API
 * returns a dated snapshot string (e.g. `claude-haiku-4-5-20251001`), not this bare name.
 */
const PRICE_PER_MTOK_USD: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

/** Cents (USD, integer) rather than a float dollar amount, so summing many rows for a monthly
 *  spend cap can't drift from floating-point rounding. Returns 0 for an unrecognized/missing
 *  model or missing token counts, rather than throwing — a usage row with incomplete data
 *  shouldn't block the cap check that reads it. */
export function costUsdCents(model: string | null | undefined, inputTokens: number | null, outputTokens: number | null): number {
  if (!model || !inputTokens || !outputTokens) return 0;
  const key = Object.keys(PRICE_PER_MTOK_USD).find((k) => model.startsWith(k));
  const price = key ? PRICE_PER_MTOK_USD[key] : undefined;
  if (!price) return 0;
  const dollars = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return Math.round(dollars * 100);
}
