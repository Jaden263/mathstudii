// Tabular data in and out of table regions: pasted Excel ranges (tab separated), CSV
// and TSV files (comma or semicolon, decimal point or comma), with an optional header
// row whose cells may carry units: "x [m]", "F (kN)".

export interface TableData {
  headers: string[];
  units: string[];
  cells: string[][];
}

/** Split delimited text into rows of cells (quotes and doubled quotes understood). */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const firstLines = src.split('\n').slice(0, 20).join('\n');
  const count = (ch: string) => (firstLines.match(new RegExp(ch === '|' ? '\\|' : ch, 'g')) ?? []).length;
  const delim = firstLines.includes('\t') ? '\t' : count(';') > count(',') / 2 && count(';') > 0 ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r.map((c) => c.trim()), ...Array(width - r.length).fill('')]);
}

const NUMBER = /^[-+]?(\d[\d\s\u00a0\u2009'.,]*)?([.,]\d+)?([eE][-+]?\d+)?$/;

/** "1 234,5" → "1234.5" when the data uses a decimal comma; leaves other text alone. */
function cleanNumber(c: string, decimalComma: boolean): string {
  if (!c || !NUMBER.test(c) || !/\d/.test(c)) return c;
  let s = c.replace(/[\s  ']/g, '');
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return s;
}

const isNumeric = (c: string) => c === '' || (NUMBER.test(c) && /\d/.test(c));

/** Header row detection, units from "name [unit]", decimal commas fixed. */
export function toTableData(grid: string[][]): TableData {
  if (!grid.length) return { headers: [], units: [], cells: [['']] };
  const body = grid.slice(1);
  const hasHeader = grid.length > 1 && grid[0].some((c) => c && !isNumeric(c)) && body.some((r) => r.some((c) => c && isNumeric(c)));
  const rows = hasHeader ? body : grid;
  // a comma decimal separator: numbers like 3,5 and no number like 3.5 or 1,234.5
  const nums = rows.flat().filter((c) => c && NUMBER.test(c));
  const decimalComma = nums.some((c) => /^[-+]?[\d.\s]*,\d+$/.test(c) && !/,\d{3}$/.test(c))
    && !nums.some((c) => /\.\d+$/.test(c) && !c.includes(',') && !/\.\d{3}$/.test(c));
  const cells = rows.map((r) => r.map((c) => cleanNumber(c, decimalComma)));
  const headers: string[] = [];
  const units: string[] = [];
  if (hasHeader) {
    for (const h of grid[0]) {
      const m = /^(.*?)\s*[[(]\s*([^\])]*)\s*[\])]\s*$/.exec(h);
      if (m && m[2] && !/^-$/.test(m[2])) {
        headers.push(m[1].trim());
        units.push(m[2].trim().replace(/²/g, '^2').replace(/³/g, '^3').replace(/⁴/g, '^4').replace(/·/g, ' '));
      } else {
        headers.push(h.trim());
        units.push('');
      }
    }
  } else {
    const w = cells[0]?.length ?? 1;
    for (let j = 0; j < w; j++) { headers.push(''); units.push(''); }
  }
  return { headers, units, cells: cells.length ? cells : [['']] };
}

/** CSV with a header row "name [unit]" (comma separated, quotes where needed). */
export function toCsv(headers: string[], units: string[], cells: string[][]): string {
  const width = Math.max(headers.length, units.length, ...cells.map((r) => r.length));
  const q = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = Array.from({ length: width }, (_, j) => {
    const h = headers[j] || `col${j}`;
    return q(units[j] ? `${h} [${units[j]}]` : h);
  });
  const lines = [head.join(',')];
  for (const r of cells) lines.push(Array.from({ length: width }, (_, j) => q(r[j] ?? '')).join(','));
  return lines.join('\n') + '\n';
}

/** Tab separated rows (what Excel pastes). */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.join('\t')).join('\n');
}
