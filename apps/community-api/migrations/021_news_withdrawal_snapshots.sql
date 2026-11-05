ALTER TABLE news_revisions DROP CONSTRAINT news_revisions_state_check;
ALTER TABLE news_revisions ADD CONSTRAINT news_revisions_state_check
  CHECK(state IN ('draft','pending','returned','rejected','approved','withdrawn'));

ALTER TABLE news_articles ADD COLUMN withdrawn_action text
  CHECK(withdrawn_action IN ('author','moderator'));

-- Actor identity alone cannot distinguish an official author's moderation action
-- from that same author's voluntary withdrawal. Prefer the recorded action.
UPDATE news_articles n SET withdrawn_action=COALESCE(
  (SELECT CASE WHEN e.action='down' THEN 'moderator' ELSE 'author' END
   FROM news_events e WHERE e.article_id=n.id AND e.action IN ('down','withdraw_published')
   ORDER BY e.position DESC LIMIT 1),
  CASE WHEN n.withdrawn_by=(SELECT o.owner_id FROM protected_objects o WHERE o.id=n.id)
    THEN 'author' ELSE 'moderator' END)
WHERE n.withdrawn_by IS NOT NULL;
