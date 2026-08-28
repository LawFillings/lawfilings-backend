import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import {
  razorpay,
  planAmountPaise,
  getOrCreateRazorpayPlanId,
  verifySubscriptionSignature,
} from '../services/razorpay.js';

export type PlanId = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';
const PLAN_IDS: PlanId[] = ['monthly', 'quarterly', 'half_yearly', 'yearly'];

const FREE_DRAFTS = 2;

// How long a subscription period lasts, used to set subscription_current_period_end on our side
// after a successful first charge (Razorpay tracks the authoritative schedule; this is only what
// BillingPage.tsx shows as "Renews …" until the next webhook/status sync updates it).
const PLAN_PERIOD_DAYS: Record<PlanId, number> = {
  monthly: 30,
  quarterly: 90,
  half_yearly: 182,
  yearly: 365,
};

export const billingRouter = Router();

billingRouter.use(requireAuth);

/** GET /api/billing/status — one uniform tariff: every account (role no longer matters) gets 2
 *  free drafts on sign up, then needs an active subscription. No trial concept any more. */
billingRouter.get('/status', async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    `SELECT subscription_status, subscription_plan, subscription_current_period_end, free_drafts_used
     FROM users WHERE id = $1`,
    [req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const user = rows[0];

  res.json({
    subscriptionStatus: user.subscription_status,
    subscriptionPlan: user.subscription_plan,
    subscriptionCurrentPeriodEnd: user.subscription_current_period_end,
    freeDraftsRemaining: Math.max(0, FREE_DRAFTS - user.free_drafts_used),
  });
});

/** GET /api/billing/history */
billingRouter.get('/history', async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, status, amount_paise, currency, plan, created_at
     FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

/** POST /api/billing/subscription — creates (and lazily creates the underlying Razorpay Plan for)
 *  a subscription in an unpaid state; it only becomes active once /verify confirms the first charge. */
billingRouter.post('/subscription', async (req: AuthedRequest, res) => {
  const { plan } = req.body as { plan?: PlanId };
  if (!plan || !PLAN_IDS.includes(plan)) {
    return res.status(400).json({ error: `plan must be one of ${PLAN_IDS.join(', ')}` });
  }

  let subscription;
  try {
    const razorpayPlanId = await getOrCreateRazorpayPlanId(plan);
    subscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_notify: 1,
      // Razorpay requires a finite total_count of billing cycles — 120 monthly-equivalent cycles
      // covers 10+ years at every interval we offer, which in practice means "until cancelled."
      total_count: 120,
      notes: { userId: req.userId ?? '' },
    });
  } catch (err) {
    console.error('Razorpay subscription creation failed', err);
    return res.status(502).json({ error: 'Could not start subscription — try again shortly.' });
  }

  await pool.query('UPDATE users SET razorpay_subscription_id = $1 WHERE id = $2', [subscription.id, req.userId]);

  await pool.query(
    `INSERT INTO payments (user_id, kind, status, amount_paise, currency, plan, razorpay_subscription_id)
     VALUES ($1, 'subscription_charge', 'created', $2, 'INR', $3, $4)`,
    [req.userId, planAmountPaise(plan), plan, subscription.id]
  );

  res.json({ subscriptionId: subscription.id, keyId: process.env.RAZORPAY_KEY_ID });
});

/** POST /api/billing/subscription/verify */
billingRouter.post('/subscription/verify', async (req: AuthedRequest, res) => {
  const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature) {
    return res
      .status(400)
      .json({ error: 'razorpaySubscriptionId, razorpayPaymentId, and razorpaySignature are required' });
  }

  if (!verifySubscriptionSignature(razorpaySubscriptionId, razorpayPaymentId, razorpaySignature)) {
    await pool.query(
      `UPDATE payments SET status = 'failed', failure_reason = 'signature_mismatch', updated_at = now()
       WHERE razorpay_subscription_id = $1 AND user_id = $2`,
      [razorpaySubscriptionId, req.userId]
    );
    return res.status(400).json({ error: 'Payment signature could not be verified' });
  }

  const paymentRow = await pool.query(
    `SELECT plan FROM payments WHERE razorpay_subscription_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [razorpaySubscriptionId, req.userId]
  );
  if (paymentRow.rows.length === 0) return res.status(404).json({ error: 'Subscription not found for this account' });
  const plan: PlanId = paymentRow.rows[0].plan;

  await pool.query(
    `UPDATE payments SET status = 'captured', razorpay_payment_id = $1, updated_at = now()
     WHERE razorpay_subscription_id = $2 AND user_id = $3`,
    [razorpayPaymentId, razorpaySubscriptionId, req.userId]
  );
  await pool.query(
    `UPDATE users
     SET subscription_status = 'active', subscription_plan = $1,
         subscription_current_period_end = now() + make_interval(days => $2)
     WHERE id = $3`,
    [plan, PLAN_PERIOD_DAYS[plan], req.userId]
  );

  res.json({ status: 'active' });
});

/** POST /api/billing/subscription/cancel */
billingRouter.post('/subscription/cancel', async (req: AuthedRequest, res) => {
  const { rows } = await pool.query('SELECT razorpay_subscription_id FROM users WHERE id = $1', [req.userId]);
  const subscriptionId = rows[0]?.razorpay_subscription_id;
  if (!subscriptionId) return res.status(400).json({ error: 'No active subscription to cancel' });

  try {
    await razorpay.subscriptions.cancel(subscriptionId);
  } catch (err) {
    console.error('Razorpay subscription cancellation failed', err);
    return res.status(502).json({ error: 'Could not cancel subscription — try again shortly.' });
  }

  await pool.query(`UPDATE users SET subscription_status = 'cancelled' WHERE id = $1`, [req.userId]);
  res.json({ status: 'cancelled' });
});
