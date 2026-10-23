// The text of a Word document embedded in a worksheet (an OLE object): a Word 97–2003 document
// (its WordDocument stream, text found through the piece table) or a .docx (the "Package"
// stream, word/document.xml). Paragraphs come out as lines; formatting, pictures and equations
// are not kept.
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { cfbStream } from './cfb';

/** An embedded Word document: its paragraphs (none when it holds only drawing objects). */
export function wordContent(ole: Uint8Array): { paragraphs: string[] } | null {
  const paragraphs = wordParagraphs(ole);
  if (!paragraphs) return null;
  return { paragraphs: paragraphs.some((p) => p.trim()) ? paragraphs : [] };
}

/** The paragraphs of an embedded Word document, or null when the object is not one. */
export function wordParagraphs(ole: Uint8Array): string[] | null {
  const doc = cfbStream(ole, 'WordDocument');
  if (doc) {
    const flags = doc.length > 12 ? doc[0x0a] | (doc[0x0b] << 8) : 0;
    const table = cfbStream(ole, flags & 0x0200 ? '1Table' : '0Table');
    return table ? doc97(doc, table) : null;
  }
  const pkg = cfbStream(ole, 'Package');
  return pkg ? docx(pkg) : null;
}

const cp1252 = new TextDecoder('windows-1252');

/** Word 97–2003: the main document's characters through the piece table (the Clx in the table stream). */
function doc97(doc: Uint8Array, table: Uint8Array): string[] | null {
  const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength);
  if (doc.length < 0x1aa || dv.getUint16(0, true) !== 0xa5ec) return null;
  const ccpText = dv.getInt32(0x4c, true);
  const fcClx = dv.getUint32(0x1a2, true), lcbClx = dv.getUint32(0x1a6, true);
  if (fcClx + lcbClx > table.length || lcbClx < 5) return null;
  const tv = new DataView(table.buffer, table.byteOffset + fcClx, lcbClx);
  // skip the Prc entries (formatting) to the Pcdt (the piece table)
  let o = 0;
  while (o < lcbClx && tv.getUint8(o) === 1) o += 3 + tv.getUint16(o + 1, true);
  if (o >= lcbClx || tv.getUint8(o) !== 2) return null;
  const lcb = tv.getUint32(o + 1, true);
  const base = o + 5;
  const n = Math.floor((lcb - 4) / 12);
  if (n < 1 || base + lcb > lcbClx) return null;
  let text = '';
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cp0 = tv.getUint32(base + 4 * i, true), cp1 = tv.getUint32(base + 4 * (i + 1), true);
    const fcRaw = tv.getUint32(base + 4 * (n + 1) + 8 * i + 2, true);
    const len = Math.min(cp1, ccpText) - cp0;
    if (len <= 0) continue;
    if (fcRaw & 0x40000000) {
      const fc = (fcRaw & ~0x40000000) / 2;
      text += cp1252.decode(doc.subarray(fc, fc + len));
    } else {
      for (let k = 0; k < len && fcRaw + 2 * k + 1 < doc.length; k++) text += String.fromCharCode(dv.getUint16(fcRaw + 2 * k, true));
    }
  }
  return paragraphsOf(text);
}

/** Word's control characters: fields keep their result, cells and paragraph marks end lines. */
function paragraphsOf(text: string): string[] {
  let out = '';
  let depth = 0;
  const code: boolean[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 0x13) { code[++depth] = true; continue; } // field: its code …
    if (c === 0x14) { code[depth] = false; continue; } // … then its result
    if (c === 0x15) { depth = Math.max(0, depth - 1); continue; }
    if (depth && code[depth]) continue;
    if (c === 0x0d || c === 0x07 || c === 0x0c) out += '\n';
    else if (c === 0x0b) out += '\n';
    else if (c === 0x09) out += '\t';
    else if (c === 0x1e) out += '-';
    else if (c === 0x1f) continue; // optional hyphen
    else if (c >= 0x20 || c === 0xa0) out += ch;
  }
  return out.split('\n').map((l) => l.replace(/[ \t]+$/, ''));
}

/** A .docx: the paragraphs of word/document.xml. */
function docx(zip: Uint8Array): string[] | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    return null;
  }
  const key = Object.keys(files).find((k) => k.toLowerCase() === 'word/document.xml');
  if (!key) return null;
  const xml = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(files[key]), 'text/xml');
  const out: string[] = [];
  const ps = xml.getElementsByTagNameNS('*', 'p');
  for (let i = 0; i < ps.length; i++) {
    let line = '';
    const walk = (n: { firstChild: unknown }) => {
      for (let c = n.firstChild as { nodeType: number; localName?: string; nodeName: string; textContent: string | null; nextSibling: unknown; firstChild: unknown } | null; c; c = c.nextSibling as typeof c) {
        if (c.nodeType !== 1) continue;
        const t = c.localName || c.nodeName.replace(/^.*:/, '');
        if (t === 't') line += c.textContent ?? '';
        else if (t === 'tab') line += '\t';
        else if (t === 'br' || t === 'cr') line += '\n';
        else if (t !== 'p' && t !== 'instrText') walk(c);
      }
    };
    walk(ps[i] as unknown as { firstChild: unknown });
    out.push(...line.split('\n'));
  }
  return out;
}
