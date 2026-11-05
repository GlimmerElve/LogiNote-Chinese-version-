CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 80),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member','administrator')),
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  login_failures integer NOT NULL DEFAULT 0 CHECK (login_failures >= 0),
  login_locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  mfa_verified_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account_id_idx ON sessions(account_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_account_purpose_idx ON auth_tokens(account_id,purpose);
CREATE INDEX auth_tokens_expiry_idx ON auth_tokens(expires_at);

CREATE TABLE account_mfa (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  pending_expires_at timestamptz,
  enabled_at timestamptz,
  last_used_step bigint,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (enabled_at IS NOT NULL OR pending_expires_at IS NOT NULL)
);
