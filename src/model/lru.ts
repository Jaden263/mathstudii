// Caches bounded by what they hold, not by how many entries: one display mesh of a coil
// is megabytes while a hundred of a bracket are less, so a count says little about memory.

/**
 * Roughly how many bytes a plain value takes (typed arrays exactly; strings, numbers and
 * objects by V8's usual sizes). Shared objects are counted once.
 */
export function approxBytes(v: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (v === null || v === undefined) return 0;
  switch (typeof v) {
    case 'string':
      return 16 + v.length;
    case 'number':
    case 'bigint':
      return 8;
    case 'boolean':
      return 4;
    case 'object':
      break;
    default:
      return 0;
  }
  const o = v as object;
  if (seen.has(o)) return 0;
  seen.add(o);
  if (ArrayBuffer.isView(o)) return 64 + o.byteLength;
  if (o instanceof ArrayBuffer) return 32 + o.byteLength;
  let n = 0;
  if (Array.isArray(o)) {
    n = 16 + 8 * o.length;
    for (const x of o) if (x !== null && typeof x === 'object') n += approxBytes(x, seen);
    else if (typeof x === 'string') n += 16 + x.length;
    return n;
  }
  if (o instanceof Map) {
    n = 32;
    for (const [k, x] of o) n += 16 + approxBytes(k, seen) + approxBytes(x, seen);
    return n;
  }
  if (o instanceof Set) {
    n = 32;
    for (const x of o) n += 8 + approxBytes(x, seen);
    return n;
  }
  n = 24;
  for (const k in o) n += 8 + approxBytes((o as Record<string, unknown>)[k], seen);
  return n;
}

export interface ByteLruOptions<K, V> {
  /** Bytes of a value (default approxBytes). */
  size?: (v: V) => number;
  /** Told about every entry evicted to make room (not about deleted or replaced ones). */
  onEvict?: (k: K, v: V) => void;
  /** Entries that must stay whatever the budget (what is on screen). */
  keep?: (k: K, v: V) => boolean;
}

/**
 * Least recently used first out, within a byte budget (and a count). An entry larger than
 * the whole budget is still kept while it is the newest, and entries `keep` names are
 * never evicted, so what is on screen never goes.
 */
export class ByteLru<K, V> {
  private map = new Map<K, { v: V; bytes: number }>();
  private total = 0;
  private size: (v: V) => number;

  constructor(
    private maxBytes: number,
    private maxCount = Infinity,
    private o: ByteLruOptions<K, V> = {},
  ) {
    this.size = o.size ?? approxBytes;
  }

  get count() {
    return this.map.size;
  }

  /** Bytes held now. */
  get bytes() {
    return this.total;
  }

  has(k: K) {
    return this.map.has(k);
  }

  /** The value, marked as just used. */
  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  /** The value without marking it used. */
  peek(k: K): V | undefined {
    return this.map.get(k)?.v;
  }

  set(k: K, v: V, bytes = this.size(v)) {
    this.delete(k);
    this.map.set(k, { v, bytes });
    this.total += bytes;
    this.trim();
  }

  delete(k: K): boolean {
    const e = this.map.get(k);
    if (!e) return false;
    this.map.delete(k);
    this.total -= e.bytes;
    return true;
  }

  clear() {
    this.map.clear();
    this.total = 0;
  }

  keys() {
    return this.map.keys();
  }

  /** Keep at most this much (the newest entry stays whatever its size). */
  limit(maxBytes: number, maxCount = this.maxCount) {
    this.maxBytes = maxBytes;
    this.maxCount = maxCount;
    this.trim();
  }

  private trim() {
    const over = () => this.total > this.maxBytes || this.map.size > this.maxCount;
    if (!over()) return;
    let newest: K | undefined;
    for (const k of this.map.keys()) newest = k;
    for (const [k, e] of [...this.map]) {
      if (!over()) return;
      if (k === newest || this.o.keep?.(k, e.v)) continue;
      this.map.delete(k);
      this.total -= e.bytes;
      this.o.onEvict?.(k, e.v);
    }
  }
}
