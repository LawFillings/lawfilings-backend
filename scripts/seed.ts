/**
 * Seeds the database with the forums, case types, and clauses designed across the schema docs
 * and mirrored in the frontend's src/data/mockData.ts, plus curated case-law precedents. Run
 * after `npm run migrate` (and any migrations after 001 — see migrations/, applied by hand).
 *
 * This covers the forums and the case types that have full clause data (the ones with working
 * wizards in the frontend). The remaining case types (general IA/MA, revision petitions, etc.)
 * follow the identical INSERT pattern — see the design docs for their field values.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO forums (name, forum_type, advocate_mandatory, jurisdiction_rule) VALUES
      ('Consumer Commission', 'consumer_commission', false, '{
        "rule_type": "pecuniary_tier",
        "basis": "value_of_consideration_paid",
        "tiers": [
          {"forum": "District Commission", "max": 5000000},
          {"forum": "State Commission", "min": 5000000, "max": 20000000},
          {"forum": "National Commission", "min": 20000000}
        ]
      }'),
      ('DRT', 'DRT', false, '{
        "rule_type": "debt_threshold",
        "basis": "total_outstanding_debt",
        "min": 2000000
      }'),
      ('DRAT', 'DRAT', false, '{"rule_type": "appellate_only"}'),
      ('NCLT', 'NCLT', false, '{"rule_type": "subject_matter_and_bench"}'),
      ('NCLAT', 'NCLAT', false, '{"rule_type": "appellate_only"}')
      ON CONFLICT DO NOTHING;
    `);

    const caseTypeInserts: Array<[string, string, string, string, string, string, number | null, number | null]> = [
      ['consumer_commission', 'Consumer Complaint', 'Consumer Protection Act, 2019, Section 35', 'any_consumer', 'original', 'statutory_fixed', null, null],
      ['DRT', 'Securitisation Application (SA)', 'SARFAESI Act, 2002, Section 17', 'borrower_only', 'original', 'statutory_fixed', null, null],
      ['DRT', 'Written Statement — reply to Original Application', 'RDDBFI Act, 1993, Section 19(5)', 'borrower_or_guarantor', 'reply', 'statutory_fixed', 30, 15],
      ['NCLT', 'Section 9 IBC — Operational Creditor CIRP Application', 'Insolvency and Bankruptcy Code, 2016, Section 9', 'any_operational_creditor', 'original', 'statutory_fixed', null, null],
      ['DRAT', 'Appeal to DRAT against DRT order', 'RDDBFI Act, 1993, Section 20', 'any_aggrieved_party', 'appeal', 'statutory_fixed', 45, null],
      ['consumer_commission', 'Execution Application', 'Consumer Protection Act, 2019, Sections 71–72', 'complainant_or_person_in_whose_favour_order_passed', 'execution', 'statutory_fixed', null, null],
    ];

    for (const [forumType, name, governingLaw, eligibility, category, deadlineSource, limitDays, extDays] of caseTypeInserts) {
      await client.query(
        `INSERT INTO case_types (forum_type, name, governing_law, applicant_eligibility, filing_category, deadline_source, limitation_days, condonable_extension_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [forumType, name, governingLaw, eligibility, category, deadlineSource, limitDays, extDays]
      );
    }

    // Consumer Complaint case-law precedents (case type id 10000000-0000-0000-0000-000000000004,
    // fixed in the frontend's src/data/backendCaseTypeIds.ts). Each entry independently verified
    // (case title + reported citation confirmed against indiankanoon.org) before being added —
    // same discipline as FIXED_CASE_TYPE_CASE_LAW in src/lib/actReferenceMatcher.ts on the
    // frontend. `summary` is written as a holding clause (lowercase, no leading "Holds that") to
    // slot into "That the Hon'ble [court] in [case], [citation], has held that [summary]".
    const CC_COMPLAINT_CASE_TYPE_ID = '10000000-0000-0000-0000-000000000004';
    const precedentInserts: Array<[string, string, string, number, string, string]> = [
      [
        'Lucknow Development Authority v. M.K. Gupta',
        '(1994) 1 SCC 243',
        'Supreme Court of India',
        1993,
        'a statutory or development authority undertaking housing and development activity renders a service within the meaning of Section 2(1)(o) of the Act, and is liable for deficiency in that service on the same footing as a private housing developer.',
        'https://indiankanoon.org/doc/1375046/',
      ],
      [
        'Maruti Udyog Ltd. v. Susheel Kumar Gabgotra',
        '(2006) 4 SCC 644',
        'Supreme Court of India',
        2006,
        "a manufacturer's warranty obligation for a defective vehicle is ordinarily limited to repair or replacement of the defective part, not replacement of the entire vehicle or a refund, unless the warranty itself provides for that remedy.",
        'https://indiankanoon.org/doc/192244/',
      ],
      [
        'Indian Medical Association v. V.P. Shantha',
        '(1995) 6 SCC 651',
        'Supreme Court of India',
        1995,
        'medical services rendered for consideration, including by private hospitals, nursing homes and medical practitioners, fall within the definition of service under Section 2(1)(o) of the Act, except where services are rendered free of charge to every patient without exception.',
        'https://indiankanoon.org/doc/723973/',
      ],
      [
        'Spring Meadows Hospital v. Harjol Ahluwalia',
        '(1998) 4 SCC 39',
        'Supreme Court of India',
        1998,
        "a hospital is vicariously liable for the negligence of its staff, and parents who pay for a child's treatment are themselves consumers entitled to claim compensation for the mental agony they suffer on account of that negligence, separately from the compensation payable to the child.",
        'https://indiankanoon.org/doc/1715546/',
      ],
    ];

    for (const [caseTitle, citation, court, year, summary, sourceUrl] of precedentInserts) {
      await client.query(
        `INSERT INTO precedents (case_title, citation, court, year, summary, relevant_case_types, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (case_title) DO UPDATE SET
           citation = EXCLUDED.citation,
           court = EXCLUDED.court,
           year = EXCLUDED.year,
           summary = EXCLUDED.summary,
           relevant_case_types = EXCLUDED.relevant_case_types,
           source_url = EXCLUDED.source_url`,
        [caseTitle, citation, court, year, summary, [CC_COMPLAINT_CASE_TYPE_ID], sourceUrl]
      );
    }

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
