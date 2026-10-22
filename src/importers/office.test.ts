import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { compoundFile, compoundFileOf } from './cfbFixture';
import { wordContent, wordParagraphs } from './office';

/** A Word 97–2003 document: its text (8-bit) through a one-piece table, as Word keeps it. */
function doc97(text: string): Uint8Array {
  const wd = new Uint8Array(4096), table = new Uint8Array(4096);
  const dv = new DataView(wd.buffer), tv = new DataView(table.buffer);
  dv.setUint16(0, 0xa5ec, true);
  dv.setUint16(0x0a, 0x0200, true); // the table stream is 1Table
  dv.setInt32(0x4c, text.length, true);
  const at = 0x400;
  for (let i = 0; i < text.length; i++) wd[at + i] = text.charCodeAt(i);
  // Clx: a Prc (formatting) to skip, then the Pcdt: CPs [0, n] and one piece, 8-bit at fc / 2
  const clx = 0x20;
  table.set([1, 2, 0, 0xaa, 0xbb], clx);
  const p = clx + 5;
  table[p] = 2;
  tv.setUint32(p + 1, 4 * 2 + 8, true);
  tv.setUint32(p + 5, 0, true);
  tv.setUint32(p + 9, text.length, true);
  tv.setUint32(p + 13 + 2, (at * 2) | 0x40000000, true);
  dv.setUint32(0x1a2, clx, true);
  dv.setUint32(0x1a6, 5 + 5 + 16, true);
  return compoundFileOf({ WordDocument: wd, '1Table': table });
}

describe('Word documents embedded in worksheets', () => {
  it('Word 97–2003: paragraphs; a field keeps its result; cells end lines', () => {
    const paras = wordParagraphs(doc97('Steel grade\rS355 \x13 PAGE \x14see p. 2\x15\x07f_y = 355 MPa\r'));
    expect(paras).toEqual(['Steel grade', 'S355 see p. 2', 'f_y = 355 MPa', '']);
  });
  it('.docx in a Package stream: the paragraphs of word/document.xml', () => {
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Task 1</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Roots </w:t></w:r><w:r><w:tab/><w:t>graphically</w:t></w:r></w:p></w:body></w:document>';
    const docx = zipSync({ 'word/document.xml': strToU8(xml), '[Content_Types].xml': strToU8('<Types/>') });
    expect(wordParagraphs(compoundFile('Package', docx))).toEqual(['Task 1', 'Roots \tgraphically']);
  });
  it('a document of drawing objects only has no paragraphs; another object is no Word document', () => {
    expect(wordContent(doc97('\x01\r'))).toEqual({ paragraphs: [] });
    expect(wordContent(compoundFile('Contents', new Uint8Array(100)))).toBeNull();
  });
});
