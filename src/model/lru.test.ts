// Caches bounded by bytes: the oldest go first, what is pinned and the newest stay.
import { describe, expect, it } from 'vitest';
import { approxBytes, ByteLru } from './lru';

describe('byte-bounded caches', () => {
  it('counts typed arrays exactly and shared objects once', () => {
    const f = new Float32Array(1000);
    expect(approxBytes(f)).toBe(64 + 4000);
    const shared = { positions: f };
    // the same array twice in one value counts once
    const twice = approxBytes([shared, shared]);
    expect(twice).toBeLessThan(2 * approxBytes(shared));
    expect(twice).toBeGreaterThan(4000);
    expect(approxBytes('x'.repeat(100))).toBe(116);
    expect(approxBytes(null)).toBe(0);
    expect(approxBytes(new Map([['a', f]]))).toBeGreaterThan(4000);
  });

  it('evicts the least recently used past the byte budget', () => {
    const evicted: string[] = [];
    const c = new ByteLru<string, number>(300, Infinity, { size: (v) => v, onEvict: (k) => evicted.push(k) });
    c.set('a', 100);
    c.set('b', 100);
    c.set('c', 100);
    expect(c.bytes).toBe(300);
    // a read marks it used: b is now the oldest
    expect(c.get('a')).toBe(100);
    c.set('d', 100);
    expect(evicted).toEqual(['b']);
    expect([...c.keys()]).toEqual(['c', 'a', 'd']);
    expect(c.bytes).toBe(300);
    // replacing an entry changes its size, it is not evicted
    c.set('a', 50);
    expect(c.bytes).toBe(250);
    expect(evicted).toEqual(['b']);
    // peek does not mark it used
    c.peek('c');
    c.set('e', 100);
    expect(evicted).toEqual(['b', 'c']);
  });

  it('keeps the newest entry even when it alone is over the budget', () => {
    const c = new ByteLru<string, number>(100, Infinity, { size: (v) => v });
    c.set('a', 50);
    c.set('big', 500);
    expect([...c.keys()]).toEqual(['big']);
    expect(c.bytes).toBe(500);
  });

  it('bounds the count too, and never evicts what `keep` pins', () => {
    const pinned = new Set(['a']);
    const c = new ByteLru<string, number>(Infinity, 2, { size: () => 1, keep: (k) => pinned.has(k) });
    c.set('a', 1);
    c.set('b', 1);
    c.set('c', 1);
    // a is the oldest but pinned: b goes
    expect([...c.keys()]).toEqual(['a', 'c']);
    pinned.clear();
    c.set('d', 1);
    expect([...c.keys()]).toEqual(['c', 'd']);
    c.limit(Infinity, 1);
    expect([...c.keys()]).toEqual(['d']);
    expect(c.delete('d')).toBe(true);
    expect(c.bytes).toBe(0);
  });
});
