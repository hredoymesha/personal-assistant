import { isValidDateStr, isValidTimeStr } from './dates';
import { isSupportedCurrency, sumMinor } from './money';
import {
  validateCycleGroup,
  validateCycleBill,
  validateCycleBillOverride,
  validateCyclePayment,
  validateCycleIncome,
  validateCycleMonth,
  validateCycleMonthLockEvent,
  backfillBillGroupIds,
} from './cycle';
import type {
  AppData, Debt, Expense, Goal, MessAllocationMode, MessExpense, MessGroup, MessMeal,
  MessMember, Priority, Recurrence, Settings, SyncedContact, Task, Wallet, WalletEntry,
  WalletTransfer,
  ReceiptAttachment, ReceiptRecordType,
} from './types';
import { SCHEMA_VERSION } from './types';
import { walletBalance } from './wallets';
import { validateDailyExpenseEntry, validateDailyExpenseField, validateDailyExpenseSheet } from './expenseSheet';
import { validateTrashRecord } from './trash';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const money = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const PRIORITIES: Priority[] = ['low', 'medium', 'high'];
const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly'];
const RECEIPT_RECORD_TYPES: ReceiptRecordType[] = [
  'expense', 'debt', 'wallet', 'wallet_entry', 'wallet_transfer', 'mess_expense',
  'daily_expense', 'cycle_bill', 'cycle_payment', 'cycle_income',
];

export function validateReceiptAttachment(v: unknown): Result<ReceiptAttachment> {
  if (!isObj(v)) return fail('Receipt attachment must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Receipt attachment id is invalid');
  if (!RECEIPT_RECORD_TYPES.includes(v.recordType as ReceiptRecordType)) return fail('Receipt record type is invalid');
  if (!str(v.recordId, 64) || !v.recordId) return fail('Receipt record id is invalid');
  if (!str(v.fileName, 240) || typeof v.fileName !== 'string' || !v.fileName.trim()) return fail('Receipt file name is invalid');
  if (!str(v.mimeType, 120) || typeof v.mimeType !== 'string' || !v.mimeType.trim()) return fail('Receipt MIME type is invalid');
  if (!Number.isSafeInteger(v.sizeBytes) || (v.sizeBytes as number) <= 0 || (v.sizeBytes as number) > 10 * 1024 * 1024) return fail('Receipt file size is invalid');
  if (!str(v.dataBase64, Math.ceil(10 * 1024 * 1024 * 4 / 3) + 32) || !v.dataBase64) return fail('Receipt data is invalid');
  if (!str(v.createdAt, 64) || !v.createdAt) return fail('Receipt creation time is invalid');
  return ok(v as unknown as ReceiptAttachment);
}

export function validateTask(v: unknown): Result<Task> {
  if (!isObj(v)) return fail('Task must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Task id is invalid');
  if (!str(v.title, 200) || !(v.title as string).trim()) return fail('Task title is required (max 200 characters)');
  if (!str(v.notes, 2000)) return fail('Task notes are too long');
  if (v.dueDate !== null && !isValidDateStr(v.dueDate)) return fail('Task due date is invalid');
  if (v.dueTime !== null && !isValidTimeStr(v.dueTime)) return fail('Task due time is invalid');
  if (!PRIORITIES.includes(v.priority as Priority)) return fail('Task priority is invalid');
  if (!str(v.category, 40)) return fail('Task category is invalid');
  if (!RECURRENCES.includes(v.recurrence as Recurrence)) return fail('Task recurrence is invalid');
  if (typeof v.done !== 'boolean' || typeof v.sample !== 'boolean') return fail('Task flags are invalid');
  if (v.deletedAt !== null && typeof v.deletedAt !== 'string') return fail('Task deletedAt is invalid');
  if (v.originalText !== null && !str(v.originalText, 2000)) return fail('Task originalText is invalid');
  if (typeof v.createdAt !== 'string') return fail('Task createdAt is invalid');
  return ok(v as unknown as Task);
}

export function validateExpense(v: unknown): Result<Expense> {
  if (!isObj(v)) return fail('Expense must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Expense id is invalid');
  if (!money(v.amountMinor) || v.amountMinor === 0) return fail('Expense amount must be greater than zero');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Expense currency is invalid');
  if (!str(v.category, 40) || !v.category) return fail('Expense category is required');
  if (!str(v.note, 500)) return fail('Expense note is too long');
  if (!isValidDateStr(v.date)) return fail('Expense date is invalid');
  if (v.walletId !== undefined && v.walletId !== null && (!str(v.walletId, 64) || !v.walletId)) return fail('Expense wallet is invalid');
  if (v.originalText !== null && !str(v.originalText, 2000)) return fail('Expense originalText is invalid');
  if (typeof v.sample !== 'boolean') return fail('Expense flags are invalid');
  return ok({ ...v, walletId: v.walletId ?? null } as unknown as Expense);
}

export function validateGoal(v: unknown): Result<Goal> {
  if (!isObj(v)) return fail('Goal must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Goal id is invalid');
  if (!str(v.name, 100) || !(v.name as string).trim()) return fail('Goal name is required');
  if (!money(v.targetMinor) || v.targetMinor === 0) return fail('Goal target must be greater than zero');
  if (!money(v.savedMinor)) return fail('Goal saved amount is invalid');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Goal currency is invalid');
  if (typeof v.sample !== 'boolean') return fail('Goal flags are invalid');
  return ok(v as unknown as Goal);
}

export function validateDebt(v: unknown): Result<Debt> {
  if (!isObj(v)) return fail('Debt must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Debt id is invalid');
  if (!str(v.person, 100) || !(v.person as string).trim()) return fail('Person name is required');
  if (v.direction !== 'owed_to_me' && v.direction !== 'i_owe') return fail('Debt direction is invalid');
  if (!money(v.amountMinor) || v.amountMinor === 0) return fail('Debt amount must be greater than zero');
  if (!money(v.paidMinor) || v.paidMinor > v.amountMinor) return fail('Debt paid amount is invalid');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Debt currency is invalid');
  if (v.dueDate !== null && !isValidDateStr(v.dueDate)) return fail('Debt due date is invalid');
  if (v.createdAt !== null && (typeof v.createdAt !== 'string' || !str(v.createdAt, 64)
    || !Number.isFinite(Date.parse(v.createdAt))
    || new Date(v.createdAt).toISOString() !== v.createdAt)) return fail('Debt creation time is invalid');
  if (typeof v.sample !== 'boolean') return fail('Debt flags are invalid');
  return ok(v as unknown as Debt);
}

export function validateWallet(v: unknown): Result<Wallet> {
  if (!isObj(v)) return fail('Wallet must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Wallet id is invalid');
  if (!str(v.name, 80) || !(v.name as string).trim()) return fail('Wallet name is required');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Wallet currency is invalid');
  if (!money(v.openingBalanceMinor)) return fail('Wallet opening balance is invalid');
  if (!str(v.createdAt, 64) || !v.createdAt) return fail('Wallet creation time is invalid');
  return ok(v as unknown as Wallet);
}

export function validateWalletEntry(v: unknown): Result<WalletEntry> {
  if (!isObj(v)) return fail('Wallet entry must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Wallet entry id is invalid');
  if (!str(v.walletId, 64) || !v.walletId) return fail('Wallet entry wallet is invalid');
  if (v.direction !== 'in' && v.direction !== 'out') return fail('Wallet entry direction is invalid');
  if (!money(v.amountMinor) || v.amountMinor === 0) return fail('Wallet entry amount must be greater than zero');
  if (!isValidDateStr(v.date)) return fail('Wallet entry date is invalid');
  if (!str(v.note, 500)) return fail('Wallet entry note is too long');
  return ok(v as unknown as WalletEntry);
}

export function validateWalletTransfer(v: unknown): Result<WalletTransfer> {
  if (!isObj(v)) return fail('Wallet transfer must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Wallet transfer id is invalid');
  if (!str(v.fromWalletId, 64) || !v.fromWalletId) return fail('Transfer source wallet is invalid');
  if (!str(v.toWalletId, 64) || !v.toWalletId) return fail('Transfer destination wallet is invalid');
  if (v.fromWalletId === v.toWalletId) return fail('Transfer wallets must be different');
  if (!money(v.amountMinor) || v.amountMinor === 0) return fail('Transfer amount must be greater than zero');
  if (!isValidDateStr(v.date)) return fail('Wallet transfer date is invalid');
  if (!str(v.note, 500)) return fail('Wallet transfer note is too long');
  return ok(v as unknown as WalletTransfer);
}

export function validateSyncedContact(v: unknown): Result<SyncedContact> {
  if (!isObj(v)) return fail('Synced contact must be an object');
  if (!str(v.id, 256) || !v.id) return fail('Contact id is invalid');
  if (!str(v.fullName, 200)) return fail('Contact name is invalid');
  if (!Array.isArray(v.phones) || v.phones.length > 100 || !v.phones.every((phone) => str(phone, 200))) return fail('Contact phone list is invalid');
  if (!Array.isArray(v.emails) || v.emails.length > 100 || !v.emails.every((email) => str(email, 320))) return fail('Contact email list is invalid');
  if (v.photoUri !== null && !str(v.photoUri, 2048)) return fail('Contact photo URI is invalid');
  if (!str(v.syncedAt, 64) || !v.syncedAt) return fail('Contact sync time is invalid');
  return ok(v as unknown as SyncedContact);
}

export function validateMessGroup(v: unknown): Result<MessGroup> {
  if (!isObj(v)) return fail('Mess group must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Mess group id is invalid');
  if (!str(v.name, 100) || !(v.name as string).trim()) return fail('Mess group name is required');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Mess group currency is invalid');
  if (!str(v.createdAt, 64) || !v.createdAt) return fail('Mess group creation time is invalid');
  return ok(v as unknown as MessGroup);
}

export function validateMessMember(v: unknown): Result<MessMember> {
  if (!isObj(v)) return fail('Mess member must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Mess member id is invalid');
  if (!str(v.groupId, 64) || !v.groupId) return fail('Mess member group is invalid');
  if (!str(v.name, 100) || !(v.name as string).trim()) return fail('Mess member name is required');
  if (v.contactId !== null && (!str(v.contactId, 256) || !v.contactId)) return fail('Mess member contact is invalid');
  if (typeof v.isSelf !== 'boolean') return fail('Mess member self flag is invalid');
  return ok(v as unknown as MessMember);
}

export function validateMessMeal(v: unknown): Result<MessMeal> {
  if (!isObj(v)) return fail('Mess meal record must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Mess meal id is invalid');
  if (!str(v.groupId, 64) || !v.groupId) return fail('Mess meal group is invalid');
  if (!str(v.memberId, 64) || !v.memberId) return fail('Mess meal member is invalid');
  if (!isValidDateStr(v.date)) return fail('Mess meal date is invalid');
  if (!Number.isSafeInteger(v.halfMealUnits) || (v.halfMealUnits as number) <= 0) return fail('Mess meal count must be a positive whole or half meal');
  return ok(v as unknown as MessMeal);
}

const MESS_ALLOCATION_MODES: MessAllocationMode[] = ['meals', 'equal', 'custom'];

export function validateMessExpense(v: unknown): Result<MessExpense> {
  if (!isObj(v)) return fail('Mess expense must be an object');
  if (!str(v.id, 64) || !v.id) return fail('Mess expense id is invalid');
  if (!str(v.groupId, 64) || !v.groupId) return fail('Mess expense group is invalid');
  if (!money(v.amountMinor) || v.amountMinor === 0) return fail('Mess expense amount must be greater than zero');
  if (!isValidDateStr(v.date)) return fail('Mess expense date is invalid');
  if (!str(v.category, 40) || !v.category) return fail('Mess expense category is required');
  if (!str(v.note, 500)) return fail('Mess expense note is too long');
  if (!str(v.payerMemberId, 64) || !v.payerMemberId) return fail('Mess expense payer is invalid');
  if (v.walletId !== null && (!str(v.walletId, 64) || !v.walletId)) return fail('Mess expense wallet is invalid');
  if (!MESS_ALLOCATION_MODES.includes(v.allocationMode as MessAllocationMode)) return fail('Mess expense allocation mode is invalid');
  if (!Array.isArray(v.allocations) || v.allocations.length === 0) return fail('Mess expense allocations are required');
  const allocationIds = new Set<string>();
  const allocationAmounts: number[] = [];
  for (const allocation of v.allocations) {
    if (!isObj(allocation) || typeof allocation.memberId !== 'string' || !str(allocation.memberId, 64) || !allocation.memberId || allocationIds.has(allocation.memberId)) {
      return fail('Mess expense allocation member is invalid');
    }
    if (!money(allocation.amountMinor)) return fail('Mess expense allocation amount is invalid');
    allocationIds.add(allocation.memberId);
    allocationAmounts.push(allocation.amountMinor);
  }
  try {
    if (sumMinor(allocationAmounts) !== v.amountMinor) return fail('Mess expense allocations do not match its amount');
  } catch {
    return fail('Mess expense allocation total exceeds safe range');
  }
  if (v.allocationMode === 'meals') {
    if (!isValidDateStr(v.mealRangeStart) || !isValidDateStr(v.mealRangeEnd) || v.mealRangeStart > v.mealRangeEnd) {
      return fail('Mess meal allocation range is invalid');
    }
  } else if (v.mealRangeStart !== null || v.mealRangeEnd !== null) {
    return fail('Only meal-based allocation may have a meal date range');
  }
  return ok(v as unknown as MessExpense);
}

export function validateSettings(v: unknown): Result<Settings> {
  if (!isObj(v)) return fail('Settings must be an object');
  if (typeof v.currency !== 'string' || !isSupportedCurrency(v.currency)) return fail('Currency is not supported');
  if (!['system', 'light', 'dark'].includes(v.theme as string)) return fail('Theme is invalid');
  if (!['en', 'bn'].includes(v.language as string)) return fail('Language is invalid');
  return ok(v as unknown as Settings);
}

function validateList<T>(name: string, list: unknown, fn: (v: unknown) => Result<T>): Result<T[]> {
  if (!Array.isArray(list)) return fail(`${name} must be a list`);
  const out: T[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const r = fn(list[i]);
    if (!r.ok) return fail(`${name}[${i}]: ${r.error}`);
    const id = (r.value as { id: string }).id;
    if (ids.has(id)) return fail(`${name}[${i}]: duplicate id`);
    ids.add(id);
    out.push(r.value);
  }
  return ok(out);
}

/** Validates a full, already-migrated dataset. Used on load and on import. */
export function validateAppData(v: unknown): Result<AppData> {
  if (!isObj(v)) return fail('Data must be an object');
  if (v.schemaVersion !== SCHEMA_VERSION) return fail('Unexpected schema version');
  const settings = validateSettings(v.settings);
  if (!settings.ok) return settings;
  const tasks = validateList('tasks', v.tasks, validateTask);
  if (!tasks.ok) return tasks;
  const expenses = validateList('expenses', v.expenses, validateExpense);
  if (!expenses.ok) return expenses;
  const goals = validateList('goals', v.goals, validateGoal);
  if (!goals.ok) return goals;
  const debts = validateList('debts', v.debts, validateDebt);
  if (!debts.ok) return debts;
  const wallets = validateList('wallets', v.wallets, validateWallet);
  if (!wallets.ok) return wallets;
  const walletEntries = validateList('walletEntries', v.walletEntries, validateWalletEntry);
  if (!walletEntries.ok) return walletEntries;
  const walletTransfers = validateList('walletTransfers', v.walletTransfers, validateWalletTransfer);
  if (!walletTransfers.ok) return walletTransfers;
  const syncedContacts = validateList('syncedContacts', v.syncedContacts, validateSyncedContact);
  if (!syncedContacts.ok) return syncedContacts;
  const messGroups = validateList('messGroups', v.messGroups, validateMessGroup);
  if (!messGroups.ok) return messGroups;
  const messMembers = validateList('messMembers', v.messMembers, validateMessMember);
  if (!messMembers.ok) return messMembers;
  const messMeals = validateList('messMeals', v.messMeals, validateMessMeal);
  if (!messMeals.ok) return messMeals;
  const messExpenses = validateList('messExpenses', v.messExpenses, validateMessExpense);
  if (!messExpenses.ok) return messExpenses;
  const dailyExpenseFields = v.dailyExpenseFields !== undefined ? validateList('dailyExpenseFields', v.dailyExpenseFields, validateDailyExpenseField) : ok([]);
  if (!dailyExpenseFields.ok) return dailyExpenseFields;
  const dailyExpenseSheets = v.dailyExpenseSheets !== undefined ? validateList('dailyExpenseSheets', v.dailyExpenseSheets, validateDailyExpenseSheet) : ok([]);
  if (!dailyExpenseSheets.ok) return dailyExpenseSheets;
  const dailyExpenseEntries = v.dailyExpenseEntries !== undefined
    ? validateList('dailyExpenseEntries', v.dailyExpenseEntries, (value) => validateDailyExpenseEntry(value, { fields: dailyExpenseFields.value }))
    : ok([]);
  if (!dailyExpenseEntries.ok) return dailyExpenseEntries;
  const trash = v.trash !== undefined ? validateList('trash', v.trash, validateTrashRecord) : ok([]);
  if (!trash.ok) return trash;
  const cycleGroups = v.cycleGroups !== undefined ? validateList('cycleGroups', v.cycleGroups, validateCycleGroup) : ok([]);
  if (!cycleGroups.ok) return cycleGroups;
  const cycleBills = v.cycleBills !== undefined ? validateList('cycleBills', v.cycleBills, validateCycleBill) : ok([]);
  if (!cycleBills.ok) return cycleBills;
  const cycleBillOverrides = v.cycleBillOverrides !== undefined
    ? validateList('cycleBillOverrides', v.cycleBillOverrides, validateCycleBillOverride)
    : ok([]);
  if (!cycleBillOverrides.ok) return cycleBillOverrides;
  const cycleIncomes = v.cycleIncomes !== undefined ? validateList('cycleIncomes', v.cycleIncomes, validateCycleIncome) : ok([]);
  if (!cycleIncomes.ok) return cycleIncomes;
  const cyclePayments = v.cyclePayments !== undefined ? validateList('cyclePayments', v.cyclePayments, validateCyclePayment) : ok([]);
  if (!cyclePayments.ok) return cyclePayments;
  const cycleMonths = v.cycleMonths !== undefined ? validateList('cycleMonths', v.cycleMonths, validateCycleMonth) : ok([]);
  if (!cycleMonths.ok) return cycleMonths;
  const cycleMonthLockEvents = v.cycleMonthLockEvents !== undefined
    ? validateList('cycleMonthLockEvents', v.cycleMonthLockEvents, validateCycleMonthLockEvent)
    : ok([]);
  if (!cycleMonthLockEvents.ok) return cycleMonthLockEvents;
  const receiptAttachments = v.receiptAttachments !== undefined
    ? validateList('receiptAttachments', v.receiptAttachments, validateReceiptAttachment)
    : ok([]);
  if (!receiptAttachments.ok) return receiptAttachments;

  const walletById = new Map(wallets.value.map((wallet) => [wallet.id, wallet]));
  const cycleBillById = new Map(cycleBills.value.map((bill) => [bill.id, bill]));
  for (const override of cycleBillOverrides.value) {
    const bill = cycleBillById.get(override.billId);
    if (!bill) return fail(`Cycle bill override ${override.id} refers to a missing bill`);
    if (bill.userId !== override.userId) return fail(`Cycle bill override ${override.id} crosses users`);
  }
  for (const entry of walletEntries.value) {
    if (!walletById.has(entry.walletId)) return fail(`Wallet entry ${entry.id} refers to a missing wallet`);
  }
  for (const transfer of walletTransfers.value) {
    const from = walletById.get(transfer.fromWalletId);
    const to = walletById.get(transfer.toWalletId);
    if (!from || !to) return fail(`Wallet transfer ${transfer.id} refers to a missing wallet`);
    if (from.currency !== to.currency) return fail(`Wallet transfer ${transfer.id} mixes currencies`);
  }
  for (const expense of expenses.value) {
    if (!expense.walletId) continue;
    const wallet = walletById.get(expense.walletId);
    if (!wallet) return fail(`Expense ${expense.id} refers to a missing wallet`);
    if (wallet.currency !== expense.currency) return fail(`Expense ${expense.id} currency does not match its wallet`);
  }

  for (const bill of cycleBills.value) {
    if (bill.linkedDebtId) {
      const debt = debts.value.find((item) => item.id === bill.linkedDebtId);
      if (!debt) return fail(`Cycle bill ${bill.id} refers to a missing linked debt`);
      if (debt.currency !== bill.currency) return fail(`Cycle bill ${bill.id} currency does not match its linked debt`);
    }
  }
  for (const payment of cyclePayments.value) {
    const bill = cycleBillById.get(payment.billId);
    if (!bill) return fail(`Cycle payment ${payment.id} refers to a missing bill`);
    if (payment.userId !== bill.userId) return fail(`Cycle payment ${payment.id} user does not match its bill`);
    if (payment.currency !== bill.currency) return fail(`Cycle payment ${payment.id} currency does not match its bill`);
  }
  for (const income of cycleIncomes.value) {
    if (!isSupportedCurrency(income.currency)) return fail(`Cycle income ${income.id} currency is not supported`);
  }

  const groupById = new Map(messGroups.value.map((group) => [group.id, group]));
  const memberById = new Map(messMembers.value.map((member) => [member.id, member]));
  for (const member of messMembers.value) {
    if (!groupById.has(member.groupId)) return fail(`Mess member ${member.id} refers to a missing group`);
  }
  for (const group of messGroups.value) {
    const groupMembers = messMembers.value.filter((member) => member.groupId === group.id);
    if (groupMembers.length === 0 || groupMembers.filter((member) => member.isSelf).length !== 1) {
      return fail(`Mess group ${group.id} must have exactly one self member`);
    }
  }
  for (const meal of messMeals.value) {
    const member = memberById.get(meal.memberId);
    if (!member || member.groupId !== meal.groupId) return fail(`Mess meal ${meal.id} has a member from another group`);
  }
  for (const expense of messExpenses.value) {
    const group = groupById.get(expense.groupId);
    const payer = memberById.get(expense.payerMemberId);
    if (!group || !payer || payer.groupId !== expense.groupId) return fail(`Mess expense ${expense.id} has an invalid group or payer`);
    if (expense.walletId) {
      const wallet = walletById.get(expense.walletId);
      if (!payer.isSelf || !wallet || wallet.currency !== group.currency) return fail(`Mess expense ${expense.id} has an invalid wallet`);
    } else if (payer.isSelf) {
      return fail(`Mess expense ${expense.id} paid by self requires a wallet`);
    }
    if (expense.allocations.some((allocation) => memberById.get(allocation.memberId)?.groupId !== expense.groupId)) {
      return fail(`Mess expense ${expense.id} has an allocation for another group`);
    }
  }

  const normalized: AppData = {
    schemaVersion: SCHEMA_VERSION,
    settings: settings.value,
    tasks: tasks.value,
    expenses: expenses.value,
    goals: goals.value,
    debts: debts.value,
    wallets: wallets.value,
    walletEntries: walletEntries.value,
    walletTransfers: walletTransfers.value,
    syncedContacts: syncedContacts.value,
    messGroups: messGroups.value,
    messMembers: messMembers.value,
    messMeals: messMeals.value,
    messExpenses: messExpenses.value,
    dailyExpenseSheets: dailyExpenseSheets.value,
    dailyExpenseEntries: dailyExpenseEntries.value,
    dailyExpenseFields: dailyExpenseFields.value,
    trash: trash.value,
    receiptAttachments: receiptAttachments.value,
    cycleGroups: cycleGroups.value,
    cycleBills: backfillBillGroupIds(cycleBills.value, cycleGroups.value),
    cycleBillOverrides: cycleBillOverrides.value,
    cycleMonthLockEvents: cycleMonthLockEvents.value,
    cycleIncomes: cycleIncomes.value,
    cyclePayments: cyclePayments.value,
    cycleMonths: cycleMonths.value,
  };
  try {
    for (const wallet of wallets.value) walletBalance(normalized, wallet.id);
  } catch (error) {
    return fail(error instanceof Error ? `Wallet balance is invalid: ${error.message}` : 'Wallet balance is invalid');
  }
  return ok({
    ...normalized,
  });
}
