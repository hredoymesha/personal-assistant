/** Dates are stored as local calendar strings "YYYY-MM-DD" to avoid timezone drift. */
export type DateStr = string;

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): DateStr {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidDateStr(s: unknown): s is DateStr {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function addDays(s: DateStr, n: number): DateStr {
  const [y, m, d] = s.split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + n));
}

export function addMonths(s: DateStr, n: number): DateStr {
  const [y, m, d] = s.split('-').map(Number);
  const target = new Date(y, m - 1 + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, last)); // Jan 31 + 1 month -> Feb 28/29
  return toDateStr(target);
}

export function isValidTimeStr(s: unknown): s is string {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export interface CalendarDay {
  dateStr: DateStr;
  day: number;
  isCurrentMonth: boolean;
}

export function getMonthCalendarGrid(year: number, month: number): CalendarDay[] {
  // month is 1-based (1=Jan, 12=Dec)
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysInPrevMonth = new Date(year, month - 1, 0).getDate();

  const grid: CalendarDay[] = [];

  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i;
    const prevDate = new Date(year, month - 2, d);
    grid.push({
      dateStr: toDateStr(prevDate),
      day: d,
      isCurrentMonth: false,
    });
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const curDate = new Date(year, month - 1, d);
    grid.push({
      dateStr: toDateStr(curDate),
      day: d,
      isCurrentMonth: true,
    });
  }

  const remainder = grid.length % 7;
  if (remainder > 0) {
    const needed = 7 - remainder;
    for (let d = 1; d <= needed; d++) {
      const nextDate = new Date(year, month, d);
      grid.push({
        dateStr: toDateStr(nextDate),
        day: d,
        isCurrentMonth: false,
      });
    }
  }

  return grid;
}

export function getDateRangePreset(
  preset: 'this_month' | 'last_7_days' | 'last_30_days',
  referenceDate: DateStr
): { from: DateStr; to: DateStr } {
  const [y, m] = referenceDate.split('-').map(Number);
  if (preset === 'this_month') {
    return { from: `${y}-${pad(m)}-01`, to: referenceDate };
  }
  if (preset === 'last_7_days') {
    return { from: addDays(referenceDate, -6), to: referenceDate };
  }
  return { from: addDays(referenceDate, -29), to: referenceDate };
}
