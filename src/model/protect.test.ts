import { describe, expect, it } from 'vitest';
import { checkPassword, makeProtection, sameForEvaluation, sha256Bytes, sha256Hex } from './protect';
import { createRegion, emptyWorksheet, type CadRegion, type MathRegion, type Region, type Worksheet } from './types';

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

describe('SHA-256 without WebCrypto (pages served over plain http)', () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const enc = (s: string) => new TextEncoder().encode(s);
  it('matches the FIPS 180-2 test vectors', () => {
    expect(hex(sha256Bytes(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Bytes(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // two blocks (448 bits of message, then the padding)
    expect(hex(sha256Bytes(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // one million "a" (FIPS 180-2, appendix B.3)
    expect(hex(sha256Bytes(new Uint8Array(1e6).fill(0x61)))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  it('agrees with WebCrypto at every padding length', async () => {
    for (let n = 0; n < 140; n++) {
      const msg = 'ü'.repeat(n % 7) + 'x'.repeat(n);
      expect(hex(sha256Bytes(enc(msg)))).toBe(await sha256Hex(msg));
    }
  });
});

describe('what a calculation depends on', () => {
  const ws = (): Worksheet => ({ ...emptyWorksheet(), regions: [{ ...createRegion('cad', 80, 40), id: 'c' } as Region, { ...createRegion('math', 80, 400, { source: 'a := 1' }), id: 'm' } as Region] });

  it('turning a view or zooming is not a change to calculate', () => {
    const a = ws();
    const c = a.regions[0] as CadRegion;
    const turned = { ...a, regions: [{ ...c, view3d: { yaw: 10, pitch: 20 }, view3dW: { yaw: 1, pitch: 2, zoom: 3 } }, a.regions[1]] };
    expect(sameForEvaluation(a, turned)).toBe(true);
    expect(sameForEvaluation(a, a)).toBe(true);
  });

  it('anything else is', () => {
    const a = ws();
    const m = a.regions[1] as MathRegion;
    expect(sameForEvaluation(a, { ...a, regions: [a.regions[0], { ...m, source: 'a := 2' }] })).toBe(false);
    expect(sameForEvaluation(a, { ...a, regions: [a.regions[0], { ...m, y: 410 }] })).toBe(false);
    expect(sameForEvaluation(a, { ...a, regions: [a.regions[0]] })).toBe(false);
    expect(sameForEvaluation(a, { ...a, settings: { ...a.settings } })).toBe(false);
    expect(sameForEvaluation(a, { ...a, title: 'Other' })).toBe(false);
    // a field added that is not about the view
    expect(sameForEvaluation(a, { ...a, regions: [a.regions[0], { ...m, disabled: true }] })).toBe(false);
  });
});
