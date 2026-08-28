-- Migration 007: Log every Law Library question that couldn't be answered from sourced text —
-- turns "a user happens to notice and mention a gap" into a systematic, prioritizable backlog of
-- what to source next, instead of relying on manual reports.

CREATE TABLE library_question_gaps (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question      TEXT NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('no_search_matches', 'model_declined')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX library_question_gaps_created_idx ON library_question_gaps(created_at DESC);
