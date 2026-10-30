// Criptografia de segredos guardados no banco (senha de vídeo da loja).
// Chave: MEDIA_SECRET_KEY (64 hex = 32 bytes). Sem ela, deriva-se uma chave do
// JWT_SECRET com HKDF, para não exigir mais uma variável no piloto. Trocar o
// JWT_SECRET sem definir MEDIA_SECRET_KEY torna as senhas guardadas ilegíveis.
import crypto from 'node:crypto';

const key = (() => {
  const configured = process.env.MEDIA_SECRET_KEY || '';
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  const base = process.env.JWT_SECRET || '';
  if (base.length < 32) throw Error('Configure JWT_SECRET ou MEDIA_SECRET_KEY');
  return Buffer.from(crypto.hkdfSync('sha256', base, 'nextvision', 'store-media-secret-v1', 32));
})();

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function open(sealed) {
  const match = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(sealed || ''));
  if (!match) throw Error('Segredo em formato desconhecido');
  const raw = Buffer.from(match[1], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const randomPassword = () => crypto.randomBytes(24).toString('base64url');
