-- Migration 002: status_updates table
-- The API and frontend (casesClient.ts: createStatusUpdate/listStatusUpdates, CaseRecord's
-- nextHearingDate/latestStatusLabel) already expected this table and its routes; neither existed
-- yet, so every case-detail status update and every "diary case" add with a status/hearing
-- date/note filled in was silently failing (POST /api/cases/:id/status-updates 404'd).

CREATE TABLE status_updates (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    updated_by    UUID NOT NULL REFERENCES users(id),
    status_label  TEXT NOT NULL,
    note          TEXT,
    hearing_date  DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX status_updates_case_idx ON status_updates(case_id);
