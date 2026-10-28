ALTER TABLE processes ADD COLUMN IF NOT EXISTS camera_id uuid REFERENCES cameras(id);
ALTER TABLE processes ADD COLUMN IF NOT EXISTS step_cameras jsonb NOT NULL DEFAULT '{}'::jsonb;
