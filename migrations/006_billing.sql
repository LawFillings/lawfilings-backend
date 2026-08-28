-- Migration 006: Billing — free-draft tracking.
--
-- Note: this database already had `payments`, `razorpay_plans`, and most of the
-- subscription-related columns on `users` (subscription_status, subscription_plan, trial_ends_at,
-- razorpay_customer_id, razorpay_subscription_id, subscription_current_period_end) applied before
-- this migration was written — outside of any file in this migrations/ folder, so there's no
-- earlier numbered migration documenting them. This migration only adds what was still missing.

ALTER TABLE users
    ADD COLUMN free_drafts_used INT NOT NULL DEFAULT 0;
