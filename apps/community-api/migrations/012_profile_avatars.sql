-- Small, normalized account thumbnails. Source photos and EXIF are never stored.
ALTER TABLE account_profiles ADD COLUMN avatar_data text
  CHECK (avatar_data IS NULL OR octet_length(avatar_data) <= 44000);
ALTER TABLE account_profiles ADD COLUMN avatar_version bigint NOT NULL DEFAULT 0
  CHECK (avatar_version >= 0);
