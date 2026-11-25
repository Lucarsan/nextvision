// Senha colada do WhatsApp ou do e-mail costuma vir com espaço no fim ou caractere invisível.
// Primeiro compara exatamente o que foi digitado; só se falhar, tenta sem esses extras.
// Assim quem tem espaço de propósito na senha continua entrando.
import bcrypt from 'bcryptjs';

const INVISIBLE = /[​-‏‪-‮⁠﻿]/g;

export const cleanPassword = s => String(s ?? '').replace(INVISIBLE, '').trim();

export async function passwordMatches(plain, hash) {
  if (!hash) return false;
  if (await bcrypt.compare(plain, hash)) return true;
  const clean = cleanPassword(plain);
  return clean !== plain && clean.length > 0 && bcrypt.compare(clean, hash);
}
