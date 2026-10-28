import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { q, db } from './db.js';
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password || password.length < 16) throw new Error('Defina BOOTSTRAP_ADMIN_EMAIL e senha de 16+ caracteres');
try {
  const existing = await q("SELECT count(*)::int AS total FROM users WHERE role='master'");
  if (existing.rows[0].total > 0) {
    console.log('Administrador Master existente; bootstrap ignorado');
  } else {
    const hash = await bcrypt.hash(password, 12);
    const result = await q("INSERT INTO users(name,email,password_hash,role) VALUES('Administrador Master',$1,$2,'master') ON CONFLICT(email) DO NOTHING RETURNING id", [email.trim().toLowerCase(), hash]);
    console.log(result.rowCount ? 'Administrador Master inicial criado' : 'E-mail já cadastrado; nenhuma alteração');
  }
} finally {
  await db.end();
}
