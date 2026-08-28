# Filing Assistant — Backend

Express + PostgreSQL API implementing the schema designed across the project's design documents.

## Setup

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL
npm run migrate         # applies migrations/001_initial_schema.sql
npm run seed             # populates forums + the case types with working frontend wizards
npm run dev
```

## What's real vs. what's a stub

**Real and working (against a real Postgres instance and, for the copilot, a real Anthropic API key):**
- Full schema migration — every table designed across the schema docs, with proper FKs, checks, and indexes
- `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout` — real password hashing (bcrypt) and session tokens (SHA-256 hashed before storage, never kept in plaintext)
- `GET /api/forums`, `GET /api/case-types`, `GET /api/case-types/:id/clauses` — catalog endpoints the frontend needs to stop using `mockData.ts`
- `POST /api/cases`, `GET /api/cases/:id`, `PUT /api/cases/:id/drafts/:draftId` — case creation and draft save, with proper `draft_versions` archiving on every save (never overwrites without keeping history)
- `POST /api/copilot/suggest-clauses`, `POST /api/copilot/check-defects` — real Claude API integration. Both fail gracefully (502 with a clear message) rather than blocking drafting if the AI call fails — the copilot is an aid, not a dependency
- Auth middleware checks real, properly-hashed session tokens against the `sessions` table

**Stubs / not implemented:**
- No Bar Council verification integration (no such public API currently exists — this needs a manual review workflow or a business partnership, not just code)
- No rate limiting on auth endpoints — needed before production (brute-force protection)
- Seed script covers the forums and case types with full clause data; the remaining ~15 case types from the design docs (general IA/MA, revision petitions, Section 12A, etc.) follow the identical `INSERT` pattern and can be added directly from the values already specified in `nclt_cc_extended.md` and `drt_oa_ia_ma_appeals.md`
- The AI copilot's clause suggestions and defect checks are additive to, not a replacement for, the hardcoded `complexity_rules` blocking gates already in the schema — those remain authoritative

## Connecting the frontend

The React app's `src/data/mockData.ts` is structured to make this swap mechanical: replace the static
exports with `fetch('/api/forums')` / `fetch('/api/case-types')` calls, likely behind a small data-fetching
hook, since the shape of `Forum` and `CaseType` in the frontend's `types.ts` already matches these API
responses field-for-field (camelCase vs snake_case is the only real conversion needed).
