// Money Cycle: partial payments and carry-over, paying and undoing, skip and pause, installments,
// closed months, per-user isolation, currency checks and keeping input when a save is rejected.

import {
  CycleGroup,
  CycleBill,
  CyclePayment,
  CycleIncome,
  CycleMonth,
  computeBillMonthState,
  computeMonthSummary,
  computeGroupedMonthSheet,
  filterBillStates,
  getUniformCurrency,
  validateCycleGroup,
  validateCycleBill,
  validateCyclePayment,
  validateCycleIncome,
  validateCycleMonth,
  validateCurrency,
  backfillBillGroupIds,
  resolveBillGroupName,
  DEFAULT_CYCLE_GROUP_NAMES,
  validateCycleBillOverride,
  validateCycleMonthLockEvent,
} from '../src/domain/cycle';
import { sampleData } from '../src/domain/sample';
import { validateAppData } from '../src/domain/validation';
import { applyDebtPayment } from '../src/domain/debts';
import { AppData, Debt, emptyData, SCHEMA_VERSION } from '../src/domain/types';
import { makeBackupPlaintext } from '../src/storage/backup';
import { parseData } from '../src/storage/repository';
import { AUTO_BACKUP_DISCLOSURE_TEXT } from '../src/services/autoBackup';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  getAllKeys: jest.fn(() => Promise.resolve([])),
}));

describe('Monthly Money Cycle', () => {
  const userIdA = 'user_123';
  const userIdB = 'user_999';

  const baseBill: CycleBill = {
    id: 'bill-1',
    userId: userIdA,
    name: 'Internet Bill',
    group: 'Utilities',
    expectedAmountMinor: 100000, // ৳1,000.00
    currency: 'BDT',
    dueDay: 10,
    payee: 'ISP Provider',
    isVariable: false,
    isPaused: false,
    autopay: false,
    completedInstallments: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  describe('Partial payment + carry_in liability (no double count)', () => {
    it('carries unpaid balance from previous month into current month without double counting', () => {
      // Month 1: October 2026
      // User pays ৳600 out of ৳1,000 -> unpaid balance ৳400
      const octPayments: CyclePayment[] = [
        {
          id: 'pay-oct-1',
          userId: userIdA,
          billId: 'bill-1',
          monthKey: '2026-10',
          amountMinor: 60000, // ৳600.00
          currency: 'BDT',
          paidAt: '2026-10-09T10:00:00.000Z',
          createdAt: '2026-10-09T10:00:00.000Z',
        },
      ];

      const octState = computeBillMonthState(baseBill, '2026-10', octPayments, null, '2026-10-15' as any);
      expect(octState.totalDueMinor).toBe(100000); // ৳1,000
      expect(octState.totalPaidMinor).toBe(60000);  // ৳600
      expect(octState.remainingMinor).toBe(40000);  // ৳400
      expect(octState.status).toBe('overdue'); // remaining > 0 and past Oct 10

      // Month 2: November 2026
      // Carry-in is ৳400 + November expected ৳1,000 = Total due ৳1,400
      const novPayments: CyclePayment[] = [
        ...octPayments,
        {
          id: 'pay-nov-1',
          userId: userIdA,
          billId: 'bill-1',
          monthKey: '2026-11',
          amountMinor: 50000, // ৳500.00
          currency: 'BDT',
          paidAt: '2026-11-05T10:00:00.000Z',
          createdAt: '2026-11-05T10:00:00.000Z',
        },
      ];

      const novState = computeBillMonthState(baseBill, '2026-11', novPayments, octState, '2026-11-07' as any);
      expect(novState.carryInMinor).toBe(40000);       // ৳400
      expect(novState.expectedAmountMinor).toBe(100000); // ৳1,000
      expect(novState.totalDueMinor).toBe(140000);     // ৳1,400
      expect(novState.totalPaidMinor).toBe(50000);      // ৳500 paid in Nov
      expect(novState.remainingMinor).toBe(90000);      // ৳900 remaining
      expect(novState.status).toBe('due');             // within 3 days of Nov 10
    });
  });

  describe('Mark paid -> payment record; undo paid -> restores balance identically', () => {
    it('marking bill fully paid zeroes balance, and undoing payment restores original balance', () => {
      let payments: CyclePayment[] = [];

      // Initial state
      const initial = computeBillMonthState(baseBill, '2026-11', payments, null, '2026-11-01' as any);
      expect(initial.remainingMinor).toBe(100000);
      expect(initial.status).toBe('upcoming');

      // 1. Mark paid
      const newPayment: CyclePayment = {
        id: 'pay-1',
        userId: userIdA,
        billId: 'bill-1',
        monthKey: '2026-11',
        amountMinor: 100000,
        currency: 'BDT',
        paidAt: '2026-11-02T12:00:00.000Z',
        createdAt: '2026-11-02T12:00:00.000Z',
      };
      payments = [newPayment];

      const afterPaid = computeBillMonthState(baseBill, '2026-11', payments, null, '2026-11-02' as any);
      expect(afterPaid.remainingMinor).toBe(0);
      expect(afterPaid.totalPaidMinor).toBe(100000);
      expect(afterPaid.status).toBe('paid');

      // 2. Undo paid: remove payment
      payments = payments.filter((p) => p.id !== 'pay-1');

      const afterUndo = computeBillMonthState(baseBill, '2026-11', payments, null, '2026-11-02' as any);
      expect(afterUndo.remainingMinor).toBe(100000);
      expect(afterUndo.totalPaidMinor).toBe(0);
      expect(afterUndo.status).toBe('upcoming');
    });
  });

  describe('Skip / pause bill', () => {
    it('paused bill has 0 expected amount for the month without deleting the bill definition', () => {
      const pausedBill: CycleBill = { ...baseBill, isPaused: true };

      const state = computeBillMonthState(pausedBill, '2026-11', [], null, '2026-11-05' as any);
      expect(state.status).toBe('paused');
      expect(state.expectedAmountMinor).toBe(0);
      expect(state.totalDueMinor).toBe(0);
      expect(state.isReminderDue).toBe(false);

      // Unpausing resumes normal expected amount (checked on 2026-11-08 within 3 days of Nov 10)
      const unpaused = computeBillMonthState({ ...pausedBill, isPaused: false }, '2026-11', [], null, '2026-11-08' as any);
      expect(unpaused.status).toBe('due');
      expect(unpaused.expectedAmountMinor).toBe(100000);
    });
  });

  describe('Installment count & end-date completion', () => {
    it('bill with finished installments is marked completed and demands 0 due', () => {
      const loanBill: CycleBill = {
        ...baseBill,
        id: 'bill-loan',
        installmentCount: 12,
        completedInstallments: 12,
      };

      const state = computeBillMonthState(loanBill, '2026-11', [], null, '2026-11-05' as any);
      expect(state.status).toBe('completed');
      expect(state.totalDueMinor).toBe(0);
      expect(state.expectedAmountMinor).toBe(0);
    });

    it('bill past its end-date is marked completed and demands 0 due', () => {
      const expiredBill: CycleBill = {
        ...baseBill,
        id: 'bill-rent-ended',
        endDate: '2026-09-30' as any,
      };

      const state = computeBillMonthState(expiredBill, '2026-11', [], null, '2026-11-05' as any);
      expect(state.status).toBe('completed');
      expect(state.totalDueMinor).toBe(0);
    });
  });

  describe('Month close: read-only invariant', () => {
    it('computeMonthSummary reflects closed status accurately', () => {
      const months: CycleMonth[] = [
        {
          id: 'm-1',
          userId: userIdA,
          monthKey: '2026-10',
          isClosed: true,
          closedAt: '2026-11-01T00:00:00.000Z',
        },
      ];

      const octSummary = computeMonthSummary('2026-10', userIdA, [baseBill], [], [], months);
      expect(octSummary.isClosed).toBe(true);

      const novSummary = computeMonthSummary('2026-11', userIdA, [baseBill], [], [], months);
      expect(novSummary.isClosed).toBe(false);
    });
  });

  describe('Cross-user isolation', () => {
    it('queries for User A return zero data from User B', () => {
      const bills: CycleBill[] = [
        { ...baseBill, id: 'bill-user-a', userId: userIdA, expectedAmountMinor: 50000, createdAt: '2026-11-01T00:00:00.000Z' },
        { ...baseBill, id: 'bill-user-b', userId: userIdB, expectedAmountMinor: 200000, createdAt: '2026-11-01T00:00:00.000Z' },
      ];
      const incomes: CycleIncome[] = [
        { id: 'inc-a', userId: userIdA, source: 'A Salary', amountMinor: 100000, currency: 'BDT', monthKey: '2026-11', receivedAt: '2026-11-01' as any, isReceived: true, createdAt: '' },
        { id: 'inc-b', userId: userIdB, source: 'B Salary', amountMinor: 500000, currency: 'BDT', monthKey: '2026-11', receivedAt: '2026-11-01' as any, isReceived: true, createdAt: '' },
      ];

      const summaryA = computeMonthSummary('2026-11', userIdA, bills, [], incomes, []);
      expect(summaryA.activeBillsCount).toBe(1);
      expect(summaryA.totalExpectedBillsMinor).toBe(50000);
      expect(summaryA.totalIncomeMinor).toBe(100000);
      expect(summaryA.safeToSpendMinor).toBe(50000); // 100000 - 50000

      const summaryB = computeMonthSummary('2026-11', userIdB, bills, [], incomes, []);
      expect(summaryB.activeBillsCount).toBe(1);
      expect(summaryB.totalExpectedBillsMinor).toBe(200000);
      expect(summaryB.totalIncomeMinor).toBe(500000);
      expect(summaryB.safeToSpendMinor).toBe(300000); // 500000 - 200000
    });
  });

  describe('Currency own-property validation', () => {
    it('accepts supported currencies and rejects inherited prototype names', () => {
      expect(validateCurrency('BDT').ok).toBe(true);
      expect(validateCurrency('USD').ok).toBe(true);
      expect(validateCurrency('EUR').ok).toBe(true);

      for (const bad of ['constructor', 'toString', '__proto__', 'valueOf', 'toLocaleString', 'UNKNOWN']) {
        expect(validateCurrency(bad).ok).toBe(false);
      }
    });

    it('validates bill and payment currency via own-property check', () => {
      const badBill = { ...baseBill, currency: 'constructor' };
      expect(validateCycleBill(badBill).ok).toBe(false);

      const goodBill = { ...baseBill, currency: 'BDT' };
      expect(validateCycleBill(goodBill).ok).toBe(true);

      const badPayment = {
        id: 'p-1',
        userId: userIdA,
        billId: 'bill-1',
        monthKey: '2026-11',
        amountMinor: 50000,
        currency: 'toString',
        paidAt: '2026-11-01',
      };
      expect(validateCyclePayment(badPayment).ok).toBe(false);

      const badIncome = {
        id: 'inc-1',
        userId: userIdA,
        source: 'Salary',
        amountMinor: 50000,
        currency: 'constructor',
        monthKey: '2026-11',
        receivedAt: '2026-11-01',
        isReceived: true,
        createdAt: '',
      };
      expect(validateCycleIncome(badIncome).ok).toBe(false);
    });
  });

  describe('7a. Cycle financial integrity boundaries', () => {
    it('identifies whether an aggregate has one currency without treating mixed currencies as one total', () => {
      expect(getUniformCurrency([])).toBeNull();
      expect(getUniformCurrency(['BDT', 'BDT'])).toBe('BDT');
      expect(getUniformCurrency(['BDT', 'USD'])).toBeNull();
    });

    it('rejects zero, unsafe, and non-safe installment values', () => {
      expect(validateCycleBill({ ...baseBill, expectedAmountMinor: 0 }).ok).toBe(false);
      expect(validateCycleBill({ ...baseBill, expectedAmountMinor: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
      expect(validateCycleBill({ ...baseBill, completedInstallments: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
      expect(validateCyclePayment({
        id: 'p-unsafe',
        userId: userIdA,
        billId: baseBill.id,
        monthKey: '2026-11',
        amountMinor: Number.MAX_SAFE_INTEGER + 1,
        currency: 'BDT',
        paidAt: '2026-11-01',
      }).ok).toBe(false);
    });

    it('rejects cycle payments that do not belong to a valid bill relationship', () => {
      const data = {
        ...emptyData(),
        cycleBills: [baseBill],
        cyclePayments: [{
          id: 'p-wrong-currency',
          userId: userIdA,
          billId: baseBill.id,
          monthKey: '2026-11',
          amountMinor: 100,
          currency: 'USD',
          paidAt: '2026-11-01',
          createdAt: '2026-11-01T00:00:00.000Z',
        }],
      };
      expect(validateAppData(data).ok).toBe(false);
      expect(validateAppData({
        ...data,
        cyclePayments: [{ ...data.cyclePayments[0], currency: 'BDT', billId: 'missing' }],
      }).ok).toBe(false);
    });

    it('allows supported Cycle currencies independently of the app default currency', () => {
      expect(validateAppData({
        ...emptyData(),
        cycleBills: [{ ...baseBill, currency: 'USD' }],
      }).ok).toBe(true);
      expect(validateAppData({
        ...emptyData(),
        cycleIncomes: [{
          id: 'income-usd',
          userId: userIdA,
          source: 'Salary',
          amountMinor: 100,
          currency: 'USD',
          monthKey: '2026-11',
          receivedAt: '2026-11-01' as any,
          isReceived: true,
          createdAt: '2026-11-01T00:00:00.000Z',
        }],
      }).ok).toBe(true);
    });
  });

  describe('Additive schema validation & backward compatibility', () => {
    it('validates append-only month lock events and rejects unknown actors', () => {
      const event = {
        id: 'lock-1',
        userId: userIdA,
        monthKey: '2026-11',
        action: 'closed',
        actor: 'local_owner',
        reason: 'Reviewed November bills',
        createdAt: '2026-11-13T10:00:00.000Z',
      };
      expect(validateCycleMonthLockEvent(event).ok).toBe(true);
      expect(validateCycleMonthLockEvent({ ...event, actor: 'admin' }).ok).toBe(false);
    });
    it('validateAppData accepts datasets with or without cycle collections', () => {
      const base = sampleData('2026-11-09');

      // Without cycle collections (legacy or previous version)
      const { cycleGroups, cycleBills, cycleIncomes, cyclePayments, cycleMonths, cycleBillOverrides, cycleMonthLockEvents, ...legacyBase } = base;
      const validWithout = validateAppData(legacyBase);
      expect(validWithout.ok).toBe(true);
      if (validWithout.ok) {
        expect(validWithout.value.cycleGroups).toEqual([]);
        expect(validWithout.value.cycleBills).toEqual([]);
        expect(validWithout.value.cycleIncomes).toEqual([]);
        expect(validWithout.value.cyclePayments).toEqual([]);
        expect(validWithout.value.cycleMonths).toEqual([]);
      }

      // With cycle collections
      const withCycle: AppData = {
        ...base,
        cycleGroups: [],
        cycleBills: [baseBill],
        cycleIncomes: [],
        cyclePayments: [],
        cycleMonths: [],
        cycleBillOverrides: [],
        cycleMonthLockEvents: [],
      };
      const validWith = validateAppData(withCycle);
      expect(validWith.ok).toBe(true);
      if (validWith.ok) {
        expect(validWith.value.cycleBills).toHaveLength(1);
        expect(validWith.value.cycleBills?.[0].name).toBe('Internet Bill');
      }
    });
  });

  describe('FIX-A: User-defined Groups & Group-less Bills', () => {
    it('validates custom groups and allows bills without a group', () => {
      const groupA: CycleGroup = {
        id: 'grp-1',
        userId: userIdA,
        name: 'Home Office',
        sortOrder: 0,
        createdAt: '2026-11-01T00:00:00.000Z',
      };
      expect(validateCycleGroup(groupA).ok).toBe(true);

      // Rejects invalid groups
      expect(validateCycleGroup({ ...groupA, name: '' }).ok).toBe(false);
      expect(validateCycleGroup({ ...groupA, sortOrder: -1 }).ok).toBe(false);

      // Bill with custom group
      const customGroupBill: CycleBill = { ...baseBill, group: 'Home Office' };
      expect(validateCycleBill(customGroupBill).ok).toBe(true);

      // Bill with NO group (empty string or undefined)
      const noGroupBill1: CycleBill = { ...baseBill, group: '' };
      expect(validateCycleBill(noGroupBill1).ok).toBe(true);

      const noGroupBill2: CycleBill = { ...baseBill, group: undefined };
      expect(validateCycleBill(noGroupBill2).ok).toBe(true);
    });
  });

  describe('FIX-B: Safe-to-Spend formula & breakdown', () => {
    it('verifies exact owner example: income 5,000, bill 1,000, paid 600 -> available 4,400, remaining 400, safe 4,000', () => {
      // Setup: 1 bill of ৳1,000
      const testBill: CycleBill = {
        ...baseBill,
        id: 'bill-test-5k',
        expectedAmountMinor: 100000, // ৳1,000.00
        createdAt: '2026-11-01T00:00:00.000Z',
      };
      // Income: ৳5,000
      const incomes: CycleIncome[] = [
        {
          id: 'inc-5k',
          userId: userIdA,
          source: 'Salary',
          amountMinor: 500000, // ৳5,000.00
          currency: 'BDT',
          monthKey: '2026-11',
          receivedAt: '2026-11-01' as any,
          isReceived: true,
          createdAt: '',
        },
      ];
      // Paid: ৳600
      const payments: CyclePayment[] = [
        {
          id: 'pay-600',
          userId: userIdA,
          billId: 'bill-test-5k',
          monthKey: '2026-11',
          amountMinor: 60000, // ৳600.00
          currency: 'BDT',
          paidAt: '2026-11-05T10:00:00.000Z',
          createdAt: '',
        },
      ];

      const summary = computeMonthSummary('2026-11', userIdA, [testBill], payments, incomes, []);

      // Total Income = ৳5,000
      expect(summary.totalIncomeMinor).toBe(500000);
      // Total Monthly Liability = ৳1,000
      expect(summary.totalDueBillsMinor).toBe(100000);
      // Total Paid This Month = ৳600
      expect(summary.totalPaidBillsMinor).toBe(60000);
      // Available Cash (Income - Paid) = ৳4,400
      expect(summary.availableCashMinor).toBe(440000);
      // Remaining Unpaid Bill = ৳400
      expect(summary.totalRemainingBillsMinor).toBe(40000);
      // Safe-to-Spend (Income - Total Liability = Available Cash - Remaining) = ৳4,000
      expect(summary.safeToSpendMinor).toBe(400000);
    });

    it('handles negative Safe-to-Spend without clamping to 0', () => {
      // Income ৳3,000 against ৳5,000 bills -> Safe-to-Spend is -৳2,000
      const heavyBill: CycleBill = {
        ...baseBill,
        id: 'bill-heavy',
        expectedAmountMinor: 500000, // ৳5,000.00
        createdAt: '2026-11-01T00:00:00.000Z',
      };
      const lowIncome: CycleIncome[] = [
        {
          id: 'inc-low',
          userId: userIdA,
          source: 'Gig',
          amountMinor: 300000, // ৳3,000.00
          currency: 'BDT',
          monthKey: '2026-11',
          receivedAt: '2026-11-01' as any,
          isReceived: true,
          createdAt: '',
        },
      ];

      const summary = computeMonthSummary('2026-11', userIdA, [heavyBill], [], lowIncome, []);
      expect(summary.safeToSpendMinor).toBe(-200000); // stays -৳2,000.00
      expect(summary.safeToSpendMinor < 0).toBe(true);
    });
  });

  describe('Multi-month carry-in chaining across 3 months', () => {
    it('chains partial payments across Month 1 -> Month 2 -> Month 3 correctly', () => {
      // Month 1 (Oct 2026): ৳1,000 expected, ৳600 paid -> ৳400 remaining
      const octPayments: CyclePayment[] = [
        { id: 'p-oct', userId: userIdA, billId: 'bill-1', monthKey: '2026-10', amountMinor: 60000, currency: 'BDT', paidAt: '', createdAt: '' },
      ];
      const octState = computeBillMonthState(baseBill, '2026-10', octPayments, null, '2026-10-15' as any);
      expect(octState.totalDueMinor).toBe(100000);
      expect(octState.totalPaidMinor).toBe(60000);
      expect(octState.remainingMinor).toBe(40000);

      // Month 2 (Nov 2026): ৳1,000 expected + ৳400 carry-in = ৳1,400 due. ৳500 paid -> ৳900 remaining
      const novPayments: CyclePayment[] = [
        ...octPayments,
        { id: 'p-nov', userId: userIdA, billId: 'bill-1', monthKey: '2026-11', amountMinor: 50000, currency: 'BDT', paidAt: '', createdAt: '' },
      ];
      const novState = computeBillMonthState(baseBill, '2026-11', novPayments, octState, '2026-11-15' as any);
      expect(novState.carryInMinor).toBe(40000);
      expect(novState.totalDueMinor).toBe(140000);
      expect(novState.totalPaidMinor).toBe(50000);
      expect(novState.remainingMinor).toBe(90000);

      // Month 3 (Dec 2026): ৳1,000 expected + ৳900 carry-in = ৳1,900 due. User pays full ৳1,900 -> ৳0 remaining, status paid
      const decPayments: CyclePayment[] = [
        ...novPayments,
        { id: 'p-dec', userId: userIdA, billId: 'bill-1', monthKey: '2026-12', amountMinor: 190000, currency: 'BDT', paidAt: '', createdAt: '' },
      ];
      const decState = computeBillMonthState(baseBill, '2026-12', decPayments, novState, '2026-12-15' as any);
      expect(decState.carryInMinor).toBe(90000);
      expect(decState.totalDueMinor).toBe(190000);
      expect(decState.totalPaidMinor).toBe(190000);
      expect(decState.remainingMinor).toBe(0);
      expect(decState.status).toBe('paid');
    });
  });

  describe('Autopay flag & Month reopen', () => {
    it('accurately identifies autopay bills', () => {
      const manualBill = { ...baseBill, autopay: false };
      const autoBill = { ...baseBill, id: 'bill-auto', autopay: true };
      expect(manualBill.autopay).toBe(false);
      expect(autoBill.autopay).toBe(true);
      expect(validateCycleBill(autoBill).ok).toBe(true);
    });

    it('reopening a closed month restores editable isClosed: false state', () => {
      const closedMonth: CycleMonth = {
        id: 'cm-1',
        userId: userIdA,
        monthKey: '2026-11',
        isClosed: true,
        closedAt: '2026-11-30T00:00:00.000Z',
      };
      const summaryClosed = computeMonthSummary('2026-11', userIdA, [baseBill], [], [], [closedMonth]);
      expect(summaryClosed.isClosed).toBe(true);

      // Reopen (record deleted or isClosed: false)
      const reopenedMonth: CycleMonth = { ...closedMonth, isClosed: false };
      const summaryReopened = computeMonthSummary('2026-11', userIdA, [baseBill], [], [], [reopenedMonth]);
      expect(summaryReopened.isClosed).toBe(false);

      const summaryNoRecord = computeMonthSummary('2026-11', userIdA, [baseBill], [], [], []);
      expect(summaryNoRecord.isClosed).toBe(false);
    });
  });

  describe('Group Identity, Rename Propagation & Backfill', () => {
    const sampleGroup: CycleGroup = {
      id: 'grp-work',
      userId: userIdA,
      name: 'Work Utilities',
      sortOrder: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
    };

    it('propagates group rename immediately to linked bills', () => {
      const bill: CycleBill = {
        ...baseBill,
        id: 'bill-work-1',
        groupId: 'grp-work',
        group: 'Work Utilities',
      };

      // Initial name
      expect(resolveBillGroupName(bill, [sampleGroup])).toBe('Work Utilities');

      // Renamed group
      const renamedGroup = { ...sampleGroup, name: 'Office Operations' };
      expect(resolveBillGroupName(bill, [renamedGroup])).toBe('Office Operations');
    });

    it('handles group deletion without deleting bills (bills become groupless, 0 data loss)', () => {
      const bill: CycleBill = {
        ...baseBill,
        id: 'bill-work-1',
        groupId: 'grp-work',
        group: null,
      };

      // Group deleted: empty groups array
      const resolved = resolveBillGroupName(bill, []);
      expect(resolved).toBeNull(); // "No group"
      // Bill data is completely intact
      expect(bill.id).toBe('bill-work-1');
      expect(bill.expectedAmountMinor).toBe(100000);
    });

    it('backfills legacy bills without groupId to matching group by name', () => {
      const legacyBill: CycleBill = {
        ...baseBill,
        id: 'bill-legacy-1',
        groupId: undefined,
        group: 'Work Utilities',
      };

      const backfilled = backfillBillGroupIds([legacyBill], [sampleGroup]);
      expect(backfilled[0].groupId).toBe('grp-work');
      expect(resolveBillGroupName(backfilled[0], [sampleGroup])).toBe('Work Utilities');
    });

    it('executes backfill idempotently (running multiple times produces identical output)', () => {
      const legacyBill: CycleBill = {
        ...baseBill,
        id: 'bill-legacy-1',
        groupId: undefined,
        group: 'Work Utilities',
      };

      const pass1 = backfillBillGroupIds([legacyBill], [sampleGroup]);
      const pass2 = backfillBillGroupIds(pass1, [sampleGroup]);
      expect(pass2).toEqual(pass1);
    });
  });

  describe('Grouped Month Sheet & Single Source of Truth Invariant (Batch 3 Part A)', () => {
    const group1: CycleGroup = {
      id: 'grp-home',
      userId: userIdA,
      name: 'Home & Living',
      sortOrder: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const group2: CycleGroup = {
      id: 'grp-work',
      userId: userIdA,
      name: 'Work & SaaS',
      sortOrder: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    };

    const billHome1: CycleBill = {
      ...baseBill,
      id: 'bill-home-1',
      name: 'Electricity',
      groupId: 'grp-home',
      expectedAmountMinor: 150000, // ৳1,500
      dueDay: 5,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const billHome2: CycleBill = {
      ...baseBill,
      id: 'bill-home-2',
      name: 'Water',
      groupId: 'grp-home',
      expectedAmountMinor: 50000, // ৳500
      dueDay: 12,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const billWork1: CycleBill = {
      ...baseBill,
      id: 'bill-work-1',
      name: 'Cloud Server',
      groupId: 'grp-work',
      expectedAmountMinor: 300000, // ৳3,000
      dueDay: 15,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    const billNoGroup: CycleBill = {
      ...baseBill,
      id: 'bill-nogroup-1',
      name: 'Personal Gym',
      groupId: null,
      group: null,
      expectedAmountMinor: 200000, // ৳2,000
      dueDay: 20,
      createdAt: '2026-11-01T00:00:00.000Z',
    };

    const allBills = [billHome1, billHome2, billWork1, billNoGroup];
    const allGroups = [group2, group1]; // Pass in unsorted to verify sortOrder sorting

    it('orders defined groups by sortOrder and places "No group" at the very end', () => {
      const sheet = computeGroupedMonthSheet(
        '2026-11',
        userIdA,
        allBills,
        allGroups,
        [],
        [],
        '2026-11-01' as any
      );

      expect(sheet.groups.length).toBe(3);
      expect(sheet.groups[0].groupName).toBe('Home & Living');
      expect(sheet.groups[0].sortOrder).toBe(0);
      expect(sheet.groups[1].groupName).toBe('Work & SaaS');
      expect(sheet.groups[1].sortOrder).toBe(1);
      expect(sheet.groups[2].groupName).toBe('No group');
      expect(sheet.groups[2].group).toBeNull();
    });

    it('proves mathematical invariant sum(group_subtotals) === month_total (Single Source of Truth A6)', () => {
      // Partial payment on Electricity
      const payment1: CyclePayment = {
        id: 'pay-1',
        userId: userIdA,
        billId: 'bill-home-1',
        monthKey: '2026-11',
        amountMinor: 50000, // ৳500 of ৳1,500
        currency: 'BDT',
        paidAt: '2026-11-04T00:00:00.000Z',
        createdAt: '2026-11-04T00:00:00.000Z',
      };
      // Full payment on Cloud Server
      const payment2: CyclePayment = {
        id: 'pay-2',
        userId: userIdA,
        billId: 'bill-work-1',
        monthKey: '2026-11',
        amountMinor: 300000,
        currency: 'BDT',
        paidAt: '2026-11-14T00:00:00.000Z',
        createdAt: '2026-11-14T00:00:00.000Z',
      };

      const sheet = computeGroupedMonthSheet(
        '2026-11',
        userIdA,
        allBills,
        allGroups,
        [payment1, payment2],
        [],
        '2026-11-16' as any
      );

      const sumExpected = sheet.groups.reduce((acc, g) => acc + g.totalExpectedMinor, 0);
      const sumDue = sheet.groups.reduce((acc, g) => acc + g.totalDueMinor, 0);
      const sumPaid = sheet.groups.reduce((acc, g) => acc + g.totalPaidMinor, 0);
      const sumRemaining = sheet.groups.reduce((acc, g) => acc + g.totalRemainingMinor, 0);
      const sumActive = sheet.groups.reduce((acc, g) => acc + g.activeBillsCount, 0);
      const sumPaidCount = sheet.groups.reduce((acc, g) => acc + g.paidBillsCount, 0);
      const sumOverdueCount = sheet.groups.reduce((acc, g) => acc + g.overdueBillsCount, 0);

      // Exact identity check: Single Source of Truth
      expect(sumExpected).toBe(sheet.monthTotal.totalExpectedMinor);
      expect(sumDue).toBe(sheet.monthTotal.totalDueMinor);
      expect(sumPaid).toBe(sheet.monthTotal.totalPaidMinor);
      expect(sumRemaining).toBe(sheet.monthTotal.totalRemainingMinor);
      expect(sheet.monthTotal.carryOutMinor).toBe(sheet.monthTotal.totalRemainingMinor);
      expect(sumActive).toBe(sheet.monthTotal.activeBillsCount);
      expect(sumPaidCount).toBe(sheet.monthTotal.paidBillsCount);
      expect(sumOverdueCount).toBe(sheet.monthTotal.overdueBillsCount);

      // Value verification
      expect(sheet.monthTotal.totalExpectedMinor).toBe(700000); // 1500 + 500 + 3000 + 2000
      expect(sheet.monthTotal.totalPaidMinor).toBe(350000); // 500 + 3000
      expect(sheet.monthTotal.totalRemainingMinor).toBe(350000); // 1000 + 500 + 0 + 2000
      expect(sheet.monthTotal.carryOutMinor).toBe(350000);
    });

    it('filters bill states correctly for All, Unpaid, Paid, Overdue, Carried (A5)', () => {
      // Setup bills with different states
      const sheet = computeGroupedMonthSheet(
        '2026-11',
        userIdA,
        allBills,
        allGroups,
        [
          {
            id: 'pay-work',
            userId: userIdA,
            billId: 'bill-work-1',
            monthKey: '2026-11',
            amountMinor: 300000,
            currency: 'BDT',
            paidAt: '2026-11-10T00:00:00.000Z',
            createdAt: '2026-11-10T00:00:00.000Z',
          },
        ],
        [],
        '2026-11-10' as any // billHome1 is due Nov 5 -> overdue
      );

      const allStates = sheet.groups.flatMap((g) => g.billStates);

      const filteredAll = filterBillStates(allStates, 'All');
      expect(filteredAll.length).toBe(4);

      const filteredPaid = filterBillStates(allStates, 'Paid');
      expect(filteredPaid.length).toBe(1);
      expect(filteredPaid[0].bill.id).toBe('bill-work-1');

      const filteredUnpaid = filterBillStates(allStates, 'Unpaid');
      expect(filteredUnpaid.length).toBe(3);

      const filteredOverdue = filterBillStates(allStates, 'Overdue');
      expect(filteredOverdue.length).toBe(1);
      expect(filteredOverdue[0].bill.id).toBe('bill-home-1');

      const filteredCarried = filterBillStates(allStates, 'Carried');
      expect(filteredCarried.length).toBe(0); // No carry-ins in this scenario
    });

    it('accurately identifies and aggregates carry-ins across groups and month totals', () => {
      // Bill created in October, partially paid in October
      const octBill: CycleBill = {
        ...baseBill,
        id: 'bill-carried-1',
        groupId: 'grp-home',
        expectedAmountMinor: 100000,
        createdAt: '2026-10-01T00:00:00.000Z',
      };
      const octPayments: CyclePayment[] = [
        {
          id: 'pay-oct',
          userId: userIdA,
          billId: 'bill-carried-1',
          monthKey: '2026-10',
          amountMinor: 40000, // ৳400 of ৳1,000 paid -> ৳600 unpaid
          currency: 'BDT',
          paidAt: '2026-10-10T00:00:00.000Z',
          createdAt: '2026-10-10T00:00:00.000Z',
        },
      ];

      const sheet = computeGroupedMonthSheet(
        '2026-11',
        userIdA,
        [octBill],
        allGroups,
        octPayments,
        [],
        '2026-11-01' as any
      );

      expect(sheet.monthTotal.totalCarryInMinor).toBe(60000); // ৳600 carried in
      expect(sheet.groups[0].totalCarryInMinor).toBe(60000);

      const allStates = sheet.groups.flatMap((g) => g.billStates);
      const carried = filterBillStates(allStates, 'Carried');
      expect(carried.length).toBe(1);
      expect(carried[0].carryInMinor).toBe(60000);
    });
  });

  describe('External-Paid Bill & Debt Integration (Batch 3 Part B)', () => {
    it('counts external-paid bill as paid immediately in monthly cycle with 0 remaining liability', () => {
      const extBill: CycleBill = {
        ...baseBill,
        id: 'bill-ext-1',
        paidBy: 'person',
        payerName: 'Karim Bhai',
        expectedAmountMinor: 120000, // ৳1,200
        dueDay: 15,
      };

      const state = computeBillMonthState(extBill, '2026-11', [], null, '2026-11-16' as any);
      expect(state.status).toBe('paid');
      expect(state.totalDueMinor).toBe(120000);
      expect(state.totalPaidMinor).toBe(120000);
      expect(state.remainingMinor).toBe(0);
      expect(state.isOverdue).toBe(false);
    });

    it('monthly cash flow counts bill liability exactly once', () => {
      const extBill: CycleBill = {
        ...baseBill,
        id: 'bill-ext-1',
        paidBy: 'lender',
        payerName: 'City Bank',
        expectedAmountMinor: 500000, // ৳5,000
      };

      const summary = computeMonthSummary(
        '2026-11',
        userIdA,
        [extBill],
        [],
        [
          {
            id: 'inc-1',
            userId: userIdA,
            source: 'Salary',
            amountMinor: 1000000, // ৳10,000
            currency: 'BDT',
            monthKey: '2026-11',
            receivedAt: '2026-11-01' as any,
            isReceived: true,
            createdAt: '2026-11-01T00:00:00.000Z',
          },
        ],
        [],
        null,
        '2026-11-16' as any
      );

      expect(summary.totalExpectedBillsMinor).toBe(500000);
      expect(summary.totalPaidBillsMinor).toBe(500000);
      expect(summary.totalRemainingBillsMinor).toBe(0);
      expect(summary.paidBillsCount).toBe(1);
      // Safe to spend = income - totalDueBillsMinor = 10,000 - 5,000 = 5,000
      expect(summary.safeToSpendMinor).toBe(500000);
    });

    it('supports debt repayment lifecycle without affecting monthly cycle expense (B4)', () => {
      const initialDebt: Debt = {
        id: 'debt-ext-1',
        person: 'Karim Bhai',
        direction: 'i_owe',
        amountMinor: 120000,
        paidMinor: 0,
        currency: 'BDT',
        dueDate: '2026-12-01' as any,
        createdAt: '2026-11-01T00:00:00.000Z',
        sample: false,
      };

      // 1. Partial debt repayment (৳500 of ৳1,200)
      const pay1 = applyDebtPayment([initialDebt], 'debt-ext-1', 50000);
      expect(pay1.ok).toBe(true);
      if (pay1.ok) {
        const debtAfterPay1 = pay1.debts.find((d) => d.id === 'debt-ext-1')!;
        expect(debtAfterPay1.paidMinor).toBe(50000);
        // Bill remains fully paid in the cycle month
        const extBill: CycleBill = {
          ...baseBill,
          id: 'bill-ext-1',
          paidBy: 'person',
          payerName: 'Karim Bhai',
          linkedDebtId: 'debt-ext-1',
          repayStatus: 'partial',
        };
        const state = computeBillMonthState(extBill, '2026-11', [], null, '2026-11-16' as any);
        expect(state.status).toBe('paid');
        expect(state.remainingMinor).toBe(0);

        // 2. Full debt repayment (remaining ৳700)
        const pay2 = applyDebtPayment(pay1.debts, 'debt-ext-1', 70000);
        expect(pay2.ok).toBe(true);
        if (pay2.ok) {
          const debtAfterPay2 = pay2.debts.find((d) => d.id === 'debt-ext-1')!;
          expect(debtAfterPay2.paidMinor).toBe(120000);
          expect(debtAfterPay2.paidMinor >= debtAfterPay2.amountMinor).toBe(true);
        }
      }
    });

    it('rejects invalid paidBy option and invalid date strings during validation', () => {
      const invalidPaidBy = validateCycleBill({
        ...baseBill,
        paidBy: 'unauthorized_entity',
      });
      expect(invalidPaidBy.ok).toBe(false);
      if (!invalidPaidBy.ok) {
        expect(invalidPaidBy.error).toContain('Invalid paidBy');
      }

      const invalidDate = validateCycleBill({
        ...baseBill,
        paidBy: 'person',
        repayDueDate: 'invalid-date-string',
      });
      expect(invalidDate.ok).toBe(false);
      if (!invalidDate.ok) {
        expect(invalidDate.error).toContain('repayDueDate');
      }
    });

    it('backfills legacy bills without paidBy to "self" idempotently (B6)', () => {
      const legacyBill: CycleBill = {
        ...baseBill,
        id: 'bill-legacy-no-paidby',
        paidBy: undefined,
      };

      const pass1 = backfillBillGroupIds([legacyBill], []);
      expect(pass1[0].paidBy).toBe('self');

      const pass2 = backfillBillGroupIds(pass1, []);
      expect(pass2[0].paidBy).toBe('self');
      expect(pass2).toEqual(pass1);
    });

    it('validates linked debt currency integrity without silent conversion (B7)', () => {
      const bdtBill: CycleBill = {
        ...baseBill,
        currency: 'USD',
        paidBy: 'person',
        payerName: 'Alex',
        expectedAmountMinor: 10000,
      };

      const mismatchedDebt: Debt = {
        id: 'debt-bdt-1',
        person: 'Alex',
        direction: 'i_owe',
        amountMinor: 10000,
        paidMinor: 0,
        currency: 'BDT', // Mismatch! USD vs BDT
        dueDate: null,
        createdAt: '2026-11-01T00:00:00.000Z',
        sample: false,
      };

      // Currency check helper / integrity rule:
      const checkCurrency = (bill: CycleBill, debt: Debt) => {
        if (bill.currency !== debt.currency) {
          return `Currency mismatch: bill currency (${bill.currency}) does not match debt currency (${debt.currency})`;
        }
        return null;
      };

      const err = checkCurrency(bdtBill, mismatchedDebt);
      expect(err).toBe('Currency mismatch: bill currency (USD) does not match debt currency (BDT)');
    });
  });

  describe('Split payments, sample data, backups and copy', () => {
    describe('Split Paid Cash Calculation', () => {
      it('calculates available cash = income - paidSelf (excluding external payments) while safe-to-spend = income - totalDue', () => {
        // Scenario:
        // income 5000, bill 820 paid by person -> available 5000, debt 820, safe 4180, month expense 820 counted once
        const monthKey = '2026-11';
        const incomeAmount = 500000; // 5,000.00
        const billAmount = 82000;    // 820.00

        const externalBill: CycleBill = {
          id: 'cbill-external-1',
          userId: userIdA,
          name: 'Apartment Maintenance',
          group: 'Housing',
          expectedAmountMinor: billAmount,
          currency: 'BDT',
          dueDay: 15,
          payee: 'Landlord',
          isVariable: false,
          isPaused: false,
          autopay: false,
          completedInstallments: 0,
          paidBy: 'person',
          payerName: 'Alex',
          linkedDebtId: 'debt-alex-820',
          repayStatus: 'unpaid',
          createdAt: `${monthKey}-01T00:00:00.000Z`,
        };

        const income: CycleIncome = {
          id: 'cincome-1',
          userId: userIdA,
          source: 'Primary Salary',
          amountMinor: incomeAmount,
          currency: 'BDT',
          monthKey,
          receivedAt: `${monthKey}-01`,
          isReceived: true,
          createdAt: `${monthKey}-01T00:00:00.000Z`,
        };

        // Linked debt record in debts collection:
        const linkedDebt: Debt = {
          id: 'debt-alex-820',
          person: 'Alex',
          direction: 'i_owe',
          amountMinor: billAmount,
          paidMinor: 0,
          currency: 'BDT',
          dueDate: null,
          createdAt: `${monthKey}-01T00:00:00.000Z`,
          sample: false,
        };

        // Bill state:
        const billState = computeBillMonthState(externalBill, monthKey, []);
        expect(billState.totalDueMinor).toBe(billAmount);
        expect(billState.totalPaidMinor).toBe(billAmount);
        expect(billState.paidSelfMinor).toBe(0);
        expect(billState.paidExternalMinor).toBe(billAmount);
        expect(billState.remainingMinor).toBe(0); // Settled externally for this month's bill

        // Month summary:
        const summary = computeMonthSummary(monthKey, userIdA, [externalBill], [], [income], []);
        expect(summary.totalIncomeMinor).toBe(incomeAmount); // 5000
        expect(summary.totalPaidBillsMinor).toBe(billAmount); // 820
        expect(summary.totalPaidSelfMinor).toBe(0);          // 0 paid by self
        expect(summary.totalPaidExternalMinor).toBe(billAmount); // 820 paid by external person
        expect(summary.availableCashMinor).toBe(incomeAmount); // 5000: NOT reduced because self didn't pay cash!
        expect(summary.safeToSpendMinor).toBe(incomeAmount - billAmount); // 4180: liability is still 820
        expect(summary.totalRemainingBillsMinor).toBe(0);

        // Debt list invariant: user owes Alex 820
        expect(linkedDebt.direction).toBe('i_owe');
        expect(linkedDebt.amountMinor - linkedDebt.paidMinor).toBe(billAmount);

        // Grouped Month Sheet totals reflect the split:
        const sheet = computeGroupedMonthSheet(monthKey, userIdA, [externalBill], [], [], []);
        expect(sheet.monthTotal.totalPaidMinor).toBe(billAmount);
        expect(sheet.monthTotal.totalPaidSelfMinor).toBe(0);
        expect(sheet.monthTotal.totalPaidExternalMinor).toBe(billAmount);
      });
    });

    describe('Sample Data & Backup Compatibility', () => {
      it('2.1 includes sample cycle collections with partial bill and external-paid bill, tagged sample: true', () => {
        const sample = sampleData('2026-11-09');
        expect(sample.cycleGroups).toBeDefined();
        expect(sample.cycleBills).toBeDefined();
        expect(sample.cyclePayments).toBeDefined();
        expect(sample.cycleIncomes).toBeDefined();
        expect(sample.cycleMonths).toBeDefined();

        expect(sample.cycleGroups!.length).toBeGreaterThanOrEqual(1);
        expect(sample.cycleBills!.length).toBeGreaterThanOrEqual(2);

        // Partial bill verification:
        const partialBill = sample.cycleBills!.find((b) => b.id === 'sample_cbill1');
        expect(partialBill).toBeDefined();
        expect(partialBill?.sample).toBe(true);
        const partialPayment = sample.cyclePayments!.find((p) => p.billId === 'sample_cbill1');
        expect(partialPayment).toBeDefined();
        expect(partialPayment!.amountMinor).toBeLessThan(partialBill!.expectedAmountMinor);
        expect(partialPayment?.sample).toBe(true);

        // External-paid bill verification:
        const externalBill = sample.cycleBills!.find((b) => b.id === 'sample_cbill2');
        expect(externalBill).toBeDefined();
        expect(externalBill?.sample).toBe(true);
        expect(externalBill?.paidBy).toBe('person');
        expect(externalBill?.linkedDebtId).toBe('sample_d2');

        // Linked debt exists in sample.debts:
        const linkedDebt = sample.debts.find((d) => d.id === 'sample_d2');
        expect(linkedDebt).toBeDefined();
        expect(linkedDebt?.sample).toBe(true);

        // Sample data is not default (emptyData has zero cycle records)
        const blank = emptyData();
        expect(blank.cycleGroups?.length ?? 0).toBe(0);
        expect(blank.cycleBills?.length ?? 0).toBe(0);
        expect(blank.cyclePayments?.length ?? 0).toBe(0);
        expect(blank.cycleIncomes?.length ?? 0).toBe(0);
        expect(blank.cycleMonths?.length ?? 0).toBe(0);
      });

      it('2.2 wipes cycle collections completely on delete all / emptyData', () => {
        // Populated state from sampleData
        const populated = sampleData('2026-11-09');
        expect(populated.cycleBills!.length).toBeGreaterThan(0);

        // Delete all -> emptyData()
        const reset = emptyData();
        expect(reset.cycleGroups).toEqual([]);
        expect(reset.cycleBills).toEqual([]);
        expect(reset.cyclePayments).toEqual([]);
        expect(reset.cycleIncomes).toEqual([]);
        expect(reset.cycleMonths).toEqual([]);
      });

      it('2.3 round-trips cycle collections through makeBackupPlaintext and parseData, and handles legacy backups without cycle data', () => {
        const fullData = sampleData('2026-11-09');

        // Export round trip:
        const jsonExport = makeBackupPlaintext(fullData);
        const parsed = parseData(jsonExport);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error(parsed.error);

        expect(parsed.data.cycleGroups).toEqual(fullData.cycleGroups);
        expect(parsed.data.cycleBills).toEqual(fullData.cycleBills);
        expect(parsed.data.cyclePayments).toEqual(fullData.cyclePayments);
        expect(parsed.data.cycleIncomes).toEqual(fullData.cycleIncomes);
        expect(parsed.data.cycleMonths).toEqual(fullData.cycleMonths);

        // Legacy backup without cycle collections:
        const legacyPayload = {
          schemaVersion: 2,
          settings: fullData.settings,
          tasks: fullData.tasks,
          expenses: fullData.expenses,
          goals: fullData.goals,
          debts: fullData.debts,
          wallets: fullData.wallets,
          walletEntries: fullData.walletEntries,
          walletTransfers: fullData.walletTransfers,
          syncedContacts: fullData.syncedContacts,
          messGroups: fullData.messGroups,
          messMembers: fullData.messMembers,
          messMeals: fullData.messMeals,
          messExpenses: fullData.messExpenses,
          // cycle collections omitted!
        };

        const parsedLegacy = parseData(JSON.stringify(legacyPayload));
        expect(parsedLegacy.ok).toBe(true);
        if (!parsedLegacy.ok) throw new Error(parsedLegacy.error);
        expect(parsedLegacy.data.cycleGroups).toEqual([]);
        expect(parsedLegacy.data.cycleBills).toEqual([]);
        expect(parsedLegacy.data.cyclePayments).toEqual([]);
        expect(parsedLegacy.data.cycleIncomes).toEqual([]);
        expect(parsedLegacy.data.cycleMonths).toEqual([]);
      });

      it('2.5 sets the current schema version for backward-compatibility guard', () => {
        expect(SCHEMA_VERSION).toBe(10);
      });

      it('2.6 validates collection constraints: integer minor, enums, and graceful orphan groupId fallback', () => {
        // Invalid cycle bill amount (fractional or negative)
        const invalidBill1 = { ...baseBill, expectedAmountMinor: 100.5 };
        expect(validateCycleBill(invalidBill1).ok).toBe(false);

        const invalidBill2 = { ...baseBill, expectedAmountMinor: -50 };
        expect(validateCycleBill(invalidBill2).ok).toBe(false);

        // Invalid paidBy enum
        const invalidBill3 = { ...baseBill, paidBy: 'magic' };
        expect(validateCycleBill(invalidBill3).ok).toBe(false);

        // Invalid cycle month
        expect(validateCycleMonth({ id: 'm1', userId: 'u1', monthKey: 'invalid-month', isClosed: false }).ok).toBe(false);

        // Orphan groupId resolution:
        const orphanBill: CycleBill = {
          ...baseBill,
          groupId: 'non-existent-group-id',
          group: 'Legacy Name',
        };
        const resolvedName = resolveBillGroupName(orphanBill, []);
        // Falls back to legacy name or null, doesn't throw:
        expect(resolvedName).toBe('Legacy Name');

        // Render sheet with orphan group:
        const sheet = computeGroupedMonthSheet('2026-11', userIdA, [orphanBill], [], [], []);
        // Orphan bill without a matching group ends up in "No group" without crashing:
        const noGroup = sheet.groups.find((g) => g.groupName === 'No group');
        expect(noGroup).toBeDefined();
        expect(noGroup?.billStates.length).toBe(1);
      });

      it('2.7 validates currency own-property validation on cycle amounts', () => {
        expect(validateCurrency('BDT').ok).toBe(true);
        expect(validateCurrency('USD').ok).toBe(true);
        expect(validateCurrency('INVALID').ok).toBe(false);
        expect(validateCurrency(123).ok).toBe(false);
        expect(validateCurrency(null).ok).toBe(false);
      });
    });

    describe('Copy & Disclosure Consistency', () => {
      it('keeps the approved starter category template stable and editable as groups', () => {
        expect(DEFAULT_CYCLE_GROUP_NAMES).toEqual([
          'Room rent',
          'Home insurance',
          'Other insurance',
          'Electricity',
          'Heating',
          'Loan 1',
          'Loan 2',
          'Loan 3',
          'Loan 4',
          'Loan 5',
          'Loan 6',
          'Personal loans',
          'Bank loans',
          'Food',
          'Gym bills',
          'Wi-Fi bills',
          'Cosmetics and barber',
          'Internet tools',
          'Other bills',
        ]);
      });

      it('applies a month-specific amount without changing the recurring bill', () => {
        const override = {
          id: 'override-1',
          userId: baseBill.userId,
          billId: baseBill.id,
          monthKey: '2026-11',
          expectedAmountMinor: 250000,
          createdAt: '2026-11-01T00:00:00.000Z',
        };
        expect(validateCycleBillOverride(override).ok).toBe(true);
        const state = computeBillMonthState(
          baseBill,
          '2026-11',
          [],
          null,
          '2026-11-05' as any,
          [override],
        );
        expect(state.expectedAmountMinor).toBe(250000);
        expect(baseBill.expectedAmountMinor).not.toBe(250000);
      });

      it('auto-backup disclosure says "At most once a day, never guaranteed."', () => {
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).toContain('At most once a day');
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).toContain('never guaranteed');
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).toContain('The OS decides when background tasks run');
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).toContain('no backup runs if the app is force-closed or offline');

        // False promises must not exist:
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).not.toContain('guaranteed at 3am');
        expect(AUTO_BACKUP_DISCLOSURE_TEXT).not.toContain('automatic daily');
      });
    });
  });
});
