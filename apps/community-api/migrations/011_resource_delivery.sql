CREATE TABLE resource_upload_stages (
  object_id uuid PRIMARY KEY REFERENCES protected_objects(id),
  owner_id uuid NOT NULL REFERENCES accounts(id),
  published_entry_id uuid REFERENCES community_entries(object_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resource_stage_files (
  stage_id uuid NOT NULL REFERENCES resource_upload_stages(object_id),
  attachment_id uuid UNIQUE NOT NULL REFERENCES private_attachments(id),
  role text NOT NULL CHECK(role IN ('main','attachment','image','cover')),
  removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(stage_id,attachment_id)
);
CREATE UNIQUE INDEX resource_stage_main ON resource_stage_files(stage_id) WHERE role='main' AND NOT removed;
CREATE UNIQUE INDEX resource_stage_cover ON resource_stage_files(stage_id) WHERE role='cover' AND NOT removed;
CREATE TABLE community_resource_versions (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES community_entries(object_id),
  version integer NOT NULL CHECK(version>0),
  title text NOT NULL,
  body text NOT NULL,
  license text NOT NULL,
  preview jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entry_id,version)
);
CREATE TABLE community_resource_files (
  version_id uuid NOT NULL REFERENCES community_resource_versions(id),
  attachment_id uuid NOT NULL REFERENCES private_attachments(id),
  role text NOT NULL CHECK(role IN ('main','attachment','image','cover')),
  PRIMARY KEY(version_id,attachment_id)
);
ALTER TABLE account_content_drafts ADD COLUMN stage_id uuid REFERENCES resource_upload_stages(object_id);
CREATE TABLE community_device_pairings (
  id uuid PRIMARY KEY,code_hash text UNIQUE NOT NULL,claim_hash text NOT NULL,
  label text NOT NULL,target_key uuid NOT NULL,
  account_id uuid REFERENCES accounts(id),device_id uuid,
  expires_at timestamptz NOT NULL,consumed_at timestamptz
);
CREATE TABLE community_devices (
  id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id),
  target_key uuid NOT NULL,label text NOT NULL,token_hash text UNIQUE NOT NULL,
  is_default boolean NOT NULL DEFAULT true,revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz,
  UNIQUE(account_id,target_key)
);
CREATE UNIQUE INDEX community_default_device ON community_devices(account_id) WHERE is_default AND revoked_at IS NULL;
CREATE TABLE community_receipts (
  id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id),
  entry_id uuid NOT NULL REFERENCES community_entries(object_id),version_id uuid NOT NULL REFERENCES community_resource_versions(id),
  device_id uuid REFERENCES community_devices(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','receiving','stored','imported','indexing','indexed','failed','cancelled','blocked')),
  lease_hash text,lease_until timestamptz,result jsonb,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,version_id)
);
CREATE INDEX community_receipts_queue ON community_receipts(account_id,state,created_at);
