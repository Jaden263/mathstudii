import { it } from 'vitest';
import { evaluateWorksheet } from './engine/evaluator';
import { beamExample } from './model/examples';
it('x', () => {
  const ws = beamExample();
  const out = evaluateWorksheet(ws);
  for (const r of ws.regions) { const res = out.results.get(r.id) as any; if (res?.error || (res?.errors && Object.keys(res.errors).length)) console.log('ERR', r.kind, (r as any).source ?? (r as any).name, res.error, JSON.stringify(res.errors)); }
  console.log(ws.regions.filter(r => r.kind==='math').slice(0,6).map((r: any) => r.source + ' @' + r.x + ',' + r.y).join('\n'));
});
