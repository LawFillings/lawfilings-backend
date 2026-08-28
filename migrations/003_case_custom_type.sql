-- Migration 003: free-text case type + generic tribunal filing-type catalog entries
-- The "Type" column on My Cases only offered the narrow set of case_types tied to real wizard
-- flows (7 unique types across DRT/DRAT/NCLT/consumer_commission/district_court). Users
-- classifying a manually-added diary case as an OA/IA/RA/MA/Petition/Application had no matching
-- option and no way to write their own label.

ALTER TABLE cases ADD COLUMN custom_type_label TEXT;

INSERT INTO case_types (forum_type, name) VALUES
  ('General', 'Original Application (OA)'),
  ('General', 'Interlocutory Application (IA)'),
  ('General', 'Review Application (RA)'),
  ('General', 'Miscellaneous Application (MA)'),
  ('General', 'Petition'),
  ('General', 'Application');
