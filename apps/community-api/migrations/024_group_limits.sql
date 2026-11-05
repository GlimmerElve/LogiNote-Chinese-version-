CREATE TABLE group_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  member_limit integer NOT NULL DEFAULT 50 CHECK (member_limit BETWEEN 2 AND 500),
  created_group_limit integer NOT NULL DEFAULT 3 CHECK (created_group_limit BETWEEN 1 AND 20),
  joined_group_limit integer NOT NULL DEFAULT 10 CHECK (joined_group_limit BETWEEN 1 AND 100),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (created_group_limit<=joined_group_limit)
);
INSERT INTO group_limits(singleton) VALUES(true);

CREATE TABLE group_limit_changes (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_id uuid NOT NULL REFERENCES accounts(id),
  previous_limits jsonb NOT NULL CHECK (jsonb_typeof(previous_limits)='object'),
  new_limits jsonb NOT NULL CHECK (jsonb_typeof(new_limits)='object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
