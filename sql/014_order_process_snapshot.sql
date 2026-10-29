-- Freeze the process definition per order. Existing history can only be
-- initialized from the definition available at migration time.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS process_snapshot jsonb;

UPDATE orders o SET process_snapshot=jsonb_build_object(
  'name',p.name,'steps',p.steps,'camera_id',p.camera_id,'step_cameras',p.step_cameras
)
FROM processes p
WHERE p.id=o.process_id AND p.tenant_id=o.tenant_id AND o.process_snapshot IS NULL;

ALTER TABLE orders ALTER COLUMN process_snapshot SET NOT NULL;

CREATE OR REPLACE FUNCTION freeze_order_process() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE definition processes%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.process_snapshot IS DISTINCT FROM OLD.process_snapshot
       OR NEW.process_id IS DISTINCT FROM OLD.process_id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'Order process definition is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  -- A shared lock makes copying atomic with concurrent process edits.
  SELECT * INTO definition FROM processes
    WHERE id=NEW.process_id AND tenant_id=NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Process does not belong to this tenant' USING ERRCODE='23503';
  END IF;
  NEW.process_snapshot=jsonb_build_object('name',definition.name,'steps',definition.steps,
    'camera_id',definition.camera_id,'step_cameras',definition.step_cameras);
  NEW.camera_id=CASE WHEN definition.step_cameras ? '0'
    THEN (definition.step_cameras->>'0')::uuid ELSE definition.camera_id END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_freeze_process ON orders;
CREATE TRIGGER orders_freeze_process
BEFORE INSERT OR UPDATE OF process_snapshot,process_id,tenant_id ON orders
FOR EACH ROW EXECUTE FUNCTION freeze_order_process();
