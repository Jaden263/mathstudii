// Locks and worksheet protection (Mathcad Prime "Lock" and "Protect worksheet"). The reducer
// refuses edits, moves and deletions that a lock forbids, and undo leaves locked regions as
// they are. This guards against accidents, not against anyone determined: a worksheet is plain
// JSON, and the password is only checked by this app.
import type { Region, Worksheet, WorksheetProtection } from './types';
import { areasAt, isArea, withContents } from './areas';

export const isProtected = (ws: Worksheet): boolean => !!ws.settings.protect;

/** Regions locked by themselves or by an area they are in. */
export function lockedIds(ws: Worksheet): Set<string> {
  return withContents(ws.regions, ws.regions.filter((r) => r.locked).map((r) => r.id));
}

export function isLocked(ws: Worksheet, r: Region, locked = lockedIds(ws)): boolean {
  return locked.has(r.id);
}

/** May its content change? On a protected worksheet only the inputs may. */
export function canEdit(ws: Worksheet, r: Region, locked = lockedIds(ws)): boolean {
  return !locked.has(r.id) && (!isProtected(ws) || !!r.input);
}

/** May it be moved or deleted? */
export function canMove(ws: Worksheet, r: Region, locked = lockedIds(ws)): boolean {
  return !locked.has(r.id) && !isProtected(ws);
}

/** Ids that may move or be deleted, each with what is inside it; a block with a locked region in it stays. */
export function movableIds(ws: Worksheet, ids: Iterable<string>): Set<string> {
  const locked = lockedIds(ws);
  const byId = new Map(ws.regions.map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || !canMove(ws, r, locked)) continue;
    const block = withContents(ws.regions, [id]);
    if ([...block].some((b) => locked.has(b))) continue;
    block.forEach((b) => out.add(b));
  }
  return out;
}

/** May a new region be put at this height (not on a protected sheet, not into a locked area)? */
export function canAddAt(ws: Worksheet, y: number): boolean {
  return !isProtected(ws) && !areasAt(ws.regions, y).some((a) => a.locked);
}

/** Fields that only change how a region is looked at (zoom, camera, open tab, how an area prints), not what it is. */
const VIEW_KEYS = new Set(['view', 'viewW', 'view3d', 'view3dW', 'camera', 'tab', 'print', 'active']);

export function isViewPatch(patch: object): boolean {
  return Object.keys(patch).every((k) => VIEW_KEYS.has(k));
}

/** The two regions differ in how they are looked at only. */
function sameButView(a: Region, b: Region): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  for (const k in x) if (x[k] !== y[k] && !VIEW_KEYS.has(k)) return false;
  for (const k in y) if (!(k in x) && !VIEW_KEYS.has(k)) return false;
  return true;
}

/**
 * Two states of a worksheet calculate the same: everything but how regions are looked at
 * (cameras, zoom, open tabs) is the same object.
 */
export function sameForEvaluation(a: Worksheet, b: Worksheet): boolean {
  if (a === b) return true;
  if (a.settings !== b.settings || a.regions.length !== b.regions.length) return false;
  for (const k in a) if (k !== 'regions' && (a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  for (let i = 0; i < a.regions.length; i++) if (a.regions[i] !== b.regions[i] && !sameButView(a.regions[i], b.regions[i])) return false;
  return true;
}

/** Where a region is (layout, which follows undo even when the region is locked). */
function layoutOf(r: Region): Partial<Region> {
  const out: Record<string, unknown> = { x: r.x, y: r.y };
  if (isArea(r)) Object.assign(out, { height: r.height, collapsed: r.collapsed, hidden: r.hidden });
  return out as Partial<Region>;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * The worksheet `target` (an undo or redo step) with what `current` protects kept as it is
 * now: the protection itself, the lock and input marks, and the content of every region that
 * cannot be edited. Such a region is never removed by undo; its place follows the layout of the
 * step (areas collapsed or expanded above it).
 */
export function respectLocks(target: Worksheet, current: Worksheet): Worksheet {
  const now = new Map(current.regions.map((r) => [r.id, r]));
  const locked = lockedIds(current);
  const frozen = new Set(current.regions.filter((r) => !canEdit(current, r, locked)).map((r) => r.id));
  const inTarget = new Set(target.regions.map((r) => r.id));
  const regions = target.regions.flatMap((r): Region[] => {
    const cur = now.get(r.id);
    // a region undo would bring back is an addition: not on a protected sheet, not into a locked area
    if (!cur) return canAddAt(current, r.y) ? [r] : [];
    if (frozen.has(r.id)) return [clean({ ...cur, ...layoutOf(r) } as Region)];
    return [clean({ ...r, locked: cur.locked, input: cur.input } as Region)];
  });
  for (const r of current.regions) if (frozen.has(r.id) && !inTarget.has(r.id)) regions.push(r);
  const prot = current.settings.protect;
  const settings = prot ? current.settings : clean({ ...target.settings, protect: undefined });
  return { ...target, title: prot ? current.title : target.title, settings, regions };
}

// ---------------------------------------------------------------- password

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a text (UTF-8) in hex, by WebCrypto (or in script where the page is not a secure context). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // crypto.subtle only exists on https and localhost; a copy served over plain http still protects
  const subtle = globalThis.crypto?.subtle;
  return hex(subtle ? await subtle.digest('SHA-256', bytes) : sha256Bytes(bytes));
}

const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const PRIMES = [...Array(312).keys()].filter((n) => n > 1 && [...Array(n).keys()].slice(2).every((d) => n % d)).slice(0, 64);
/** Round constants and initial hash: the first 32 bits of the fractional parts of the cube and square roots of the first primes (FIPS 180-4, 4.2.2 and 5.3.3). */
const K = Uint32Array.from(PRIMES, (p) => Math.floor((Math.cbrt(p) % 1) * 2 ** 32));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => Math.floor((Math.sqrt(p) % 1) * 2 ** 32));

/** SHA-256 (FIPS 180-4) in plain script. */
export function sha256Bytes(msg: Uint8Array): Uint8Array {
  // padding: a 1 bit, zeros, and the length in bits as a 64-bit big-endian number
  const block = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  block.set(msg);
  block[msg.length] = 0x80;
  const dv = new DataView(block.buffer);
  dv.setUint32(block.length - 8, Math.floor(msg.length / 2 ** 29));
  dv.setUint32(block.length - 4, (msg.length * 8) >>> 0);
  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let o = 0; o < block.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] += x; });
  }
  const out = new Uint8Array(32);
  h.forEach((x, i) => new DataView(out.buffer).setUint32(4 * i, x));
  return out;
}

/** Protection with this password (none when empty): a random salt and SHA-256(salt + password). */
export async function makeProtection(password: string): Promise<WorksheetProtection> {
  if (!password) return {};
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await sha256Hex(salt + password) };
}

/** Does this password unprotect the worksheet? Always true without a password. */
export async function checkPassword(p: WorksheetProtection, password: string): Promise<boolean> {
  if (!p.hash) return true;
  return (await sha256Hex((p.salt ?? '') + password)) === p.hash;
}
