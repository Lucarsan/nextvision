import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (Boolean(email) !== Boolean(password)) throw new Error('BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD devem ser configuradas juntas');
// The API must never start against the previous schema. The migration runner
// serializes deployments and records each migration transactionally.
execFileSync(process.execPath, [fileURLToPath(new URL('./migrate.js', import.meta.url))], { stdio: 'inherit', env: process.env });
if (email && password) {
  execFileSync(process.execPath, ['src/bootstrap.js'], { stdio: 'inherit', env: process.env });
}
await import('./server.js');
