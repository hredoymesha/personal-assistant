/**
 * Money Cycle: monthly bills, payments, income and month totals.
 *
 * Amounts are integer minor units and currencies are never mixed. A partial payment carries
 * the rest into next month exactly once, and undoing a payment reverses it exactly. Bills can
 * be skipped or paused, and finish on their own after the last installment or end date.
 * Closed months are read-only.
 */

import { Minor, isSupportedCurrency, sumMinor } from './money';
import { DateStr, isValidDateStr } from './dates';
import { Result } from './validation';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export type BillType = 'fixed' | 'variable';
export type BillStatus = 'upcoming' | 'due' | 'paid' | 'overdue' | 'paused' | 'completed';
export type BillPaidBy = 'self' | 'person' | 'lender' | 'credit';
export type RepayStatus = 'unpaid' | 'partial' | 'repaid';

/** Returns the shared currency for an aggregate, or null when it mixes currencies. */
export function getUniformCurrency(currencies: string[]): string | null {
  const first = currencies[0];
  if (!first || currencies.some((currency) => currency !== first)) return null;
  return first;
}

export interface CycleGroup {
  id: string;
  userId: string;
  name: string;
  sortOrder: number;
  sample?: boolean;
  createdAt: string;
}

export const DEFAULT_CYCLE_GROUP_NAMES = [
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
] as const;

export interface CycleBill {
  id: string;
  userId: string;
  name: string;
  groupId?: string | null;
  group?: string | null;
  expectedAmountMinor: Minor;
  currency: string;
  dueDay: number; // 1-31
  dueDate?: DateStr | null;
  payee: string;
  isVariable: boolean;
  isPaused: boolean;
  autopay: boolean;
  installmentCount?: number | null;
  completedInstallments: number;
  endDate?: DateStr | null;
  paidBy?: BillPaidBy;
  payerName?: string | null;
  linkedDebtId?: string | null;
  repayDueDate?: DateStr | null;
  repayStatus?: RepayStatus;
  sample?: boolean;
  createdAt: string;
}

export interface CycleBillOverride {
  id: string;
  userId: string;
  billId: string;
  monthKey: string;
  expectedAmountMinor?: Minor;
  groupId?: string | null;
  group?: string | null;
  createdAt: string;
  sample?: boolean;
}

export interface CyclePayment {
  id: string;
  userId: string;
  billId: string;
  monthKey: string; // YYYY-MM
  amountMinor: Minor;
  currency: string;
  paidAt: string; // ISO
  walletId?: string | null;
  note?: string;
  sample?: boolean;
  createdAt: string;
}

export interface CycleIncome {
  id: string;
  userId: string;
  source: string;
  amountMinor: Minor;
  currency: string;
  monthKey: string; // YYYY-MM
  receivedAt: DateStr;
  isReceived: boolean;
  sample?: boolean;
  createdAt: string;
}

export interface CycleMonth {
  id: string;
  userId: string;
  monthKey: string; // YYYY-MM
  isClosed: boolean;
  closedAt?: string | null;
  notes?: string;
  sample?: boolean;
}

export type CycleMonthLockAction = 'closed' | 'reopened';

export interface CycleMonthLockEvent {
  id: string;
  userId: string;
  monthKey: string;
  action: CycleMonthLockAction;
  actor: 'local_owner';
  reason?: string;
  createdAt: string;
  sample?: boolean;
}

export interface BillMonthState {
  bill: CycleBill;
  monthKey: string;
  expectedAmountMinor: Minor;
  carryInMinor: Minor;
  totalDueMinor: Minor;
  totalPaidMinor: Minor;
  paidSelfMinor: Minor;
  paidExternalMinor: Minor;
  remainingMinor: Minor;
  status: BillStatus;
  computedDueDate: DateStr;
  isReminderDue: boolean;
  isOverdue: boolean;
}

export interface MonthSummary {
  monthKey: string;
  isClosed: boolean;
  totalExpectedBillsMinor: Minor;
  totalCarryInMinor: Minor;
  totalDueBillsMinor: Minor;
  totalPaidBillsMinor: Minor;
  totalPaidSelfMinor: Minor;
  totalPaidExternalMinor: Minor;
  totalRemainingBillsMinor: Minor;
  availableCashMinor: Minor;
  totalIncomeMinor: Minor;
  safeToSpendMinor: Minor;
  activeBillsCount: number;
  paidBillsCount: number;
  overdueBillsCount: number;
}

/** Pure helper to format a month key YYYY-MM */
export function formatMonthKey(year: number, month: number): string {
  const m = String(month).padStart(2, '0');
  return `${year}-${m}`;
}

/** Pure helper to get previous month key */
export function getPreviousMonthKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-');
  let y = parseInt(yearStr, 10);
  let m = parseInt(monthStr, 10);
  m -= 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return formatMonthKey(y, m);
}

/** Pure helper to compute actual due date string for a given month and dueDay */
export function computeDueDateStr(monthKey: string, dueDay: number): DateStr {
  const [yearStr, monthStr] = monthKey.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  // Cap at max days in that month (e.g. Feb 28/29, Apr 30)
  const daysInMonth = new Date(y, m, 0).getDate();
  const cappedDay = Math.min(Math.max(1, dueDay), daysInMonth);
  const d = String(cappedDay).padStart(2, '0');
  return `${monthKey}-${d}` as DateStr;
}

/** Own-property validation for currency codes */
export function validateCurrency(currency: unknown): Result<string> {
  if (typeof currency !== 'string' || !currency) {
    return fail('Currency must be a non-empty string');
  }
  if (!isSupportedCurrency(currency)) {
    return fail(`Currency '${currency}' is not supported`);
  }
  return ok(currency);
}

/** Validates a CycleGroup */
export function validateCycleGroup(v: unknown): Result<CycleGroup> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('CycleGroup must be an object');
  }
  const g = v as Record<string, unknown>;
  if (typeof g.id !== 'string' || !g.id.trim()) return fail('Group id is required');
  if (typeof g.userId !== 'string' || !g.userId.trim()) return fail('Group userId is required');
  if (typeof g.name !== 'string' || !g.name.trim()) return fail('Group name is required');
  if (typeof g.sortOrder !== 'number' || !Number.isInteger(g.sortOrder) || g.sortOrder < 0) {
    return fail('sortOrder must be a non-negative integer');
  }
  return ok(v as CycleGroup);
}

/** Validates a CycleBill */
export function validateCycleBill(v: unknown): Result<CycleBill> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('CycleBill must be an object');
  }
  const b = v as Record<string, unknown>;
  if (typeof b.id !== 'string' || !b.id.trim()) return fail('Bill id is required');
  if (typeof b.userId !== 'string' || !b.userId.trim()) return fail('Bill userId is required');
  if (typeof b.name !== 'string' || !b.name.trim()) return fail('Bill name is required');
  if (b.groupId !== undefined && b.groupId !== null && typeof b.groupId !== 'string') {
    return fail('Bill groupId must be a string or null');
  }
  if (b.group !== undefined && b.group !== null && typeof b.group !== 'string') {
    return fail('Bill group must be a string or null');
  }
  if (typeof b.expectedAmountMinor !== 'number' || !Number.isSafeInteger(b.expectedAmountMinor) || b.expectedAmountMinor <= 0) {
    return fail('Bill expected amount must be a positive safe integer minor unit');
  }
  const curr = validateCurrency(b.currency);
  if (!curr.ok) return curr;
  if (typeof b.dueDay !== 'number' || b.dueDay < 1 || b.dueDay > 31) {
    return fail('Bill due day must be between 1 and 31');
  }
  if (typeof b.isPaused !== 'boolean') return fail('isPaused must be boolean');
  if (typeof b.completedInstallments !== 'number' || !Number.isSafeInteger(b.completedInstallments) || b.completedInstallments < 0) {
    return fail('completedInstallments must be non-negative integer');
  }
  if (b.paidBy !== undefined && b.paidBy !== null) {
    if (!['self', 'person', 'lender', 'credit'].includes(b.paidBy as string)) {
      return fail('Invalid paidBy option');
    }
  }
  if (b.payerName !== undefined && b.payerName !== null && typeof b.payerName !== 'string') {
    return fail('payerName must be a string or null');
  }
  if (b.linkedDebtId !== undefined && b.linkedDebtId !== null && typeof b.linkedDebtId !== 'string') {
    return fail('linkedDebtId must be a string or null');
  }
  if (b.repayDueDate !== undefined && b.repayDueDate !== null && !isValidDateStr(b.repayDueDate)) {
    return fail('repayDueDate must be a valid date or null');
  }
  if (b.repayStatus !== undefined && b.repayStatus !== null) {
    if (!['unpaid', 'partial', 'repaid'].includes(b.repayStatus as string)) {
      return fail('Invalid repayStatus option');
    }
  }
  return ok(v as CycleBill);
}

export function validateCycleBillOverride(v: unknown): Result<CycleBillOverride> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('CycleBillOverride must be an object');
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return fail('Override id is required');
  if (typeof o.userId !== 'string' || !o.userId.trim()) return fail('Override userId is required');
  if (typeof o.billId !== 'string' || !o.billId.trim()) return fail('Override billId is required');
  if (typeof o.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(o.monthKey)) return fail('Override monthKey must be YYYY-MM');
  if (o.expectedAmountMinor !== undefined &&
    (typeof o.expectedAmountMinor !== 'number' || !Number.isSafeInteger(o.expectedAmountMinor) || o.expectedAmountMinor <= 0)) {
    return fail('Override amount must be a positive safe integer minor unit');
  }
  if (o.groupId !== undefined && o.groupId !== null && typeof o.groupId !== 'string') return fail('Override groupId must be a string or null');
  if (o.group !== undefined && o.group !== null && typeof o.group !== 'string') return fail('Override group must be a string or null');
  return ok(v as CycleBillOverride);
}

/** Fills in groupId and paidBy on older bills (paidBy defaults to 'self'). Returns new objects. */
export function backfillBillGroupIds(bills: CycleBill[], groups: CycleGroup[]): CycleBill[] {
  if (!bills || bills.length === 0) return bills ?? [];

  return bills.map((bill) => {
    let updated = bill;
    if (!updated.paidBy) {
      updated = { ...updated, paidBy: 'self' };
    }
    if (updated.groupId) return updated;
    if (!updated.group || !updated.group.trim()) return updated;

    const matched = (groups || []).find(
      (g) => g.userId === updated.userId && g.name.toLowerCase() === updated.group!.trim().toLowerCase()
    );
    if (matched) {
      return { ...updated, groupId: matched.id };
    }
    return updated;
  });
}

/** Group name for a bill: the group its groupId points to, else the old free-text group. */
export function resolveBillGroupName(bill: CycleBill, groups: CycleGroup[]): string | null {
  if (bill.groupId) {
    const matched = groups.find((g) => g.id === bill.groupId);
    if (matched) return matched.name;
  }
  return bill.group && bill.group.trim() ? bill.group.trim() : null;
}

/** Validates a CyclePayment */
export function validateCyclePayment(v: unknown): Result<CyclePayment> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('CyclePayment must be an object');
  }
  const p = v as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id.trim()) return fail('Payment id is required');
  if (typeof p.userId !== 'string' || !p.userId.trim()) return fail('Payment userId is required');
  if (typeof p.billId !== 'string' || !p.billId.trim()) return fail('Payment billId is required');
  if (typeof p.amountMinor !== 'number' || !Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) {
    return fail('Payment amount must be a positive safe integer minor unit');
  }
  const curr = validateCurrency(p.currency);
  if (!curr.ok) return curr;
  if (typeof p.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(p.monthKey)) {
    return fail('Payment monthKey must be in YYYY-MM format');
  }
  return ok(v as CyclePayment);
}

/** Validates a CycleIncome */
export function validateCycleIncome(v: unknown): Result<CycleIncome> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('CycleIncome must be an object');
  }
  const inc = v as Record<string, unknown>;
  if (typeof inc.id !== 'string' || !inc.id.trim()) return fail('Income id is required');
  if (typeof inc.userId !== 'string' || !inc.userId.trim()) return fail('Income userId is required');
  if (typeof inc.source !== 'string' || !inc.source.trim()) return fail('Income source is required');
  if (typeof inc.amountMinor !== 'number' || !Number.isSafeInteger(inc.amountMinor) || inc.amountMinor <= 0) {
    return fail('Income amount must be a positive safe integer minor unit');
  }
  const curr = validateCurrency(inc.currency);
  if (!curr.ok) return curr;
  if (typeof inc.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(inc.monthKey)) {
    return fail('Income monthKey must be in YYYY-MM format');
  }
  return ok(v as CycleIncome);
}

/** Validates a CycleMonth */
export function validateCycleMonth(v: unknown): Result<CycleMonth> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('CycleMonth must be an object');
  }
  const m = v as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id.trim()) return fail('Month id is required');
  if (typeof m.userId !== 'string' || !m.userId.trim()) return fail('Month userId is required');
  if (typeof m.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(m.monthKey)) {
    return fail('Month monthKey must be in YYYY-MM format');
  }
  if (typeof m.isClosed !== 'boolean') return fail('isClosed must be boolean');
  return ok(v as CycleMonth);
}

export function validateCycleMonthLockEvent(v: unknown): Result<CycleMonthLockEvent> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('CycleMonthLockEvent must be an object');
  const e = v as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id.trim()) return fail('Lock event id is required');
  if (typeof e.userId !== 'string' || !e.userId.trim()) return fail('Lock event userId is required');
  if (typeof e.monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(e.monthKey)) return fail('Lock event monthKey must be YYYY-MM');
  if (e.action !== 'closed' && e.action !== 'reopened') return fail('Invalid lock event action');
  if (e.actor !== 'local_owner') return fail('Invalid lock event actor');
  if (e.reason !== undefined && typeof e.reason !== 'string') return fail('Lock event reason must be text');
  return ok(v as CycleMonthLockEvent);
}

/** Computes single bill state in a target month with carry_in liability support */
export function computeBillMonthState(
  bill: CycleBill,
  monthKey: string,
  payments: CyclePayment[],
  previousMonthState?: BillMonthState | null,
  today: DateStr = new Date().toISOString().slice(0, 10) as DateStr,
  overrides: CycleBillOverride[] = [],
): BillMonthState {
  const override = overrides.find((item) => item.billId === bill.id && item.userId === bill.userId && item.monthKey === monthKey);
  const effectiveBill = override ? {
    ...bill,
    ...(override.expectedAmountMinor !== undefined ? { expectedAmountMinor: override.expectedAmountMinor } : {}),
    ...(override.groupId !== undefined ? { groupId: override.groupId } : {}),
    ...(override.group !== undefined ? { group: override.group } : {}),
  } : bill;
  bill = effectiveBill;
  const computedDueDate = computeDueDateStr(monthKey, bill.dueDay);

  // If bill was created in a future month relative to monthKey, it was not yet active
  if (bill.createdAt && monthKey < bill.createdAt.slice(0, 7)) {
    return {
      bill,
      monthKey,
      expectedAmountMinor: 0,
      carryInMinor: 0,
      totalDueMinor: 0,
      totalPaidMinor: 0,
      paidSelfMinor: 0,
      paidExternalMinor: 0,
      remainingMinor: 0,
      status: 'completed',
      computedDueDate,
      isReminderDue: false,
      isOverdue: false,
    };
  }

  // Check installment expiration
  if (bill.installmentCount && bill.completedInstallments >= bill.installmentCount) {
    return {
      bill,
      monthKey,
      expectedAmountMinor: 0,
      carryInMinor: 0,
      totalDueMinor: 0,
      totalPaidMinor: 0,
      paidSelfMinor: 0,
      paidExternalMinor: 0,
      remainingMinor: 0,
      status: 'completed',
      computedDueDate,
      isReminderDue: false,
      isOverdue: false,
    };
  }

  // Check end-date expiration
  if (bill.endDate && bill.endDate.slice(0, 7) < monthKey) {
    return {
      bill,
      monthKey,
      expectedAmountMinor: 0,
      carryInMinor: 0,
      totalDueMinor: 0,
      totalPaidMinor: 0,
      paidSelfMinor: 0,
      paidExternalMinor: 0,
      remainingMinor: 0,
      status: 'completed',
      computedDueDate,
      isReminderDue: false,
      isOverdue: false,
    };
  }

  // Carry in is unpaid balance from previous month
  const carryInMinor = previousMonthState ? previousMonthState.remainingMinor : 0;
  const expectedAmountMinor = bill.isPaused ? 0 : bill.expectedAmountMinor;
  const totalDueMinor = sumMinor([expectedAmountMinor, carryInMinor]);

  const isExternalPaid = Boolean(bill.paidBy && bill.paidBy !== 'self');

  // Payments made for this bill in this month
  const billPaymentsThisMonth = payments.filter((p) => p.billId === bill.id && p.monthKey === monthKey);
  const recordedPaidMinor = sumMinor(billPaymentsThisMonth.map((p) => p.amountMinor));

  let paidSelfMinor = 0;
  let paidExternalMinor = 0;
  let totalPaidMinor = 0;

  if (bill.isPaused) {
    paidSelfMinor = 0;
    paidExternalMinor = 0;
    totalPaidMinor = 0;
  } else if (isExternalPaid) {
    paidSelfMinor = recordedPaidMinor;
    paidExternalMinor = Math.max(0, totalDueMinor - recordedPaidMinor);
    totalPaidMinor = sumMinor([paidSelfMinor, paidExternalMinor]);
  } else {
    paidSelfMinor = Math.min(totalDueMinor, recordedPaidMinor);
    paidExternalMinor = 0;
    totalPaidMinor = recordedPaidMinor;
  }

  const remainingMinor = bill.isPaused || isExternalPaid ? 0 : Math.max(0, totalDueMinor - totalPaidMinor);

  let status: BillStatus = 'upcoming';
  if (bill.isPaused) {
    status = 'paused';
  } else if (remainingMinor === 0 || isExternalPaid) {
    status = 'paid';
  } else if (today > computedDueDate) {
    status = 'overdue';
  } else {
    // 3-day reminder window
    const [y, m, d] = computedDueDate.split('-').map(Number);
    const dueDateObj = new Date(y, m - 1, d);
    const threeDaysBefore = new Date(dueDateObj.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (today >= threeDaysBefore) {
      status = 'due';
    } else {
      status = 'upcoming';
    }
  }

  const isOverdue = status === 'overdue';
  const isReminderDue = status === 'due' || status === 'overdue';

  return {
    bill,
    monthKey,
    expectedAmountMinor,
    carryInMinor,
    totalDueMinor,
    totalPaidMinor,
    paidSelfMinor,
    paidExternalMinor,
    remainingMinor,
    status,
    computedDueDate,
    isReminderDue,
    isOverdue,
  };
}

/** Computes entire month summary and safe-to-spend */
export function computeMonthSummary(
  monthKey: string,
  userId: string,
  bills: CycleBill[],
  payments: CyclePayment[],
  incomes: CycleIncome[],
  months: CycleMonth[],
  previousMonthSummary?: MonthSummary | null,
  today: DateStr = new Date().toISOString().slice(0, 10) as DateStr,
  overrides: CycleBillOverride[] = [],
): MonthSummary {
  // Only this user's records
  const userBills = bills.filter((b) => b.userId === userId);
  const userPayments = payments.filter((p) => p.userId === userId);
  const userIncomes = incomes.filter((i) => i.userId === userId && i.monthKey === monthKey);
  const monthRecord = months.find((m) => m.userId === userId && m.monthKey === monthKey);
  const isClosed = monthRecord?.isClosed ?? false;

  const prevMonthKey = getPreviousMonthKey(monthKey);

  let totalExpectedBillsMinor = 0;
  let totalCarryInMinor = 0;
  let totalDueBillsMinor = 0;
  let totalPaidBillsMinor = 0;
  let totalPaidSelfMinor = 0;
  let totalPaidExternalMinor = 0;
  let totalRemainingBillsMinor = 0;
  let activeBillsCount = 0;
  let paidBillsCount = 0;
  let overdueBillsCount = 0;

  for (const bill of userBills) {
    const prevState = computeBillMonthState(bill, prevMonthKey, userPayments, null, today, overrides);
    const state = computeBillMonthState(bill, monthKey, userPayments, prevState, today, overrides);

    if (state.status !== 'completed') {
      activeBillsCount++;
      totalExpectedBillsMinor = sumMinor([totalExpectedBillsMinor, state.expectedAmountMinor]);
      totalCarryInMinor = sumMinor([totalCarryInMinor, state.carryInMinor]);
      totalDueBillsMinor = sumMinor([totalDueBillsMinor, state.totalDueMinor]);
      totalPaidBillsMinor = sumMinor([totalPaidBillsMinor, state.totalPaidMinor]);
      totalPaidSelfMinor = sumMinor([totalPaidSelfMinor, state.paidSelfMinor]);
      totalPaidExternalMinor = sumMinor([totalPaidExternalMinor, state.paidExternalMinor]);
      totalRemainingBillsMinor = sumMinor([totalRemainingBillsMinor, state.remainingMinor]);

      if (state.status === 'paid') paidBillsCount++;
      if (state.status === 'overdue') overdueBillsCount++;
    }
  }

  const totalIncomeMinor = sumMinor(userIncomes.map((inc) => inc.amountMinor));

  // Available cash after bills paid by self so far this month (income - paidSelfThisMonth)
  const availableCashMinor = sumMinor([totalIncomeMinor, -totalPaidSelfMinor]);

  // Safe-to-spend: Total income minus total monthly liabilities (expected + carry-in)
  // i.e. availableCashMinor - totalRemainingBillsMinor - totalPaidExternalMinor = income - totalDueBillsMinor
  const safeToSpendMinor = sumMinor([totalIncomeMinor, -totalDueBillsMinor]);

  return {
    monthKey,
    isClosed,
    totalExpectedBillsMinor,
    totalCarryInMinor,
    totalDueBillsMinor,
    totalPaidBillsMinor,
    totalPaidSelfMinor,
    totalPaidExternalMinor,
    totalRemainingBillsMinor,
    availableCashMinor,
    totalIncomeMinor,
    safeToSpendMinor,
    activeBillsCount,
    paidBillsCount,
    overdueBillsCount,
  };
}

export type BillFilterType = 'All' | 'Unpaid' | 'Paid' | 'Overdue' | 'Carried';

export interface GroupMonthSummary {
  group: CycleGroup | null;
  groupId: string | null;
  groupName: string;
  sortOrder: number;
  billStates: BillMonthState[];
  totalExpectedMinor: Minor;
  totalCarryInMinor: Minor;
  totalDueMinor: Minor;
  totalPaidMinor: Minor;
  totalPaidSelfMinor: Minor;
  totalPaidExternalMinor: Minor;
  totalRemainingMinor: Minor;
  activeBillsCount: number;
  paidBillsCount: number;
  overdueBillsCount: number;
}

export interface GroupedMonthSheet {
  monthKey: string;
  isClosed: boolean;
  groups: GroupMonthSummary[];
  monthTotal: {
    totalExpectedMinor: Minor;
    totalCarryInMinor: Minor;
    totalDueMinor: Minor;
    totalPaidMinor: Minor;
    totalPaidSelfMinor: Minor;
    totalPaidExternalMinor: Minor;
    totalRemainingMinor: Minor;
    carryOutMinor: Minor;
    activeBillsCount: number;
    paidBillsCount: number;
    overdueBillsCount: number;
  };
}

export function filterBillStates(states: BillMonthState[], filter: BillFilterType): BillMonthState[] {
  if (filter === 'All') return states;
  if (filter === 'Unpaid') return states.filter((s) => s.status !== 'completed' && s.status !== 'paid' && s.remainingMinor > 0);
  if (filter === 'Paid') return states.filter((s) => s.status === 'paid' || (s.status !== 'completed' && s.remainingMinor === 0));
  if (filter === 'Overdue') return states.filter((s) => s.status === 'overdue' || (s.isOverdue && s.remainingMinor > 0));
  if (filter === 'Carried') return states.filter((s) => s.carryInMinor > 0);
  return states;
}

/**
 * Bills for one month, grouped. Groups follow sortOrder, with "No group" last. The month total
 * is the sum of the group subtotals, so the two can't disagree.
 */
export function computeGroupedMonthSheet(
  monthKey: string,
  userId: string,
  bills: CycleBill[],
  groups: CycleGroup[],
  payments: CyclePayment[],
  months: CycleMonth[],
  today: DateStr = new Date().toISOString().slice(0, 10) as DateStr,
  overrides: CycleBillOverride[] = [],
): GroupedMonthSheet {
  const userBills = backfillBillGroupIds(bills.filter((b) => b.userId === userId), groups);
  const userGroups = groups.filter((g) => g.userId === userId).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const userPayments = payments.filter((p) => p.userId === userId);
  const monthRecord = months.find((m) => m.userId === userId && m.monthKey === monthKey);
  const isClosed = monthRecord?.isClosed ?? false;
  const prevMonthKey = getPreviousMonthKey(monthKey);

  // Compute BillMonthState for each bill
  const statesByBillId = new Map<string, BillMonthState>();
  for (const bill of userBills) {
    const prevState = computeBillMonthState(bill, prevMonthKey, userPayments, null, today, overrides);
    const currState = computeBillMonthState(bill, monthKey, userPayments, prevState, today, overrides);
    statesByBillId.set(bill.id, currState);
  }

  const groupSummaries: GroupMonthSummary[] = [];

  // 1. Defined custom groups in sortOrder
  for (const g of userGroups) {
    const matchingBills = userBills.filter(
      (b) => b.groupId === g.id || (!b.groupId && b.group && b.group.trim().toLowerCase() === g.name.toLowerCase())
    );
    const billStates = matchingBills.map((b) => statesByBillId.get(b.id)!).filter(Boolean);

    let totalExpectedMinor = 0;
    let totalCarryInMinor = 0;
    let totalDueMinor = 0;
    let totalPaidMinor = 0;
    let totalPaidSelfMinor = 0;
    let totalPaidExternalMinor = 0;
    let totalRemainingMinor = 0;
    let activeBillsCount = 0;
    let paidBillsCount = 0;
    let overdueBillsCount = 0;

    for (const st of billStates) {
      if (st.status !== 'completed') {
        activeBillsCount++;
        totalExpectedMinor = sumMinor([totalExpectedMinor, st.expectedAmountMinor]);
        totalCarryInMinor = sumMinor([totalCarryInMinor, st.carryInMinor]);
        totalDueMinor = sumMinor([totalDueMinor, st.totalDueMinor]);
        totalPaidMinor = sumMinor([totalPaidMinor, st.totalPaidMinor]);
        totalPaidSelfMinor = sumMinor([totalPaidSelfMinor, st.paidSelfMinor]);
        totalPaidExternalMinor = sumMinor([totalPaidExternalMinor, st.paidExternalMinor]);
        totalRemainingMinor = sumMinor([totalRemainingMinor, st.remainingMinor]);
        if (st.status === 'paid') paidBillsCount++;
        if (st.status === 'overdue') overdueBillsCount++;
      }
    }

    groupSummaries.push({
      group: g,
      groupId: g.id,
      groupName: g.name,
      sortOrder: g.sortOrder,
      billStates,
      totalExpectedMinor,
      totalCarryInMinor,
      totalDueMinor,
      totalPaidMinor,
      totalPaidSelfMinor,
      totalPaidExternalMinor,
      totalRemainingMinor,
      activeBillsCount,
      paidBillsCount,
      overdueBillsCount,
    });
  }

  // 2. 'No group' placed at the very end
  const groupIdsSet = new Set(userGroups.map((g) => g.id));
  const groupNamesSet = new Set(userGroups.map((g) => g.name.toLowerCase()));
  const noGroupBills = userBills.filter((b) => {
    if (b.groupId && groupIdsSet.has(b.groupId)) return false;
    if (b.group && groupNamesSet.has(b.group.trim().toLowerCase())) return false;
    return true;
  });

  const noGroupBillStates = noGroupBills.map((b) => statesByBillId.get(b.id)!).filter(Boolean);
  let ngExpected = 0;
  let ngCarryIn = 0;
  let ngDue = 0;
  let ngPaid = 0;
  let ngPaidSelf = 0;
  let ngPaidExternal = 0;
  let ngRemaining = 0;
  let ngActive = 0;
  let ngPaidCount = 0;
  let ngOverdueCount = 0;

  for (const st of noGroupBillStates) {
    if (st.status !== 'completed') {
      ngActive++;
      ngExpected = sumMinor([ngExpected, st.expectedAmountMinor]);
      ngCarryIn = sumMinor([ngCarryIn, st.carryInMinor]);
      ngDue = sumMinor([ngDue, st.totalDueMinor]);
      ngPaid = sumMinor([ngPaid, st.totalPaidMinor]);
      ngPaidSelf = sumMinor([ngPaidSelf, st.paidSelfMinor]);
      ngPaidExternal = sumMinor([ngPaidExternal, st.paidExternalMinor]);
      ngRemaining = sumMinor([ngRemaining, st.remainingMinor]);
      if (st.status === 'paid') ngPaidCount++;
      if (st.status === 'overdue') ngOverdueCount++;
    }
  }

  groupSummaries.push({
    group: null,
    groupId: null,
    groupName: 'No group',
    sortOrder: userGroups.length,
    billStates: noGroupBillStates,
    totalExpectedMinor: ngExpected,
    totalCarryInMinor: ngCarryIn,
    totalDueMinor: ngDue,
    totalPaidMinor: ngPaid,
    totalPaidSelfMinor: ngPaidSelf,
    totalPaidExternalMinor: ngPaidExternal,
    totalRemainingMinor: ngRemaining,
    activeBillsCount: ngActive,
    paidBillsCount: ngPaidCount,
    overdueBillsCount: ngOverdueCount,
  });

  // 3. Month total reduction directly from group subtotals
  const monthTotal = {
    totalExpectedMinor: 0,
    totalCarryInMinor: 0,
    totalDueMinor: 0,
    totalPaidMinor: 0,
    totalPaidSelfMinor: 0,
    totalPaidExternalMinor: 0,
    totalRemainingMinor: 0,
    carryOutMinor: 0,
    activeBillsCount: 0,
    paidBillsCount: 0,
    overdueBillsCount: 0,
  };

  for (const gs of groupSummaries) {
    monthTotal.totalExpectedMinor = sumMinor([monthTotal.totalExpectedMinor, gs.totalExpectedMinor]);
    monthTotal.totalCarryInMinor = sumMinor([monthTotal.totalCarryInMinor, gs.totalCarryInMinor]);
    monthTotal.totalDueMinor = sumMinor([monthTotal.totalDueMinor, gs.totalDueMinor]);
    monthTotal.totalPaidMinor = sumMinor([monthTotal.totalPaidMinor, gs.totalPaidMinor]);
    monthTotal.totalPaidSelfMinor = sumMinor([monthTotal.totalPaidSelfMinor, gs.totalPaidSelfMinor]);
    monthTotal.totalPaidExternalMinor = sumMinor([monthTotal.totalPaidExternalMinor, gs.totalPaidExternalMinor]);
    monthTotal.totalRemainingMinor = sumMinor([monthTotal.totalRemainingMinor, gs.totalRemainingMinor]);
    monthTotal.activeBillsCount += gs.activeBillsCount;
    monthTotal.paidBillsCount += gs.paidBillsCount;
    monthTotal.overdueBillsCount += gs.overdueBillsCount;
  }
  monthTotal.carryOutMinor = monthTotal.totalRemainingMinor;

  return {
    monthKey,
    isClosed,
    groups: groupSummaries,
    monthTotal,
  };
}
