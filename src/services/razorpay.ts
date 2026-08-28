import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import type { PlanId } from '../routes/billing.js';

export const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID ?? '',
  key_secret: process.env.RAZORPAY_KEY_SECRET ?? '',
});

// Uniform tariff — same pricing for every account regardless of role, no per-document fallback.
const PLAN_PRICING: Record<PlanId, { amountPaise: number; period: 'monthly' | 'yearly'; interval: number }> = {
  monthly: { amountPaise: 29900, period: 'monthly', interval: 1 },
  quarterly: { amountPaise: 69900, period: 'monthly', interval: 3 },
  half_yearly: { amountPaise: 119900, period: 'monthly', interval: 6 },
  yearly: { amountPaise: 199900, period: 'yearly', interval: 1 },
};

export function planAmountPaise(plan: PlanId) {
  return PLAN_PRICING[plan].amountPaise;
}

/**
 * Razorpay Subscriptions need a Plan object created on their side first. Rather than requiring
 * the four plans to be set up by hand in the Razorpay dashboard, this creates each one on first
 * use and caches the resulting plan_id in our own `razorpay_plans` table, so it's only ever
 * created once per plan tier regardless of how many users subscribe.
 */
export async function getOrCreateRazorpayPlanId(plan: PlanId): Promise<string> {
  const cached = await pool.query('SELECT razorpay_plan_id FROM razorpay_plans WHERE plan_id = $1', [plan]);
  if (cached.rows.length > 0) return cached.rows[0].razorpay_plan_id;

  const pricing = PLAN_PRICING[plan];
  const created = await razorpay.plans.create({
    period: pricing.period,
    interval: pricing.interval,
    item: {
      name: `LawFilings — ${plan.replace('_', '-')}`,
      amount: pricing.amountPaise,
      currency: 'INR',
    },
  });

  await pool.query(
    `INSERT INTO razorpay_plans (plan_id, razorpay_plan_id) VALUES ($1, $2)
     ON CONFLICT (plan_id) DO UPDATE SET razorpay_plan_id = EXCLUDED.razorpay_plan_id`,
    [plan, created.id]
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
