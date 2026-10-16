import { useEffect, useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import { flushSync } from 'react-dom';
import { ChevronDown, ChevronRight, Lock, Printer } from 'lucide-react';
import type { AreaRegion, Worksheet } from '../model/types';
import { PAGE_MARGIN, PAGE_WIDTH } from '../model/types';
import { AREA_PAD, contentBottom, hiddenIds, isArea, printLayout } from '../model/areas';
import type { Action } from './store';

interface Props {
  region: AreaRegion;
  /** Regions inside (all levels). */
  count: number;
  /** Locked by itself or by an area it is in. */
  locked: boolean;
  renaming: boolean;
  dispatch: Dispatch<Action>;
  onRename: () => void;
  onDone: () => void;
}

/** Width of an area's bar: from its left edge to the right margin. */
export const areaWidth = (a: AreaRegion) => Math.max(120, PAGE_WIDTH - PAGE_MARGIN + 8 - a.x);

/** The title bar of an area: collapse / expand, its title, what it holds when collapsed. */
export function AreaBar({ region: a, count, locked, renaming, dispatch, onRename, onDone }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(a.title);
  useEffect(() => {
    if (!renaming) return;
    setTitle(a.title);
    input.current?.focus();
    input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);
  const commit = () => {
    if (title.trim() && title !== a.title) dispatch({ type: 'update', id: a.id, patch: { title: title.trim() } });
    onDone();
  };
  const toggle = () => dispatch({ type: a.collapsed ? 'expand' : 'collapse', id: a.id });
  return (
    <div className={`area-bar${a.collapsed ? ' collapsed' : ''}`} style={{ width: areaWidth(a) }} onDoubleClick={(e) => { if (!locked && !(e.target as HTMLElement).closest('button')) onRename(); }}>
      <button
        className="area-toggle" aria-expanded={!a.collapsed} aria-label={a.collapsed ? `Expand ${a.title}` : `Collapse ${a.title}`}
        title={a.collapsed ? 'Expand' : 'Collapse'} onPointerDown={(e) => e.stopPropagation()} onClick={toggle}
      >
        {a.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
      </button>
      {renaming ? (
        <input
          ref={input} className="area-title-input" value={title} aria-label="Area title"
          onChange={(e) => setTitle(e.target.value)} onBlur={commit} onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); onDone(); }
          }}
        />
      ) : (
        <span className="area-title">{a.title || 'Area'}</span>
      )}
      {a.collapsed && <span className="area-count">· {count} region{count === 1 ? '' : 's'}</span>}
      <span className="area-spacer" />
      {a.print && (
        <span className="area-badge" title={`Printed ${a.print}`}><Printer size={12} /> {a.print}</span>
      )}
      {locked && <span className="area-badge" title="Locked"><Lock size={12} /></span>}
    </div>
  );
}

/**
 * Keep every open area's band round its contents: when they grow past the end line (a taller
 * result, a region typed at the bottom), the band and everything under it move down.
 */
export function useAreaFit(sheet: React.RefObject<HTMLDivElement | null>, ws: Worksheet, editingId: string | null, dispatch: Dispatch<Action>) {
  useLayoutEffect(() => {
    const root = sheet.current;
    if (!root || !ws.regions.some(isArea)) return;
    const hidden = hiddenIds(ws.regions);
    const height = (id: string) => {
      // the region being typed in is measured when it is done
      if (id === editingId) return 24;
      return root.querySelector<HTMLElement>(`[data-region-id="${id}"]`)?.offsetHeight ?? 24;
    };
    for (const a of ws.regions) {
      if (!isArea(a) || a.collapsed || hidden.has(a.id)) continue;
      const want = contentBottom(ws.regions, a, height) + AREA_PAD - a.y;
      if (want > a.height + 0.5) {
        dispatch({ type: 'areaFit', id: a.id, height: Math.ceil(want) });
        // one at a time: the others move with it and are measured again on the next render
        return;
      }
    }
  });
}

/** While printing, the layout with each area collapsed or expanded as its print setting asks. */
export function usePrintLayout(ws: Worksheet): Worksheet {
  const [printing, setPrinting] = useState<Worksheet | null>(null);
  const live = useRef(ws);
  live.current = ws;
  useEffect(() => {
    const before = () => {
      const pl = printLayout(live.current);
      if (pl !== live.current) flushSync(() => setPrinting(pl));
    };
    const after = () => setPrinting(null);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  return printing ?? ws;
}
