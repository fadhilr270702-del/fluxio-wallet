import { describe, it, expect } from 'vitest';
import { encryptWithPassword, decryptWithPassword } from '../encryption.js';

describe('encryptWithPassword / decryptWithPassword', () => {
  it('round-trips a value through encryption and decryption', async () => {
    const secret = { mnemonic: 'test value not a real mnemonic', n: 42 };
    const record = await encryptWithPassword(secret, 'correct horse battery staple');
    const decrypted = await decryptWithPassword(record, 'correct horse battery staple');
    expect(decrypted).toEqual(secret);
  });

  it('rejects decryption with the wrong password', async () => {
    const record = await encryptWithPassword({ x: 1 }, 'right-password');
    await expect(decryptWithPassword(record, 'wrong-password')).rejects.toThrow();
  });

  it('rejects a corrupted ciphertext (tamper detection via AES-GCM auth tag)', async () => {
    const record = await encryptWithPassword({ x: 1 }, 'a-password');
    const tampered = { ...record, ciphertextB64: flipLastChar(record.ciphertextB64) };
    await expect(decryptWithPassword(tampered, 'a-password')).rejects.toThrow();
  });

  it('rejects a tampered salt (would derive the wrong key)', async () => {
    const record = await encryptWithPassword({ x: 1 }, 'a-password');
    const tampered = { ...record, saltB64: flipLastChar(record.saltB64) };
    await expect(decryptWithPassword(tampered, 'a-password')).rejects.toThrow();
  });

  it('generates a unique salt and IV on every call, even for the same input', async () => {
    const a = await encryptWithPassword({ x: 1 }, 'same-password');
    const b = await encryptWithPassword({ x: 1 }, 'same-password');
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.ivB64).not.toBe(b.ivB64);
    expect(a.ciphertextB64).not.toBe(b.ciphertextB64);
  });

  it('rejects an empty password', async () => {
    await expect(encryptWithPassword({ x: 1 }, '')).rejects.toThrow();
  });

  it('rejects a malformed encrypted record', async () => {
    await expect(decryptWithPassword({ nope: true }, 'password')).rejects.toThrow();
  });
});

function flipLastChar(base64) {
  const chars = base64.split('');
  const last = chars.pop();
  chars.push(last === 'A' ? 'B' : 'A');
  return chars.join('');
}
