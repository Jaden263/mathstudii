// Mathcad 11–15 .xmcd: one XML file in the worksheet30 / math30 schemas, laid out in points
// (1/72 in) with each math region placed by its baseline (align-y), as Mathcad 14 and 15 save
// them. Solve blocks are separate regions there: guess values, "Given", the constraints and
// the Find (Minerr, Odesolve …) definition; pictures are PNGs in <binaryContent>. Mathcad 15
// keeps plots in a binary format of its own, so plots come as pictures (plan.ts).
import { MlWriter, esc } from './mathml';
import { paragraphs, type Para } from './richText';
import { itemSize, notExported, type Item, type Plan } from './plan';
import { NotRepresentable } from './tree';
import { toBase64 } from '../importers/common';

const PT = 72 / 96;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const guid = () => (globalThis.crypto?.randomUUID?.() ?? ZERO_ID).toUpperCase();
const n = (px: number) => String(Math.round(px * PT * 100) / 100);

const TEXT_STYLES: [string, string, string, string][] = [
  ['Normal', 'Arial', '10', 'normal'], ['Heading 1', 'Arial', '14', 'bold'], ['Heading 2', 'Arial', '12', 'bold'],
  ['Heading 3', 'Arial', '12', 'normal'], ['Title', 'Times New Roman', '24', 'bold'],
];

function settings(origin: number): string {
  const styles = TEXT_STYLES.map(([name, font, size, weight]) => `<textStyle name="${name}"><blockAttr margin-left="0" margin-right="0" text-indent="inherit" text-align="left" list-style-type="inherit" tabs="inherit"/><inlineAttr font-family="${font}" font-charset="0" font-size="${size}" font-weight="${weight}" font-style="normal" underline="false" line-through="false" vertical-align="baseline"/></textStyle>`).join('');
  const math = ['Variables', 'Constants'].map((name) => `<mathStyle name="${name}" font-family="Times New Roman" font-charset="0" font-size="10" font-weight="normal" font-style="normal" underline="false"/>`).join('');
  return `<settings><presentation><textRendering><textStyles>${styles}</textStyles></textRendering><mathRendering equation-color="#000"><operators multiplication="narrow-dot" derivative="derivative" literal-subscript="large" definition="colon-equal" global-definition="triple-equal" local-definition="left-arrow" equality="bold-equal" symbolic-evaluation="right-arrow"/><mathStyles>${math}</mathStyles><dimensionNames mass="mass" length="length" time="time" current="current" thermodynamic-temperature="temperature" luminous-intensity="luminosity" amount-of-substance="substance" display="false"/><symbolics derivation-steps-style="vertical-insert" show-comments="false" evaluate-in-place="false"/><results numeric-only="true"><general precision="3" show-trailing-zeros="false" radix="dec" complex-threshold="10" zero-threshold="15" imaginary-value="i" exponential-threshold="3"/><matrix display-style="auto" expand-nested-arrays="false"/><unit format-units="true" simplify-units="true" fractional-unit-exponent="false"/></results></mathRendering><pageModel show-page-frame="false" show-header-frame="false" show-footer-frame="false" header-footer-start-page="1" paper-code="9" orientation="portrait" print-single-page-width="false" page-width="595.5" page-height="842.25"><margins left="86.4" right="86.4" top="86.4" bottom="86.4"/><header use-full-page-width="false"/><footer use-full-page-width="false"/></pageModel><colorModel background-color="#fff" default-highlight-color="#ffff80"/><language math="en" UI="en"/></presentation><calculation><builtInVariables array-origin="${origin}" convergence-tolerance="0.001" constraint-tolerance="0.001" random-seed="1" prn-precision="4" prn-col-width="8"/><calculationBehavior automatic-recalculation="true" matrix-strict-singularity-check="true" optimize-expressions="false" exact-boolean="true" strings-use-origin="false" zero-over-zero="0"><compatibility multiple-assignment="MC12" local-assignment="MC12"/></calculationBehavior><units><currentUnitSystem name="si" customized="false"/></units></calculation><editor view-annotations="false" view-regions="false"><ruler is-visible="false" ruler-unit="cm"/><grid granularity-x="6" granularity-y="6"/></editor><fileFormat image-type="image/png" image-quality="75" save-numeric-results="true" exclude-large-results="false" save-text-images="false" screen-dpi="96"/><miscellaneous><handbook handbook-region-tag-ub="1" can-delete-original-handbook-regions="true" can-delete-user-regions="true" can-print="true" can-copy="true" can-save="true" file-permission-mask="4294967295"/></miscellaneous></settings>`;
}

const P_ATTRS = 'margin-left="inherit" margin-right="inherit" text-indent="inherit" text-align="inherit" list-style-type="inherit" tabs="inherit"';

function textXml(md: string): string {
  const STYLE: Record<Para['kind'], string> = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', p: 'Normal' };
  const run = (r: Para['runs'][number]) => {
    let s = esc(r.text).replace(/\t/g, '<tab/>');
    if (r.code) s = `<f family="Courier New" charset="0">${s}</f>`;
    if (r.italic) s = `<i>${s}</i>`;
    if (r.bold) s = `<b>${s}</b>`;
    return s;
  };
  const ps = paragraphs(md).map((p) => `<p style="${STYLE[p.kind]}" ${P_ATTRS}>${p.runs.map(run).join('')}</p>`);
  return `<text use-page-width="false" push-down="false" lock-width="true">${ps.join('') || `<p style="Normal" ${P_ATTRS}/>`}</text>`;
}

export function writeXmcd(plan: Plan): Uint8Array {
  const w = new MlWriter(false, plan.defined);
  let regionId = 0;
  const binary: string[] = [];
  const regions: string[] = [];
  /** A region; math regions sit on their baseline, 12 px below their top. */
  const region = (x: number, y: number, width: number, height: number, body: string, isMath = false) => {
    const alignY = isMath ? y + 12 : y;
    regions.push(`<region region-id="${++regionId}" left="${n(x)}" top="${n(y)}" width="${n(width)}" height="${n(height)}" align-x="${n(x)}" align-y="${n(alignY)}" show-border="false" show-highlight="false" is-protected="true" z-order="0" background-color="inherit" tag="">${body}</region>`);
  };
  const math = (inner: string, disabled?: boolean) => `<math optimize="false" disable-calc="${disabled ? 'true' : 'false'}">${inner}</math>`;

  const write = (it: Item) => {
    const { w: width, h: height } = itemSize(it);
    switch (it.k) {
      case 'math':
        region(it.x, it.y, width, height, math(w.statement(it.st), it.disabled), true);
        break;
      case 'text':
        region(it.x, it.y, width, height, textXml(it.md));
        break;
      case 'picture': {
        binary.push(`<item item-id="${binary.length + 1}">${toBase64(it.png).replace(/.{1,76}/g, '$&\n')}</item>`);
        region(it.x, it.y, width, height, `<picture><png item-idref="${binary.length}" display-width="${n(width)}" display-height="${n(height)}"/></picture>`);
        break;
      }
      case 'solve': {
        // guess values side by side, Given after them, the constraints and the solver below: one region each
        const guesses = it.guesses.map((g) => math(w.statement(g)));
        const constraints = it.constraints.map((c) => math(w.x(c)));
        const solver = math(w.statement(it.solver));
        let x = it.x, y = it.y;
        for (const g of guesses) {
          region(x, y, 110, 24, g, true);
          x += 120;
        }
        region(x, y, 50, 18, math(w.id('Given', 'keyword')), true);
        y += 30;
        for (const c of constraints) {
          region(it.x + 24, y, 240, 24, c, true);
          y += 30;
        }
        region(it.x, y, 240, 24, solver, true);
        break;
      }
      case 'plot':
        // never planned for Mathcad 15 (plan.ts makes a picture)
        break;
    }
  };
  for (const it of plan.items) {
    try {
      write(it);
    } catch (e) {
      if (!(e instanceof NotRepresentable)) throw e;
      write(notExported(it, e, 'Mathcad 15', plan));
    }
  }
  for (const [unit, as] of w.respelled) plan.warnings.push(`In Mathcad 15 the name ${unit} is the worksheet’s variable, so the unit ${unit} was written as (${as})`);
  for (const unit of w.droppedUnits) plan.warnings.push(`Display unit ${unit}: Mathcad 15 would read it as the worksheet’s variable, so the result shows in its default units`);
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:ws="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30" xmlns:u="http://schemas.mathsoft.com/units10" xmlns:p="http://schemas.mathsoft.com/provenance10">`;
  const meta = `<pointReleaseData/><metadata><generator>mathstudii</generator><userData><title>${esc(plan.title)}</title><description/><author/><company/><keywords/><revisedBy/></userData><identityInfo><revision>1</revision><documentID>${guid()}</documentID><versionID>${guid()}</versionID><parentVersionID>${ZERO_ID}</parentVersionID><branchID>${ZERO_ID}</branchID></identityInfo></metadata>`;
  const xml = `${head}\n${meta}\n${settings(plan.origin)}\n<regions>\n${regions.join('\n')}\n</regions>${binary.length ? `\n<binaryContent>\n${binary.join('\n')}\n</binaryContent>` : ''}\n</worksheet>\n`;
  return new TextEncoder().encode(xml);
}
