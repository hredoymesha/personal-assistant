import { findDuplicateExpense, partitionDuplicates } from '../src/domain/duplicates';
import { expensesToCsv, parseExpenseCsv } from '../src/domain/csv';
import { addMonths, isValidDateStr } from '../src/domain/dates';
import { nextDueDate } from '../src/domain/recurrence';
import { sampleData } from '../src/domain/sample';
import { isOverdueTask, monthTotals, replaceExpenseCategory, replaceMessExpenseCategory, tasksDueOn, upcomingTasks } from '../src/domain/summaries';
import type { MessExpense } from '../src/domain/types';
import { validateAppData, validateExpense, validateSettings } from '../src/domain/validation';

const exp = (o = {}) => ({ id: 'e1', amountMinor: 500, currency: 'BDT', category: 'Food', note: '', date: '2026-10-10', walletId: null, originalText: null, sample: false, ...o });

describe('dates', () => {
  it('validates real calendar dates', () => {
    expect(isValidDateStr('2026-02-29')).toBe(false);
    expect(isValidDateStr('2028-02-29')).toBe(true);
    expect(isValidDateStr('2026-13-01')).toBe(false);
  });
  it('clamps month-end', () => expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'));
  it('recurrence', () => {
    expect(nextDueDate({ dueDate: '2026-10-10', recurrence: 'weekly' })).toBe('2026-10-17');
    expect(nextDueDate({ dueDate: '2026-10-10', recurrence: 'none' })).toBeNull();
    expect(nextDueDate({ dueDate: null, recurrence: 'daily' })).toBeNull();
  });
});

describe('validation', () => {
  it('accepts sample data', () => expect(validateAppData(sampleData('2026-10-10')).ok).toBe(true));
  it('rejects zero, negative, fractional minor amounts', () => {
    for (const a of [0, -1, 1.5, NaN]) expect(validateExpense(exp({ amountMinor: a })).ok).toBe(false);
  });
  it('rejects bad currency/date', () => {
    expect(validateExpense(exp({ currency: 'bdt' })).ok).toBe(false);
    expect(validateExpense(exp({ date: '2026-02-30' })).ok).toBe(false);
  });
  it('rejects inherited currency property names', () => {
    for (const currency of ['constructor', 'toString', '__proto__']) {
      expect(validateSettings({ currency, theme: 'light', language: 'en' }).ok).toBe(false);
    }
  });
  it('rejects duplicate ids', () => {
    const d = sampleData('2026-10-10');
    d.expenses.push({ ...d.expenses[0] });
    expect(validateAppData(d).ok).toBe(false);
  });
});

describe('summaries', () => {
  const d = sampleData('2026-10-10');
  d.tasks = d.tasks.filter((task) => ['sample_t1', 'sample_t2', 'sample_t3'].includes(task.id));
  it('due today includes overdue, excludes deleted/done', () => {
    d.tasks[0].deletedAt = 'x';
    expect(tasksDueOn(d.tasks, '2026-10-10')).toHaveLength(0);
    d.tasks[0].deletedAt = null;
    expect(tasksDueOn(d.tasks, '2026-10-10')).toHaveLength(1);
  });
  it('keeps old sample tasks in Today without presenting them as overdue', () => {
    const sample = { ...d.tasks[0], dueDate: '2026-10-10' };
    expect(tasksDueOn([sample], '2026-10-11')).toEqual([sample]);
    expect(isOverdueTask(sample, '2026-10-11')).toBe(false);
    expect(isOverdueTask({ ...sample, sample: false }, '2026-10-11')).toBe(true);
  });
  it('upcoming is within window and sorted', () => {
    expect(upcomingTasks(d.tasks, '2026-10-10').map((t) => t.id)).toEqual(['sample_t2', 'sample_t3']);
  });
  it('month totals only count the month', () => {
    expect(monthTotals([exp(), exp({ id: 'e2', date: '2026-09-30' })], '2026-10-10')).toEqual({ BDT: 500 });
  });
});

describe('csv', () => {
  it('round-trips with quotes and commas', () => {
    const csv = expensesToCsv([exp({ note: 'tea, "good"', amountMinor: 12050 })]);
    const rows = parseExpenseCsv(csv, 'BDT');
    expect(rows[0].expense).toMatchObject({ amountMinor: 12050, note: 'tea, "good"' });
  });
  it('neutralises formula injection on export', () => {
    expect(expensesToCsv([exp({ note: '=SUM(A1)' })])).toContain("'=SUM(A1)");
  });
  it('reports bad rows instead of guessing', () => {
    const rows = parseExpenseCsv('date,amount\n2026-10-10,abc\n2026-13-01,5\n2026-10-10,5.555', 'BDT');
    expect(rows.every((r) => r.error)).toBe(true);
  });
  it('rejects missing header', () => expect(parseExpenseCsv('a,b\n1,2', 'BDT')[0].error).toBeDefined());
});

describe('duplicates', () => {
  it('flags identical expenses, ignoring case/whitespace in note', () => {
    expect(findDuplicateExpense([exp({ note: 'Lunch ' })], exp({ id: undefined, note: 'lunch' }))).not.toBeNull();
  });
  it('does not flag a different amount, date, currency or category', () => {
    for (const o of [{ amountMinor: 501 }, { date: '2026-10-09' }, { currency: 'USD' }, { category: 'Bills' }, { walletId: 'other-wallet' }]) {
      expect(findDuplicateExpense([exp()], exp(o))).toBeNull();
    }
  });
});

describe('csv re-import (regression: importing the same file twice duplicated every expense)', () => {
  it('separates probable duplicates of saved expenses', () => {
    const existing = [exp({ id: 'a', note: 'tea' })];
    const rows = [exp({ note: 'tea' }), exp({ note: 'rice' })];
    const { fresh, duplicates } = partitionDuplicates(rows, existing as any);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });
  it('keeps legitimately repeated rows inside one file', () => {
    expect(partitionDuplicates([exp({ note: 'tea' }), exp({ note: 'tea' })], []).fresh).toHaveLength(2);
  });
});

describe('csv rows can never produce an invalid stored record (regression)', () => {
  it('rejects over-long categories and bad currencies at review time', () => {
    const rows = parseExpenseCsv(`date,amount,currency,category\n2026-10-10,5,BDT,${'x'.repeat(41)}\n2026-10-10,5,bdtt,Food\n2026-10-10,5,BDT,Food`, 'BDT');
    expect(rows.map((r) => !!r.error)).toEqual([true, true, false]);
  });
  it('every accepted csv row passes validateExpense', () => {
    const rows = parseExpenseCsv('date,amount,category,note\n2026-10-10,12.50,Food,tea', 'BDT');
    expect(validateExpense({ ...rows[0].expense!, id: 'x', sample: false, originalText: null }).ok).toBe(true);
  });
});

describe('financial expense category replacement invariants', () => {
  const messExp = (overrides: Partial<MessExpense> = {}): MessExpense => ({
    id: 'm1',
    groupId: 'g1',
    amountMinor: 600,
    date: '2026-10-10',
    category: 'Food',
    note: 'Bazaar',
    payerMemberId: 'mem1',
    walletId: 'w1',
    allocationMode: 'equal',
    mealRangeStart: null,
    mealRangeEnd: null,
    allocations: [{ memberId: 'mem1', amountMinor: 600 }],
    ...overrides,
  });

  describe('regular expenses category replacement', () => {
    it('replaces the specified category across matching regular expenses and preserves all other fields intact', () => {
      const expenses = [
        exp({ id: 'e1', category: 'Food', amountMinor: 250, date: '2026-10-10', note: 'Breakfast', walletId: 'w1', originalText: 'orig1', sample: false }),
        exp({ id: 'e2', category: 'Transport', amountMinor: 100, date: '2026-10-10', note: 'Bus', walletId: null, originalText: null, sample: true }),
        exp({ id: 'e3', category: 'Food', amountMinor: 400, date: '2026-10-11', note: 'Dinner', walletId: 'w2', originalText: null, sample: false }),
      ];

      const updated = replaceExpenseCategory(expenses, 'Food', 'Groceries');

      expect(updated).toEqual([
        exp({ id: 'e1', category: 'Groceries', amountMinor: 250, date: '2026-10-10', note: 'Breakfast', walletId: 'w1', originalText: 'orig1', sample: false }),
        exp({ id: 'e2', category: 'Transport', amountMinor: 100, date: '2026-10-10', note: 'Bus', walletId: null, originalText: null, sample: true }),
        exp({ id: 'e3', category: 'Groceries', amountMinor: 400, date: '2026-10-11', note: 'Dinner', walletId: 'w2', originalText: null, sample: false }),
      ]);

      // Unmodified item retains reference
      expect(updated[1]).toBe(expenses[1]);
      // Input immutability
      expect(expenses[0].category).toBe('Food');
    });

    it('returns a shallow copy when source category has no matching records (valid no-op)', () => {
      const expenses = [exp({ id: 'e1', category: 'Food' })];
      const updated = replaceExpenseCategory(expenses, 'Transport', 'Utilities');
      expect(updated).toEqual(expenses);
      expect(updated).not.toBe(expenses);
      expect(updated[0]).toBe(expenses[0]);
    });

    it('returns a shallow copy when source category equals target category (valid no-op)', () => {
      const expenses = [exp({ id: 'e1', category: 'Food' })];
      const updated = replaceExpenseCategory(expenses, 'Food', 'Food');
      expect(updated).toEqual(expenses);
      expect(updated).not.toBe(expenses);
    });

    it('rejects invalid, empty, whitespace-only, non-string, or over-40-character source or target categories', () => {
      const expenses = [exp({ category: 'Food' })];
      expect(() => replaceExpenseCategory(expenses, '', 'Health')).toThrow('Source category is required');
      expect(() => replaceExpenseCategory(expenses, '   ', 'Health')).toThrow('Source category is required');
      expect(() => replaceExpenseCategory(expenses, 'Food', '')).toThrow('Target category is required');
      expect(() => replaceExpenseCategory(expenses, 'Food', '   ')).toThrow('Target category is required');
      // @ts-expect-error non-string runtime rejection
      expect(() => replaceExpenseCategory(expenses, null, 'Health')).toThrow('Source category is required');
      // @ts-expect-error non-string runtime rejection
      expect(() => replaceExpenseCategory(expenses, 'Food', 123)).toThrow('Target category is required');
      expect(() => replaceExpenseCategory(expenses, 'x'.repeat(41), 'Health')).toThrow('Source category cannot exceed 40 characters');
      expect(() => replaceExpenseCategory(expenses, 'Food', 'y'.repeat(41))).toThrow('Target category cannot exceed 40 characters');
    });
  });

  describe('mess expenses category replacement', () => {
    it('replaces the specified category across matching mess expenses and preserves all other fields intact', () => {
      const messExpenses = [
        messExp({ id: 'm1', category: 'Food', amountMinor: 500, note: 'Fish', payerMemberId: 'p1', walletId: 'w1', allocations: [{ memberId: 'p1', amountMinor: 500 }] }),
        messExp({ id: 'm2', category: 'Utilities', amountMinor: 200, note: 'Gas', payerMemberId: 'p2', walletId: null, allocations: [{ memberId: 'p2', amountMinor: 200 }] }),
        messExp({ id: 'm3', category: 'Food', amountMinor: 300, note: 'Rice', payerMemberId: 'p1', walletId: 'w2', allocations: [{ memberId: 'p1', amountMinor: 300 }] }),
      ];

      const updated = replaceMessExpenseCategory(messExpenses, 'Food', 'Groceries');

      expect(updated).toEqual([
        messExp({ id: 'm1', category: 'Groceries', amountMinor: 500, note: 'Fish', payerMemberId: 'p1', walletId: 'w1', allocations: [{ memberId: 'p1', amountMinor: 500 }] }),
        messExp({ id: 'm2', category: 'Utilities', amountMinor: 200, note: 'Gas', payerMemberId: 'p2', walletId: null, allocations: [{ memberId: 'p2', amountMinor: 200 }] }),
        messExp({ id: 'm3', category: 'Groceries', amountMinor: 300, note: 'Rice', payerMemberId: 'p1', walletId: 'w2', allocations: [{ memberId: 'p1', amountMinor: 300 }] }),
      ]);

      // Unmodified item retains reference
      expect(updated[1]).toBe(messExpenses[1]);
      // Input immutability
      expect(messExpenses[0].category).toBe('Food');
    });

    it('returns a shallow copy when mess source category has no matching records (valid no-op)', () => {
      const messExpenses = [messExp({ id: 'm1', category: 'Food' })];
      const updated = replaceMessExpenseCategory(messExpenses, 'Bills', 'Utilities');
      expect(updated).toEqual(messExpenses);
      expect(updated).not.toBe(messExpenses);
      expect(updated[0]).toBe(messExpenses[0]);
    });

    it('returns a shallow copy when mess source equals target category (valid no-op)', () => {
      const messExpenses = [messExp({ id: 'm1', category: 'Food' })];
      const updated = replaceMessExpenseCategory(messExpenses, 'Food', 'Food');
      expect(updated).toEqual(messExpenses);
      expect(updated).not.toBe(messExpenses);
    });

    it('rejects invalid, empty, or over-40-character categories for mess expenses', () => {
      const messExpenses = [messExp({ category: 'Food' })];
      expect(() => replaceMessExpenseCategory(messExpenses, '', 'Health')).toThrow('Source category is required');
      expect(() => replaceMessExpenseCategory(messExpenses, 'Food', '')).toThrow('Target category is required');
      expect(() => replaceMessExpenseCategory(messExpenses, 'Food', 'z'.repeat(41))).toThrow('Target category cannot exceed 40 characters');
    });
  });
});
