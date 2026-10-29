ALTER TABLE tenants ADD COLUMN IF NOT EXISTS camera_limit integer NOT NULL DEFAULT 1 CHECK(camera_limit BETWEEN 1 AND 128);
-- Preserve previously installed cameras on upgrade; never disable them silently.
UPDATE tenants t SET camera_limit=GREATEST(camera_limit,(SELECT count(*)::int FROM cameras c WHERE c.tenant_id=t.id AND c.deleted_at IS NULL));

CREATE OR REPLACE FUNCTION enforce_camera_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed integer; installed integer;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT camera_limit INTO allowed FROM tenants WHERE id=NEW.tenant_id FOR UPDATE;
  SELECT count(*) INTO installed FROM cameras WHERE tenant_id=NEW.tenant_id AND deleted_at IS NULL AND id<>NEW.id;
  IF installed>=allowed THEN RAISE EXCEPTION 'camera_limit_reached' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cameras_enforce_plan BEFORE INSERT OR UPDATE OF tenant_id,deleted_at ON cameras
FOR EACH ROW EXECUTE FUNCTION enforce_camera_limit();

CREATE OR REPLACE FUNCTION protect_camera_limit_reduction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.camera_limit<(SELECT count(*) FROM cameras WHERE tenant_id=NEW.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'camera_limit_below_installed' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenants_protect_camera_limit BEFORE UPDATE OF camera_limit ON tenants
FOR EACH ROW EXECUTE FUNCTION protect_camera_limit_reduction();

CREATE TABLE platform_settings(id boolean PRIMARY KEY DEFAULT true CHECK(id),sales_whatsapp text NOT NULL DEFAULT '' CHECK(sales_whatsapp='' OR sales_whatsapp~'^[0-9]{10,15}$'));
INSERT INTO platform_settings(id) VALUES(true);
