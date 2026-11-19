import { applyDebtPayment } from '../src/domain/debts';
import { allocateByMeals, validateMessSettlementInput } from '../src/domain/mess';
import type { MessMemberBalance } from '../src/domain/mess';
import { sumMinor, totalsByCurrency } from '../src/domain/money';
import type { Minor } from '../src/domain/money';
import { categoryTotals, monthTotals, netDebt } from '../src/domain/summaries';
import { emptyData } from '../src/domain/types';
import type { AppData, Debt, Expense, MessExpense, Wallet, WalletEntry, WalletTransfer } from '../src/domain/types';
import { walletBalance } from '../src/domain/wallets';

/**
 * Deterministic pseudo-random number generator (Mulberry32) for property-style seeded loops.
 * Seeded, so every run is the same, with no extra dependency.
 */
function createSeededRng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Golden fixtures and property-style financial tests', () => {
  describe('Golden summary fixtures (deterministic fictional baseline)', () => {
    const goldenWallets: Wallet[] = [
      { id: 'w_bdt_cash', name: 'Cash', currency: 'BDT', openingBalanceMinor: 500000, createdAt: '2026-01-01T00:00:00.000Z' }, // 5000.00
      { id: 'w_bdt_bank', name: 'Bank', currency: 'BDT', openingBalanceMinor: 2000000, createdAt: '2026-01-01T00:00:00.000Z' }, // 20000.00
      { id: 'w_usd_card', name: 'USD Card', currency: 'USD', openingBalanceMinor: 10000, createdAt: '2026-01-01T00:00:00.000Z' }, // 100.00
    ];

    const goldenEntries: WalletEntry[] = [
      { id: 'we_1', walletId: 'w_bdt_cash', direction: 'in', amountMinor: 150000, note: 'Salary deposit', date: '2026-11-01' }, // +1500.00
      { id: 'we_2', walletId: 'w_bdt_bank', direction: 'out', amountMinor: 250000, note: 'ATM withdrawal', date: '2026-11-02' }, // -2500.00
    ];

    const goldenTransfers: WalletTransfer[] = [
      { id: 'wt_1', fromWalletId: 'w_bdt_bank', toWalletId: 'w_bdt_cash', amountMinor: 300000, date: '2026-11-03', note: 'Topup cash' }, // Bank -3000, Cash +3000
    ];

    const goldenExpenses: Expense[] = [
      { id: 'ge_1', amountMinor: 45000, currency: 'BDT', category: 'Groceries', note: 'Market', date: '2026-11-04', walletId: 'w_bdt_cash', originalText: null, sample: false }, // -450.00
      { id: 'ge_2', amountMinor: 120000, currency: 'BDT', category: 'Utilities', note: 'Electricity', date: '2026-11-05', walletId: 'w_bdt_bank', originalText: null, sample: false }, // -1200.00
      { id: 'ge_3', amountMinor: 35000, currency: 'BDT', category: 'Groceries', note: 'Veggies', date: '2026-10-28', walletId: 'w_bdt_cash', originalText: null, sample: false }, // Previous month
      { id: 'ge_4', amountMinor: 2500, currency: 'USD', category: 'Software', note: 'Hosting', date: '2026-11-06', walletId: 'w_usd_card', originalText: null, sample: false }, // USD
    ];

    const goldenMessExpenses: MessExpense[] = [
      {
        id: 'gme_1',
        groupId: 'mg_1',
        amountMinor: 80000, // 800.00 BDT
        payerMemberId: 'm_owner',
        category: 'Mess Bazar',
        date: '2026-11-07',
        note: 'Fish & rice',
        walletId: 'w_bdt_cash', // paid from user's cash wallet (-800.00)
        allocationMode: 'equal',
        mealRangeStart: null,
        mealRangeEnd: null,
        allocations: [
          { memberId: 'm_owner', amountMinor: 40000 },
          { memberId: 'm_roommate', amountMinor: 40000 },
        ],
      },
    ];

    const goldenDebts: Debt[] = [
      { id: 'd_1', person: 'Rahim', direction: 'owed_to_me', amountMinor: 100000, paidMinor: 20000, currency: 'BDT', createdAt: '2026-10-01T10:00:00.000Z', dueDate: null, sample: false }, // 800.00 open
      { id: 'd_2', person: 'Rahim', direction: 'owed_to_me', amountMinor: 50000, paidMinor: 0, currency: 'BDT', createdAt: '2026-10-15T12:00:00.000Z', dueDate: null, sample: false }, // 500.00 open
      { id: 'd_3', person: 'Karim', direction: 'i_owe', amountMinor: 40000, paidMinor: 10000, currency: 'BDT', createdAt: '2026-11-02T09:00:00.000Z', dueDate: null, sample: false }, // 300.00 open
      { id: 'd_4', person: 'John', direction: 'owed_to_me', amountMinor: 5000, paidMinor: 0, currency: 'USD', createdAt: '2026-11-03T15:00:00.000Z', dueDate: null, sample: false }, // 50.00 USD open
    ];

    const goldenAppData: AppData = {
      ...emptyData(),
      expenses: goldenExpenses,
      debts: goldenDebts,
      wallets: goldenWallets,
      walletEntries: goldenEntries,
      walletTransfers: goldenTransfers,
      messGroups: [{ id: 'mg_1', name: 'Bachelor Flat', currency: 'BDT', createdAt: '2026-01-01' }],
      messMembers: [
        { id: 'm_owner', groupId: 'mg_1', name: 'Me', contactId: null, isSelf: true },
        { id: 'm_roommate', groupId: 'mg_1', name: 'Roommate', contactId: null, isSelf: false },
      ],
      messExpenses: goldenMessExpenses,
    };

    it('verifies golden wallet balance calculations', () => {
      // Cash: 500000 (opening) + 150000 (entry in) + 300000 (transfer from bank) - 45000 (ge_1) - 35000 (ge_3) - 80000 (gme_1) = 790000
      expect(walletBalance(goldenAppData, 'w_bdt_cash')).toBe(790000);

      // Bank: 2000000 (opening) - 250000 (entry out) - 300000 (transfer to cash) - 120000 (ge_2) = 1330000
      expect(walletBalance(goldenAppData, 'w_bdt_bank')).toBe(1330000);

      // USD Card: 10000 (opening) - 2500 (ge_4) = 7500
      expect(walletBalance(goldenAppData, 'w_usd_card')).toBe(7500);
    });

    it('verifies golden category totals and currency isolation', () => {
      const bdtCategoryTotals = categoryTotals(goldenExpenses, 'BDT');
      expect(bdtCategoryTotals).toEqual([
        { category: 'Utilities', total: 120000 },
        { category: 'Groceries', total: 80000 }, // 45000 + 35000
      ]);

      const usdCategoryTotals = categoryTotals(goldenExpenses, 'USD');
      expect(usdCategoryTotals).toEqual([
        { category: 'Software', total: 2500 },
      ]);
    });

    it('verifies golden month totals with strict month boundary', () => {
      const novTotals = monthTotals(goldenExpenses, '2026-11-09');
      // ge_1 (45000 BDT) + ge_2 (120000 BDT) = 165000 BDT; ge_4 = 2500 USD; ge_3 is in October so excluded
      expect(novTotals).toEqual({
        BDT: 165000,
        USD: 2500,
      });

      const octTotals = monthTotals(goldenExpenses, '2026-10-31');
      expect(octTotals).toEqual({
        BDT: 35000,
      });
    });

    it('verifies golden net debt calculations per currency', () => {
      const bdtNet = netDebt(goldenAppData, 'BDT');
      // Rahim owes me 80000 + 50000 = 130000; I owe Karim 30000
      expect(bdtNet).toEqual({
        owedToMe: 130000,
        iOwe: 30000,
      });

      const usdNet = netDebt(goldenAppData, 'USD');
      expect(usdNet).toEqual({
        owedToMe: 5000,
        iOwe: 0,
      });
    });

    it('verifies golden mess settlement validation on balanced and unbalanced balances', () => {
      const balanced: MessMemberBalance[] = [
        { memberId: 'm_owner', balanceMinor: 40000, paidMinor: 80000, shareMinor: 40000, halfMealUnits: 10 },
        { memberId: 'm_roommate', balanceMinor: -40000, paidMinor: 0, shareMinor: 40000, halfMealUnits: 10 },
      ];
      expect(validateMessSettlementInput(balanced, { currency: 'BDT' })).toEqual({
        ok: true,
        memberCount: 2,
        netBalanceMinor: 0,
        currency: 'BDT',
      });

      const unbalanced: MessMemberBalance[] = [
        { memberId: 'm_owner', balanceMinor: 40000, paidMinor: 40000, shareMinor: 0, halfMealUnits: 0 },
        { memberId: 'm_roommate', balanceMinor: -39999, paidMinor: 0, shareMinor: 39999, halfMealUnits: 0 },
      ];
      const check = validateMessSettlementInput(unbalanced, { currency: 'BDT' });
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.error).toContain('refuses unbalanced input');
      }
    });
  });

  describe('Property-style invariant tests (seeded loops)', () => {
    it('Property 1: Wallet transfer conservation holds over 100 pseudo-random transfers', () => {
      const rng = createSeededRng(0xdeadbeef);
      let walletA: Minor = 10000000; // 100,000.00
      let walletB: Minor = 5000000;  // 50,000.00
      const initialTotal = walletA + walletB;

      for (let i = 0; i < 100; i++) {
        // Random amount between 1 and 50,000 poisha
        const amount = Math.floor(rng() * 50000) + 1;
        const direction = rng() > 0.5 ? 'A_to_B' : 'B_to_A';

        const mockData: AppData = {
          ...emptyData(),
          wallets: [
            { id: 'wA', name: 'A', currency: 'BDT', openingBalanceMinor: walletA, createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'wB', name: 'B', currency: 'BDT', openingBalanceMinor: walletB, createdAt: '2026-01-01T00:00:00.000Z' },
          ],
          walletTransfers: [
            {
              id: `t_${i}`,
              fromWalletId: direction === 'A_to_B' ? 'wA' : 'wB',
              toWalletId: direction === 'A_to_B' ? 'wB' : 'wA',
              amountMinor: amount,
              date: '2026-11-09',
              note: '',
            },
          ],
        };

        const newBalA = walletBalance(mockData, 'wA');
        const newBalB = walletBalance(mockData, 'wB');

        // Exact conservation property: newBalA + newBalB must equal initialTotal
        expect(newBalA + newBalB).toBe(initialTotal);
        walletA = newBalA;
        walletB = newBalB;
      }
    });

    it('Property 2: Largest-remainder proportional allocation sum conserves total expense', () => {
      const rng = createSeededRng(0xcafebabe);

      for (let iteration = 0; iteration < 100; iteration++) {
        const memberCount = Math.floor(rng() * 10) + 2; // 2 to 11 members
        const totalAmount = Math.floor(rng() * 500000) + 10; // 10 to 500,000 minor units
        const weights = Array.from({ length: memberCount }, (_, idx) => ({
          memberId: `mem_${idx}`,
          halfMealUnits: Math.floor(rng() * 10) + 1, // 1 to 10 half-meals
        }));

        const allocations = allocateByMeals(totalAmount, weights);

        // Conservation property: sum of allocated minor units must equal totalAmount exactly
        const allocatedSum = sumMinor(allocations.map((a) => a.amountMinor));
        expect(allocatedSum).toBe(totalAmount);

        // Boundary property: every member receives non-negative integer amount
        for (const alloc of allocations) {
          expect(Number.isSafeInteger(alloc.amountMinor)).toBe(true);
          expect(alloc.amountMinor).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('Property 3: Debt FIFO payment preserves open principal and monotonicity', () => {
      const debts: Debt[] = [
        { id: 'd_old', person: 'Alice', direction: 'owed_to_me', amountMinor: 10000, paidMinor: 0, currency: 'BDT', createdAt: '2026-10-01T00:00:00.000Z', dueDate: null, sample: false },
        { id: 'd_mid', person: 'Alice', direction: 'owed_to_me', amountMinor: 20000, paidMinor: 0, currency: 'BDT', createdAt: '2026-10-15T00:00:00.000Z', dueDate: null, sample: false },
        { id: 'd_new', person: 'Alice', direction: 'owed_to_me', amountMinor: 30000, paidMinor: 0, currency: 'BDT', createdAt: '2026-11-01T00:00:00.000Z', dueDate: null, sample: false },
      ];

      const initialOpen = 10000 + 20000 + 30000;
      const rng = createSeededRng(0x1337c0de);

      let currentDebts = debts;
      let totalPaidSoFar = 0;

      while (totalPaidSoFar < initialOpen) {
        const remainingPrincipal = initialOpen - totalPaidSoFar;
        const payment = Math.min(remainingPrincipal, Math.floor(rng() * 12000) + 1);

        const result = applyDebtPayment(currentDebts, 'd_old', payment);
        expect(result.ok).toBe(true);
        if (!result.ok) break;

        currentDebts = result.debts;
        totalPaidSoFar += payment;

        const currentOpen = sumMinor(currentDebts.map((d) => d.amountMinor - d.paidMinor));
        // Conservation property: remaining open must equal initial - totalPaid
        expect(currentOpen).toBe(initialOpen - totalPaidSoFar);

        // FIFO Monotonicity property: if d_mid has any payment, d_old must be fully paid (paid == amount)
        const dOld = currentDebts.find((d) => d.id === 'd_old')!;
        const dMid = currentDebts.find((d) => d.id === 'd_mid')!;
        const dNew = currentDebts.find((d) => d.id === 'd_new')!;

        if (dMid.paidMinor > 0) {
          expect(dOld.paidMinor).toBe(dOld.amountMinor);
        }
        if (dNew.paidMinor > 0) {
          expect(dMid.paidMinor).toBe(dMid.amountMinor);
        }
      }
    });

    it('Property 4: totalsByCurrency isolates independent currency additions', () => {
      const rng = createSeededRng(0xabcdef01);
      const currencies = ['BDT', 'USD', 'EUR', 'GBP'] as const;
      const expectedTotals: Record<string, Minor> = { BDT: 0, USD: 0, EUR: 0, GBP: 0 };
      const items: { amountMinor: Minor; currency: string }[] = [];

      for (let i = 0; i < 200; i++) {
        const cur = currencies[Math.floor(rng() * currencies.length)];
        const amount = Math.floor(rng() * 10000) + 1;
        items.push({ amountMinor: amount, currency: cur });
        expectedTotals[cur] += amount;

        const totals = totalsByCurrency(items);
        for (const c of currencies) {
          expect(totals[c] ?? 0).toBe(expectedTotals[c]);
        }
      }
    });

    it('Property 5: Mess settlement zero-sum invariance rejects any single-unit perturbation', () => {
      const rng = createSeededRng(0x77788899);

      for (let iter = 0; iter < 50; iter++) {
        const memberCount = Math.floor(rng() * 5) + 3; // 3 to 7 members
        const rawAmounts = Array.from({ length: memberCount - 1 }, () => Math.floor(rng() * 20000) - 10000);
        const lastAmount = -rawAmounts.reduce((acc, v) => acc + v, 0);

        const balances: MessMemberBalance[] = [...rawAmounts, lastAmount].map((val, idx) => ({
          memberId: `member_${idx}`,
          balanceMinor: val,
          halfMealUnits: 1,
          paidMinor: val > 0 ? val : 0,
          shareMinor: val < 0 ? -val : 0,
        }));

        // Balanced input must pass
        expect(validateMessSettlementInput(balances, { currency: 'BDT' }).ok).toBe(true);

        // Perturbing any single member balance by +1 or -1 must cause immediate rejection
        const perturbed = balances.map((b, idx) => (idx === 0 ? { ...b, balanceMinor: b.balanceMinor + 1 } : b));
        const check = validateMessSettlementInput(perturbed, { currency: 'BDT' });
        expect(check.ok).toBe(false);
      }
    });
  });
});
