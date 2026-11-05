-- Reuse only upstream identity verification. Community sessions and permissions
-- remain live reads, and no provider tokens or authorization results are cached.
ALTER TABLE hosted_sessions
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN identity_verified_email text;
