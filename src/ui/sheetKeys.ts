// Whose key is it? Region editors (a frame's picked member, a plate's column, a beam's load, a
// table cell) handle keys first, in React, before the worksheet's window listener sees them.
// A key the editor used (preventDefault) or one pressed while the focus is inside the region
// being edited belongs to that editor: the worksheet must not also act on it, or Delete on a
// picked member removes the whole region.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

/** True when the worksheet's own shortcuts (Delete, arrows, Enter, typing …) must leave this key alone. */
export function regionOwnsKey(e: KeyLike, editingId: string | null): boolean {
  if (e.defaultPrevented) return true;
  if (!editingId) return false;
  const t = e.target as { closest?: (sel: string) => unknown } | null;
  if (!t?.closest?.(`[data-region-id="${editingId}"]`)) return false;
  // undo and redo still go to the worksheet history from inside an editor
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) return false;
  return true;
}
