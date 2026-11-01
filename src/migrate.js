import { readFile } from 'node:fs/promises';
import { db } from './db.js';

const files = [
  '001_init.sql', '002_store_settings.sql', '003_quick_orders_integrations.sql',
  '004_loyalty.sql', '005_loyalty_redemptions.sql', '006_operations_ui.sql',
  '007_process_camera_mapping.sql', '008_technician_assignments.sql',
  '009_order_share_links.sql', '010_order_soft_delete.sql', '011_shop_devices.sql',
  '012_step_recordings.sql', '013_camera_device_binding.sql', '014_order_process_snapshot.sql',
  '015_store_operations.sql', '016_camera_control.sql', '017_camera_plans.sql', '018_camera_paths.sql', '019_ready_message.sql', '020_short_order_links.sql', '021_order_photos.sql', '022_store_panel_fields.sql', '023_support_and_process_archive.sql', '024_store_media.sql', '025_cash_sales.sql', '026_cash_expenses.sql', '027_customer_soft_delete.sql', '028_sale_quick_items.sql', '029_store_qr_contact.sql', '030_products_barcode.sql', '031_products_cost_stock.sql', '032_sale_seller.sql', '033_sale_item_prices.sql', '034_user_access_level.sql', '035_variants_stock_ledger.sql', '036_email_reports.sql', '037_service_sales_parts.sql', '038_store_backups.sql', '039_cashback.sql', '040_link_analytics.sql', '041_stock_log_label_queue.sql'
];
let client;
let currentMigration='connection';
try {
  client = await db.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext(current_database() || ':' || current_schema() || ':nextvision-migrate'))");
  await client.query('CREATE TABLE IF NOT EXISTS nextvision_schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of files) {
    if ((await client.query('SELECT 1 FROM nextvision_schema_migrations WHERE name=$1', [file])).rowCount) continue;
    currentMigration=file;
    await client.query(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'));
    await client.query('INSERT INTO nextvision_schema_migrations(name) VALUES($1)', [file]);
  }
  await client.query('COMMIT');
  console.log('Migração concluída');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(()=>{});
  // PostgreSQL detail/row data and connection strings must not enter startup logs.
  console.error('Migration failed', { migration: currentMigration, code: error.code || error.name });
  process.exitCode=1;
} finally {
  client?.release();
  await db.end();
}
