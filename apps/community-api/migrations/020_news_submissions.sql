CREATE TABLE news_articles (
  id uuid PRIMARY KEY REFERENCES protected_objects(id),
  kind text NOT NULL CHECK(kind IN ('news','article','announcement')),
  origin text NOT NULL CHECK(origin IN ('user','manual','feed')),
  version integer NOT NULL DEFAULT 1,
  latest_revision_id uuid,
  published_revision_id uuid,
  withdrawn_by uuid REFERENCES accounts(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE news_revisions (
  id uuid PRIMARY KEY REFERENCES protected_objects(id),
  article_id uuid NOT NULL REFERENCES news_articles(id),
  number integer NOT NULL,
  state text NOT NULL CHECK(state IN ('draft','pending','returned','rejected','approved')),
  title text NOT NULL DEFAULT '' CHECK(char_length(title)<=160),
  body text NOT NULL DEFAULT '' CHECK(char_length(body)<=40000),
  topics text[] NOT NULL DEFAULT '{}' CHECK(cardinality(topics)<=3),
  source_url text NOT NULL DEFAULT '' CHECK(char_length(source_url)<=2000),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  submitted_at timestamptz,
  UNIQUE(article_id,number)
);
ALTER TABLE news_articles ADD FOREIGN KEY(latest_revision_id) REFERENCES news_revisions(id);
ALTER TABLE news_articles ADD FOREIGN KEY(published_revision_id) REFERENCES news_revisions(id);
ALTER TABLE protected_objects ADD COLUMN news_article_id uuid REFERENCES news_articles(id);
ALTER TABLE resource_upload_stages ADD COLUMN news_revision_id uuid REFERENCES news_revisions(id);
CREATE TABLE news_revision_images (
  revision_id uuid NOT NULL REFERENCES news_revisions(id),
  attachment_id uuid NOT NULL REFERENCES private_attachments(id),
  PRIMARY KEY(revision_id,attachment_id)
);
CREATE INDEX news_revision_images_file ON news_revision_images(attachment_id);
CREATE INDEX news_review_queue ON news_revisions(submitted_at,id) WHERE state='pending';
CREATE TABLE news_events (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES news_articles(id),
  revision_id uuid REFERENCES news_revisions(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  action text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL
);
CREATE INDEX news_events_article ON news_events(article_id,position);
