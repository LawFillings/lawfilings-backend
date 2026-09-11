-- Migration 012: Pro tier + spend-based usage cap for cause-list and document translation.
--
-- Adds a subscription_tier axis (base/pro) orthogonal to the existing subscription_plan (billing
-- period) — a user can be on any period at either tier. Existing subscribers default to 'base'.
--
-- Widens razorpay_plans/payments to carry tier-qualified plan keys. Razorpay Plan amounts are
-- immutable once created, so the existing 'monthly'/'quarterly'/'half_yearly'/'yearly' cached rows
-- (pointing at the old ₹299-etc. Razorpay Plan objects) can't be repriced in place — both the new
-- Base prices and the new Pro tier need fresh, tier-qualified plan keys ('base_monthly',
-- 'pro_monthly', etc.) rather than reusing the old bare period names. No production subscriber has
-- ever completed a live subscription yet (Razorpay Subscriptions has been blocked pending account
-- activation since 2026-08-27), so there's nothing to migrate off the old keys.
--
-- Also adds translation_usage, mirroring cause_list_usage's shape, so translate-document calls get
-- the same real per-request token logging cause-list already has — the new spend cap needs that to
-- see translation cost at all.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'base';

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_subscription_tier_check
        CHECK (subscription_tier = ANY (ARRAY['base', 'pro']));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'base';

DO $$ BEGIN
    ALTER TABLE payments ADD CONSTRAINT payments_tier_check
        CHECK (tier = ANY (ARRAY['base', 'pro']));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE razorpay_plans DROP CONSTRAINT IF EXISTS razorpay_plans_plan_id_check;
ALTER TABLE razorpay_plans ADD CONSTRAINT razorpay_plans_plan_id_check
    CHECK (plan_id = ANY (ARRAY[
        'base_monthly', 'base_quarterly', 'base_half_yearly', 'base_yearly',
        'pro_monthly', 'pro_quarterly', 'pro_half_yearly', 'pro_yearly'
    ]));

CREATE TABLE IF NOT EXISTS translation_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_language TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    truncated BOOLEAN NOT NULL DEFAULT false,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS translation_usage_user_id_idx ON translation_usage (user_id);
CREATE INDEX IF NOT EXISTS translation_usage_created_at_idx ON translation_usage (created_at);
