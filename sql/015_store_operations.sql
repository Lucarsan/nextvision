ALTER TABLE tenants ADD COLUMN IF NOT EXISTS niche text NOT NULL DEFAULT 'general'
  CHECK(niche IN ('general','automotive','carwash','electronics','pet','food'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'
  CHECK(jsonb_typeof(details)='object');

-- A new visit/continuation gets a new recording id and therefore a new file.
-- Preserve old recordings when returning to a stage or resuming after a pause.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS visit_index integer NOT NULL DEFAULT 0 CHECK(visit_index>=0);
DROP INDEX IF EXISTS recordings_one_per_step;
CREATE UNIQUE INDEX IF NOT EXISTS recordings_one_per_visit ON recordings(order_id,step_index,visit_index);

-- Keep manual priorities; append previously unranked orders chronologically.
WITH unranked AS (
  SELECT o.id,
    COALESCE((SELECT max(q.queue_rank) FROM orders q WHERE q.tenant_id=o.tenant_id AND q.status='queued' AND q.deleted_at IS NULL),0)
    +1000*row_number() OVER(PARTITION BY o.tenant_id ORDER BY o.created_at,o.id) AS rank
  FROM orders o WHERE o.status='queued' AND o.deleted_at IS NULL AND o.queue_rank IS NULL
)
UPDATE orders o SET queue_rank=u.rank FROM unranked u WHERE o.id=u.id;

CREATE OR REPLACE FUNCTION assign_order_queue_rank() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='queued' AND NEW.queue_rank IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text || ':order-queue'));
    SELECT COALESCE(max(queue_rank),0)+1000 INTO NEW.queue_rank
      FROM orders WHERE tenant_id=NEW.tenant_id AND status='queued' AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_assign_queue_rank ON orders;
CREATE TRIGGER orders_assign_queue_rank BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION assign_order_queue_rank();
