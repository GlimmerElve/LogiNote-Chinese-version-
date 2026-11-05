CREATE TABLE groups (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE group_memberships (
  group_id uuid NOT NULL REFERENCES groups(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('owner','administrator','member')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','left')),
  PRIMARY KEY (group_id,account_id)
);
CREATE TABLE protected_objects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES accounts(id),
  scope text NOT NULL CHECK (scope IN ('public','group','direct','self')),
  group_id uuid REFERENCES groups(id),
  state text NOT NULL DEFAULT 'visible' CHECK (state IN ('visible','restricted','withdrawn')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  restricted_until timestamptz,
  restriction_decision_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((scope='group')=(group_id IS NOT NULL)),
  CHECK (state<>'restricted' OR restricted_until IS NOT NULL)
);
CREATE TABLE direct_object_recipients (
  object_id uuid NOT NULL REFERENCES protected_objects(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (object_id,account_id)
);
CREATE TABLE reports (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('report','suggestion')),
  target_type text NOT NULL CHECK (target_type IN ('object','account')),
  target_object_id uuid REFERENCES protected_objects(id),
  target_account_id uuid REFERENCES accounts(id),
  subject_account_id uuid NOT NULL REFERENCES accounts(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','assigned','decided','appealed','closed')),
  assignee_account_id uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((target_type='object' AND target_object_id IS NOT NULL AND target_account_id IS NULL) OR
         (target_type='account' AND target_account_id IS NOT NULL AND target_object_id IS NULL))
);
CREATE INDEX reports_reporter ON reports(reporter_id,created_at DESC);
CREATE INDEX reports_queue ON reports(status,created_at);
CREATE TABLE report_evidence (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id),
  submitted_by uuid NOT NULL REFERENCES accounts(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 16000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE governance_decisions (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  report_id uuid NOT NULL REFERENCES reports(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL CHECK (action IN ('restrict_object','restore_object','restrict_account','restore_account','no_action')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  capabilities text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (capabilities <@ ARRAY['write','send_message','create_group']::text[])
);
ALTER TABLE protected_objects ADD CONSTRAINT protected_object_decision_fk
  FOREIGN KEY (restriction_decision_id) REFERENCES governance_decisions(id);
CREATE TABLE account_restrictions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  capability text NOT NULL CHECK (capability IN ('write','send_message','create_group')),
  decision_id uuid NOT NULL REFERENCES governance_decisions(id),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > starts_at),
  UNIQUE (decision_id,capability)
);
CREATE INDEX active_account_restrictions ON account_restrictions(account_id,capability,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE appeals (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL REFERENCES reports(id),
  decision_id uuid NOT NULL REFERENCES governance_decisions(id),
  appellant_id uuid NOT NULL REFERENCES accounts(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','upheld','restored')),
  reviewer_id uuid REFERENCES accounts(id),
  review_reason text CHECK (length(review_reason) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at timestamptz
);
CREATE UNIQUE INDEX one_pending_appeal ON appeals(report_id) WHERE status='pending';
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id uuid NOT NULL REFERENCES accounts(id),
  report_id uuid NOT NULL REFERENCES reports(id),
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_events_report ON audit_events(report_id,created_at,id);
