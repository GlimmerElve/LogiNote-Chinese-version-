-- Provider identities stay separate from local accounts even when email matches.
ALTER TABLE accounts ADD COLUMN auth_provider text NOT NULL DEFAULT 'local'
  CHECK (auth_provider IN ('local','cloudbase'));
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE accounts DROP CONSTRAINT accounts_email_key;
CREATE UNIQUE INDEX accounts_local_email_unique ON accounts(email) WHERE auth_provider='local';
ALTER TABLE accounts ADD CONSTRAINT accounts_provider_credentials CHECK (
  (auth_provider='local' AND password_hash IS NOT NULL)
  OR (auth_provider='cloudbase' AND password_hash IS NULL AND email_verified_at IS NOT NULL)
);
ALTER TABLE accounts ADD CONSTRAINT accounts_id_auth_provider_unique UNIQUE (id,auth_provider);

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider='cloudbase'),
  environment text NOT NULL CHECK (environment ~ '^[A-Za-z0-9_-]{1,128}$'),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,environment,subject),
  FOREIGN KEY (account_id,provider) REFERENCES accounts(id,auth_provider) ON DELETE CASCADE
);
