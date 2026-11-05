CREATE TABLE community_entries (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  kind text NOT NULL CHECK (kind IN ('post','question','resource')),
  title text NOT NULL DEFAULT '' CHECK (char_length(title)<=160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 50000),
  resource_type text CHECK (resource_type IN ('note','route','exercise','link')),
  topics text[] NOT NULL DEFAULT '{}' CHECK (cardinality(topics)<=3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='resource')=(resource_type IS NOT NULL))
);
CREATE INDEX community_entries_created ON community_entries(created_at DESC,object_id DESC);
CREATE TABLE community_comments (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  entry_id uuid NOT NULL REFERENCES community_entries(object_id),
  reply_to_id uuid REFERENCES community_comments(object_id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_comments_parent ON community_comments(entry_id,created_at,position);
CREATE TABLE account_bookmarks (
  account_id uuid NOT NULL REFERENCES accounts(id),
  entry_id uuid NOT NULL REFERENCES community_entries(object_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,entry_id)
);
CREATE TABLE account_learning_resources (
  account_id uuid NOT NULL REFERENCES accounts(id),
  entry_id uuid NOT NULL REFERENCES community_entries(object_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,entry_id)
);
CREATE TABLE account_follows (
  follower_id uuid NOT NULL REFERENCES accounts(id),
  followed_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(follower_id,followed_id),
  CHECK(follower_id<>followed_id)
);
CREATE TABLE account_content_drafts (
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK(kind IN ('post','resource')),
  title text NOT NULL DEFAULT '' CHECK(char_length(title)<=160),
  body text NOT NULL DEFAULT '' CHECK(char_length(body)<=50000),
  topics text[] NOT NULL DEFAULT '{}' CHECK(cardinality(topics)<=3),
  scope text NOT NULL DEFAULT 'public' CHECK(scope IN ('public','self')),
  resource_type text NOT NULL DEFAULT 'note' CHECK(resource_type IN ('note','route','exercise','link')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,kind)
);
