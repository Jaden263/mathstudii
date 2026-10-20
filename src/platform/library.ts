// The document library: every worksheet is kept in the browser (IndexedDB) and saved
// there continuously, so closing the tab never loses work. A document can also be
// linked to a file on disk (a File System Access handle in Chromium browsers, a path in
// the desktop app); the link is remembered, so Save writes there without asking again.
import type { FileHandle } from './files';

export interface LibraryEntry {
  id: string;
  title: string;
  /** Last change, ms since epoch. */
  updated: number;
  /** Name of the linked file, if any. */
  file?: string;
  size: number;
}

interface StoredDoc extends LibraryEntry {
  text: string;
}

const DB = 'mathstudii';
const DOCS = 'docs';
const LINKS = 'links';
const VERSIONS = 'versions';
/** Snapshots kept per document (oldest dropped first)… */
const MAX_VERSIONS = 60;
/** … and about this much text of them (a document with pictures keeps fewer, at least MIN_VERSIONS). */
const MAX_VERSION_BYTES = 64 * 2 ** 20;
const MIN_VERSIONS = 10;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(DOCS)) d.createObjectStore(DOCS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(LINKS)) d.createObjectStore(LINKS);
        if (!d.objectStoreNames.contains(VERSIONS)) d.createObjectStore(VERSIONS, { keyPath: 'n', autoIncrement: true }).createIndex('doc', 'doc');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve) => {
    if (!d) return resolve(undefined);
    try {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export function newDocId(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Store a worksheet (JSON text) under its id. Resolves false when storage is unavailable or full. */
export async function putDoc(id: string, title: string, text: string, file?: string): Promise<boolean> {
  const doc: StoredDoc = { id, title: title || 'Untitled', updated: Date.now(), text, size: text.length, ...(file ? { file } : {}) };
  const r = await run(DOCS, 'readwrite', (s) => s.put(doc));
  return r !== undefined;
}

export async function getDoc(id: string): Promise<string | null> {
  const d = await run<StoredDoc>(DOCS, 'readonly', (s) => s.get(id));
  return d?.text ?? null;
}

export async function listDocs(): Promise<LibraryEntry[]> {
  const all = (await run<StoredDoc[]>(DOCS, 'readonly', (s) => s.getAll())) ?? [];
  return all.map(({ text: _text, ...e }) => e).sort((a, b) => b.updated - a.updated);
}

export async function deleteDoc(id: string): Promise<void> {
  await run(DOCS, 'readwrite', (s) => s.delete(id));
  await run(LINKS, 'readwrite', (s) => s.delete(id));
  for (const n of await versionKeys(id)) await run(VERSIONS, 'readwrite', (s) => s.delete(n));
  newest.delete(id);
}

// ---------------------------------------------------------------- version history

export interface VersionEntry {
  n: number;
  doc: string;
  time: number;
  title: string;
  size: number;
  /** "Saved", "Before restore" …; automatic snapshots have none. */
  label?: string;
}

interface StoredVersion extends VersionEntry {
  text: string;
}

/** Numbers of a document's snapshots, oldest first (nothing of them is read). */
const versionKeys = async (docId: string): Promise<number[]> => ((await run<IDBValidKey[]>(VERSIONS, 'readonly', (s) => s.index('doc').getAllKeys(docId))) ?? []).map(Number).sort((a, b) => a - b);

/** Snapshots of a document, newest first (without their text; this reads them all: for the history dialog). */
export async function listVersions(docId: string): Promise<VersionEntry[]> {
  const all = (await run<StoredVersion[]>(VERSIONS, 'readonly', (s) => s.index('doc').getAll(docId))) ?? [];
  return all.map(({ text: _t, ...v }) => v).sort((a, b) => b.time - a.time);
}

export async function getVersion(n: number): Promise<string | null> {
  return (await run<StoredVersion>(VERSIONS, 'readonly', (s) => s.get(n)))?.text ?? null;
}

/** A fingerprint of a text (two 32-bit FNV-1a hashes and its length): equal texts, equal fingerprints. */
export function textHash(t: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ t.length;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${t.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/**
 * The newest snapshot of each document this page knows of: autosave asks about every
 * pause in typing, and reading the stored texts each time (60 documents' worth) costs
 * far more than the snapshot.
 */
const newest = new Map<string, { time: number; hash: string }>();

/**
 * Keep a snapshot. Without a label it is skipped when the last one is younger than
 * `minGap` ms or identical; labelled snapshots (an explicit save) are always kept
 * unless nothing changed.
 */
export async function addVersion(docId: string, title: string, text: string, label?: string, minGap = 10 * 60 * 1000): Promise<boolean> {
  const now = Date.now();
  let last = newest.get(docId);
  if (last && !label && now - last.time < minGap) return false;
  const hash = textHash(text);
  if (last?.hash === hash) return false;
  const keys = await versionKeys(docId);
  if (!last && keys.length) {
    const v = await run<StoredVersion>(VERSIONS, 'readonly', (s) => s.get(keys[keys.length - 1]));
    if (v) newest.set(docId, (last = { time: v.time, hash: textHash(v.text) }));
    if (last?.hash === hash) return false;
    if (last && !label && now - last.time < minGap) return false;
  }
  const v = { doc: docId, time: now, title: title || 'Untitled', size: text.length, text, ...(label ? { label } : {}) };
  const n = await run(VERSIONS, 'readwrite', (s) => s.add(v));
  if (n === undefined) return false;
  newest.set(docId, { time: now, hash });
  const keep = Math.max(MIN_VERSIONS, Math.min(MAX_VERSIONS, Math.floor(MAX_VERSION_BYTES / Math.max(1, text.length))));
  const all = [...keys, Number(n)];
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await run(VERSIONS, 'readwrite', (s) => s.delete(old));
  return true;
}

/** Remember (or forget) the file a document is linked to. Handles are stored as they are. */
export async function putLink(id: string, handle: FileHandle): Promise<void> {
  if (handle) await run(LINKS, 'readwrite', (s) => s.put(handle, id));
  else await run(LINKS, 'readwrite', (s) => s.delete(id));
}

export async function getLink(id: string): Promise<FileHandle> {
  return ((await run<FileHandle>(LINKS, 'readonly', (s) => s.get(id))) ?? null) as FileHandle;
}

type PermHandle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/**
 * Can we write the linked file now? Paths (desktop) always; browser handles once the
 * user has allowed it in this session. `ask` may show the browser's prompt (needs a click).
 */
export async function canWrite(handle: FileHandle, ask: boolean): Promise<boolean> {
  if (!handle) return false;
  if (typeof handle === 'string') return true;
  const h = handle as PermHandle;
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    if (ask && h.requestPermission) return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    /* treat as not writable */
  }
  return false;
}

/** The library document already linked to this file, if any (so reopening a file reuses it). */
export async function findLinked(handle: FileHandle): Promise<string | null> {
  if (!handle) return null;
  const d = await db();
  if (!d) return null;
  const pairs = await new Promise<[string, FileHandle][]>((resolve) => {
    const out: [string, FileHandle][] = [];
    try {
      const req = d.transaction(LINKS, 'readonly').objectStore(LINKS).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push([String(c.key), c.value as FileHandle]);
        c.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
  for (const [id, h] of pairs) {
    // spreadsheet components keep their linked workbooks here too
    if (id.startsWith('xlsx:')) continue;
    if (typeof handle === 'string' ? h === handle : h && typeof h !== 'string' && (await handle.isSameEntry(h).catch(() => false))) return id;
  }
  return null;
}
