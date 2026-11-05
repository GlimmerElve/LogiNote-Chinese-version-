CREATE TABLE operator_audit (
  id uuid PRIMARY KEY,
  target_account_id uuid NOT NULL REFERENCES accounts(id),
  event_type text NOT NULL CHECK (event_type IN ('administrator.granted','administrator.revoked')),
  database_operator text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
