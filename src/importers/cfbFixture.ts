// For tests: compound files (OLE structured storage) to read back with cfb.ts.

/** A compound file (version 3, 512-byte sectors) holding one stream, in regular sectors or in the mini stream. */
export function compoundFile(name: string, data: Uint8Array): Uint8Array {
  const S = 512, END = 0xfffffffe, FREE = 0xffffffff;
  const mini = data.length < 4096;
  const dataSectors = mini ? Math.ceil(Math.ceil(data.length / 64) * 64 / S) : Math.ceil(data.length / S);
  // sector 0: FAT, 1: directory, 2: mini FAT (when mini), then the data (or the mini stream)
  const first = mini ? 3 : 2;
  const total = first + dataSectors;
  const buf = new Uint8Array(S * (1 + total));
  const dv = new DataView(buf.buffer);
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x18, 0x3e, true); dv.setUint16(0x1a, 3, true); dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true); dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, 1, true); dv.setUint32(0x30, 1, true); dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3c, mini ? 2 : END, true); dv.setUint32(0x40, mini ? 1 : 0, true);
  dv.setUint32(0x44, END, true); dv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + 4 * i, i === 0 ? 0 : FREE, true);
  const sec = (n: number) => S * (n + 1);
  for (let i = 0; i < 128; i++) dv.setUint32(sec(0) + 4 * i, FREE, true);
  dv.setUint32(sec(0), 0xfffffffd, true);
  dv.setUint32(sec(0) + 4, END, true);
  if (mini) dv.setUint32(sec(0) + 8, END, true);
  for (let i = 0; i < dataSectors; i++) dv.setUint32(sec(0) + 4 * (first + i), i === dataSectors - 1 ? END : first + i + 1, true);
  const entry = (k: number, nm: string, type: number, start: number, size: number, child: number) => {
    const o = sec(1) + 128 * k;
    for (let i = 0; i < nm.length; i++) dv.setUint16(o + 2 * i, nm.charCodeAt(i), true);
    dv.setUint16(o + 0x40, 2 * nm.length + 2, true);
    buf[o + 0x42] = type;
    dv.setUint32(o + 0x44, FREE, true); dv.setUint32(o + 0x48, FREE, true); dv.setUint32(o + 0x4c, child, true);
    dv.setUint32(o + 0x74, start, true); dv.setUint32(o + 0x78, size, true);
  };
  const miniLen = Math.ceil(data.length / 64) * 64;
  entry(0, 'Root Entry', 5, mini ? first : END, mini ? miniLen : 0, 1);
  entry(1, name, 2, mini ? 0 : first, data.length, FREE);
  if (mini) {
    const units = miniLen / 64;
    for (let i = 0; i < 128; i++) dv.setUint32(sec(2) + 4 * i, i < units ? (i === units - 1 ? END : i + 1) : FREE, true);
  }
  buf.set(data, sec(first));
  return buf;
}
