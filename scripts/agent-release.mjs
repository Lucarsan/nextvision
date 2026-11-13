#!/usr/bin/env node
// Pacotes de atualização remota do agente (só os scripts PowerShell; binários continuam no instalador).
//
//   node scripts/agent-release.mjs keygen <pasta-fora-do-repositorio>
//     Cria a chave de assinatura (privada fica na pasta indicada; NUNCA no repositório)
//     e mostra a chave pública no formato que vai em FicouPronto.psm1.
//
//   node scripts/agent-release.mjs build --key <private.pem>
//     Lê installer/windows/payload/*.ps1|*.psm1 + connect/windows/NextVision.Core.psm1,
//     assina e grava agent-releases/<versao>.json (a central serve esse arquivo).
//
// Formato: { format: 1, key_id, payload: base64(JSON do manifesto), signature: base64(RSA-SHA256 PKCS#1 v1.5 do payload) }
// Manifesto: { format: 1, version, created_at, notes, files: [{ name, size, sha256, content }] } (content em base64).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = s => Buffer.from(s, 'base64url').toString('base64');
const asPublic = k => (k instanceof crypto.KeyObject && k.type === 'public') ? k : crypto.createPublicKey(k);

export function publicKeyXml(publicKey) {
  const jwk = asPublic(publicKey).export({ format: 'jwk' });
  return '<RSAKeyValue><Modulus>' + b64(jwk.n) + '</Modulus><Exponent>' + b64(jwk.e) + '</Exponent></RSAKeyValue>';
}

export const keyId = publicKey => crypto.createHash('sha256').update(asPublic(publicKey).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(ps1|psm1)$/;
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function agentFiles(root = repo) {
  const payload = path.join(root, 'installer/windows/payload');
  const list = fs.readdirSync(payload).filter(n => FILE_NAME.test(n)).map(n => path.join(payload, n));
  list.push(path.join(root, 'connect/windows/NextVision.Core.psm1'));
  return list.sort();
}

export function buildRelease({ privateKey, files, version, notes = '', createdAt = new Date().toISOString() }) {
  if (!VERSION.test(version)) throw new Error('Versão inválida: ' + version);
  const entries = files.map(f => {
    const name = path.basename(f);
    if (!FILE_NAME.test(name)) throw new Error('Nome de arquivo não permitido: ' + name);
    const bytes = fs.readFileSync(f);
    return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), content: bytes.toString('base64') };
  });
  const payload = Buffer.from(JSON.stringify({ format: 1, version, created_at: createdAt, notes: String(notes).slice(0, 300), files: entries }), 'utf8');
  const signature = crypto.sign('sha256', payload, privateKey);
  return { format: 1, key_id: keyId(privateKey), payload: payload.toString('base64'), signature: signature.toString('base64') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'keygen') {
    const dir = rest[0];
    if (!dir) throw new Error('Informe a pasta (fora do repositório) para guardar a chave privada.');
    const out = path.resolve(dir);
    if (out.startsWith(repo + path.sep) || out === repo) throw new Error('A chave privada não pode ficar dentro do repositório.');
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = path.join(out, 'ficoupronto-agent-signing.pem');
    if (fs.existsSync(file)) throw new Error('Já existe uma chave em ' + file);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log('Chave privada: ' + file);
    console.log('key_id: ' + keyId(publicKey));
    console.log('Chave pública (XML): ' + publicKeyXml(publicKey));
    return;
  }
  if (cmd === 'build') {
    const keyFile = opt('--key');
    if (!keyFile) throw new Error('Use --key <private.pem>');
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
    const psm1 = fs.readFileSync(path.join(repo, 'installer/windows/payload/FicouPronto.psm1'), 'utf8');
    const version = (psm1.match(/^\$script:AgentVersion = '([^']+)'/m) || [])[1];
    const trusted = (psm1.match(/AgentUpdateKeyId = '([0-9a-f]{16})'/) || [])[1];
    if (trusted !== keyId(privateKey)) throw new Error('A chave informada não é a que o agente confia (' + trusted + ').');
    const release = buildRelease({ privateKey, files: agentFiles(), version, notes: opt('--notes') || '' });
    const dir = path.join(repo, 'agent-releases');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, version + '.json');
    fs.writeFileSync(file, JSON.stringify(release) + '\n');
    const bytes = fs.statSync(file).size;
    console.log(file + ' ' + bytes + ' bytes sha256 ' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    return;
  }
  throw new Error('Uso: agent-release.mjs keygen <pasta> | build --key <private.pem> [--notes "..."]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
