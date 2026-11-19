import { allocateByMeals, allocateEqually, formatHalfMeals, parseHalfMealUnits, summarizeMessGroup, validateMessSettlementInput } from '../src/domain/mess';
import { walletBalance } from '../src/domain/wallets';
import { trackedExpensesForTotals } from '../src/domain/summaries';
import type { AppData, MessExpense, MessGroup, MessMember, Wallet } from '../src/domain/types';
import { emptyData, SCHEMA_VERSION } from '../src/domain/types';
import { validateAppData } from '../src/domain/validation';
import { migrate } from '../src/storage/migrations';
import { sumMinor } from '../src/domain/money';

const wallet = (id: string, currency = 'BDT', openingBalanceMinor = 0): Wallet => ({
  id, name: id, currency, openingBalanceMinor, createdAt: '2026-11-06T00:00:00.000Z',
});

const group: MessGroup = { id: 'group1', name: 'Flat', currency: 'BDT', createdAt: '2026-11-06T00:00:00.000Z' };
const members: MessMember[] = [
  { id: 'self', groupId: group.id, name: 'Me', contactId: null, isSelf: true },
  { id: 'member-a', groupId: group.id, name: 'A', contactId: null, isSelf: false },
  { id: 'member-b', groupId: group.id, name: 'B', contactId: null, isSelf: false },
];

const messExpense = (overrides: Partial<MessExpense> = {}): MessExpense => ({
  id: 'me1',
  groupId: group.id,
  amountMinor: 101,
  date: '2026-11-06',
  category: 'Food',
  note: '',
  payerMemberId: 'self',
  walletId: 'wallet1',
  allocationMode: 'equal',
  mealRangeStart: null,
  mealRangeEnd: null,
  allocations: [
    { memberId: 'self', amountMinor: 34 },
    { memberId: 'member-a', amountMinor: 34 },
    { memberId: 'member-b', amountMinor: 33 },
  ],
  ...overrides,
});

function messData(): AppData {
  const data = emptyData();
  data.wallets.push(wallet('wallet1', 'BDT', 1000), wallet('wallet2', 'BDT'), wallet('usd', 'USD'));
  data.messGroups.push(group);
  data.messMembers.push(...members);
  return data;
}

describe('wallet accounting', () => {
  it('sums opening balance, manual entries, transfers, linked expenses, and self-paid mess expenses once', () => {
    const data = messData();
    data.walletEntries.push({ id: 'in', walletId: 'wallet1', direction: 'in', amountMinor: 200, date: '2026-11-06', note: '' });
    data.walletEntries.push({ id: 'out', walletId: 'wallet1', direction: 'out', amountMinor: 50, date: '2026-11-06', note: '' });
    data.walletTransfers.push({ id: 'transfer', fromWalletId: 'wallet1', toWalletId: 'wallet2', amountMinor: 100, date: '2026-11-06', note: '' });
    data.expenses.push({ id: 'expense', amountMinor: 70, currency: 'BDT', category: 'Food', note: '', date: '2026-11-06', walletId: 'wallet1', originalText: null, sample: false });
    data.messExpenses.push(messExpense({ amountMinor: 60 }));

    expect(walletBalance(data, 'wallet1')).toBe(920);
    expect(walletBalance(data, 'wallet2')).toBe(100);
  });

  it('conserves the combined balance when transferring between same-currency wallets', () => {
    const data = emptyData();
    data.wallets.push(wallet('cash', 'BDT', 1000), wallet('bank', 'BDT', 250));
    const before = data.wallets.map((item) => walletBalance(data, item.id));
    data.walletTransfers.push({
      id: 'move',
      fromWalletId: 'cash',
      toWalletId: 'bank',
      amountMinor: 375,
      date: '2026-11-06',
      note: '',
    });

    const after = data.wallets.map((item) => walletBalance(data, item.id));
    expect(after).toEqual([625, 625]);
    expect(sumMinor(after)).toBe(sumMinor(before));
  });

  it('allows a negative balance but rejects unsafe balance totals', () => {
    const data = emptyData();
    data.wallets.push(wallet('cash', 'BDT', 10));
    data.walletEntries.push({ id: 'spend', walletId: 'cash', direction: 'out', amountMinor: 25, date: '2026-11-06', note: '' });
    expect(walletBalance(data, 'cash')).toBe(-15);
    data.walletEntries = [{ id: 'overflow', walletId: 'cash', direction: 'in', amountMinor: Number.MAX_SAFE_INTEGER, date: '2026-11-06', note: '' }];
    expect(validateAppData(data)).toMatchObject({ ok: false });
  });

  it('rejects transfers between different currencies', () => {
    const data = emptyData();
    data.wallets.push(wallet('bdt', 'BDT'), wallet('usd', 'USD'));
    data.walletTransfers.push({ id: 'bad', fromWalletId: 'bdt', toWalletId: 'usd', amountMinor: 1, date: '2026-11-06', note: '' });
    expect(validateAppData(data)).toMatchObject({ ok: false, error: expect.stringContaining('mixes currencies') });
  });
});

describe('mess allocations', () => {
  it('rejects zero participants and zero amounts, and gives a single participant the full amount', () => {
    expect(() => allocateEqually(10, [])).toThrow('At least one member is required');
    expect(() => allocateEqually(0, ['only'])).toThrow('positive safe integer');
    expect(allocateEqually(501, ['only'])).toEqual([{ memberId: 'only', amountMinor: 501 }]);
  });

  it('allocates equal-share remainders by stable member id', () => {
    expect(allocateEqually(10, ['member-b', 'member-a', 'member-c'])).toEqual([
      { memberId: 'member-a', amountMinor: 4 },
      { memberId: 'member-b', amountMinor: 3 },
      { memberId: 'member-c', amountMinor: 3 },
    ]);
  });

  it('allocates a large participant set exactly and resolves equal remainders deterministically', () => {
    const members = Array.from({ length: 10_000 }, (_, index) => `member-${String(index).padStart(5, '0')}`);
    const allocations = allocateEqually(5_001, members);

    expect(allocations).toHaveLength(members.length);
    expect(allocations[0]).toEqual({ memberId: 'member-00000', amountMinor: 1 });
    expect(allocations[5_000]).toEqual({ memberId: 'member-05000', amountMinor: 1 });
    expect(allocations[5_001]).toEqual({ memberId: 'member-05001', amountMinor: 0 });
    expect(sumMinor(allocations.map((item) => item.amountMinor))).toBe(5_001);
  });

  it('uses exact integer arithmetic for large meal-weighted amounts', () => {
    expect(allocateByMeals(Number.MAX_SAFE_INTEGER, [
      { memberId: 'a', halfMealUnits: 1 },
      { memberId: 'b', halfMealUnits: 2 },
    ])).toEqual([
      { memberId: 'a', amountMinor: 3002399751580330 },
      { memberId: 'b', amountMinor: 6004799503160661 },
    ]);
  });

  it('parses only whole and half meals', () => {
    expect(parseHalfMealUnits('1.5')).toBe(3);
    expect(parseHalfMealUnits('০.৫')).toBe(1);
    expect(parseHalfMealUnits('0.5')).toBe(1);
    expect(parseHalfMealUnits('1.25')).toBeNull();
    expect(formatHalfMeals(5)).toBe('2.5');
  });

  it('reports date-filtered meal counts and balances using frozen expense allocations', () => {
    const data = messData();
    data.messMeals.push(
      { id: 'meal1', groupId: group.id, memberId: 'self', date: '2026-11-06', halfMealUnits: 2 },
      { id: 'meal2', groupId: group.id, memberId: 'member-a', date: '2026-11-06', halfMealUnits: 1 },
      { id: 'meal3', groupId: group.id, memberId: 'member-b', date: '2026-11-07', halfMealUnits: 3 },
    );
    data.messExpenses.push(messExpense());

    expect(summarizeMessGroup(data, group.id, '2026-11-06', '2026-11-06')).toEqual([
      { memberId: 'member-a', halfMealUnits: 1, paidMinor: 0, shareMinor: 34, balanceMinor: -34 },
      { memberId: 'member-b', halfMealUnits: 0, paidMinor: 0, shareMinor: 33, balanceMinor: -33 },
      { memberId: 'self', halfMealUnits: 2, paidMinor: 101, shareMinor: 34, balanceMinor: 67 },
    ]);
    expect(summarizeMessGroup(data, group.id, '2026-11-07', '2026-11-07')[1].halfMealUnits).toBe(3);
  });

  it('counts only self-paid mess expenses in personal expense totals', () => {
    const data = messData();
    data.messExpenses.push(
      messExpense(),
      messExpense({
        id: 'me2',
        payerMemberId: 'member-a',
        walletId: null,
        allocations: [{ memberId: 'self', amountMinor: 34 }, { memberId: 'member-a', amountMinor: 34 }, { memberId: 'member-b', amountMinor: 33 }],
      }),
    );
    expect(trackedExpensesForTotals(data)).toHaveLength(1);
    expect(trackedExpensesForTotals(data)[0]).toMatchObject({ amountMinor: 101, currency: 'BDT', walletId: 'wallet1' });
  });

  it('validates mess payer wallets and exact allocation totals', () => {
    const data = messData();
    data.messExpenses.push(messExpense({
      payerMemberId: 'member-a',
      walletId: null,
      allocationMode: 'custom',
      allocations: [
        { memberId: 'self', amountMinor: 50 },
        { memberId: 'member-a', amountMinor: 51 },
      ],
    }));
    expect(validateAppData(data).ok).toBe(true);

    data.messExpenses[0] = messExpense({
      payerMemberId: 'self',
      walletId: null,
      allocationMode: 'custom',
      allocations: [{ memberId: 'self', amountMinor: 101 }],
    });
    expect(validateAppData(data)).toMatchObject({ ok: false, error: expect.stringContaining('requires a wallet') });

    data.messExpenses[0] = messExpense({
      allocationMode: 'custom',
      allocations: [{ memberId: 'self', amountMinor: 100 }],
    });
    expect(validateAppData(data)).toMatchObject({ ok: false, error: expect.stringContaining('do not match') });
  });

  it('migrates schema v1 without losing existing expenses', () => {
    const legacy = {
      schemaVersion: 1,
      settings: { currency: 'BDT', theme: 'system', language: 'en' },
      tasks: [],
      expenses: [{ id: 'old', amountMinor: 250, currency: 'BDT', category: 'Food', note: 'kept', date: '2026-11-06', originalText: null, sample: false }],
      goals: [],
      debts: [{
        id: 'legacy-debt',
        person: 'A',
        direction: 'i_owe',
        amountMinor: 100,
        paidMinor: 20,
        currency: 'BDT',
        dueDate: null,
        sample: false,
      }],
    };
    const result = migrate(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.data.expenses).toEqual([{ ...legacy.expenses[0], walletId: null }]);
    expect(result.data.debts).toEqual([{ ...legacy.debts[0], createdAt: null }]);
    expect(validateAppData(result.data).ok).toBe(true);
  });
});

describe('mess settlement input validation invariants', () => {
  it('refuses empty or non-array member balances', () => {
    expect(validateMessSettlementInput([])).toEqual({
      ok: false,
      error: 'At least one member balance is required for settlement.',
    });
    // @ts-expect-error testing non-array runtime rejection
    expect(validateMessSettlementInput(null)).toEqual({
      ok: false,
      error: 'At least one member balance is required for settlement.',
    });
  });

  it('validates a balanced multi-member mess input with zero net sum', () => {
    const balanced = [
      { memberId: 'alice', halfMealUnits: 4, paidMinor: 300, shareMinor: 100, balanceMinor: 200 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 100, balanceMinor: -100 },
      { memberId: 'charlie', halfMealUnits: 2, paidMinor: 0, shareMinor: 100, balanceMinor: -100 },
    ];
    const result = validateMessSettlementInput(balanced, { currency: 'BDT' });
    expect(result).toEqual({
      ok: true,
      memberCount: 3,
      netBalanceMinor: 0,
      currency: 'BDT',
    });
  });

  it('validates an all-zero balanced input where all member balances are already zero', () => {
    const allZero = [
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 50, shareMinor: 50, balanceMinor: 0 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 50, shareMinor: 50, balanceMinor: 0 },
    ];
    expect(validateMessSettlementInput(allZero)).toEqual({
      ok: true,
      memberCount: 2,
      netBalanceMinor: 0,
      currency: undefined,
    });
  });

  it('refuses positive and negative imbalance', () => {
    // Positive imbalance: +200 and -100 -> net sum is +100
    const positiveImbalance = [
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 300, shareMinor: 100, balanceMinor: 200 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 100, balanceMinor: -100 },
    ];
    expect(validateMessSettlementInput(positiveImbalance)).toEqual({
      ok: false,
      error: expect.stringContaining('Mess settlement refuses unbalanced input: sum of member balances must be zero (current net sum: 100).'),
    });

    // Negative imbalance: +100 and -150 -> net sum is -50
    const negativeImbalance = [
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 200, shareMinor: 100, balanceMinor: 100 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 150, balanceMinor: -150 },
    ];
    expect(validateMessSettlementInput(negativeImbalance)).toEqual({
      ok: false,
      error: expect.stringContaining('Mess settlement refuses unbalanced input: sum of member balances must be zero (current net sum: -50).'),
    });
  });

  it('rejects invalid, fractional, non-finite, and unsafe integer amounts without epsilon tolerance', () => {
    // Fractional amount
    expect(validateMessSettlementInput([
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 100, shareMinor: 50, balanceMinor: 50.5 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 50, balanceMinor: -50.5 },
    ])).toEqual({
      ok: false,
      error: expect.stringContaining('must be a safe integer minor unit'),
    });

    // NaN amount
    expect(validateMessSettlementInput([
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 100, shareMinor: 50, balanceMinor: NaN },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 50, balanceMinor: 0 },
    ])).toEqual({
      ok: false,
      error: expect.stringContaining('must be a safe integer minor unit'),
    });

    // Infinity amount
    expect(validateMessSettlementInput([
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 100, shareMinor: 50, balanceMinor: Infinity },
    ])).toEqual({
      ok: false,
      error: expect.stringContaining('must be a safe integer minor unit'),
    });

    // Unsafe integer above MAX_SAFE_INTEGER
    expect(validateMessSettlementInput([
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 100, shareMinor: 50, balanceMinor: Number.MAX_SAFE_INTEGER + 1 },
    ])).toEqual({
      ok: false,
      error: expect.stringContaining('must be a safe integer minor unit'),
    });
  });

  it('safely handles arithmetic overflow when summing balances', () => {
    const overflow = [
      { memberId: 'alice', halfMealUnits: 1, paidMinor: Number.MAX_SAFE_INTEGER, shareMinor: 0, balanceMinor: Number.MAX_SAFE_INTEGER },
      { memberId: 'bob', halfMealUnits: 1, paidMinor: 1, shareMinor: 0, balanceMinor: 1 },
    ];
    expect(validateMessSettlementInput(overflow)).toEqual({
      ok: false,
      error: 'Total settlement balance exceeds the safe integer range.',
    });
  });

  it('validates member integrity: non-empty IDs, duplicate rejection, and allowed group membership', () => {
    // Duplicate member ID
    expect(validateMessSettlementInput([
      { memberId: 'dup', halfMealUnits: 1, paidMinor: 100, shareMinor: 50, balanceMinor: 50 },
      { memberId: 'dup', halfMealUnits: 1, paidMinor: 0, shareMinor: 50, balanceMinor: -50 },
    ])).toEqual({
      ok: false,
      error: 'Duplicate member balance entry for member: dup',
    });

    // Empty member ID
    expect(validateMessSettlementInput([
      { memberId: '  ', halfMealUnits: 1, paidMinor: 100, shareMinor: 100, balanceMinor: 0 },
    ])).toEqual({
      ok: false,
      error: 'Member id is required and cannot be empty.',
    });

    // Member not in allowed group
    expect(validateMessSettlementInput(
      [
        { memberId: 'outsider', halfMealUnits: 1, paidMinor: 100, shareMinor: 50, balanceMinor: 50 },
        { memberId: 'member-a', halfMealUnits: 1, paidMinor: 0, shareMinor: 50, balanceMinor: -50 },
      ],
      { allowedMemberIds: ['member-a', 'member-b'] },
    )).toEqual({
      ok: false,
      error: 'Member outsider does not belong to the settlement group.',
    });
  });

  it('rejects invalid currency options and verifies paid/share consistency', () => {
    const validBalances = [
      { memberId: 'alice', halfMealUnits: 1, paidMinor: 100, shareMinor: 50, balanceMinor: 50 },
      { memberId: 'bob', halfMealUnits: 1, paidMinor: 0, shareMinor: 50, balanceMinor: -50 },
    ];

    expect(validateMessSettlementInput(validBalances, { currency: 'invalid' })).toEqual({
      ok: false,
      error: 'Settlement currency is invalid.',
    });

    // Inconsistent balance with paid and share
    const inconsistent = [
      { memberId: 'alice', halfMealUnits: 1, paidMinor: 100, shareMinor: 50, balanceMinor: 60 },
      { memberId: 'bob', halfMealUnits: 1, paidMinor: 0, shareMinor: 50, balanceMinor: -60 },
    ];
    expect(validateMessSettlementInput(inconsistent)).toEqual({
      ok: false,
      error: 'Balance for member alice does not match paid minus share.',
    });
  });

  it('does not mutate the input array or its item objects', () => {
    const original = [
      { memberId: 'alice', halfMealUnits: 2, paidMinor: 300, shareMinor: 100, balanceMinor: 200 },
      { memberId: 'bob', halfMealUnits: 2, paidMinor: 0, shareMinor: 200, balanceMinor: -200 },
    ];
    const snapshot = JSON.stringify(original);
    validateMessSettlementInput(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
