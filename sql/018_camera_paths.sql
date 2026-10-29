ALTER TABLE cameras ADD COLUMN stream_path text;
UPDATE cameras SET stream_path='camera_'||replace(id::text,'-','');
ALTER TABLE cameras ALTER COLUMN stream_path SET NOT NULL;
ALTER TABLE cameras ALTER COLUMN stream_path SET DEFAULT ('camera_'||replace(gen_random_uuid()::text,'-',''));
ALTER TABLE cameras ADD CONSTRAINT cameras_stream_path_format CHECK(stream_path~'^[A-Za-z0-9_-]{1,100}$');
CREATE UNIQUE INDEX cameras_stream_path_unique ON cameras(stream_path);
ALTER TABLE cameras ADD COLUMN config_version integer NOT NULL DEFAULT 1;
