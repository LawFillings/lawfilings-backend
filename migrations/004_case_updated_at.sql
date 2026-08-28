-- Migration 004: updated_at on cases
-- The My Cases table's "Created" column is being relabeled "Updated on" — that only makes sense
-- if there's a real last-modified timestamp behind it, not just created_at re-labeled.

ALTER TABLE cases ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
