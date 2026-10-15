// Units offered while typing (no mathjs here, so the page can use it without the engine).

export interface UnitInfo {
  /** As typed in the worksheet. */
  u: string;
  /** What it is, for suggestion lists. */
  name: string;
}

const PREFIXED: [string, string][] = [
  // structural units first: they are what most suggestions should start with
  ['N', 'newton'], ['kN', 'kilonewton'], ['MN', 'meganewton'], ['kNm', 'kilonewton metre'], ['Nm', 'newton metre'], ['Nmm', 'newton millimetre'],
  ['kN/m', 'kilonewton per metre'], ['kN/m^2', 'kilonewton per m²'], ['kN/m^3', 'kilonewton per m³'], ['N/mm^2', 'newton per mm² (= MPa)'],
  ['Pa', 'pascal'], ['kPa', 'kilopascal'], ['MPa', 'megapascal'], ['GPa', 'gigapascal'], ['bar', 'bar'], ['mbar', 'millibar'],
  ['mm', 'millimetre'], ['cm', 'centimetre'], ['dm', 'decimetre'], ['m', 'metre'], ['km', 'kilometre'], ['um', 'micrometre'],
  ['mm^2', 'square millimetre'], ['cm^2', 'square centimetre'], ['m^2', 'square metre'], ['mm^3', 'cubic millimetre'], ['cm^3', 'cubic centimetre'],
  ['m^3', 'cubic metre'], ['mm^4', 'millimetre⁴'], ['cm^4', 'centimetre⁴'], ['L', 'litre'], ['mL', 'millilitre'], ['ha', 'hectare'],
  ['gm', 'gram'], ['kg', 'kilogram'], ['t', 'tonne'],
  ['s', 'second'], ['ms', 'millisecond'], ['min', 'minute'], ['hr', 'hour'], ['day', 'day'], ['year', 'year'],
  ['J', 'joule'], ['kJ', 'kilojoule'], ['MJ', 'megajoule'], ['kWh', 'kilowatt-hour'], ['W', 'watt'], ['kW', 'kilowatt'], ['MW', 'megawatt'],
  ['m/s', 'metre per second'], ['km/hr', 'kilometre per hour'], ['m/s^2', 'metre per second²'], ['Hz', 'hertz'], ['kHz', 'kilohertz'], ['rpm', 'revolutions per minute'],
  ['kg/m^3', 'kilogram per m³'], ['rad', 'radian'], ['deg', 'degree'], ['K', 'kelvin'], ['degC', 'degree Celsius'],
  ['A', 'ampere'], ['mA', 'milliampere'], ['V', 'volt'], ['kV', 'kilovolt'], ['ohm', 'ohm'], ['mol', 'mole'],
];

/** Units offered while typing, metric first. */
export const UNIT_SUGGESTIONS: UnitInfo[] = PREFIXED.map(([u, name]) => ({ u, name }));

