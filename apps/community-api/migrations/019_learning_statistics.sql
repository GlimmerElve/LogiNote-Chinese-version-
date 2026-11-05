CREATE TABLE learning_statistics_policies (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  metrics text[] NOT NULL CHECK (cardinality(metrics) BETWEEN 1 AND 3 AND metrics <@ ARRAY['streak','activeDaysThisMonth','avgDailyMinutes']::text[]),
  scope text NOT NULL DEFAULT 'public' CHECK (scope IN ('public','groups')),
  group_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(group_ids)<=10),
  source_device_id uuid REFERENCES community_devices(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_statistics_snapshots (
  account_id uuid PRIMARY KEY REFERENCES learning_statistics_policies(account_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES community_devices(id),
  policy_revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  fingerprint char(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
