import type { Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import type { AuthedRequest } from './auth.js';
import { costUsdCents } from '../services/modelPricing.js';

/** Combined monthly spend cap across every Pro-gated feature (cause-list + document translation)
 *  — one ledger rather than a per-feature call-count quota, since a flat count doesn't track cost:
 *  the cause-list auto-fetch's rare >100-page fallback path costs ~27x a normal call, so capping
 *  "calls" still leaves a wide-open cost tail (see project discussion). $7.20 ≈ ₹600 at current
 *  rates, sized to leave real margin under the ₹999 Pro-monthly price once Razorpay's fee and
 *  infra/support overhead are accounted for. */
const MONTHLY_SPEND_CAP_CENTS = 720;

/** Gates a route to active Pro subscribers only — mirrors the existing `subscription_status`
 *  check already used for judge-style analysis in copilot.ts, plus the new tier axis. */
export async function requireProTier(req: AuthedRequest, res: Response, next: NextFunction) {
  const { rows } = await pool.query('SELECT subscription_status, subscription_tier FROM users WHERE id = $1', [req.userId]);
  const user = rows[0];
  if (!user || user.subscription_status !== 'active' || user.subscription_tier !== 'pro') {
    return res.status(402).json({ error: 'This feature is available on the Pro plan.', reason: 'pro_required' });
  }
  next();
}

/**
 * Sums this calendar month's real spend across both Pro-gated features and blocks further calls
 * once MONTHLY_SPEND_CAP_CENTS is crossed. Calendar-month reset (not billing-period-anchored) —
 * simpler to reason about than tracking every user's individual renewal date, and close enough
 * for a fair-use cap rather than a precisely-billed one.
 *
 * Checked before a call starts, using only prior spend — a court's page count (and therefore
 * whether a cause-list request trips the far pricier Sonnet-5 fallback) isn't known until the PDF
 * is actually fetched, so the call already in flight can push a user slightly over the cap before
 * the *next* one is blocked. That's an accepted soft-ceiling tradeoff: knowing a document's cost
 * before fetching it isn't possible here.
 */
export async function checkProBudget(req: AuthedRequest, res: Response, next: NextFunction) {
  const { rows: causeListRows } = await pool.query(
    `SELECT model, input_tokens, output_tokens FROM cause_list_usage
     WHERE user_id = $1 AND success = true AND created_at >= date_trunc('month', now())`,
    [req.userId]
  );
  const { rows: translationRows } = await pool.query(
    `SELECT model, input_tokens, output_tokens FROM translation_usage
     WHERE user_id = $1 AND success = true AND created_at >= date_trunc('month', now())`,
    [req.userId]
  );

  const spentCents = [...causeListRows, ...translationRows].reduce(
    (sum, r) => sum + costUsdCents(r.model, r.input_tokens, r.output_tokens),
    0
  );

  if (spentCents >= MONTHLY_SPEND_CAP_CENTS) {
    const now = new Date();
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return res.status(402).json({
      error: `Pro usage limit reached for this month — resets on ${resetsAt.toISOString().slice(0, 10)}`,
      reason: 'usage_cap_reached',
      resetsAt: resetsAt.toISOString(),
    });
  }
  next();
}
