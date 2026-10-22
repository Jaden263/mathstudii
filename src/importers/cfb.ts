// Reading a stream out of a Compound File (OLE structured storage, [MS-CFB]): the format of
// the objects Mathcad embeds, such as an Excel component's workbook (its "Package" stream).

const END = 0xfffffffe;
const MAX_CHAIN = 1 << 20;

/** The bytes of the first stream called `name` (any case), or null when there is none or the file is damaged. */
export function cfbStream(bytes: Uint8Array, name: string): Uint8Array | null {
  if (bytes.length < 512 || bytes[0] !== 0xd0 || bytes[1] !== 0xcf || bytes[2] !== 0x11 || bytes[3] !== 0xe0) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => (o + 4 <= bytes.length ? dv.getUint32(o, true) : END);
  const shift = dv.getUint16(0x1e, true), miniShift = dv.getUint16(0x20, true);
  if (shift !== 9 && shift !== 12) return null;
  const size = 1 << shift;
  const offset = (s: number) => (s + 1) * size;
  // the FAT's sectors: 109 in the header, the rest in a chain of DIFAT sectors
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(0x4c + 4 * i);
    if (s < END - 1) fatSectors.push(s);
  }
  let difat = u32(0x44);
  for (let n = 0; difat < END - 1 && n < MAX_CHAIN; n++) {
    for (let i = 0; i < size / 4 - 1; i++) {
      const s = u32(offset(difat) + 4 * i);
      if (s < END - 1) fatSectors.push(s);
    }
    difat = u32(offset(difat) + size - 4);
  }
  const next = (s: number) => {
    const per = size / 4;
    const fs = fatSectors[Math.floor(s / per)];
    return fs === undefined ? END : u32(offset(fs) + 4 * (s % per));
  };
  /** A stream in regular sectors along its FAT chain. */
  const regular = (start: number, len: number) => {
    const out = new Uint8Array(len);
    let at = 0;
    for (let s = start, n = 0; s < END - 1 && at < len; s = next(s), n++) {
      if (n > MAX_CHAIN) return null;
      const piece = bytes.subarray(offset(s), Math.min(offset(s) + size, bytes.length));
      out.set(piece.subarray(0, Math.min(piece.length, len - at)), at);
      at += piece.length;
    }
    return at >= len ? out : null;
  };
  // the directory: 128-byte entries along its chain
  const dirs: { name: string; type: number; start: number; size: number }[] = [];
  for (let s = u32(0x30), n = 0; s < END - 1 && n < MAX_CHAIN; s = next(s), n++) {
    for (let e = 0; e < size / 128; e++) {
      const o = offset(s) + e * 128;
      if (o + 128 > bytes.length) break;
      const nameLen = Math.max(0, Math.min(64, dv.getUint16(o + 0x40, true)) - 2);
      let nm = '';
      for (let i = 0; i < nameLen; i += 2) nm += String.fromCharCode(dv.getUint16(o + i, true));
      dirs.push({ name: nm, type: bytes[o + 0x42], start: u32(o + 0x74), size: u32(o + 0x78) });
    }
  }
  const root = dirs.find((d) => d.type === 5);
  const want = dirs.find((d) => d.type === 2 && d.name.toLowerCase() === name.toLowerCase());
  if (!root || !want) return null;
  const cutoff = u32(0x38) || 4096;
  if (want.size >= cutoff) return regular(want.start, want.size);
  // a small stream lives in the mini stream (the root's data), in mini sectors chained by the mini FAT
  const ministream = regular(root.start, root.size);
  const miniFat = regular(u32(0x3c), Math.max(0, u32(0x40)) * size);
  if (!ministream || !miniFat) return null;
  const mdv = new DataView(miniFat.buffer, miniFat.byteOffset, miniFat.byteLength);
  const miniNext = (s: number) => (4 * s + 4 <= miniFat.length ? mdv.getUint32(4 * s, true) : END);
  const unit = 1 << miniShift;
  const out = new Uint8Array(want.size);
  let at = 0;
  for (let s = want.start, n = 0; s < END - 1 && at < want.size; s = miniNext(s), n++) {
    if (n > MAX_CHAIN) return null;
    const piece = ministream.subarray(s * unit, Math.min(s * unit + unit, ministream.length));
    out.set(piece.subarray(0, Math.min(piece.length, want.size - at)), at);
    at += piece.length;
  }
  return at >= want.size ? out : null;
}
