import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { bandOf, mc15Fields, mc15Text, primeField, rtfText } from './mathcadPage';
import { importMathcad } from './mathcad';
import { fillFields, hasBand } from '../model/pageBand';

describe('Mathcad page headers and footers', () => {
  it('reads RTF: code page, paragraphs, escaped braces; not the font and colour tables', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0\deflang1033{\fonttbl{\f0\fnil\fprq10\fcharset0 Arial;}}
{\colortbl ;\red0\green128\blue0;}
\viewkind4\uc1\pard\qr\f0\fs18 C\'e1lculo de la ecuaci\'f3n\par Page \{n\} of \{nn\}\par }`;
    expect(rtfText(rtf)).toBe('Cálculo de la ecuación\nPage {n} of {nn}');
    expect(rtfText('{\\rtf1\\uc1 x\\u8805?y\\tab z}')).toBe('x≥y z');
    // some files keep plain text there
    expect(mc15Text('{n}')).toBe('{n}');
  });
  it("Mathcad 15's and Prime's fields become the page's", () => {
    expect(mc15Fields('{f} – Page {n} of {nn}, {d}')).toBe('{title} – Page {page} of {pages}, {date}');
    expect(mc15Fields('{image}\n')).toBe('');
    expect(primeField('pageNumber', 'Page_@PageNo_of_@PagesTotal')).toBe('Page {page} of {pages}');
    expect(primeField('dateSaved', 'mm_dd_yyyy')).toBe('{date}');
    expect(fillFields('Page {page} of {pages} · {title} · {x}', { page: 2, pages: 5, date: '2026-10-22', title: 'Beam' })).toBe('Page 2 of 5 · Beam · {x}');
    expect(hasBand({ left: ' ' })).toBe(false);
  });
  it('places the pieces of a Prime band by where they sit; a label and its field run on', () => {
    const band = bandOf([
      { text: 'Appendix C', left: 10, top: 20, width: 200 },
      { text: 'Page C-', left: 600, top: 20, width: 40 },
      { text: '{page}', left: 641, top: 20, width: 20 },
      { text: 'Rev. 2', left: 600, top: 40, width: 60 },
      { text: 'Title', left: 0, top: 0, width: 800, align: 'Center' },
    ], 816);
    expect(band).toEqual({ left: 'Appendix C', center: 'Title', right: 'Page C-{page}\nRev. 2' });
  });
});

describe('headers and footers in imported worksheets', () => {
  it('Mathcad 15: the three texts of the header and footer, with their fields', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30">
<settings><presentation><pageModel page-width="612" page-height="792">
<header use-full-page-width="false"><left>{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Arial;}}\\pard\\f0\\fs18 Distancia de un punto\\par }</left><right>{\\rtf1\\ansi\\pard\\qr\\f0\\fs18\\{f\\}\\par }</right></header>
<footer><center>{\\rtf1\\ansi\\pard\\qc Page \\{n\\} of \\{nn\\}\\par }</center></footer>
</pageModel></presentation></settings>
<regions><region region-id="1" left="24" top="20"><math><ml:define><ml:id>a</ml:id><ml:real>1</ml:real></ml:define></math></region></regions></worksheet>`;
    const { ws } = importMathcad(strToU8(xml), 't.xmcd');
    expect(ws.settings.report).toEqual({ enabled: true, header: { left: 'Distancia de un punto', right: '{title}' }, footer: { center: 'Page {page} of {pages}' } });
  });
  it('Prime: text regions and page-number fields of header.xml and footer.xml', () => {
    const NS = 'xmlns="http://schemas.mathsoft.com/worksheet50"';
    const flow = (t: string, align = 'Left') => `<FlowDocument TextAlignment="${align}" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Paragraph>${t}</Paragraph></FlowDocument>`;
    const files: Record<string, Uint8Array> = {
      'mathcad/worksheet.xml': strToU8(`<?xml version="1.0"?><worksheet ${NS}><regions/></worksheet>`),
      'mathcad/header.xml': strToU8(`<header ${NS}><regions><region region-id="1" left="40" top="19" width="300"><text>${flow('Beam analysis')}</text></region></regions></header>`),
      'mathcad/footer.xml': strToU8(`<footer ${NS}><regions><region region-id="2" left="355" top="19" actualWidth="60"><fieldText><text>${flow('Page 11')}</text><pageNumber template="Page_@PageNo_of_@PagesTotal"/></fieldText></region><region region-id="3" left="300" top="40" width="100"><math/></region></regions></footer>`),
    };
    const res = importMathcad(zipSync(files), 't.mcdx');
    expect(res.ws.settings.report).toEqual({ enabled: true, header: { left: 'Beam analysis' }, footer: { center: 'Page {page} of {pages}' } });
    expect(res.warnings).toContain('The page footer has a math region, which is not imported');
  });
});
