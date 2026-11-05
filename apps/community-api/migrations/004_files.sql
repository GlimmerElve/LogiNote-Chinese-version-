CREATE TABLE private_attachments (
  id uuid PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES protected_objects(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES storage_reservations(id),
  intent_key text NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 200),
  intent_hash char(64) NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (length(mime) BETWEEN 1 AND 120),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 1 AND 10485760),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','cancelled')),
  upload_token_hash char(64) NOT NULL,
  upload_expires_at timestamptz NOT NULL,
  content_hash char(64),
  stored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_id,intent_key),
  CHECK ((state='ready')=(content_hash IS NOT NULL AND stored_at IS NOT NULL))
);
CREATE INDEX private_attachments_object_idx ON private_attachments(object_id,state);
CREATE TABLE attachment_download_grants (
  token_hash char(64) PRIMARY KEY,
  attachment_id uuid NOT NULL REFERENCES private_attachments(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX attachment_download_grants_expiry_idx ON attachment_download_grants(expires_at);
