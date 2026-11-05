-- Package type is derived from the validated main file by ResourceService.
ALTER TABLE community_entries DROP CONSTRAINT community_entries_resource_type_check;
ALTER TABLE community_entries ADD CONSTRAINT community_entries_resource_type_check CHECK(resource_type IN ('note','route','exercise','link','scene'));
ALTER TABLE account_content_drafts DROP CONSTRAINT account_content_drafts_resource_type_check;
ALTER TABLE account_content_drafts ADD CONSTRAINT account_content_drafts_resource_type_check CHECK(resource_type IN ('note','route','exercise','link','scene'));
