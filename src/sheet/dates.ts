// Excel date serials. In the 1900 system day 1 is 1900-01-01 and day 60 is 29 February
// 1900, a day that never was (Lotus 1-2-3 thought 1900 a leap year and Excel kept it), so
// from 1 March 1900 on, serial n is 1899-12-30 + n days. In the 1904 system (old Mac
// Excel) day 0 is 1904-01-01. The fraction of a serial is the time of day.

const DAY = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  /** Milliseconds, for formats with fractions of seconds. */
  ms: number;
  /** 0 = Sunday. */
  wd: number;
}

/** Year, month, day → serial (months and days out of range roll over, as DATE does). */
export function dateSerial(y: number, m: number, d: number, date1904 = false): number {
  const t = Date.UTC(y, m - 1, 1) + (d - 1) * DAY;
  if (date1904) return Math.round((t - EPOCH_1904) / DAY);
  const n = Math.round((t - EPOCH_1900) / DAY);
  // before 1 March 1900 the phantom 29 February is not counted yet
  return n < 61 ? n - 1 : n;
}

/** Serial → calendar parts (UTC arithmetic, so no time zone or summer time shifts). */
export function serialParts(serial: number, date1904 = false): DateParts {
  let days = Math.floor(serial);
  // milliseconds rounded, so 0.5 / 86400 of a second does not show as 59.999
  let msOfDay = Math.round((serial - days) * DAY);
  if (msOfDay >= DAY) { days++; msOfDay -= DAY; }
  let t: number;
  if (date1904) t = EPOCH_1904 + days * DAY;
  else if (days === 60) {
    const time = splitTime(msOfDay);
    return { y: 1900, m: 2, d: 29, ...time, wd: 3 };
  } else t = EPOCH_1900 + (days < 60 ? days + 1 : days) * DAY;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), ...splitTime(msOfDay), wd: date1904 || days > 60 ? dt.getUTCDay() : (dt.getUTCDay() + 6) % 7 };
}

function splitTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return { hh: Math.floor(s / 3600), mm: Math.floor((s % 3600) / 60), ss: s % 60, ms: ms % 1000 };
}

/** Serial of a JavaScript time as local wall-clock time (what NOW() shows). */
export function serialOfTime(ms: number, date1904 = false): number {
  const local = ms - new Date(ms).getTimezoneOffset() * 60000;
  return (local - (date1904 ? EPOCH_1904 : EPOCH_1900)) / DAY;
}

/** "2023-03-15" for a serial (and " 14:30:00" when it has a time). */
export function isoDate(serial: number, date1904 = false): string {
  const p = serialParts(serial, date1904);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  return serial % 1 ? `${date} ${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : date;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Date and time text as a serial: "2023-03-15", "2023-03-15 14:30", "3/15/2023" (US order,
 * as Excel in English reads it), "15-Mar-2023", "14:30", "2:30 PM". null otherwise.
 */
export function parseDateText(s: string, date1904 = false): number | null {
  const t = s.trim();
  let m: RegExpExecArray | null;
  let day: number | null = null;
  let rest = t;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+|$)/.exec(t))) {
    day = validDate(+m[1], +m[2], +m[3], date1904);
    rest = t.slice(m[0].length);
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+|$)/.exec(t))) {
    const y = +m[3] < 100 ? (+m[3] < 30 ? 2000 : 1900) + +m[3] : +m[3];
    day = validDate(y, +m[1], +m[2], date1904);
    rest = t.slice(m[0].length);
  } else if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})(?:\s+|$)/.exec(t))) {
    const mon = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const y = +m[3] < 100 ? (+m[3] < 30 ? 2000 : 1900) + +m[3] : +m[3];
    day = mon ? validDate(y, mon, +m[1], date1904) : null;
    rest = t.slice(m[0].length);
  }
  if (day === null && rest === t && !/^\d{1,2}:\d/.test(t)) return null;
  if (day === null && rest !== t) return null;
  if (!rest) return day;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/.exec(rest);
  if (!tm) return null;
  let h = +tm[1];
  if (tm[4]) {
    if (h > 12) return null;
    h = (h % 12) + (/p/i.test(tm[4]) ? 12 : 0);
  }
  const min = +tm[2], sec = tm[3] ? +tm[3] : 0;
  if (h > 23 && day !== null) return null;
  if (min > 59 || sec >= 60) return null;
  return (day ?? 0) + (h * 3600 + min * 60 + sec) / 86400;
}

function validDate(y: number, m: number, d: number, date1904: boolean): number | null {
  if (m < 1 || m > 12 || d < 1) return null;
  if (y === 1900 && m === 2 && d === 29 && !date1904) return 60;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const n = dateSerial(y, m, d, date1904);
  return n >= 0 ? n : null;
}
