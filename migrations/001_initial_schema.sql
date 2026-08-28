-- Migration 001: Full initial schema
-- Consolidates: justice_seeker_platform_schema_v2.md, phase1_case_types_consolidated.md,
-- full_filing_type_coverage.md, drt_appeal_routes.md, drt_oa_ia_ma_appeals.md, nclt_cc_extended.md

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============ Identity ============

CREATE TABLE users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name         TEXT NOT NULL,
    email             TEXT UNIQUE,
    phone             TEXT UNIQUE,
    password_hash     TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('justice_seeker', 'advocate', 'authorised_agent')),
    bar_council_no    TEXT UNIQUE,
    bar_state         TEXT,
    verification_status TEXT NOT NULL DEFAULT 'not_applicable'
        CHECK (verification_status IN ('not_applicable', 'pending', 'verified', 'rejected')),
    verification_doc_url TEXT,
    preferred_language TEXT DEFAULT 'en',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clients (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    advocate_id   UUID NOT NULL REFERENCES users(id),
    full_name     TEXT NOT NULL,
    contact_phone TEXT,
    contact_email TEXT,
    linked_user_id UUID REFERENCES users(id),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Forums & case types ============

CREATE TABLE forums (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    forum_type    TEXT NOT NULL,
    advocate_mandatory BOOLEAN NOT NULL DEFAULT false,
    jurisdiction_rule JSONB,
    print_spec    JSONB
);

CREATE TABLE case_types (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forum_type    TEXT NOT NULL,
    name          TEXT NOT NULL,
    governing_law TEXT,
    plain_language_summary TEXT,
    applicant_eligibility TEXT,
    filing_category TEXT NOT NULL DEFAULT 'original'
        CHECK (filing_category IN ('original', 'reply', 'interlocutory', 'appeal', 'execution')),
    deadline_source TEXT DEFAULT 'statutory_fixed'
        CHECK (deadline_source IN ('statutory_fixed', 'tribunal_assigned')),
    limitation_days INT,
    condonable_extension_days INT,
    deposit_requirement JSONB,
    parent_required BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE templates (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_type_id  UUID NOT NULL REFERENCES case_types(id),
    name          TEXT NOT NULL,
    structure     JSONB NOT NULL,
    is_public     BOOLEAN NOT NULL DEFAULT true,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clauses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT UNIQUE NOT NULL,
    case_type_id  UUID REFERENCES case_types(id),
    category      TEXT,
    title         TEXT NOT NULL,
    body_template TEXT NOT NULL,
    plain_language_explanation TEXT,
    is_custom     BOOLEAN NOT NULL DEFAULT false,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE complexity_rules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_type_id  UUID REFERENCES case_types(id),
    condition     JSONB NOT NULL,
    resulting_flag TEXT NOT NULL CHECK (resulting_flag IN ('simple', 'consider_advocate', 'recommend_advocate')),
    reason        TEXT NOT NULL,
    blocking      BOOLEAN NOT NULL DEFAULT false
);

-- ============ Cases & drafts ============

CREATE TABLE cases (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      UUID NOT NULL REFERENCES users(id),
    owner_role    TEXT NOT NULL CHECK (owner_role IN ('justice_seeker', 'advocate')),
    client_id     UUID REFERENCES clients(id),
    forum_id      UUID REFERENCES forums(id),
    case_type_id  UUID REFERENCES case_types(id),
    parent_case_id UUID REFERENCES cases(id),
    case_number   TEXT,
    title         TEXT NOT NULL,
    parties       JSONB,
    dispute_summary TEXT,
    claim_value   NUMERIC,
    role_in_proceeding TEXT NOT NULL DEFAULT 'applicant' CHECK (role_in_proceeding IN ('applicant', 'respondent')),
    status        TEXT NOT NULL DEFAULT 'assessing' CHECK (status IN ('assessing', 'drafting', 'ready', 'filed', 'disposed')),
    complexity_flag TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE case_assistance (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id           UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    justice_seeker_id UUID NOT NULL REFERENCES users(id),
    advocate_id       UUID NOT NULL REFERENCES users(id),
    assistance_type   TEXT NOT NULL CHECK (assistance_type IN ('full_representation', 'limited_scope_drafting', 'pro_bono_review')),
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    invited_by        TEXT NOT NULL CHECK (invited_by IN ('justice_seeker', 'advocate')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    template_id   UUID REFERENCES templates(id),
    title         TEXT NOT NULL,
    content       JSONB NOT NULL,
    version       INT NOT NULL DEFAULT 1,
    status        TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'ready', 'filed')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE draft_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id      UUID NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    version       INT NOT NULL,
    content       JSONB NOT NULL,
    edited_by     UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Law reference ============

CREATE TABLE acts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_title   TEXT NOT NULL,
    year          INT,
    act_number    TEXT
);

CREATE TABLE act_sections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    act_id        UUID NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
    section_no    TEXT NOT NULL,
    heading       TEXT,
    text          TEXT NOT NULL,
    search_vector TSVECTOR
);

CREATE INDEX act_sections_search_idx ON act_sections USING GIN (search_vector);

CREATE TABLE precedents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_title    TEXT NOT NULL,
    citation      TEXT,
    court         TEXT,
    year          INT,
    summary       TEXT,
    relevant_case_types UUID[] DEFAULT '{}',
    source_url    TEXT
);

-- ============ Audit ============

CREATE TABLE audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id),
    action        TEXT NOT NULL,
    entity_type   TEXT,
    entity_id     UUID,
    metadata      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Indexes for common lookups ============

CREATE INDEX cases_owner_idx ON cases(owner_id);
CREATE INDEX cases_parent_idx ON cases(parent_case_id);
CREATE INDEX drafts_case_idx ON drafts(case_id);
CREATE INDEX case_types_forum_idx ON case_types(forum_type);
CREATE INDEX clauses_case_type_idx ON clauses(case_type_id);
