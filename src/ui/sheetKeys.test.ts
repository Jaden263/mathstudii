import { describe, expect, it } from 'vitest';
import { regionOwnsKey, type KeyLike } from './sheetKeys';

/** An element inside the region with this id (or on the bare sheet when null). */
function inRegion(id: string | null) {
  return { closest: (sel: string) => (id !== null && sel === `[data-region-id="${id}"]` ? {} : null) };
}
const key = (k: string, target: unknown, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k, ctrlKey: false, metaKey: false, defaultPrevented: false, target: target as EventTarget, ...extra,
});

describe('worksheet shortcuts and region editors', () => {
  it('leave Delete to a 3-D frame that used it on a picked member', () => {
    // Frame3DView's handler removes the member and calls preventDefault (not stopPropagation)
    expect(regionOwnsKey(key('Delete', inRegion('f1'), { defaultPrevented: true }), 'f1')).toBe(true);
    expect(regionOwnsKey(key('Backspace', inRegion('f1'), { defaultPrevented: true }), null)).toBe(true);
  });

  it('leave keys pressed inside the region being edited to its editor', () => {
    // nothing picked: Delete inside the frame being edited must not delete the frame
    expect(regionOwnsKey(key('Delete', inRegion('f1')), 'f1')).toBe(true);
    expect(regionOwnsKey(key('ArrowLeft', inRegion('f1')), 'f1')).toBe(true);
    // but undo and redo still reach the worksheet history
    expect(regionOwnsKey(key('z', inRegion('f1'), { ctrlKey: true }), 'f1')).toBe(false);
    expect(regionOwnsKey(key('Y', inRegion('f1'), { metaKey: true }), 'f1')).toBe(false);
  });

  it('let the worksheet act on selected regions otherwise', () => {
    // a selected region, focus on the sheet: Delete deletes it
    expect(regionOwnsKey(key('Delete', inRegion(null)), null)).toBe(false);
    expect(regionOwnsKey(key('Delete', inRegion(null)), 'f1')).toBe(false);
    // focus in another region than the one being edited
    expect(regionOwnsKey(key('Delete', inRegion('m2')), 'f1')).toBe(false);
    expect(regionOwnsKey(key('Delete', null), 'f1')).toBe(false);
  });
});
