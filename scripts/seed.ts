/**
 * Seeds the database with the forums, case types, and clauses designed across the schema docs
 * and mirrored in the frontend's src/data/mockData.ts. Run after `npm run migrate`.
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
