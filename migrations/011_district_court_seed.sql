-- Migration 011: seed the District Court forum + case types the frontend already hardcodes.
--
-- src/data/districtCourtLocations.ts (frontend) has carried fixed UUID constants
-- (DISTRICT_COURT_FORUM_ID, MONEY_RECOVERY_CASE_TYPE_ID, SUMMARY_SUIT_CASE_TYPE_ID —
-- 10000000-0000-0000-0000-00000000000{1,2,3}) since MoneyRecoverySuitWizard.tsx and
-- SummarySuitWizard.tsx were built, commented as "mirroring the backend seed" — but no migration
-- ever actually created these rows; they only exist on the local dev database because someone
-- inserted them there by hand at some point (same class of drift 010_billing_schema_backfill.sql
-- fixed for billing). Without this, POST /api/cases with these forumId/caseTypeId values fails
-- an FK constraint on any database that only ran the committed migrations — i.e. almost certainly
-- production today. Written with ON CONFLICT DO NOTHING so it's safe to run again anywhere,
-- including the dev database that already has these rows by hand.

INSERT INTO forums (id, name, forum_type, advocate_mandatory)
VALUES ('10000000-0000-0000-0000-000000000001', 'District Court', 'district_court', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_types (id, forum_type, name, governing_law, plain_language_summary, applicant_eligibility, filing_category)
VALUES (
    '10000000-0000-0000-0000-000000000002',
    'district_court',
    'Money Recovery Suit',
    'Code of Civil Procedure, 1908',
    'Use this if someone owes you money — an unpaid loan, an unpaid invoice, or a bounced cheque — and you want to sue them for it in a District Court.',
    'any_plaintiff',
    'original'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO case_types (id, forum_type, name, governing_law, plain_language_summary, applicant_eligibility, filing_category)
VALUES (
    '10000000-0000-0000-0000-000000000003',
    'district_court',
    'Summary Suit (Order XXXVII)',
    'Code of Civil Procedure, 1908, Order XXXVII',
    'Use this if you''re owed money under a written contract, a cheque, or a promissory note — a faster procedure where the other side must get the court''s permission to contest.',
    'plaintiff_with_written_contract_or_negotiable_instrument',
    'original'
)
ON CONFLICT (id) DO NOTHING;
