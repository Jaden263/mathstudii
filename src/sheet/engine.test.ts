import { describe, expect, it } from 'vitest';
import { calculate, Workbook, type WorkbookModel } from './engine';
import { translateFormula, tidyFormula, toFileFormula, fromFileFormula } from './formula';
import { parseCell } from './refs';
import { ERR } from './values';

/** One sheet from { A1: '…' } and the value of a cell after calculating. */
function book(cells: Record<string, string>, extra: Partial<WorkbookModel> = {}): Workbook {
  return calculate({ sheets: [{ name: 'Sheet1', cells }], ...extra });
}
const val = (wb: Workbook, ref: string, sheet = 0) => {
  const p = parseCell(ref)!;
  return wb.value(sheet, p.r, p.c);
};
/** The value of a single formula on an otherwise empty sheet. */
const f = (formula: string, cells: Record<string, string> = {}) => val(book({ ...cells, Z99: formula }), 'Z99');

describe('operators and coercion (Excel rules)', () => {
  it('precedence: unary minus before ^, ^ left to right, % after', () => {
    expect(f('=-2^2')).toBe(4);
    expect(f('=2^3^2')).toBe(64);
    expect(f('=1+2*3')).toBe(7);
    expect(f('=(1+2)*3')).toBe(9);
    expect(f('=50%')).toBe(0.5);
    expect(f('=2^-1')).toBe(0.5);
    expect(f('=1+2&"x"')).toBe('3x');
    expect(f('=1+2>2')).toBe(true);
  });
  it('coerces text and logicals in arithmetic, compares text without case', () => {
    expect(f('="3"+1')).toBe(4);
    expect(f('=TRUE+1')).toBe(2);
    expect(f('="abc"+1')).toBe(ERR.value);
    expect(f('="a"="A"')).toBe(true);
    expect(f('=1<"a"')).toBe(true); // numbers sort before text
    expect(f('="z"<TRUE')).toBe(true); // text before logicals
    expect(f('=A1=0', {})).toBe(true); // a blank cell is 0 …
    expect(f('=A1=""', {})).toBe(true); // … and ""
    expect(f('=A1', {})).toBe(0);
  });
  it('compares numbers to 15 digits and zeroes sums within rounding', () => {
    expect(f('=0.1+0.2=0.3')).toBe(true);
    expect(f('=1.1-1-0.1')).toBe(0);
  });
  it('errors propagate', () => {
    expect(f('=1/0')).toBe(ERR.div0);
    expect(f('=1/0+1')).toBe(ERR.div0);
    expect(f('=NOSUCHFUNC(1)')).toBe(ERR.name);
    expect(f('=undefinedname*2')).toBe(ERR.name);
    expect(f('=(-8)^(1/3)')).toBe(ERR.num);
    expect(f('=0^0')).toBe(ERR.num);
  });
});

describe('aggregates', () => {
  // A1 number, A2 text "2", A3 TRUE, A4 blank, A5 5
  const cells = { A1: '1', A2: "'2", A3: 'TRUE', A5: '5' };
  it('SUM skips text and logicals in ranges but counts typed ones', () => {
    expect(f('=SUM(A1:A5)', cells)).toBe(6);
    expect(f('=SUM(1,"2",TRUE)')).toBe(4);
    expect(f('=SUM(A:A)', cells)).toBe(6);
  });
  it('COUNT, COUNTA, COUNTBLANK, AVERAGE', () => {
    expect(f('=COUNT(A1:A5)', cells)).toBe(2);
    expect(f('=COUNTA(A1:A5)', cells)).toBe(4);
    expect(f('=COUNTBLANK(A1:A5)', cells)).toBe(1);
    expect(f('=AVERAGE(A1:A5)', cells)).toBe(3);
    expect(f('=AVERAGEA(A1:A5)', cells)).toBe(7 / 4);
    expect(f('=AVERAGE(B1:B3)', cells)).toBe(ERR.div0);
    expect(f('=AVERAGE("a","b")')).toBe(ERR.value);
    expect(f('=MAX(A1:A5)', cells)).toBe(5);
    expect(f('=MIN(B1:B3)', cells)).toBe(0);
    expect(f('=COUNT(A1,1/0,3)', { A1: '1' })).toBe(2); // errors are not counted, not raised
  });
  // Microsoft's SUMIFS example (support.microsoft.com, "SUMIFS function")
  const sales = {
    A1: 'Quantity Sold', B1: 'Product', C1: 'Salesperson',
    A2: '5', B2: 'Apples', C2: 'Tom', A3: '4', B3: 'Apples', C3: 'Sarah',
    A4: '15', B4: 'Artichokes', C4: 'Tom', A5: '3', B5: 'Artichokes', C5: 'Sarah',
    A6: '22', B6: 'Bananas', C6: 'Tom', A7: '12', B7: 'Bananas', C7: 'Sarah',
    A8: '10', B8: 'Carrots', C8: 'Tom', A9: '33', B9: 'Carrots', C9: 'Sarah',
  };
  it('SUMIFS with wildcards and <> (Microsoft example: 20 and 30)', () => {
    expect(f('=SUMIFS(A2:A9, B2:B9, "=A*", C2:C9, "Tom")', sales)).toBe(20);
    expect(f('=SUMIFS(A2:A9, B2:B9, "<>Bananas", C2:C9, "Tom")', sales)).toBe(30);
  });
  it('SUMIF, COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS', () => {
    expect(f('=SUMIF(B2:B9, "Bananas", A2:A9)', sales)).toBe(34);
    expect(f('=SUMIF(A2:A9, ">10")', sales)).toBe(15 + 22 + 12 + 33);
    expect(f('=COUNTIF(C2:C9, "tom")', sales)).toBe(4);
    expect(f('=COUNTIF(A2:A9, "<=5")', sales)).toBe(3);
    expect(f('=COUNTIFS(C2:C9, "Sarah", A2:A9, ">4")', sales)).toBe(2);
    expect(f('=AVERAGEIF(C2:C9, "Sarah", A2:A9)', sales)).toBe((4 + 3 + 12 + 33) / 4);
    expect(f('=AVERAGEIFS(A2:A9, B2:B9, "C*")', sales)).toBe(21.5);
    expect(f('=MAXIFS(A2:A9, C2:C9, "Tom")', sales)).toBe(22);
    expect(f('=MINIFS(A2:A9, C2:C9, "Sarah", B2:B9, "<>Artichokes")', sales)).toBe(4);
    expect(f('=COUNTIF(B2:B9, "?????")', sales)).toBe(0);
    expect(f('=COUNTIF(B2:B9, "*a*")', sales)).toBe(8);
    expect(f('=COUNTIFS(A2:A9, ">3", A2:A3, ">3")', sales)).toBe(ERR.value); // ranges of different size
  });
  it('SUMPRODUCT with array arithmetic', () => {
    const c = { A1: '1', A2: '2', A3: '3', B1: '4', B2: '5', B3: '6' };
    expect(f('=SUMPRODUCT(A1:A3, B1:B3)', c)).toBe(32);
    expect(f('=SUMPRODUCT((A1:A3>1)*B1:B3)', c)).toBe(11);
    expect(f('=SUMPRODUCT(A1:A3, B1:B2)', c)).toBe(ERR.value);
  });
});

describe('lookup', () => {
  // the density / viscosity / temperature table of Microsoft's VLOOKUP help (Excel 2007)
  const air: Record<string, string> = {};
  [[0.457, 3.55, 500], [0.525, 3.25, 400], [0.606, 2.93, 300], [0.675, 2.75, 250], [0.746, 2.57, 200],
    [0.835, 2.38, 150], [0.946, 2.17, 100], [1.09, 1.95, 50], [1.29, 1.71, 0]].forEach((row, i) => {
    row.forEach((v, j) => { air[`${'ABC'[j]}${i + 2}`] = String(v); });
  });
  it('VLOOKUP approximate and exact (Microsoft example values)', () => {
    expect(f('=VLOOKUP(1,A2:C10,2)', air)).toBe(2.17);
    expect(f('=VLOOKUP(1,A2:C10,3,TRUE)', air)).toBe(100);
    expect(f('=VLOOKUP(0.7,A2:C10,3,FALSE)', air)).toBe(ERR.na);
    expect(f('=VLOOKUP(0.1,A2:C10,2,TRUE)', air)).toBe(ERR.na);
    expect(f('=VLOOKUP(2,A2:C10,2,TRUE)', air)).toBe(1.71);
    expect(f('=VLOOKUP(0.746,A2:C10,3,FALSE)', air)).toBe(200);
    expect(f('=VLOOKUP(1,A2:C10,4)', air)).toBe(ERR.ref);
    expect(f('=VLOOKUP(1,A2:C10,0)', air)).toBe(ERR.value);
  });
  const parts = { A1: 'Bolt', B1: '12', A2: 'Nut', B2: '3', A3: 'Washer', B3: '1', D1: 'Bolt', E1: 'Nut', F1: 'Washer', D2: '12', E2: '3', F2: '1' };
  it('HLOOKUP, INDEX/MATCH, XLOOKUP, LOOKUP', () => {
    expect(f('=HLOOKUP("nut",D1:F2,2,FALSE)', parts)).toBe(3);
    expect(f('=INDEX(B1:B3, MATCH("Washer", A1:A3, 0))', parts)).toBe(1);
    expect(f('=MATCH("W*", A1:A3, 0)', parts)).toBe(3);
    expect(f('=MATCH(5, B1:B3, 0)', parts)).toBe(ERR.na);
    expect(f('=INDEX(A1:B3, 2, 2)', parts)).toBe(3);
    expect(f('=INDEX(D1:F1, 3)', parts)).toBe('Washer');
    expect(f('=INDEX(A1:B3, 4, 1)', parts)).toBe(ERR.ref);
    expect(f('=SUM(INDEX(A1:B3, 0, 2))', parts)).toBe(16);
    expect(f('=XLOOKUP("Nut", A1:A3, B1:B3)', parts)).toBe(3);
    expect(f('=XLOOKUP("Screw", A1:A3, B1:B3, "none")', parts)).toBe('none');
    expect(f('=XLOOKUP("Screw", A1:A3, B1:B3)', parts)).toBe(ERR.na);
    expect(f('=XLOOKUP(5, B1:B3, A1:A3, , -1)', parts)).toBe('Nut'); // next smaller
    expect(f('=XLOOKUP(5, B1:B3, A1:A3, , 1)', parts)).toBe('Bolt'); // next larger
    const sorted = { A1: '1', A2: '3', A3: '5', B1: 'a', B2: 'b', B3: 'c' };
    expect(f('=MATCH(4, A1:A3)', sorted)).toBe(2);
    expect(f('=LOOKUP(4.5, A1:A3, B1:B3)', sorted)).toBe('b');
    expect(f('=CHOOSE(2, "x", "y", "z")')).toBe('y');
  });
});

describe('maths functions', () => {
  it('rounding as Excel does it', () => {
    expect(f('=ROUND(2.5,0)')).toBe(3);
    expect(f('=ROUND(-2.5,0)')).toBe(-3);
    expect(f('=ROUND(1.005,2)')).toBe(1.01); // binary 1.00499999… but Excel gives 1.01
    expect(f('=ROUND(1234.567,-2)')).toBe(1200);
    expect(f('=ROUNDUP(3.2,0)')).toBe(4);
    expect(f('=ROUNDUP(-3.14159,1)')).toBe(-3.2);
    expect(f('=ROUNDDOWN(-3.7,0)')).toBe(-3);
    expect(f('=MROUND(10,3)')).toBe(9);
    expect(f('=MROUND(-10,-3)')).toBe(-9);
    expect(f('=MROUND(5,-2)')).toBe(ERR.num);
    expect(f('=CEILING(2.5,1)')).toBe(3);
    expect(f('=CEILING(-2.5,2)')).toBe(-2);
    expect(f('=CEILING(-2.5,-2)')).toBe(-4);
    expect(f('=CEILING(2.5,-2)')).toBe(ERR.num);
    expect(f('=FLOOR(-2.5,2)')).toBe(-4);
    expect(f('=FLOOR(-2.5,-2)')).toBe(-2);
    expect(f('=FLOOR(2.5,0)')).toBe(ERR.div0);
    expect(f('=CEILING.MATH(-5.5,2,-1)')).toBe(-6);
    expect(f('=FLOOR.MATH(-5.5,2,-1)')).toBe(-4);
    expect(f('=INT(-1.5)')).toBe(-2);
    expect(f('=TRUNC(-1.59)')).toBe(-1);
    expect(f('=MOD(-3,2)')).toBe(1);
    expect(f('=MOD(3,-2)')).toBe(-1);
    expect(f('=MOD(3,0)')).toBe(ERR.div0);
    expect(f('=EVEN(-1.5)')).toBe(-2);
    expect(f('=ODD(2)')).toBe(3);
  });
  it('powers, logs, trigonometry', () => {
    expect(f('=SQRT(16)')).toBe(4);
    expect(f('=SQRT(-4)')).toBe(ERR.num);
    expect(f('=POWER(5,2)')).toBe(25);
    expect(f('=LOG(8,2)')).toBeCloseTo(3, 14);
    expect(f('=LOG(100)')).toBe(2);
    expect(f('=LN(EXP(3))')).toBeCloseTo(3, 14);
    expect(f('=LN(0)')).toBe(ERR.num);
    expect(f('=ATAN2(1,1)')).toBeCloseTo(Math.PI / 4, 15);
    expect(f('=ATAN2(-1,0)')).toBeCloseTo(Math.PI, 15); // x = -1, y = 0
    expect(f('=ATAN2(0,0)')).toBe(ERR.div0);
    expect(f('=DEGREES(PI())')).toBe(180);
    expect(f('=SIN(RADIANS(30))')).toBeCloseTo(0.5, 15);
    expect(f('=ASIN(2)')).toBe(ERR.num);
    expect(f('=FACT(5)')).toBe(120);
    expect(f('=COMBIN(8,2)')).toBe(28);
    expect(f('=ABS(-3)+SIGN(-2)')).toBe(2);
    expect(f('=GCD(24,36)')).toBe(12);
    expect(f('=LCM(4,6)')).toBe(12);
  });
});

describe('logical, text, information', () => {
  it('IF, IFS, IFERROR, AND, OR, NOT, XOR, SWITCH', () => {
    expect(f('=IF(1>2,"a","b")')).toBe('b');
    expect(f('=IF(1>2,"a")')).toBe(false);
    expect(f('=IF(TRUE,1/0,1)')).toBe(ERR.div0);
    expect(f('=IF(FALSE,1/0,1)')).toBe(1);
    expect(f('=IFS(1>2,"a",2>1,"b")')).toBe('b');
    expect(f('=IFS(1>2,"a")')).toBe(ERR.na);
    expect(f('=IFERROR(1/0,"x")')).toBe('x');
    expect(f('=IFNA(NA(),0)')).toBe(0);
    expect(f('=AND(TRUE,1,2>1)')).toBe(true);
    expect(f('=OR(FALSE,0)')).toBe(false);
    expect(f('=XOR(TRUE,TRUE,TRUE)')).toBe(true);
    expect(f('=NOT(0)')).toBe(true);
    expect(f('=AND("x")')).toBe(ERR.value);
    expect(f('=SWITCH(2,1,"one",2,"two","other")')).toBe('two');
    expect(f('=SWITCH(9,1,"one","other")')).toBe('other');
  });
  it('text functions (Microsoft examples)', () => {
    expect(f('=LEFT("Sale Price",4)')).toBe('Sale');
    expect(f('=RIGHT("Stock Number")')).toBe('r');
    expect(f('=MID("Fluid Flow",7,20)')).toBe('Flow');
    expect(f('=LEN("Phoenix, AZ")')).toBe(11);
    expect(f('=FIND("M","Miriam McGovern")')).toBe(1);
    expect(f('=FIND("m","Miriam McGovern")')).toBe(6);
    expect(f('=FIND("z","abc")')).toBe(ERR.value);
    expect(f('=SEARCH("e","Statements",6)')).toBe(7);
    expect(f('=SEARCH("m?n","Ammonia")')).toBe(3);
    expect(f('=SEARCH("m?o","Ammonia")')).toBe(2);
    expect(f('=SEARCH("x*","Ammonia")')).toBe(ERR.value);
    expect(f('=SUBSTITUTE("Quarter 1, 2011", "1", "2", 3)')).toBe('Quarter 1, 2012');
    expect(f('=SUBSTITUTE("Sales Data", "Sales", "Cost")')).toBe('Cost Data');
    expect(f('=REPLACE("abcdefghijk",6,5,"*")')).toBe('abcde*k');
    expect(f('=TRIM(" First   Quarter Earnings ")')).toBe('First Quarter Earnings');
    expect(f('=PROPER("this is a TITLE")')).toBe('This Is A Title');
    expect(f('=UPPER("total")&LOWER("E. E.")')).toBe('TOTALe. e.');
    expect(f('=CONCAT("a",1,TRUE)')).toBe('a1TRUE');
    expect(f('=CONCAT(A1:A3)', { A1: 'x', A3: 'z' })).toBe('xz');
    expect(f('=TEXTJOIN(", ",TRUE,"a","","b")')).toBe('a, b');
    expect(f('=TEXTJOIN("-",FALSE,A1:A3)', { A1: 'x', A3: 'z' })).toBe('x--z');
    expect(f('=VALUE("1,234.5")')).toBe(1234.5);
    expect(f('=VALUE("50%")')).toBe(0.5);
    expect(f('=VALUE("abc")')).toBe(ERR.value);
    expect(f('=EXACT("a","A")')).toBe(false);
    expect(f('=REPT("ab",3)')).toBe('ababab');
    expect(f('="x"&0.1+0.2')).toBe('x0.3');
  });
  it('TEXT with simple formats', () => {
    expect(f('=TEXT(1234.567,"#,##0.00")')).toBe('1,234.57');
    expect(f('=TEXT(0.125,"0.0%")')).toBe('12.5%');
    expect(f('=TEXT(12345,"0.00E+00")')).toBe('1.23E+04');
    expect(f('=TEXT(3.14159,"0.000")')).toBe('3.142');
    expect(f('=TEXT(-5,"0.0;(0.0)")')).toBe('(5.0)');
    expect(f('=TEXT(7,"000")')).toBe('007');
    expect(f('=TEXT(45000,"yyyy-mm-dd")')).toBe('2023-03-15');
    expect(f('=TEXT(45000.75,"d mmm yyyy hh:mm")')).toBe('15 Mar 2023 18:00');
    expect(f('=TEXT(45000,"dddd")')).toBe('Wednesday');
    expect(f('=TEXT(2.5,"0.0"" kN""")')).toBe('2.5 kN');
  });
  it('IS functions', () => {
    const c = { A1: '1', A2: 'x', A4: '=1/0', A5: '=NA()' };
    expect(f('=ISNUMBER(A1)', c)).toBe(true);
    expect(f('=ISTEXT(A2)', c)).toBe(true);
    expect(f('=ISBLANK(A3)', c)).toBe(true);
    expect(f('=ISBLANK(A1)', c)).toBe(false);
    expect(f('=ISERROR(A4)', c)).toBe(true);
    expect(f('=ISERR(A5)', c)).toBe(false);
    expect(f('=ISNA(A5)', c)).toBe(true);
    expect(f('=ISLOGICAL(TRUE)')).toBe(true);
    expect(f('=ERROR.TYPE(A4)', c)).toBe(2);
  });
});

describe('dates', () => {
  it('serial 45000 is 15 March 2023 (1900 system)', () => {
    expect(f('=DATE(2023,3,15)')).toBe(45000);
    expect(f('=YEAR(45000)&"-"&MONTH(45000)&"-"&DAY(45000)')).toBe('2023-3-15');
    expect(f('=WEEKDAY(45000)')).toBe(4); // Wednesday, Sunday = 1
    expect(f('=WEEKDAY(45000,2)')).toBe(3);
  });
  it('keeps Excel\'s 29 February 1900', () => {
    expect(f('=DATE(1900,2,28)')).toBe(59);
    expect(f('=DATE(1900,3,1)')).toBe(61);
    expect(f('=TEXT(60,"yyyy-mm-dd")')).toBe('1900-02-29');
    expect(f('=DATE(1900,1,1)')).toBe(1);
  });
  it('the 1904 system counts 1462 days fewer', () => {
    const wb = book({ A1: '=DATE(2023,3,15)', A2: '=TEXT(A1,"yyyy-mm-dd")' }, { date1904: true });
    expect(val(wb, 'A1')).toBe(45000 - 1462);
    expect(val(wb, 'A2')).toBe('2023-03-15');
  });
  it('months roll over, EDATE and EOMONTH clamp, times', () => {
    expect(f('=DATE(2023,13,1)')).toBe(f('=DATE(2024,1,1)'));
    expect(f('=TEXT(EDATE(DATE(2023,1,31),1),"yyyy-mm-dd")')).toBe('2023-02-28');
    expect(f('=TEXT(EOMONTH(DATE(2024,1,15),1),"yyyy-mm-dd")')).toBe('2024-02-29');
    expect(f('=TIME(12,0,0)')).toBe(0.5);
    expect(f('=HOUR(0.75)')).toBe(18);
    expect(f('=DAYS(DATE(2023,3,15),DATE(2023,1,1))')).toBe(73);
    expect(f('=DATEVALUE("2023-03-15")')).toBe(45000);
    expect(f('=NETWORKDAYS(DATE(2023,3,13),DATE(2023,3,19))')).toBe(5);
  });
  it('TODAY and NOW follow the calculation time', () => {
    const wb = calculate({ sheets: [{ name: 'S', cells: { A1: '=TODAY()', A2: '=NOW()-TODAY()' } }] }, { now: new Date(2023, 2, 15, 6, 0, 0).getTime() });
    expect(val(wb, 'A1')).toBe(45000);
    expect(val(wb, 'A2') as number).toBeCloseTo(0.25, 9);
  });
});

describe('statistics', () => {
  const d = { A1: '2', A2: '4', A3: '4', A4: '4', A5: '5', A6: '5', A7: '7', A8: '9' };
  it('standard deviation and variance of 2, 4, 4, 4, 5, 5, 7, 9 (σ = 2)', () => {
    expect(f('=STDEV.P(A1:A8)', d)).toBe(2);
    expect(f('=STDEV.S(A1:A8)', d)).toBeCloseTo(Math.sqrt(32 / 7), 14);
    expect(f('=STDEV(A1:A8)', d)).toBeCloseTo(Math.sqrt(32 / 7), 14);
    expect(f('=VAR(A1:A8)', d)).toBeCloseTo(32 / 7, 14);
    expect(f('=VAR.P(A1:A8)', d)).toBe(4);
    expect(f('=MEDIAN(A1:A8)', d)).toBe(4.5);
    expect(f('=MODE.SNGL(A1:A8)', d)).toBe(4);
  });
  it('LARGE, SMALL, RANK (Microsoft RANK example), PERCENTILE, QUARTILE', () => {
    expect(f('=LARGE({3,5,3,5,4},3)')).toBe(4);
    expect(f('=SMALL({3,5,3,5,4},2)')).toBe(3);
    expect(f('=SMALL({3,5},3)')).toBe(ERR.num);
    const r = { A2: '7', A3: '3.5', A4: '3.5', A5: '1', A6: '2' };
    expect(f('=RANK(A3,A2:A6,1)', r)).toBe(3);
    expect(f('=RANK(A2,A2:A6,1)', r)).toBe(5);
    expect(f('=RANK(A2,A2:A6)', r)).toBe(1);
    expect(f('=RANK.AVG(3.5,A2:A6,1)', r)).toBe(3.5);
    expect(f('=PERCENTILE({1,2,3,4},0.3)')).toBeCloseTo(1.9, 14);
    expect(f('=QUARTILE({1,2,4,7,8,9,10,12},1)')).toBe(3.5);
  });
  it('SLOPE, INTERCEPT, CORREL and LINEST (Microsoft LINEST example: m = 2, b = 1)', () => {
    const c = { A2: '1', A3: '9', A4: '5', A5: '7', B2: '0', B3: '4', B4: '2', B5: '3', D1: '=LINEST(A2:A5,B2:B5,,FALSE)' };
    const wb = book(c);
    expect(val(wb, 'D1')).toBeCloseTo(2, 13);
    expect(val(wb, 'E1')).toBeCloseTo(1, 13);
    expect(f('=SLOPE(A2:A5,B2:B5)', c)).toBeCloseTo(2, 14);
    expect(f('=INTERCEPT(A2:A5,B2:B5)', c)).toBeCloseTo(1, 14);
  });
  it('LINEST statistics against the closed form of simple regression', () => {
    // y = 1, 3, 2, 5, 4 at x = 1 … 5: m = 0.8, b = 0.6, SSresid = 3.6, SSreg = 6.4
    const wb = book({ A1: '1', A2: '3', A3: '2', A4: '5', A5: '4', C1: '=LINEST(A1:A5,,TRUE,TRUE)' });
    const at = (r: string) => val(wb, r) as number;
    expect(at('C1')).toBeCloseTo(0.8, 13);
    expect(at('D1')).toBeCloseTo(0.6, 13);
    expect(at('C3')).toBeCloseTo(6.4 / 10, 13); // r²
    expect(at('D3')).toBeCloseTo(Math.sqrt(3.6 / 3), 13); // standard error of y
    expect(at('C2')).toBeCloseTo(Math.sqrt(3.6 / 3 / 10), 13); // se of m = sey / √Sxx
    expect(at('C4')).toBeCloseTo(6.4 / (3.6 / 3), 12); // F
    expect(at('D4')).toBe(3);
    expect(at('C5')).toBeCloseTo(6.4, 12);
    expect(at('D5')).toBeCloseTo(3.6, 12);
    expect(val(wb, 'E1')).toBe(null); // two columns wide: nothing spills into E
  });
});

describe('arrays and spills', () => {
  it('MMULT, TRANSPOSE and range arithmetic spill into the cells beside them', () => {
    const wb = book({ A1: '1', B1: '2', A2: '3', B2: '4', D1: '=MMULT(A1:B2,A1:B2)', G1: '=TRANSPOSE(A1:B1)', I1: '=A1:A2*10', K1: '=SUM(D1:E2)' });
    expect([val(wb, 'D1'), val(wb, 'E1'), val(wb, 'D2'), val(wb, 'E2')]).toEqual([7, 10, 15, 22]);
    expect([val(wb, 'G1'), val(wb, 'G2')]).toEqual([1, 2]);
    expect([val(wb, 'I1'), val(wb, 'I2')]).toEqual([10, 30]);
    // a formula reading the spilled cells sees them (the spill area is known after the first pass)
    expect(val(wb, 'K1')).toBe(54);
  });
  it('a spill onto a filled cell is #SPILL!', () => {
    const wb = book({ A1: '1', A2: '2', C1: '=A1:A2', C2: 'x' });
    expect(val(wb, 'C1')).toBe(ERR.spill);
    expect(val(wb, 'C2')).toBe('x');
  });
  it('MINVERSE and MDETERM', () => {
    const wb = book({ A1: '4', B1: '7', A2: '2', B2: '6', D1: '=MINVERSE(A1:B2)', F1: '=MDETERM(A1:B2)' });
    expect(val(wb, 'D1')).toBeCloseTo(0.6, 14);
    expect(val(wb, 'E1')).toBeCloseTo(-0.7, 14);
    expect(val(wb, 'D2')).toBeCloseTo(-0.2, 14);
    expect(val(wb, 'E2')).toBeCloseTo(0.4, 14);
    expect(val(wb, 'F1')).toBeCloseTo(10, 13);
    expect(f('=MINVERSE({1,2;2,4})')).toBe(ERR.num);
  });
});

describe('references, names, sheets', () => {
  it('sheet-qualified, quoted and 3-D references', () => {
    const wb = calculate({
      sheets: [
        { name: 'Sheet1', cells: { A1: '11', B1: "=Sheet2!A1+'Load cases'!B2", C1: '=SUM(Sheet1:Sheet2!A1)' } },
        { name: 'Sheet2', cells: { A1: '22' } },
        { name: 'Load cases', cells: { B2: '5' } },
      ],
    });
    expect(val(wb, 'B1')).toBe(27);
    expect(val(wb, 'C1')).toBe(33);
    expect(calculate({ sheets: [{ name: 'S', cells: { A1: '=Nope!A1' } }] }).value(0, 0, 0)).toBe(ERR.ref);
  });
  it('defined names, global and local to a sheet', () => {
    const wb = calculate({
      sheets: [{ name: 'Data', cells: { A1: '100', A2: '200', B1: '=SUM(loads)*rate', B2: '=k' } }, { name: 'Other', cells: { A1: '=k' } }],
      names: [{ name: 'loads', ref: 'Data!$A$1:$A$2' }, { name: 'rate', ref: '0.5' }, { name: 'k', ref: '1', sheet: 0 }, { name: 'k', ref: '2' }],
    });
    expect(val(wb, 'B1')).toBe(150);
    expect(val(wb, 'B2')).toBe(1);
    expect(wb.value(1, 0, 0)).toBe(2);
    expect(wb.resolve('loads')).toEqual({ sheet: 0, area: { r1: 0, c1: 0, r2: 1, c2: 0 } });
  });
  it('OFFSET and INDIRECT', () => {
    const c = { A1: '1', A2: '2', A3: '3', B1: 'A2' };
    expect(f('=SUM(OFFSET(A1,1,0,2,1))', c)).toBe(5);
    expect(f('=INDIRECT(B1)*10', c)).toBe(20);
    expect(f('=ROW(A3)+COLUMN(C1)+ROWS(A1:A3)+COLUMNS(A1:D1)', c)).toBe(3 + 3 + 3 + 4);
  });
});

describe('dependencies and cycles', () => {
  it('calculates in dependency order whatever the cell order', () => {
    // a chain written bottom-up: A1000 = A999 + 1 … A1 = 1
    const cells: Record<string, string> = { A1: '1' };
    for (let i = 2; i <= 3000; i++) cells[`A${i}`] = `=A${i - 1}+1`;
    const reversed = Object.fromEntries(Object.entries(cells).reverse());
    const wb = book(reversed);
    expect(val(wb, 'A3000')).toBe(3000);
  });
  it('finds circular references and names the loop', () => {
    const wb = book({ A1: '=B1+1', B1: '=C1*2', C1: '=A1', D1: '=A1+1', E1: '=5', F1: '=F1+1' });
    expect(val(wb, 'A1')).toBe(ERR.circ);
    expect(val(wb, 'B1')).toBe(ERR.circ);
    expect(val(wb, 'C1')).toBe(ERR.circ);
    expect(val(wb, 'D1')).toBe(ERR.circ); // depends on the loop
    expect(val(wb, 'E1')).toBe(5);
    expect(wb.cycles.map((c) => c.text).sort()).toEqual(['A1 → B1 → C1 → A1', 'F1 → F1']);
  });
  it('a range that holds its own formula is circular too', () => {
    const cells: Record<string, string> = { A1: '=SUM(A2:A40)', B1: '=SUM(A1:A40)', C1: '=SUM(C1:C40)' };
    for (let i = 2; i <= 40; i++) cells[`A${i}`] = '1';
    const wb = book(cells);
    expect(val(wb, 'A1')).toBe(39);
    expect(val(wb, 'B1')).toBe(78);
    expect(val(wb, 'C1')).toBe(ERR.circ);
    expect(wb.cycles.map((c) => c.text)).toEqual(['C1 → C1']);
  });
  it('two thousand lookups over a column of formulas take well under a second or two', () => {
    // a large range is one node of the dependency graph and is read once per calculation
    const cells: Record<string, string> = {};
    const n = 2000;
    for (let i = 1; i <= n; i++) {
      cells[`A${i}`] = String(i);
      cells[`B${i}`] = `=A${i}^2`;
      cells[`C${i}`] = `=VLOOKUP(A${i},$A$1:$B$${n},2,FALSE)`;
    }
    cells.D1 = `=SUM(C1:C${n})`;
    const t0 = performance.now();
    const wb = book(cells);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(val(wb, 'C1500')).toBe(1500 ** 2);
    expect(val(wb, 'D1')).toBe((n * (n + 1) * (2 * n + 1)) / 6);
  });
  it('recalculates after a change and after an input is written over a cell', () => {
    const wb = book({ A1: '2', B1: '=A1^2', C1: '=B1+A1' });
    expect(val(wb, 'C1')).toBe(6);
    wb.setCell(0, 0, 0, '3');
    wb.recalc();
    expect(val(wb, 'C1')).toBe(12);
    wb.setInput(0, 0, 0, 10);
    wb.recalc();
    expect(val(wb, 'C1')).toBe(110);
  });
  it('a formula that cannot be read is #NAME? with the reason kept', () => {
    const wb = book({ A1: '=1+', B1: '=SUM(1,2' });
    expect(val(wb, 'A1')).toBe(ERR.name);
    expect(wb.parseErrors.size).toBe(2);
  });
});

describe('formula text', () => {
  it('relative references move when copied, absolute ones stay', () => {
    expect(translateFormula('=A1+$B$1+A$2+$C3', 2, 1)).toBe('=B3+$B$1+B$2+$C5');
    expect(translateFormula('=SUM(A1:A3)*Sheet2!B$1', 1, 0)).toBe('=SUM(A2:A4)*Sheet2!B$1');
    expect(translateFormula('=SUM(A:A)+SUM(2:2)', 1, 1)).toBe('=SUM(B:B)+SUM(3:3)');
    expect(translateFormula('=A1', -1, 0)).toBe('=#REF!');
    expect(translateFormula('="A1"&A1', 0, 1)).toBe('="A1"&B1');
  });
  it('copied formulas calculate with their moved references', () => {
    // C1 = A1*$B$1 filled down to C3
    const cells: Record<string, string> = { A1: '1', A2: '2', A3: '3', B1: '10' };
    for (let i = 0; i < 3; i++) cells[`C${i + 1}`] = translateFormula('=A1*$B$1', i, 0);
    const wb = book(cells);
    expect([val(wb, 'C1'), val(wb, 'C2'), val(wb, 'C3')]).toEqual([10, 20, 30]);
  });
  it('tidies typed formulas and adds or strips file prefixes', () => {
    expect(tidyFormula('=sum(a1:b2)+stdev.s(c1:c3)*true')).toBe('=SUM(A1:B2)+STDEV.S(C1:C3)*TRUE');
    expect(tidyFormula('="sum(a1)"')).toBe('="sum(a1)"');
    expect(toFileFormula('=XLOOKUP(A1,B:B,C:C)+STDEV.S(D1:D3)+SUM(E1)')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)+_xlfn.STDEV.S(D1:D3)+SUM(E1)');
    expect(fromFileFormula('_xlfn.IFS(A1>0,1,TRUE,2)')).toBe('=IFS(A1>0,1,TRUE,2)');
    expect(toFileFormula('=SORT(A1:A3)')).toBe('_xlfn._xlws.SORT(A1:A3)');
  });
});

describe('what cells show', () => {
  it('number formats, General to the column width, and dates from date functions', () => {
    const wb = calculate({ sheets: [{ name: 'S', cells: { A1: '=DATE(2023,3,15)', A2: '=1/3', A3: '1234.5', A4: '=NOW()', A5: '=DATE(2023,3,15)' }, styles: { A3: { fmt: '#,##0.00' }, A5: { fmt: '0' } } }] });
    expect(wb.display(0, 0, 0)).toBe('2023-03-15');
    expect(wb.display(0, 1, 0)).toBe('0.333333333');
    expect(wb.display(0, 1, 0, 6)).toBe('0.3333');
    expect(wb.display(0, 2, 0)).toBe('1,234.50');
    expect(wb.display(0, 3, 0)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(wb.display(0, 4, 0)).toBe('45000'); // a format of its own wins
  });
});
