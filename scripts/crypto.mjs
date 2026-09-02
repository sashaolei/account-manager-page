import { webcrypto as crypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const ITER = 250000;

export async function encrypt(plainBuffer, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const gz = gzipSync(plainBuffer, { level: 9 });
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz)
  );
  // формат файла: "AFE1" | salt(16) | iv(12) | ciphertext
  const out = new Uint8Array(4 + 16 + 12 + ct.length);
  out.set(new TextEncoder().encode('AFE1'), 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(ct, 32);
  return Buffer.from(out);
}

export async function decrypt(fileBuffer, passphrase) {
  const buf = new Uint8Array(fileBuffer);
  if (new TextDecoder().decode(buf.slice(0, 4)) !== 'AFE1') throw new Error('не тот формат файла');
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf.slice(4, 20), iterations: ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const gz = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.slice(20, 32) },
    key,
    buf.slice(32)
  );
  return gunzipSync(Buffer.from(gz));
}
