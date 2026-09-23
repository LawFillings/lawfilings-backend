-- Migration 014: Advocate directory — lets a verified advocate opt in to a public, read-only
-- listing (browsable without an account, per the Bar Council's bar on advocates soliciting work —
-- this is an informational directory a prospective client finds and initiates contact through,
-- not the advocate advertising to them) and receive inquiries sent through it. Additive only.

-- One row per advocate, created/updated only by that advocate via PUT /api/advocates/me.
-- `listed` defaults false — nobody appears in the public directory without explicitly opting in,
-- even once verified. The API layer also re-checks verification_status = 'verified' on every
-- public read, so a listed row from a since-unverified account still never becomes visible.
CREATE TABLE advocate_profiles (
    user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    city                 TEXT,
    practice_state       TEXT,
    practice_forums      TEXT[] NOT NULL DEFAULT '{}',
    languages            TEXT[] NOT NULL DEFAULT '{}',
    bio                  TEXT,
    practicing_since_year INT,
    listed               BOOLEAN NOT NULL DEFAULT false,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A prospective client's message to one advocate, sent from the directory or from a wizard's
-- "want an advocate to handle this" handoff. The advocate's own contact details are never put in
-- the public directory response — this is the only channel a client reaches them through, and it
-- carries the SENDER's contact (via from_user_id), not the other way round.
CREATE TABLE advocate_inquiries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    advocate_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    forum_type     TEXT,
    case_type_label TEXT,
    state          TEXT,
    message        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX advocate_inquiries_advocate_idx ON advocate_inquiries(advocate_id, created_at DESC);
CREATE INDEX advocate_profiles_listed_idx ON advocate_profiles(practice_state) WHERE listed = true;
