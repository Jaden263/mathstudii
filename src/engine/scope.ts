// Map-compatible scopes. mathjs accepts any object with get/set/has/keys as a
// scope, which lets us layer local variables (function parameters, integration
// variables, solve-block guesses) over the worksheet scope without copying it.

export interface ScopeLike {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  delete?(key: string): boolean;
}

export class ChainScope implements ScopeLike {
  readonly local = new Map<string, unknown>();

  constructor(readonly parent: ScopeLike | null, init?: Record<string, unknown> | Map<string, unknown>) {
    if (init instanceof Map) init.forEach((v, k) => this.local.set(k, v));
    else if (init) for (const k of Object.keys(init)) this.local.set(k, init[k]);
  }

  get(key: string): unknown {
    if (this.local.has(key)) return this.local.get(key);
    return this.parent ? this.parent.get(key) : undefined;
  }

  set(key: string, value: unknown): this {
    this.local.set(key, value);
    return this;
  }

  has(key: string): boolean {
    return this.local.has(key) || (!!this.parent && this.parent.has(key));
  }

  delete(key: string): boolean {
    return this.local.delete(key);
  }

  *keys(): IterableIterator<string> {
    const seen = new Set<string>();
    for (const k of this.local.keys()) {
      seen.add(k);
      yield k;
    }
    if (this.parent) for (const k of this.parent.keys()) if (!seen.has(k)) yield k;
  }

  clear(): void {
    this.local.clear();
  }

  forEach(cb: (value: unknown, key: string) => void): void {
    for (const k of this.keys()) cb(this.get(k), k);
  }

  /** Flatten into an independent Map (used to capture closures, Mathcad-style). */
  snapshot(): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const k of this.keys()) m.set(k, this.get(k));
    return m;
  }
}

export function child(parent: ScopeLike, init?: Record<string, unknown>): ChainScope {
  return new ChainScope(parent, init);
}

export function snapshot(scope: ScopeLike): Map<string, unknown> {
  if (scope instanceof ChainScope) return scope.snapshot();
  const m = new Map<string, unknown>();
  for (const k of scope.keys()) m.set(k, scope.get(k));
  return m;
}
