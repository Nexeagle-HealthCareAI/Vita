import { describe, expect, it } from 'vitest';
import { deriveKey, encrypt, decrypt } from '../src/sessionCrypto.js';

describe('sessionCrypto', () => {
  describe('deriveKey', () => {
    it('accepts a 64-char hex string literally', () => {
      const hex = 'a'.repeat(64);
      expect(deriveKey(hex)).toEqual(Buffer.from(hex, 'hex'));
    });

    it('accepts a base64 string that decodes to exactly 32 bytes literally', () => {
      const key32 = Buffer.alloc(32, 7);
      const b64 = key32.toString('base64');
      expect(deriveKey(b64)).toEqual(key32);
    });

    it('hashes an arbitrary passphrase down to a 32-byte key', () => {
      const key = deriveKey('correct horse battery staple');
      expect(key.length).toBe(32);
    });

    it('is deterministic -- the same input always derives the same key', () => {
      expect(deriveKey('some-passphrase')).toEqual(deriveKey('some-passphrase'));
    });
  });

  describe('encrypt/decrypt', () => {
    const key = deriveKey('test-key');

    it('round-trips: decrypt(encrypt(x)) === x', () => {
      const plaintext = JSON.stringify({ userId: 'u1', history: ['hello'] });
      expect(decrypt(encrypt(plaintext, key), key)).toBe(plaintext);
    });

    it('produces different ciphertext for the same plaintext on each call (random IV)', () => {
      const plaintext = 'same input every time';
      expect(encrypt(plaintext, key)).not.toBe(encrypt(plaintext, key));
    });

    it('never leaks the plaintext into the encoded payload', () => {
      const plaintext = 'super-secret-patient-name';
      expect(encrypt(plaintext, key)).not.toContain(plaintext);
    });

    it('throws on decrypt if the payload was tampered with', () => {
      const encoded = encrypt('hello world', key);
      const bytes = Buffer.from(encoded, 'base64');
      bytes[bytes.length - 1] ^= 0xff; // flip the last ciphertext byte
      const tampered = bytes.toString('base64');
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('throws on decrypt with the wrong key', () => {
      const encoded = encrypt('hello world', key);
      expect(() => decrypt(encoded, deriveKey('a-different-key'))).toThrow();
    });
  });
});
