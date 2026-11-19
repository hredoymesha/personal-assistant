import { getDateRangePreset, getMonthCalendarGrid, isValidDateStr } from '../src/domain/dates';

describe('calendar grid and date presets', () => {
  it('generates a 7-aligned calendar grid for 30-day month (November 2026)', () => {
    // Nov 1, 2026 is Sunday (getDay() === 0), Nov 30 is Monday
    const grid = getMonthCalendarGrid(2026, 11);
    expect(grid.length % 7).toBe(0);
    expect(grid.length).toBeGreaterThanOrEqual(30);

    const currentMonthDays = grid.filter((d) => d.isCurrentMonth);
    expect(currentMonthDays).toHaveLength(30);
    expect(currentMonthDays[0].day).toBe(1);
    expect(currentMonthDays[29].day).toBe(30);
    expect(currentMonthDays[0].dateStr).toBe('2026-11-01');
    expect(currentMonthDays[29].dateStr).toBe('2026-11-30');

    // All dateStr must be valid ISO dates
    for (const d of grid) {
      expect(isValidDateStr(d.dateStr)).toBe(true);
    }
  });

  it('generates a 7-aligned calendar grid with leading days for month starting midweek (October 2026)', () => {
    // Oct 1, 2026 is Thursday (getDay() === 4) -> 4 trailing days from Sep (27, 28, 29, 30)
    const grid = getMonthCalendarGrid(2026, 10);
    expect(grid.length % 7).toBe(0);

    const leadingDays = grid.filter((d, i) => !d.isCurrentMonth && i < 7);
    expect(leadingDays).toHaveLength(4);
    expect(leadingDays[0].dateStr).toBe('2026-09-27');
    expect(leadingDays[3].dateStr).toBe('2026-09-30');

    const currentMonthDays = grid.filter((d) => d.isCurrentMonth);
    expect(currentMonthDays).toHaveLength(31);
  });

  it('generates correct date range presets', () => {
    const today = '2026-11-15';
    expect(getDateRangePreset('this_month', today)).toEqual({
      from: '2026-11-01',
      to: '2026-11-15',
    });

    expect(getDateRangePreset('last_7_days', today)).toEqual({
      from: '2026-11-09',
      to: '2026-11-15',
    });

    expect(getDateRangePreset('last_30_days', today)).toEqual({
      from: '2026-10-17',
      to: '2026-11-15',
    });
  });
});
