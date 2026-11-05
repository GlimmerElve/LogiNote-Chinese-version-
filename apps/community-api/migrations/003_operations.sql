CREATE TABLE idempotency_results (
  actor_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  payload_hash char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id,idempotency_key)
);

CREATE TABLE rate_limits (
  bucket text PRIMARY KEY CHECK (length(bucket) BETWEEN 1 AND 240),
  used integer NOT NULL CHECK (used > 0),
  reset_at timestamptz NOT NULL
);

CREATE TABLE storage_reservations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reservation_key text NOT NULL CHECK (length(reservation_key) BETWEEN 1 AND 200),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 1 AND 10485760),
  state text NOT NULL CHECK (state IN ('reserved','committed','released')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id,reservation_key)
);
CREATE INDEX storage_reservations_usage_idx ON storage_reservations(state,expires_at,account_id);

CREATE TABLE background_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 120),
  dedup_key text NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  available_at timestamptz NOT NULL,
  worker_id text,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind,dedup_key),
  CHECK ((state='running') = (lease_until IS NOT NULL))
);
CREATE INDEX background_jobs_claim_idx ON background_jobs(state,available_at,lease_until);

CREATE TABLE attention_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ordinary_alerts_enabled boolean NOT NULL DEFAULT false,
  system_push_enabled boolean NOT NULL DEFAULT false,
  sound_enabled boolean NOT NULL DEFAULT false,
  vibration_enabled boolean NOT NULL DEFAULT false,
  show_unread_badges boolean NOT NULL DEFAULT false CHECK (show_unread_badges=false),
  replay_after_focus boolean NOT NULL DEFAULT false CHECK (replay_after_focus=false),
  focus boolean NOT NULL DEFAULT false,
  quiet_hours jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO attention_preferences(account_id) SELECT id FROM accounts ON CONFLICT DO NOTHING;

CREATE TABLE attention_events (
  id uuid PRIMARY KEY,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  recipient_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ordinary','system')),
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (recipient_id,event_id)
);
CREATE TABLE attention_deliveries (
  event_record_id uuid PRIMARY KEY REFERENCES attention_events(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('suppressed','not_configured','pending','delivered','failed')),
  reason text,
  provider_receipt_id text,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK ((status='delivered') = (delivered_at IS NOT NULL)),
  CHECK (status<>'delivered' OR provider_receipt_id IS NOT NULL)
);
CREATE INDEX attention_events_recipient_idx ON attention_events(recipient_id,created_at);
