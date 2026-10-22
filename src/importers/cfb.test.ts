import { describe, it, expect } from 'vitest';
import { cfbStream } from './cfb';
import { compoundFile } from './cfbFixture';

describe('compound files', () => {
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
  it('reads a stream from regular sectors and from the mini stream', () => {
    expect(cfbStream(compoundFile('Package', bytes(5000)), 'package')).toEqual(bytes(5000));
    expect(cfbStream(compoundFile('Package', bytes(300)), 'Package')).toEqual(bytes(300));
  });
  it('null for another stream name or for what is not a compound file', () => {
    expect(cfbStream(compoundFile('Package', bytes(300)), 'Workbook')).toBeNull();
    expect(cfbStream(bytes(1000), 'Package')).toBeNull();
  });
});
