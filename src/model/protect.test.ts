import { describe, expect, it } from 'vitest';
import { checkPassword, makeProtection, sha256Hex } from './protect';

describe('password hash', () => {
  it('is SHA-256 (FIPS 180-2 test vectors)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('is salted, and only the right password matches', async () => {
    const p = await makeProtection('Brücke-42');
    expect(p.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(p.hash).toBe(await sha256Hex(p.salt + 'Brücke-42'));
    expect(await checkPassword(p, 'Brücke-42')).toBe(true);
    expect(await checkPassword(p, 'brücke-42')).toBe(false);
    expect(await checkPassword(p, '')).toBe(false);
    // the same password protects differently each time
    const q = await makeProtection('Brücke-42');
    expect(q.salt).not.toBe(p.salt);
    expect(q.hash).not.toBe(p.hash);
    // no password: anyone may unprotect
    expect(await makeProtection('')).toEqual({});
    expect(await checkPassword({}, 'anything')).toBe(true);
  });
});
