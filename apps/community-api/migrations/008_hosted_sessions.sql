-- Provider credentials stay encrypted in the BFF; browsers receive only an opaque community cookie.
CREATE TABLE hosted_sessions (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  environment text NOT NULL,
  subject text NOT NULL,
  credentials_ciphertext text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hosted_email_challenges (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('register','reset_password','login')),
  verification_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hosted_email_challenges_expiry ON hosted_email_challenges(expires_at);
