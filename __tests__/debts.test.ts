import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDebtPayment } from '../src/domain/debts';
import type { Debt } from '../src/domain/types';
import { validateDebt } from '../src/domain/validation';

const debt = (
  id: string,
  overrides: Partial<Debt> = {},
): Debt => ({
  id,
  person: 'Ari',
  direction: 'i_owe',
  amountMinor: 500,
  paidMinor: 0,
  currency: 'BDT',
  dueDate: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  sample: false,
  ...overrides,
});

describe('oldest-first debt payments', () => {
  it('pays older matching debts first without touching other people, directions, or currencies', () => {
    const debts = [
      debt('new', { amountMinor: 500, createdAt: '2026-03-01T00:00:00.000Z' }),
      debt('other-person', { person: 'Mina', createdAt: '2025-01-01T00:00:00.000Z' }),
      debt('old', { amountMinor: 300, paidMinor: 100, createdAt: '2026-01-01T00:00:00.000Z' }),
      debt('other-direction', { direction: 'owed_to_me', createdAt: '2025-01-01T00:00:00.000Z' }),
      debt('other-currency', { currency: 'USD', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];

    const result = applyDebtPayment(debts, 'new', 450);

    expect(result).toMatchObject({
      ok: true,
      debts: [
        { id: 'new', paidMinor: 250 },
        { id: 'other-person', paidMinor: 0 },
        { id: 'old', paidMinor: 300 },
        { id: 'other-direction', paidMinor: 0 },
        { id: 'other-currency', paidMinor: 0 },
      ],
    });
  });

  it('uses the id as a deterministic tie-breaker for identical creation timestamps', () => {
    const debts = [
      debt('b', { createdAt: '2026-02-01T00:00:00.000Z' }),
      debt('a', { createdAt: '2026-02-01T00:00:00.000Z' }),
    ];

    const result = applyDebtPayment(debts, 'b', 500);

    expect(result).toMatchObject({
      ok: true,
      debts: [{ id: 'b', paidMinor: 0 }, { id: 'a', paidMinor: 500 }],
    });
  });

  it('keeps legacy debts with unknown age manual and applies payment only to the selected record', () => {
    const debts = [
      debt('dated', { createdAt: '2025-01-01T00:00:00.000Z' }),
      debt('legacy', { createdAt: null }),
    ];

    const result = applyDebtPayment(debts, 'legacy', 125);

    expect(result).toMatchObject({
      ok: true,
      debts: [{ id: 'dated', paidMinor: 0 }, { id: 'legacy', paidMinor: 125 }],
    });
  });

  it('rejects payments above the selected legacy debt or known-date group principal', () => {
    const dated = [
      debt('first', { amountMinor: 300, createdAt: '2026-01-01T00:00:00.000Z' }),
      debt('second', { amountMinor: 200, createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const legacy = debt('legacy', { amountMinor: 100, createdAt: null });

    expect(applyDebtPayment(dated, 'first', 501)).toMatchObject({
      ok: false,
      error: expect.stringContaining('exceeds the open principal'),
    });
    expect(applyDebtPayment([legacy], 'legacy', 101)).toMatchObject({
      ok: false,
      error: expect.stringContaining('exceeds the open principal'),
    });
    expect(dated.map((item) => item.paidMinor)).toEqual([0, 0]);
  });

  it('rejects a debt creation time that is not a UTC ISO timestamp', () => {
    expect(validateDebt(debt('bad-date', { createdAt: '2026-01-01' })).ok).toBe(false);
    expect(validateDebt(debt('legacy', { createdAt: null })).ok).toBe(true);
  });

  it('validates debt creation fields', () => {
    expect(validateDebt(debt('empty-person', { person: '   ' })).ok).toBe(false);
    expect(validateDebt(debt('zero-amount', { amountMinor: 0 })).ok).toBe(false);
    expect(validateDebt(debt('negative-amount', { amountMinor: -500 })).ok).toBe(false);
    expect(validateDebt(debt('over-paid', { amountMinor: 500, paidMinor: 600 })).ok).toBe(false);
    expect(validateDebt(debt('valid-debt')).ok).toBe(true);
  });

  it('guards debt creation in money view: awaits addDebt, preserves inputs on failure, and manages saving state', () => {
    const moneySource = readFileSync(join(process.cwd(), 'src/app/money.tsx'), 'utf8');
    const appProviderSource = readFileSync(join(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');

    // AppProvider validates debt and enables rollbackOnFailure
    expect(appProviderSource).toMatch(/addDebt:\s*async\s*\(x\)\s*=>\s*\{[\s\S]*?validateDebt\(rec\)[\s\S]*?mutate\(.*?'Debt added',\s*true\)/);

    // money.tsx awaits addDebt, handles errors without clearing person/amount, and guards submission button
    expect(moneySource).toMatch(/const \[saving, setSaving\] = useState\(false\);/);
    expect(moneySource).toMatch(/setSaving\(true\);[\s\S]*?const saveError = await addDebt\(/);
    expect(moneySource).toMatch(/if \(saveError\) \{\s*setError\(saveError\);\s*return;\s*\}/);
    expect(moneySource).toMatch(/disabled=\{saving\}/);
  });
});
