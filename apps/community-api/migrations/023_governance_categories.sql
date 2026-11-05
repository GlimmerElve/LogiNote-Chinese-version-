ALTER TABLE reports ADD COLUMN category text NOT NULL DEFAULT 'other'
  CHECK (category IN ('copyright','harassment','knowledge_error','serious_risk','other'));

CREATE TABLE suggestion_feedback (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  report_id uuid NOT NULL REFERENCES reports(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  outcome text NOT NULL CHECK (outcome IN ('adopted','evaluating','duplicate','declined')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  release_version text CHECK (length(release_version) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (release_version IS NULL OR outcome='adopted')
);
CREATE INDEX suggestion_feedback_report ON suggestion_feedback(report_id,sequence);
