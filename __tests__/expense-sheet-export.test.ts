import * as XLSX from 'xlsx';
import { dailyExpenseEntriesToCsv, previewDailyExpenseCsv } from '../src/domain/expenseSheet';
import type { DailyExpenseEntry, DailyExpenseField } from '../src/domain/types';
import { worksheetName } from '../src/services/expenseSheetFiles';

const field: DailyExpenseField = { id: 'f1', name: 'Transport type', type: 'text', options: [], required: false };
const entry = (overrides: Partial<DailyExpenseEntry> = {}): DailyExpenseEntry => ({
  id: 'e1',
  sheetId: 's1',
  date: '2026-11-19',
  amountMinor: 20000,
  currency: 'BDT',
  category: 'Home to office',
  note: 'morning trip',
  customValues: { f1: 'Rickshaw' },
  ...overrides,
});

describe('worksheetName', () => {
  it('removes characters Excel rejects in sheet names', () => {
    expect(worksheetName('Sample: Daily Travel & Meals')).toBe('Sample Daily Travel & Meals');
    expect(worksheetName('a/b\\c?d*e[f]g')).toBe('a b c d e f g');
  });

  it('keeps names within 31 characters and never empty', () => {
    expect(worksheetName('x'.repeat(40))).toHaveLength(31);
    expect(worksheetName(':::')).toBe('Expenses');
    expect(worksheetName('Receipts')).toBe('Expenses');
  });

  it('produces a name xlsx accepts for the sample sheet', () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Date']]), worksheetName('Sample: Daily Travel & Meals'));
    expect(() => XLSX.write(book, { bookType: 'xlsx', type: 'array' })).not.toThrow();
  });
});

describe('daily sheet CSV export', () => {
  it('uses the same readable headers as the XLSX export', () => {
    const csv = dailyExpenseEntriesToCsv([entry()], [field]);
    expect(csv.split('\n')[0]).toBe('Date,Place,Amount,Currency,Note,Transport type');
    expect(csv.split('\n')[1]).toBe('2026-11-19,Home to office,200.00,BDT,morning trip,Rickshaw');
  });

  it('round-trips through import, custom columns included', () => {
    const csv = dailyExpenseEntriesToCsv([entry()], [field]);
    const [row] = previewDailyExpenseCsv(csv, 'BDT', [], [field]);
    expect(row.error).toBeUndefined();
    expect(row.entry).toMatchObject({ date: '2026-11-19', category: 'Home to office', amountMinor: 20000, currency: 'BDT', note: 'morning trip', customValues: { f1: 'Rickshaw' } });
  });
});
