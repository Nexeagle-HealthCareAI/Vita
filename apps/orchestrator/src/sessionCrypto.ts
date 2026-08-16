import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce size for GCM
const TAG_LENGTH = 16;

/**
 * Turns any SESSION_ENCRYPTION_KEY value into a usable 32-byte AES-256 key: a 64-char hex
 * string or a base64 string that decodes to exactly 32 bytes is used literally; anything
 * else (e.g. a passphrase) is hashed down via SHA-256 -- so any configured value produces
 * a valid key deterministically, with no separate "key format" decision for whoever sets it.
 */
export function deriveKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  return createHash('sha256').update(raw).digest();
}

/** Returns iv + authTag + ciphertext, base64-encoded as a single string so it stores as a
 * plain Redis string value with no schema change to the caller. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Inverse of encrypt(). Throws if the payload is malformed or the auth tag doesn't verify
 * (tampering, corruption, or the wrong key) -- authenticated encryption, not just secrecy. */
export function decrypt(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
