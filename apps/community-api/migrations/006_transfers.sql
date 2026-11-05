CREATE TABLE transfer_usage (
  period char(7) PRIMARY KEY,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
