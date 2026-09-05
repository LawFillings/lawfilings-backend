-- Migration 008: prevent duplicate precedents
-- Same rationale as 005_case_types_unique.sql — case_title uniqueness lets the seed script
-- upsert (ON CONFLICT DO UPDATE) instead of accumulating duplicates on repeat runs.

ALTER TABLE precedents ADD CONSTRAINT precedents_case_title_unique UNIQUE (case_title);
