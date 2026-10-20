// The memory readout in the status bar: what the page and the calculation engine hold
// (OpenCascade, the mesh kernel, Python and the symbolic engine load when a worksheet
// first needs them), and "Free memory", which stops the engine and drops the display data
// no view shows. Engines stopped load again with the next calculation that needs them.
import { useEffect, useRef, useState } from 'react';
import { MemoryStick } from 'lucide-react';
import type { WorkerMemory } from '../engine/memoryProtocol';
import { displayBytes, dropHiddenDisplays } from './cad/kernelClient';

const MB = (b: number) => (b >= 10 * 2 ** 20 ? `${Math.round(b / 2 ** 20)} MB` : `${(b / 2 ** 20).toFixed(1)} MB`);

/** The page's JavaScript heap (bytes), where the browser tells it (Chromium). */
const pageHeap = (): number | undefined => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;

interface Reading {
  page?: number;
  displays: number;
  engine: WorkerMemory | null;
}

const read = async (query: () => Promise<WorkerMemory | null>): Promise<Reading> => ({ page: pageHeap(), displays: displayBytes(), engine: await query() });

/** The total the readout can vouch for (WASM heaps and JavaScript heaps; not the browser's own). */
export function readingTotal(r: Reading): number {
  const e = r.engine;
  return (r.page ?? r.displays) + (e ? e.occt + e.occtStale + e.python + (e.jsHeap ?? e.caches) : 0);
}

export function MemoryStatus({ query, free }: { query: () => Promise<WorkerMemory | null>; free: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [r, setR] = useState<Reading | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void read(query).then((x) => live && setR(x));
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      live = false;
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open, query]);

  const onFree = async () => {
    setFreeing(true);
    const before = r ? readingTotal(r) : 0;
    const stopped = await free();
    dropHiddenDisplays();
    const after = await read(query);
    setR(after);
    setFreeing(false);
    const gained = before - readingTotal(after);
    setNote(stopped || gained > 2 ** 20 ? `Freed about ${MB(Math.max(0, gained))}` : 'Nothing to free: the engine is busy or holds nothing');
  };

  const e = r?.engine;
  const rows: [string, string][] = [];
  if (r) {
    rows.push(['This page', r.page !== undefined ? MB(r.page) : '—']);
    if (r.displays) rows.push(['3-D display data (in this page)', MB(r.displays)]);
    if (!e) rows.push(['Calculation engine', 'stopped (starts with the next calculation)']);
    else {
      if (e.jsHeap !== undefined) rows.push(['Calculation engine', MB(e.jsHeap)]);
      if (e.occt) rows.push(['B-rep kernel (OpenCascade)', MB(e.occt) + (e.occtStale ? ` + ${MB(e.occtStale)} being released` : '')]);
      if (e.manifold) rows.push(['Mesh kernel (Manifold)', 'loaded']);
      if (e.python) rows.push(['Python', MB(e.python)]);
      if (e.cas) rows.push(['Symbolic engine', 'loaded']);
      if (e.caches) rows.push(['CAD display and drawing caches', MB(e.caches)]);
    }
  }

  return (
    <div className="memory-status" ref={box}>
      <button
        className="status-item status-btn"
        title="Memory used by the worksheet and its engines"
        aria-expanded={open}
        onClick={() => {
          setNote(null);
          setOpen((o) => !o);
        }}
      >
        <MemoryStick size={13} /> Memory
      </button>
      {open && (
        <div className="memory-pop" role="dialog" aria-label="Memory">
          <div className="memory-head">
            <b>Memory</b>
            {r && <span>{MB(readingTotal(r))}</span>}
          </div>
          {!r ? <div className="memory-row muted">Reading…</div> : rows.map(([k, v]) => (
            <div className="memory-row" key={k}><span>{k}</span><span>{v}</span></div>
          ))}
          <p className="memory-note">
            Engines load when a worksheet needs them and are stopped a minute after the worksheet stops needing them.
            Not counted: the browser’s own memory and 3-D graphics buffers.
          </p>
          <div className="memory-actions">
            <button className="text-btn" disabled={freeing || !r} onClick={() => void onFree()}>{freeing ? 'Freeing…' : 'Free memory'}</button>
            {note && <span className="memory-done">{note}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
