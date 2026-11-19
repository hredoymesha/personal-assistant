import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { addMonths } from '../src/domain/dates';
import { parseMoney, sumMinor } from '../src/domain/money';
import { categoryTotals, monthTotals, netDebt } from '../src/domain/summaries';
import { emptyData, type Debt, type Expense } from '../src/domain/types';
import { StorageCoordinator } from '../src/storage/coordinator';

const expense = (amountMinor: number, id: string, overrides: Partial<Expense> = {}): Expense => ({
  id,
  amountMinor,
  currency: 'BDT',
  category: 'Food',
  note: '',
  date: '2026-12-31',
  walletId: null,
  originalText: null,
  sample: false,
  ...overrides,
});

const debt = (amountMinor: number, id: string, overrides: Partial<Debt> = {}): Debt => ({
  id,
  person: 'Sample person',
  direction: 'owed_to_me',
  amountMinor,
  paidMinor: 0,
  currency: 'BDT',
  dueDate: null,
  createdAt: null,
  sample: false,
  ...overrides,
});

describe('money invariants available in this repository', () => {
  it('parses zero and the largest safe BDT amount, and rejects values outside that range', () => {
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('-0.01')).toBeNull();
    expect(parseMoney('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseMoney('90071992547409.92')).toBeNull();
  });

  it('rejects non-integer inputs and unsafe aggregate totals', () => {
    expect(() => sumMinor([1.5])).toThrow(RangeError);
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });

  it('rejects fractional inputs even when they cancel to an integer total', () => {
    expect(() => sumMinor([0.5, 0.5])).toThrow(RangeError);
  });

  it('does not include another currency in a category total', () => {
    expect(categoryTotals([
      expense(125050, 'bdt'),
      expense(25, 'bdt-small'),
      expense(500, 'usd', { currency: 'USD' }),
    ], 'BDT')).toEqual([{ category: 'Food', total: 125075 }]);
  });

  it('keeps month totals on the requested calendar month across a year boundary', () => {
    expect(monthTotals([
      expense(100, 'dec', { date: '2026-12-31' }),
      expense(200, 'jan', { date: '2027-01-01' }),
    ], '2027-01-01')).toEqual({ BDT: 200 });
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('keeps floating-point parsing, rounding, and decimal literals out of ledger paths', () => {
    const ledgerFiles = [
      'src/domain/money.ts',
      'src/domain/wallets.ts',
      'src/domain/mess.ts',
      'src/domain/summaries.ts',
      'src/domain/validation.ts',
      'src/domain/csv.ts',
      'src/domain/parser/draft.ts',
      'src/state/AppProvider.tsx',
    ];
    const violations: string[] = [];

    for (const file of ledgerFiles) {
      const source = ts.createSourceFile(
        file,
        readFileSync(join(process.cwd(), file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (ts.isNumericLiteral(node) && /^\d+\.\d/.test(node.text)) {
          violations.push(`${file}: decimal literal ${node.text}`);
        }
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          if (ts.isIdentifier(expression) && expression.text === 'parseFloat') {
            violations.push(`${file}: parseFloat`);
          }
          if (ts.isPropertyAccessExpression(expression)
            && ((expression.name.text === 'toFixed')
              || (expression.expression.getText(source) === 'Math' && expression.name.text === 'round'))) {
            violations.push(`${file}: ${expression.getText(source)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });

  it('rejects unsafe category totals instead of silently losing integer precision', () => {
    expect(() => categoryTotals([
      expense(Number.MAX_SAFE_INTEGER, 'large'),
      expense(1, 'overflow'),
    ], 'BDT')).toThrow(RangeError);
  });

  it('rejects unsafe debt totals instead of silently losing integer precision', () => {
    const data = emptyData();
    data.debts = [debt(Number.MAX_SAFE_INTEGER, 'large'), debt(1, 'overflow')];
    expect(() => netDebt(data, 'BDT')).toThrow(RangeError);
  });

  it('keeps ordinary net debt totals exact and separated by direction and currency', () => {
    const data = emptyData();
    data.debts = [
      debt(500, 'owed', { paidMinor: 100 }),
      debt(700, 'owe', { direction: 'i_owe', paidMinor: 250 }),
      debt(900, 'other-currency', { currency: 'USD' }),
    ];
    expect(netDebt(data, 'BDT')).toEqual({ owedToMe: 400, iOwe: 450 });
  });

  it('serializes concurrent ledger edits so no integer updates are lost', async () => {
    const coordinator = new StorageCoordinator(() => null);
    let total = 0;
    await Promise.all(Array.from({ length: 50 }, (_, index) => coordinator.runExclusive(async () => {
      const before = total;
      await Promise.resolve();
      total = sumMinor([before, index + 1]);
    })));
    expect(total).toBe(1275);
  });
});
