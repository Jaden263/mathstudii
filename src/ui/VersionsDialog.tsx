import { useEffect, useRef, useState } from 'react';
import { X, History } from 'lucide-react';
import { getVersion, listVersions, type VersionEntry } from '../platform/library';

function when(t: number): string {
  const d = new Date(t);
  const mins = Math.round((Date.now() - t) / 60000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `${d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${rel}`;
}

/** Snapshots of the current document: restore one, or open it as a copy. */
export function VersionsDialog({ docId, onClose, onRestore }: { docId: string; onClose: () => void; onRestore: (text: string, asCopy: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [list, setList] = useState<VersionEntry[] | null>(null);
  const [regions, setRegions] = useState<Record<number, number>>({});
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    void listVersions(docId).then(setList);
  }, [docId]);
  // how many regions each snapshot holds, read lazily
  useEffect(() => {
    if (!list) return;
    let stop = false;
    (async () => {
      for (const v of list.slice(0, 30)) {
        const text = await getVersion(v.n);
        if (stop || !text) continue;
        try {
          const n = (JSON.parse(text).regions ?? []).length;
          setRegions((r) => ({ ...r, [v.n]: n }));
        } catch {
          /* unreadable snapshot */
        }
      }
    })();
    return () => { stop = true; };
  }, [list]);
  const pick = async (n: number, asCopy: boolean) => {
    const text = await getVersion(n);
    if (text) onRestore(text, asCopy);
  };
  return (
    <dialog ref={ref} className="dialog versions" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="ver-title">
      <div className="dialog-head">
        <h2 id="ver-title"><History size={17} /> Version history</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="dialog-body">
        <p className="hint">A snapshot is kept every 10 minutes while you work and at every save (the newest 60, in this browser).</p>
        {list === null ? <p>Loading…</p> : !list.length ? <p>No snapshots yet — they appear after the first save or 10 minutes of work.</p> : (
          <ul className="version-list">
            {list.map((v) => (
              <li key={v.n}>
                <div>
                  <b>{when(v.time)}</b>
                  {v.label && <span className="version-tag">{v.label}</span>}
                  <small>{v.title} · {regions[v.n] !== undefined ? `${regions[v.n]} regions · ` : ''}{(v.size / 1024).toFixed(1)} kB</small>
                </div>
                <button className="btn" onClick={() => void pick(v.n, false)}>Restore</button>
                <button className="btn" onClick={() => void pick(v.n, true)}>Open as copy</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
