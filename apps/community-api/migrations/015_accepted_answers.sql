ALTER TABLE community_entries ADD COLUMN accepted_comment_id uuid REFERENCES community_comments(object_id);
ALTER TABLE community_entries ADD COLUMN accepted_by uuid REFERENCES accounts(id);
ALTER TABLE community_entries ADD COLUMN solved_at timestamptz;
ALTER TABLE community_entries ADD CONSTRAINT solution_only_for_questions CHECK (accepted_comment_id IS NULL OR kind='question');
ALTER TABLE community_entries ADD CONSTRAINT solution_attribution CHECK ((accepted_comment_id IS NULL)=(accepted_by IS NULL) AND (accepted_comment_id IS NULL)=(solved_at IS NULL));
