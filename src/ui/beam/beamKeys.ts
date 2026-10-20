// Keys of the beam editor. Tools have letters, the view has + − 0 and the arrows,
// Delete / Backspace remove what is selected, Escape steps back. Keys with Ctrl / ⌘
// (undo, redo, save, page zoom …) are the worksheet's, except Ctrl+A.
import type { BeamTool } from '../sketch/context';

export const TOOL_KEYS: Record<string, BeamTool> = { v: 'select', b: 'member', p: 'pin', r: 'roller', x: 'fixed', g: 'hinge', f: 'force', q: 'line', m: 'moment' };

export type BeamKeyAction =
  /** Not the editor's: let the worksheet have it (undo, redo, save, page zoom …). */
  | { kind: 'pass' }
  /** The editor's, with nothing to do (it must not reach the worksheet either). */
  | { kind: 'none' }
  | { kind: 'delete' }
  | { kind: 'escape' }
  | { kind: 'selectAll' }
  | { kind: 'tool'; tool: BeamTool }
  | { kind: 'zoom'; dir: 1 | -1 }
  | { kind: 'fit' }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'space' };

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key pressed in the beam editor (focus on the drawing, not in a field) does. */
export function beamKey(e: KeyInput): BeamKeyAction {
  const mod = e.ctrlKey || e.metaKey;
  if (mod) return e.key.toLowerCase() === 'a' && !e.altKey ? { kind: 'selectAll' } : { kind: 'pass' };
  switch (e.key) {
    case 'Delete': case 'Backspace': return { kind: 'delete' };
    case 'Escape': return { kind: 'escape' };
    case '+': case '=': return { kind: 'zoom', dir: 1 };
    case '-': case '_': return { kind: 'zoom', dir: -1 };
    case '0': case 'Home': return { kind: 'fit' };
    case ' ': return { kind: 'space' };
    // the arrows move the view (Shift: further)
    case 'ArrowLeft': return { kind: 'pan', dx: e.shiftKey ? 160 : 40, dy: 0 };
    case 'ArrowRight': return { kind: 'pan', dx: e.shiftKey ? -160 : -40, dy: 0 };
    case 'ArrowUp': return { kind: 'pan', dx: 0, dy: e.shiftKey ? 160 : 40 };
    case 'ArrowDown': return { kind: 'pan', dx: 0, dy: e.shiftKey ? -160 : -40 };
  }
  if (e.altKey) return { kind: 'none' };
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  return tool ? { kind: 'tool', tool } : { kind: 'none' };
}
