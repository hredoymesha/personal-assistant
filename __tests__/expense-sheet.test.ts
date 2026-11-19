import {
  dailyExpenseEntriesToCsv,
  filterDailyExpenseEntries,
  groupedDailyExpenseTotals,
  parseExpenseSheetDate,
  previewDailyExpenseCsv,
  validateDailyExpenseEntry,
} from '../src/domain/expenseSheet';
import type { DailyExpenseEntry } from '../src/domain/types';
import { sampleData } from '../src/domain/sample';
import { validateAppData } from '../src/domain/validation';

const entry = (overrides: Partial<DailyExpenseEntry> = {}): DailyExpenseEntry => ({
  id: 'e1', sheetId: 's1', date: '2026-11-15', amountMinor: 1250, currency: 'BDT',
  category: 'Food', note: 'Lunch', customValues: {}, ...overrides,
});

describe('daily expense sheet foundation', () => {
  it('parses Bengali digits and common dates', () => {
    expect(parseExpenseSheetDate('১৫/১১/২০২৬')).toBe('2026-11-15');
    expect(parseExpenseSheetDate('2026-02-31')).toBeNull();
  });

  it('validates integer minor units and groups by date/currency', () => {
    expect(validateDailyExpenseEntry(entry()).ok).toBe(true);
    expect(validateDailyExpenseEntry(entry({ amountMinor: 1.5 })).ok).toBe(false);
    expect(groupedDailyExpenseTotals([entry(), entry({ id: 'e2', amountMinor: 250 })])).toEqual([
      { key: '2026-11-15', date: '2026-11-15', currency: 'BDT', amountMinor: 1500, count: 2 },
    ]);
  });

  it('filters entries without mutating them', () => {
    const items = [
      entry({ category: 'Food', note: 'Office lunch', customValues: { f1: 'Cash' } }),
      entry({ id: 'e2', date: '2026-11-16', category: 'Transport', note: 'Rickshaw ride', customValues: { f1: 'bKash' } }),
    ];
    expect(filterDailyExpenseEntries(items, { from: '2026-11-16', to: '2026-11-16' })).toEqual([items[1]]);
    expect(filterDailyExpenseEntries(items, { query: 'rickshaw' })).toEqual([items[1]]);
    expect(filterDailyExpenseEntries(items, { query: 'cash' })).toEqual([items[0]]);
    expect(filterDailyExpenseEntries(items, { query: 'nonexistent' })).toEqual([]);
  });

  it('exports safe CSV and previews BOM input with duplicates', () => {
    const csv = dailyExpenseEntriesToCsv([entry({ note: '=SUM(A1:A2)' })]);
    expect(csv).toContain("'=SUM(A1:A2)");
    const preview = previewDailyExpenseCsv(`\uFEFFdate,amount,currency,category,note\n১৫/১১/২০২৬,12.50,BDT,Food,Lunch`, 'BDT', [entry()]);
    expect(preview[0].duplicate).toBe(true);
    expect(preview[0].entry?.amountMinor).toBe(1250);
  });

  it('includes daily sheet sample data and keeps it removable', () => {
    const data = sampleData('2026-11-15');
    expect(validateAppData(data).ok).toBe(true);
    expect(data.dailyExpenseSheets[0].sample).toBe(true);
    expect(data.dailyExpenseFields).toHaveLength(2);
    expect(data.dailyExpenseEntries).toHaveLength(8);
    expect(data.dailyExpenseEntries.every((item) => item.sample === true)).toBe(true);
  });

  it('ignores spreadsheet total rows and accepts Place as the entry column', () => {
    const preview = previewDailyExpenseCsv(
      'Date,Place,Amount,Currency\n2026-11-15,Lunch,2.50,BDT\n,Total for Nov 15,2.50,BDT\n,Grand Total,2.50,BDT',
      'BDT',
    );
    expect(preview).toHaveLength(1);
    expect(preview[0].entry?.category).toBe('Lunch');
  });
});
