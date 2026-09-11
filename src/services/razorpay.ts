import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import type { PlanId, TierId } from '../routes/billing.js';

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID ?? '',
  key_secret: process.env.RAZORPAY_KEY_SECRET ?? '',
});

// Two tiers: Base covers drafting/extraction/suggestions/Law Library/judge-style; Pro additionally
// unlocks cause-list and document translation (see requireProTier in middleware/proBudget.ts) —
// those two are priced far above Base's per-call cost (a single cause-list auto-fetch can run
// ~$0.05-$1.42 depending on document size), which Base's price was never sized to absorb.
const PLAN_PRICING: Record<TierId, Record<PlanId, { amountPaise: number; period: 'monthly' | 'yearly'; interval: number }>> = {
  base: {
    monthly: { amountPaise: 49900, period: 'monthly', interval: 1 },
    quarterly: { amountPaise: 119900, period: 'monthly', interval: 3 },
    half_yearly: { amountPaise: 199900, period: 'monthly', interval: 6 },
    yearly: { amountPaise: 349900, period: 'yearly', interval: 1 },
  },
  pro: {
    monthly: { amountPaise: 99900, period: 'monthly', interval: 1 },
    quarterly: { amountPaise: 249900, period: 'monthly', interval: 3 },
    half_yearly: { amountPaise: 449900, period: 'monthly', interval: 6 },
    yearly: { amountPaise: 699900, period: 'yearly', interval: 1 },
  },
};

export function planAmountPaise(tier: TierId, plan: PlanId) {
  return PLAN_PRICING[tier][plan].amountPaise;
}

/**
 * Razorpay Subscriptions need a Plan object created on their side first. Rather than requiring
 * every tier/period combination to be set up by hand in the Razorpay dashboard, this creates each
 * one on first use and caches the resulting plan_id in our own `razorpay_plans` table, keyed
 * `{tier}_{plan}` (e.g. `pro_monthly`), so it's only ever created once regardless of how many
 * users subscribe. Tier-qualified rather than bare period names because a Razorpay Plan's amount
 * is immutable once created — Base's new prices need their own fresh Plan objects too, not just
 * Pro's, since the old bare 'monthly' etc. keys point at the previous ₹299-etc. pricing.
 */
export async function getOrCreateRazorpayPlanId(tier: TierId, plan: PlanId): Promise<string> {
  const key = `${tier}_${plan}`;
  const cached = await pool.query('SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_id = $1', [key]);
  if (cached.rows.length > 0) return cached.rows[0].razorpay_plan_id;

  const pricing = PLAN_PRICING[tier][plan];
  const created = await razorpay.plans.create({
    period: pricing.period,
    interval: pricing.interval,
    item: {
      name: `LawFilings — ${tier} — ${plan.replace('_', '-')}`,
      amount: pricing.amountPaise,
      currency: 'INR',
    },
  });

  await pool.query(
    `INSERT INTO razorpay_plans (plan_id, razorpay_plan_id) VALUES ($1, $2)
     ON CONFLICT (plan_id) DO UPDATE SET razorpay_plan_id = EXCLUDED.razorpay_plan_id`,
    [key, created.id]
  );
  return created.id;
}

/** timingSafeEqual throws on mismatched buffer lengths rather than returning false, which would
 *  turn a malformed/forged signature into a 500 instead of a clean "verification failed" — this
 *  checks length first so it can never throw. */
function safeEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** Verifies a subscription's first-charge payment: HMAC-SHA256 over "payment_id|subscription_id"
 *  — note the field order is reversed from order verification, per Razorpay's own convention. */
export function verifySubscriptionSignature(subscriptionId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ?? '')
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return safeEqual(expected, signature);
}
