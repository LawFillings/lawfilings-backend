-- Migration 005: prevent duplicate case_types
-- The seed data had accumulated exact (forum_type, name) duplicates (likely a seed script run
-- more than once with no idempotency check) — cleaned up manually, this constraint stops it
-- from happening again.

ALTER TABLE case_types ADD CONSTRAINT case_types_forum_name_unique UNIQUE (forum_type, name);
