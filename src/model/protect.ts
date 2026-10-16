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
const VIEW_KEYS = new Set(['view', 'viewW', 'view3d', 'view3dW', 'camera', 'tab', 'print']);

export function isViewPatch(patch: object): boolean {
  return Object.keys(patch).every((k) => VIEW_KEYS.has(k));
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
  const regions = target.regions.map((r) => {
    const cur = now.get(r.id);
    if (!cur) return r;
    if (frozen.has(r.id)) return clean({ ...cur, ...layoutOf(r) } as Region);
    return clean({ ...r, locked: cur.locked, input: cur.input } as Region);
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

/** SHA-256 of a text (UTF-8) in hex, by WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
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
