import { readFile } from 'node:fs/promises';
import { db } from './db.js';

const files = [
  '001_init.sql', '002_store_settings.sql', '003_quick_orders_integrations.sql',
  '004_loyalty.sql', '005_loyalty_redemptions.sql', '006_operations_ui.sql',
  '007_process_camera_mapping.sql', '008_technician_assignments.sql',
  '009_order_share_links.sql', '010_order_soft_delete.sql', '011_shop_devices.sql',
  '012_step_recordings.sql', '013_camera_device_binding.sql', '014_order_process_snapshot.sql'
];
let client;
try {
  client = await db.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema() || ':nextvision-migrate'))");
  for (const file of files) {
    await client.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
  }
  await client.query('COMMIT');
  console.log('Migração concluída');
} catch (error) {
  if (client) await client.query('ROLLBACK');
  throw error;
} finally {
  client?.release();
  await db.end();
}
