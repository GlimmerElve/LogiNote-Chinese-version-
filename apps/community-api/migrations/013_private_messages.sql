CREATE TABLE account_blocks (
  blocker_id uuid NOT NULL REFERENCES accounts(id),
  blocked_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blocker_id,blocked_id),
  CHECK (blocker_id<>blocked_id)
);
CREATE TABLE community_conversations (
  id uuid PRIMARY KEY,
  low_id uuid NOT NULL REFERENCES accounts(id),
  high_id uuid NOT NULL REFERENCES accounts(id),
  initiator_id uuid NOT NULL REFERENCES accounts(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(low_id,high_id),
  CHECK (low_id<high_id),
  CHECK (initiator_id IN (low_id,high_id))
);
CREATE TABLE community_conversation_members (
  conversation_id uuid NOT NULL REFERENCES community_conversations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  hidden boolean NOT NULL DEFAULT false,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft)='object'),
  PRIMARY KEY(conversation_id,account_id)
);
CREATE TABLE community_message_stages (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  conversation_id uuid NOT NULL REFERENCES community_conversations(id),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL
);
CREATE TABLE community_messages (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  conversation_id uuid NOT NULL REFERENCES community_conversations(id),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  client_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body)<=8000),
  created_at timestamptz NOT NULL,
  UNIQUE(conversation_id,sender_id,client_id)
);
CREATE INDEX community_messages_history ON community_messages(conversation_id,position);
CREATE INDEX community_conversation_members_list ON community_conversation_members(account_id,hidden);
