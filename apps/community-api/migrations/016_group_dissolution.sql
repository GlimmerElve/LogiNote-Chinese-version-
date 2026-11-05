ALTER TABLE groups DROP CONSTRAINT groups_state_check;
ALTER TABLE groups ADD CONSTRAINT groups_state_check CHECK (state IN ('active','archived','dissolved'));
ALTER TABLE groups ADD COLUMN dissolved_at timestamptz;
ALTER TABLE groups ADD CONSTRAINT groups_dissolved_at_check CHECK ((state='dissolved') = (dissolved_at IS NOT NULL));
