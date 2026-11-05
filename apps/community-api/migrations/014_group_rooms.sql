ALTER TABLE groups ADD COLUMN name text NOT NULL DEFAULT '共学群' CHECK (length(name) BETWEEN 1 AND 80);
ALTER TABLE groups ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description)<=1000);
ALTER TABLE groups ADD COLUMN join_policy text NOT NULL DEFAULT 'open' CHECK (join_policy IN ('open','request'));
ALTER TABLE groups ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived'));
ALTER TABLE groups ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE group_memberships DROP CONSTRAINT group_memberships_state_check;
ALTER TABLE group_memberships ADD CONSTRAINT group_memberships_state_check CHECK (state IN ('active','left','requested','invited','banned'));
ALTER TABLE group_memberships ADD COLUMN muted_until timestamptz;
ALTER TABLE group_memberships ADD COLUMN updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX group_single_owner ON group_memberships(group_id) WHERE role='owner' AND state='active';
CREATE INDEX group_members_by_account ON group_memberships(account_id,state,group_id);
CREATE TABLE group_room_messages (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  group_id uuid NOT NULL REFERENCES groups(id),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  client_id uuid NOT NULL,
  thread_id uuid REFERENCES group_room_messages(object_id),
  body text NOT NULL CHECK (length(body)<=8000),
  pinned boolean NOT NULL DEFAULT false,
  thread_closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE(group_id,sender_id,client_id),
  CHECK (thread_id IS NULL OR NOT pinned AND NOT thread_closed)
);
CREATE INDEX group_room_timeline ON group_room_messages(group_id,thread_id,position);
CREATE TABLE group_message_stages (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  sender_id uuid NOT NULL REFERENCES accounts(id),
  thread_id uuid REFERENCES group_room_messages(object_id)
);
CREATE TABLE group_room_drafts (
  group_id uuid NOT NULL REFERENCES groups(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  context text NOT NULL,
  draft jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(draft)='object'),
  PRIMARY KEY(group_id,account_id,context)
);
CREATE TABLE group_management_events (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  target_id uuid REFERENCES accounts(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX group_audit_history ON group_management_events(group_id,created_at DESC,id);
CREATE TABLE group_room_changes (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  message_id uuid NOT NULL REFERENCES group_room_messages(object_id)
);
CREATE INDEX group_room_changes_cursor ON group_room_changes(group_id,sequence);
CREATE FUNCTION record_group_message_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO group_room_changes(group_id,message_id) VALUES(NEW.group_id,NEW.object_id);
  IF TG_OP='INSERT' AND NEW.thread_id IS NOT NULL THEN
    INSERT INTO group_room_changes(group_id,message_id) VALUES(NEW.group_id,NEW.thread_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_message_change AFTER INSERT OR UPDATE ON group_room_messages FOR EACH ROW EXECUTE FUNCTION record_group_message_change();
CREATE FUNCTION record_group_object_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO group_room_changes(group_id,message_id) SELECT group_id,object_id FROM group_room_messages WHERE object_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER group_object_change AFTER UPDATE OF state,restricted_until ON protected_objects FOR EACH ROW EXECUTE FUNCTION record_group_object_change();
