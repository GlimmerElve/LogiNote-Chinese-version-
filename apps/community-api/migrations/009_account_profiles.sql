CREATE TABLE account_profiles (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
  interests text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 8),
  updated_at timestamptz NOT NULL DEFAULT now()
);
