-- Migration 013: Password reset.
-- Additive only. The reset token is stored hashed (same reasoning as sessions.token_hash) so a DB
-- leak doesn't hand out usable reset links.

ALTER TABLE users
    ADD COLUMN password_reset_token_hash TEXT,
    ADD COLUMN password_reset_expires_at TIMESTAMPTZ;
