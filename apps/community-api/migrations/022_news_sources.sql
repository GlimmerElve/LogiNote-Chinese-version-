-- Sources are a fixed server-side catalog. An administrator must explicitly
-- authorize each enabled source; deployment never enables network collection.
CREATE TABLE news_sources (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 360 CHECK(interval_minutes BETWEEN 60 AND 10080),
  version integer NOT NULL DEFAULT 1,
  authorized_by uuid REFERENCES accounts(id),
  authorized_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_check_at timestamptz,
  last_status text NOT NULL DEFAULT 'idle',
  last_error text NOT NULL DEFAULT '',
  consecutive_failures integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  etag text,
  last_modified text,
  backlog jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(backlog)='array' AND jsonb_array_length(backlog)<=200),
  lease_token uuid,
  lease_until timestamptz,
  CHECK(NOT enabled OR authorized_by IS NOT NULL AND authorized_at IS NOT NULL)
);
INSERT INTO news_sources(id) VALUES ('ruanyifeng'),('sspai'),('solidot'),('sciencenet-news'),('sciencenet-math'),('infoq'),('oschina'),('ithome');
CREATE INDEX news_sources_due ON news_sources(next_check_at) WHERE enabled;
CREATE TABLE news_source_events (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL REFERENCES news_sources(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  enabled boolean NOT NULL,
  interval_minutes integer NOT NULL,
  created_at timestamptz NOT NULL
);
-- Reserve the maximum response bytes before each network request. A crashed
-- process leaves its reservation charged, so another process cannot overspend.
CREATE TABLE news_source_usage (
  day date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0 CHECK(requests>=0),
  bytes bigint NOT NULL DEFAULT 0 CHECK(bytes>=0)
);
CREATE TABLE news_source_runs (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES news_sources(id),
  actor_id uuid NOT NULL REFERENCES accounts(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'collecting',
  imported integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  ignored integer NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT ''
);
CREATE INDEX news_source_runs_latest ON news_source_runs(source_id,started_at DESC,id DESC);
ALTER TABLE news_articles ADD COLUMN source_id text REFERENCES news_sources(id);
ALTER TABLE news_articles ADD COLUMN source_published_at timestamptz;
ALTER TABLE news_articles ADD COLUMN source_date_label text;
-- Tombstones deliberately outlive rejection, withdrawal and moderation. The
-- next feed fetch must never resurrect an old item as a new review candidate.
CREATE TABLE news_source_items (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES news_sources(id),
  guid_hash char(64) NOT NULL,
  url_hash char(64) NOT NULL UNIQUE,
  article_id uuid REFERENCES news_articles(id),
  first_seen_at timestamptz NOT NULL
);
-- GUID aliases and canonical URLs are independent tombstones. If a second
-- source points to an already-seen URL, its GUID must still be remembered; a
-- later URL change on that GUID may not resurrect rejected/withdrawn content.
CREATE TABLE news_source_guids (
  source_id text NOT NULL REFERENCES news_sources(id),
  guid_hash char(64) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  PRIMARY KEY(source_id,guid_hash)
);
