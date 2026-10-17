// Mathcad Prime .mcdx: an OPC (zip) package with the parts Prime 8–11 write themselves.
//   [Content_Types].xml, _rels/.rels            the package and its main parts
//   docProps/app.xml, docProps/core.xml          properties
//   mathcad/worksheet.xml (+ _rels)              the regions, math in math50
//   mathcad/result.xml                           one (empty) result per math region: Prime calculates
//   mathcad/header.xml, footer.xml, integration.xml, settings/calculation.xml, settings/presentation.xml
//   mathcad/xaml/FlowDocumentN.XamlPackage       each text region, itself a small package of XAML
//   mathcad/media/ImageN.png                     pictures
import { strToU8, zipSync } from 'fflate';
import { MlWriter, esc } from './mathml';
import { paragraphs, type Para } from './richText';
import { itemSize, notExported, type Item, type Plan } from './plan';
import { NotRepresentable, type X } from './tree';

const NS = {
  ws: 'http://schemas.mathsoft.com/worksheet50', ml: 'http://schemas.mathsoft.com/math50', u: 'http://schemas.mathsoft.com/units10',
  p: 'http://schemas.mathsoft.com/provenance10', xaml: 'http://schemas.microsoft.com/winfx/2006/xaml/presentation',
};
const WS_ROOT_NS = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ve="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:ws="${NS.ws}" xmlns:ml="${NS.ml}" xmlns:u="${NS.u}" xmlns:p="${NS.p}" xmlns="${NS.ws}"`;
const REL = {
  doc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  flow: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/flowDocument',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  xaml: 'http://schemas.microsoft.com/wpf/2005/10/xaml/entry',
};
const CT_MAIN = 'application/vnd.openxmlformats-officedocument.mathprocessingml.mathcad';
const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';
const n = (v: number) => String(Math.round(v * 100) / 100);

interface Rel { id: string; type: string; target: string }
const relsXml = (rels: Rel[]) => `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Type="${r.type}" Target="${r.target}" Id="${r.id}" />`).join('')}</Relationships>`;

/** Prime's text: a Section of paragraphs and runs (XAML), packaged on its own. */
function xamlPackage(md: string): Uint8Array {
  const paras = paragraphs(md);
  const run = (r: Para['runs'][number]) => {
    const a = `${r.bold ? ' FontWeight="Bold"' : ''}${r.italic ? ' FontStyle="Italic"' : ''}${r.code ? ' FontFamily="Consolas"' : ''}`;
    return `<Run${a}>${esc(r.text)}</Run>`;
  };
  const SIZE: Record<Para['kind'], string> = { h1: ' FontSize="21.3333333333333"', h2: ' FontSize="17.3333333333333"', h3: ' FontWeight="Bold"', p: '' };
  const body = paras.map((p) => `<Paragraph${SIZE[p.kind]}>${p.runs.map(run).join('')}</Paragraph>`).join('') || '<Paragraph />';
  const section = `<Section xmlns="${NS.xaml}" xml:space="preserve" TextAlignment="Left" LineHeight="Auto" IsHyphenationEnabled="False" xml:lang="en-us" FlowDirection="LeftToRight" FontFamily="Tahoma" FontStyle="Normal" FontWeight="Normal" FontStretch="Normal" FontSize="14.6666666666667" Foreground="#FF000000">${body}</Section>`;
  return zipSync({
    '[Content_Types].xml': strToU8(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xaml" ContentType="application/vnd.ms-wpf.xaml+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /></Types>`),
    '_rels/.rels': strToU8(relsXml([{ id: 'R1', type: REL.xaml, target: '/Xaml/Document.xaml' }])),
    'Xaml/Document.xaml': strToU8(section),
  });
}

const FLOW_STUB = `<FlowDocument FontFamily="Tahoma" FontStyle="Normal" FontWeight="Normal" FontSize="14.6666666666667" Foreground="#FF000000" Background="#00FFFFFF" TextAlignment="Left" xml:lang="en-us" Typography.Variants="Normal" xmlns="${NS.xaml}" />`;

const PRESENTATION = `${XML_HEAD}<presentation xmlns:ws="${NS.ws}" xmlns="http://schemas.ptc.com/mathcad/settings/presentation10"><pageModel paper-code="A4" grid-size="Standard" orientation="Portrait" margin-type="Standard" /><mathRendering><mathStyles>${[
  ['Variable', 'Normal', 'Italic', '#FF000000'], ['Unit', 'Bold', 'Italic', '#FF00008B'], ['Constant', 'Bold', 'Italic', '#FF556B2F'],
  ['Function', 'Normal', 'Normal', '#FF000000'], ['System', 'Bold', 'Normal', '#FF000000'], ['Keyword', 'Bold', 'Normal', '#FF000000'],
].map(([name, w, s, c]) => `<mathStyle name="${name}" font-family="Mathcad UniMath Prime" font-size="14.666666666666668" font-weight="${w}" font-style="${s}" color="${c}" font-stretch="Normal" />`).join('')}</mathStyles><formatting FontFamily="Mathcad UniMath Prime" FontSize="11" Bold="false" Italic="false" Underline="false" ForegroundColor="#FF000000" BackgroundColor="#00FFFFFF" /><ws:results><general precision="PREC" show-trailing-zeros="false" radix="dec" zero-threshold="15" imaginary-value="i" exponential-threshold="EXP" complex-threshold="10" xmlns="${NS.ws}" /><matrix size="12,12" offset="0,0" show-indices="false" expand-nested-arrays="false" xmlns="${NS.ws}" /><ws:unit simplify-units="true" /></ws:results></mathRendering><textRendering><textStyles>${[
  ['Heading 1', '21.3333333333333', '#FF2E3192'], ['Heading 2', '17.3333333333333', '#FF2E3192'], ['Heading 3', '16', '#FF2E3192'],
  ['Normal', '14.666666666666668', '#FF000000'], ['Subtitle', '24', '#FF000000'], ['Title', '37.3333333333333', '#FF000000'],
].map(([name, size, fg]) => `<textStyle name="${name}" style-key="${name}" based-on-key="" font-family="Tahoma" font-weight="Normal" font-size="${size}" font-style="Normal" background="#00FFFFFF" foreground="${fg}" marker-style="None" text-indent="0" text-align="Left" />`).join('')}${['areaLayoutStyle', 'headerLayoutStyle', 'footerLayoutStyle'].map((name) => `<textStyle name="${name}" font-family="Tahoma" font-size="11" font-weight="Normal" font-style="Normal" variants="Normal" background="#00FFFFFF" foreground="#FF000000" margin="0,0,0,0" based-on-key="" style-key="${name}" marker-style="None" text-indent="0" text-align="Left" />`).join('')}</textStyles></textRendering></presentation>`;

export interface McdxOptions {
  precision?: number;
  expThreshold?: number;
}

export function writeMcdx(plan: Plan, opts: McdxOptions = {}): Uint8Array {
  const w = new MlWriter(true);
  const files: Record<string, Uint8Array> = {};
  const wsRels: Rel[] = [];
  let regionId = 0, resultRef = 0, relCount = 0;
  const results: number[] = [];
  const relId = () => `R${(++relCount).toString(16).padStart(16, '0')}`;
  const ref = () => {
    results.push(resultRef);
    return resultRef++;
  };
  const math = (inner: string, disabled?: boolean) => `<math resultRef="${ref()}"${disabled ? ' disable-calc="true"' : ''}>${inner}</math>`;
  const at = (x: number, y: number, width: number, height: number, sized = false) =>
    `region-id="${regionId++}"${sized ? ` width="${n(width)}" height="${n(height)}"` : ''} actualWidth="${n(width)}" actualHeight="${n(height)}" top="${n(y)}" left="${n(x)}"`;

  const region = (it: Item): string => {
    const { w: width, h: height } = itemSize(it);
    switch (it.k) {
      case 'math':
        return `<region ${at(it.x, it.y, width, height)}>${math(w.statement(it.st), it.disabled)}</region>`;
      case 'text': {
        const id = relId();
        const part = `/mathcad/xaml/FlowDocument${regionId}.XamlPackage`;
        files[part.slice(1)] = xamlPackage(it.md);
        wsRels.push({ id, type: REL.flow, target: part });
        return `<region region-id="${regionId++}" width="${n(width)}" actualWidth="${n(width)}" actualHeight="${n(height)}" top="${n(it.y)}" left="${n(it.x)}"><text item-idref="${id}">${FLOW_STUB}</text></region>`;
      }
      case 'picture': {
        const id = relId();
        const part = `/mathcad/media/Image${regionId}.png`;
        files[part.slice(1)] = it.png;
        wsRels.push({ id, type: REL.image, target: part });
        return `<region ${at(it.x, it.y, width, height, true)}><picture><png item-idref="${id}" display-width="${n(width)}" display-height="${n(height)}" /></picture></region>`;
      }
      case 'solve': {
        const head = at(it.x, it.y, width, height, true);
        let y = 19.2;
        const sub = (inner: string, cat: string) => {
          const r = `<region region-id="${regionId++}" actualWidth="${n(width - 40)}" actualHeight="25.6" top="${n(y)}" left="19.2" solve-block-category="${cat}">${math(inner)}</region>`;
          y += 38.4;
          return r;
        };
        // constraints are equations and inequalities as they stand, not evaluated
        const inner = [
          ...it.guesses.map((g) => sub(w.statement(g), 'guess-value')),
          ...it.constraints.map((c) => sub(w.x(c), 'constraint')),
          sub(w.statement(it.solver), 'solver'),
        ];
        return `<region ${head}><solveblock><regions>${inner.join('')}</regions></solveblock></region>`;
      }
      case 'plot':
        return `<region ${at(it.x, it.y, width, height, true)}>${plot(it, w, ref)}</region>`;
    }
  };

  const regions = plan.items.map((it) => {
    try {
      return region(it);
    } catch (e) {
      if (!(e instanceof NotRepresentable)) throw e;
      return region(notExported(it, e, 'Mathcad Prime', plan));
    }
  }).join('');
  files['mathcad/worksheet.xml'] = strToU8(`<worksheet ${WS_ROOT_NS}><regions>${regions}</regions></worksheet>`);
  if (wsRels.length) files['mathcad/_rels/worksheet.xml.rels'] = strToU8(relsXml(wsRels));
  files['mathcad/result.xml'] = strToU8(`${XML_HEAD}<resultsList xmlns:ml="${NS.ml}" xmlns:u="${NS.u}" xmlns="http://schemas.mathsoft.com/result10">${results.map((r) => `<resultData result-id="${r}" />`).join('')}</resultsList>`);
  for (const part of ['header', 'footer']) files[`mathcad/${part}.xml`] = strToU8(`<${part} ${WS_ROOT_NS}><regions /></${part}>`);
  files['mathcad/integration.xml'] = strToU8(`${XML_HEAD}<regions xmlns="http://schemas.ptc.com/integration10" />`);
  files['mathcad/settings/calculation.xml'] = strToU8(`${XML_HEAD}<calculation cache-worksheet="true" xmlns="http://schemas.ptc.com/mathcad/settings/calculation10"><builtInVariables array-origin="${plan.origin}" convergence-tolerance="0.001" constraint-tolerance="0.001" prn-col-width="8" prn-precision="4" random-seed="1" /><calculationBehavior automatic-recalculation="true" strings-use-origin="false" matrix-strict-singularity-check="false" exact-boolean="true" units-in-symbolics="false" constants-in-symbolics="false" symbolic-engine="axiom" /><units><currentUnitSystem name="si" /></units></calculation>`);
  files['mathcad/settings/presentation.xml'] = strToU8(PRESENTATION.replace('PREC', String(Math.min(15, opts.precision ?? 3))).replace('EXP', String(Math.min(15, opts.expThreshold ?? 3))));
  files['docProps/app.xml'] = strToU8(`${XML_HEAD}<properties xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.mathsoft.com/extended-properties"><appVersion>8.0.0.0</appVersion><serializationVersion architecture="x64" Culture="en-US" UiCulture="en-US">8.0.0.0</serializationVersion><engineVersion>8.0.0.18</engineVersion><build>2022.03.01.001</build><schemaPropertiesList>${[
    ['App', '1.3.4'], ['Calculation', '1.4.2'], ['Integration', '1.3.1'], ['Math', '5.8.0'], ['Presentation', '1.7.1'], ['Provenance', '1.3.1'],
    ['Result', '1.8.1'], ['SimpleTypes', '1.3.1'], ['Units', '12.3.1'], ['Worksheet', '5.7.0'],
  ].map(([name, v]) => `<schemaProperties name="${name}" version="${v}" />`).join('')}</schemaPropertiesList></properties>`);
  files['docProps/core.xml'] = strToU8(`${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${esc(plan.title)}</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">mathstudii</dc:creator><cp:lastModifiedBy>mathstudii</cp:lastModifiedBy><cp:revision>1</cp:revision></cp:coreProperties>`);
  files['_rels/.rels'] = strToU8(relsXml([
    { id: 'R0000000000000w01', type: REL.doc, target: '/mathcad/worksheet.xml' },
    { id: 'R0000000000000h01', type: REL.doc, target: '/mathcad/header.xml' },
    { id: 'R0000000000000f01', type: REL.doc, target: '/mathcad/footer.xml' },
    { id: 'R0000000000000c01', type: REL.core, target: '/docProps/core.xml' },
  ]));
  const hasText = Object.keys(files).some((k) => k.endsWith('.XamlPackage'));
  const hasPng = Object.keys(files).some((k) => k.endsWith('.png'));
  files['[Content_Types].xml'] = strToU8(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="${CT_MAIN}.main+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />${hasText ? '<Default Extension="XamlPackage" ContentType="application/zip" />' : ''}${hasPng ? '<Default Extension="png" ContentType="image/png" />' : ''}${[
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'], ['/docProps/app.xml', 'application/mathcad.extended-properties+xml'],
    ['/mathcad/settings/presentation.xml', `${CT_MAIN}.settings.presentation+xml`], ['/mathcad/settings/calculation.xml', `${CT_MAIN}.settings.calculation+xml`],
    ['/mathcad/result.xml', `${CT_MAIN}.result+xml`], ['/mathcad/integration.xml', `${CT_MAIN}.integration+xml`],
  ].map(([part, ct]) => `<Override PartName="${part}" ContentType="${ct}" />`).join('')}</Types>`);
  // the order Prime itself writes: the worksheet first, the package's own parts last
  const order = ['mathcad/worksheet.xml', '_rels/.rels', ...Object.keys(files).filter((k) => /^mathcad\/(xaml|media|_rels)\//.test(k)), 'mathcad/header.xml', 'mathcad/footer.xml', '[Content_Types].xml', 'docProps/core.xml', 'docProps/app.xml', 'mathcad/settings/presentation.xml', 'mathcad/settings/calculation.xml', 'mathcad/result.xml', 'mathcad/integration.xml'];
  const zip: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const k of order) if (files[k]) zip[k] = [files[k], { level: /\.(png|XamlPackage)$/.test(k) || k === '_rels/.rels' ? 0 : 6 }];
  return zipSync(zip, { mtime: new Date(1980, 0, 1) });
}

const COLORS = ['#FF00008B', '#FFB22222', '#FF228B22', '#FFFF8C00', '#FF8B008B', '#FF008B8B'];

function plot(it: Extract<Item, { k: 'plot' }>, w: MlWriter, ref: () => number): string {
  const unitMath = (u?: X) => `<math>${u ? w.x(u) : '<ml:placeholder />'}</math>`;
  const limits = (lo?: X, hi?: X) => `<xyDomain scale-type="linear" auto-scale="${lo || hi ? 'false' : 'true'}"><startValue>${lo ? w.x(lo) : '<ml:placeholder />'}</startValue><endValue>${hi ? w.x(hi) : '<ml:placeholder />'}</endValue></xyDomain>`;
  const axis = (name: 'xAxis' | 'yAxis', eqs: X[], unit: X | undefined, lo?: X, hi?: X) => `<${name} rank="1" legend-position="${name === 'xAxis' ? 'PlotBoundaryBottom' : 'PlotBoundaryRight'}"><axisLine position="origin" /><axisGrid><gridFrequency>11</gridFrequency><gridLabels display="true" /><gridLines /><tickMarks display="true" /></axisGrid><axisLabel /><markers /><plotEquations>${eqs.map((e) => `<plotEquation><math>${w.x(e)}</math>${unitMath(unit)}</plotEquation>`).join('')}</plotEquations>${limits(lo, hi)}</${name}>`;
  const traces = it.traces.map((_, i) => `<trace resultRef="${ref()}"><traceStyle color="${it.colors?.[i] ?? COLORS[i % COLORS.length]}" symbol="none" line-weight="1" line-style="Solid">lines</traceStyle></trace>`).join('');
  return `<plot origin-positioning="true"><xyPlot><title /><legend /><traces>${traces}</traces><graph-size width="${n(it.width * 0.75)}" height="${n(it.height * 0.75)}" /><axes>${axis('xAxis', it.traces.map((t) => t.x), it.xUnit, it.xmin, it.xmax)}${axis('yAxis', it.traces.map((t) => t.y), it.yUnit, it.ymin, it.ymax)}</axes></xyPlot></plot>`;
}
