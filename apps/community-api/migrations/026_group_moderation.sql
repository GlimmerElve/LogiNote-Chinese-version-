-- A group has one public moderation identity; its private content keeps its own
-- group scope. Reuse the normal report/decision/appeal tables for this identity.
INSERT INTO protected_objects(id,owner_id,scope,state,created_at)
SELECT id,owner_id,'public',CASE WHEN state='dissolved' THEN 'withdrawn' ELSE 'visible' END,created_at FROM groups;

CREATE FUNCTION maintain_group_moderation_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO protected_objects(id,owner_id,scope,state,created_at)
    VALUES(NEW.id,NEW.owner_id,'public',CASE WHEN NEW.state='dissolved' THEN 'withdrawn' ELSE 'visible' END,NEW.created_at);
  ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    UPDATE protected_objects SET owner_id=NEW.owner_id,version=version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_moderation_object AFTER INSERT OR UPDATE OF owner_id ON groups
FOR EACH ROW EXECUTE FUNCTION maintain_group_moderation_object();
