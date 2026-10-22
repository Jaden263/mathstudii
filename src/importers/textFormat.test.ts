import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { importMathcad } from './mathcad';
import { marked } from 'marked';
import { paragraphs, plain } from '../exporters/richText';
import type { TextRegion } from '../model/types';

const XAML_NS = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';

/** A Prime worksheet with one text region per FlowDocument given. */
function primeText(...docs: string[]) {
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  const regions = docs.map((d, i) => {
    files[`mathcad/xaml/FlowDocument${i}.XamlPackage`] = zipSync({ 'Xaml/Document.xaml': strToU8(`<FlowDocument xmlns="${XAML_NS}" FontSize="14.6666666666667" FontFamily="Arial">${d}</FlowDocument>`) });
    rels.push(`<Relationship Id="T${i}" Type="x" Target="/mathcad/xaml/FlowDocument${i}.XamlPackage"/>`);
    return `<region region-id="${i}" top="${40 + i * 60}" left="40"><text item-idref="T${i}"/></region>`;
  });
  files['mathcad/worksheet.xml'] = strToU8(`<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>${regions.join('')}</regions></worksheet>`);
  files['mathcad/_rels/worksheet.xml.rels'] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  return importMathcad(zipSync(files), 't.mcdx').ws.regions.filter((r): r is TextRegion => r.kind === 'text');
}

describe('formatted text from Mathcad Prime', () => {
  it('keeps colours, underline, sub- and superscripts, links, lists and alignment', () => {
    const [t] = primeText(
      `<Paragraph><Run>Load </Run><Run Foreground="#FFFF0000">red</Run><Run> and </Run><Run TextDecorations="Underline">under</Run><Run> f</Run><Run BaselineAlignment="Subscript">ck</Run></Paragraph>
       <Paragraph TextAlignment="Center"><Run FontWeight="Bold">Centred</Run></Paragraph>
       <List MarkerStyle="Disc"><ListItem><Paragraph><Run>one</Run></Paragraph></ListItem><ListItem><Paragraph><Run>two</Run></Paragraph></ListItem></List>
       <Paragraph><Hyperlink NavigateUri="https://example.org/a"><Run>see</Run></Hyperlink><Run> 5 $ and 2*3, f_ck not _x_</Run></Paragraph>`,
    );
    expect(t.markdown).toBe([
      'Load <span style="color:#ff0000">red</span> and <u>under</u> f<sub>ck</sub>',
      '<p style="text-align:center"><b>Centred</b></p>',
      '- one\n- two',
      '[see](<https://example.org/a>) 5 \\$ and 2\\*3, f_ck not \\_x\\_',
    ].join('\n\n'));
    // the text region renders the Markdown with its inline HTML (then sanitised, which keeps these)
    const html = marked.parse(t.markdown, { async: false });
    expect(html).toContain('<span style="color:#ff0000">red</span>');
    expect(html).toContain('<sub>ck</sub>');
    expect(html).toContain('<p style="text-align:center"><b>Centred</b></p>');
    expect(html).toContain('5 $ and 2*3, f_ck not _x_');
    // exported to plain paragraphs, the text is all there
    expect(paragraphs(t.markdown).map(plain)).toEqual(['Load red and under fck', 'Centred', '• one', '• two', 'see 5 $ and 2*3, f_ck not _x_']);
  });
  it('the size and colour most of a region has become its format; headings by size', () => {
    const [body, big] = primeText(
      `<Paragraph><Run>normal text, normal size: most of the worksheet's text has this size</Run></Paragraph>`,
      `<Paragraph FontSize="26"><Run Foreground="#FF2E3192">Title</Run></Paragraph><Paragraph><Run FontSize="18.4" Foreground="#FF2E3192">bigger text in a region of its own size</Run></Paragraph>`,
    );
    expect(body.style).toBeUndefined();
    expect(big.markdown).toBe('# Title\n\nbigger text in a region of its own size');
    expect(big.style).toEqual({ fontScale: 1.25, color: '#2e3192' });
  });
});

describe('formatted text from Mathcad 15', () => {
  const xmcd = (text: string, styles = '') => importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30">
<settings><presentation><textRendering><textStyles>${styles}</textStyles></textRendering></presentation></settings>
<regions><region region-id="1" left="24" top="20" width="300" show-highlight="true" background-color="#ffff80"><text>${text}</text></region></regions></worksheet>`), 't.xmcd').ws.regions.find((r): r is TextRegion => r.kind === 'text')!;
  const style = (name: string, inline: Record<string, string> = {}, block: Record<string, string> = {}) => {
    const attrs = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<textStyle name="${name}"><blockAttr ${attrs({ 'text-align': 'left', 'list-style-type': 'none', ...block })}/><inlineAttr ${attrs({ 'font-family': 'Arial', 'font-size': '10', 'font-weight': 'normal', color: '#000', ...inline })}/></textStyle>`;
  };
  it('styles by name, <f>, <c>, inlineAttr, <sp>, sub/superscripts, links; a highlighted region', () => {
    const t = xmcd(`<p style="Heading 1">
					Results</p>
				<p style="Normal">Steel <f size="14">big</f> <c val="#f00">red</c> <inlineAttr font-weight="bold">bold</inlineAttr><sp count="2"/>A<sub>s</sub> m<sup>2</sup> <link href="http://x.org">site</link></p>`,
      style('Normal') + style('Heading 1', { 'font-size': '16' }));
    expect(t.markdown).toBe('# Results\n\nSteel <span style="font-size:1.4em">big</span> <span style="color:#f00">red</span> **bold** \u00a0A<sub>s</sub> m<sup>2</sup> [site](<http://x.org>)');
    expect(t.style).toEqual({ background: '#ffff80' });
  });
  it('centred paragraphs and numbered lists from the paragraph or its style', () => {
    const t = xmcd(`<p style="Normal" text-align="center">mid</p><p style="Steps">first</p><p style="Steps">second</p>`, style('Normal') + style('Steps', {}, { 'list-style-type': 'decimal' }));
    expect(t.markdown).toBe('<p style="text-align:center">mid</p>\n\n1. first\n1. second');
  });
});
