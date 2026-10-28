import 'dotenv/config';
import { execFileSync } from 'node:child_process';
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (Boolean(email) !== Boolean(password)) throw new Error('BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD devem ser configuradas juntas');
if (email && password) {
  execFileSync(process.execPath, ['src/bootstrap.js'], { stdio: 'inherit', env: process.env });
}
await import('./server.js');
