ALTER TABLE group_memberships ADD COLUMN learning_paused boolean NOT NULL DEFAULT false;
CREATE TABLE group_tasks (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body text NOT NULL DEFAULT '' CHECK (length(body)<=8000),
  due_on date,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX group_tasks_by_group ON group_tasks(group_id,created_at DESC,object_id);
CREATE TABLE group_task_progress (
  task_id uuid NOT NULL REFERENCES group_tasks(object_id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  state text NOT NULL CHECK (state IN ('none','doing','done')),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(task_id,account_id),
  CHECK ((state='done') = (completed_at IS NOT NULL))
);
CREATE TABLE group_task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES group_tasks(object_id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX group_task_activity ON group_task_events(task_id,id DESC);
