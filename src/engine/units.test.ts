import { it, expect } from 'vitest';
import { math } from './math';
it('all extra units exist', () => {
  const names = ['gm','mph','kph','kmh','knot','rev','rpm','ksi','kipf','tonf','cal','kcal','mmHg','inHg','mbar','ha','are','dyn','erg','St','cSt','P','cP','Mach','pcf','slug','galUK'];
  const missing = names.filter((n) => !math.Unit.isValuelessUnit(n));
  expect(missing).toEqual([]);
  // 120 rpm = 2 rev/s = 4π rad/s; a 50 mm crank tip moves at 0.2π m/s
  expect(math.evaluate('120 rpm * 50 mm / (1 rad) to m/s').toNumber('m/s')).toBeCloseTo(0.2 * Math.PI, 9);
});
