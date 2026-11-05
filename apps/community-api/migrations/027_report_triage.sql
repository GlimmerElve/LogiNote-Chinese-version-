ALTER TABLE reports ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent'));
ALTER TABLE reports ADD COLUMN next_feedback_at timestamptz;

-- Operational targets only: Monday-Friday in Shanghai, excluding the submit
-- date. Holidays and compensatory working weekends are intentionally not
-- inferred. The target is 18:00 on the second/fifth such day, not an SLA.
CREATE FUNCTION community_report_feedback_target(created timestamptz,workdays integer) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  target_date date := (created AT TIME ZONE 'Asia/Shanghai')::date;
  remaining integer := workdays;
BEGIN
  WHILE remaining>0 LOOP
    target_date := target_date+1;
    IF EXTRACT(ISODOW FROM target_date)<=5 THEN remaining := remaining-1; END IF;
  END LOOP;
  RETURN (target_date+time '18:00') AT TIME ZONE 'Asia/Shanghai';
END;
$$;
CREATE FUNCTION community_initialize_report_triage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.priority := CASE WHEN NEW.kind='report' AND NEW.category='serious_risk' THEN 'urgent' ELSE 'normal' END;
  NEW.next_feedback_at := community_report_feedback_target(NEW.created_at,CASE WHEN NEW.kind='suggestion' THEN 5 ELSE 2 END);
  RETURN NEW;
END;
$$;
CREATE TRIGGER initialize_report_triage BEFORE INSERT ON reports FOR EACH ROW EXECUTE FUNCTION community_initialize_report_triage();
UPDATE reports SET priority=CASE WHEN kind='report' AND category='serious_risk' THEN 'urgent' ELSE 'normal' END,
  next_feedback_at=community_report_feedback_target(created_at,CASE WHEN kind='suggestion' THEN 5 ELSE 2 END);
CREATE INDEX reports_feedback_queue ON reports ((priority='urgent') DESC,next_feedback_at,created_at,id) WHERE status<>'closed';
