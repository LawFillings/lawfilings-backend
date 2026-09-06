-- Migration 010: backfill billing schema that was only ever applied to the dev database by hand.
--
-- 006_billing.sql's own comment already flagged this: `payments`, `razorpay_plans`, and most of
-- the subscription columns on `users` were added to the original dev database outside of any
-- migration file, so no earlier numbered migration ever actually created them. That went
-- unnoticed until the first production deploy (a genuinely fresh database, migrated 001-009 in
-- order) hit a real "Internal server error" on the Billing page — GET /api/billing/status querying
-- subscription_status/subscription_plan/subscription_current_period_end on `users`, none of which
-- existed. This migration recreates the exact schema found on the dev database (confirmed via
-- `\d users` / `\d payments` / `\d razorpay_plans` there) so production actually matches what
-- billing.ts and services/razorpay.ts have assumed all along. Written with IF NOT EXISTS
-- throughout so it's safe to run again on a database that already has some or all of this.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS subscription_plan TEXT,
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT,
    ADD COLUMN IF NOT EXISTS razorpay_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
        CHECK (subscription_status = ANY (ARRAY['none', 'trialing', 'active', 'past_due', 'cancelled', 'halted']));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_subscription_plan_check
        CHECK (subscription_plan = ANY (ARRAY['monthly', 'quarterly', 'half_yearly', 'yearly']));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('document_charge', 'subscription_charge')),
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    razorpay_subscription_id TEXT,
    case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
    draft_id UUID REFERENCES drafts(id) ON DELETE SET NULL,
    plan TEXT CHECK (plan = ANY (ARRAY['monthly', 'quarterly', 'half_yearly', 'yearly'])),
    failure_reason TEXT,
    raw_webhook_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id);
CREATE INDEX IF NOT EXISTS payments_razorpay_order_idx ON payments (razorpay_order_id);
CREATE INDEX IF NOT EXISTS payments_razorpay_subscription_idx ON payments (razorpay_subscription_id);

CREATE TABLE IF NOT EXISTS razorpay_plans (
    plan_id TEXT PRIMARY KEY CHECK (plan_id = ANY (ARRAY['monthly', 'quarterly', 'half_yearly', 'yearly'])),
    razorpay_plan_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
