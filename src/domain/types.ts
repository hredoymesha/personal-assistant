import type { DateStr } from './dates';
import type { Minor } from './money';
import type { CycleGroup, CycleBill, CycleBillOverride, CyclePayment, CycleIncome, CycleMonth, CycleMonthLockEvent, BillPaidBy, RepayStatus } from './cycle';
export type { CycleGroup, CycleBill, CycleBillOverride, CyclePayment, CycleIncome, CycleMonth, CycleMonthLockEvent, BillPaidBy, RepayStatus };

export const SCHEMA_VERSION = 10;

export type ReceiptRecordType =
  | 'expense' | 'debt' | 'wallet' | 'wallet_entry' | 'wallet_transfer' | 'mess_expense'
  | 'daily_expense' | 'cycle_bill' | 'cycle_payment' | 'cycle_income';

export interface ReceiptAttachment {
  id: string;
  recordType: ReceiptRecordType;
  recordId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  createdAt: string;
}

export type Priority = 'low' | 'medium' | 'high';
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';

export interface Task {
  id: string;
  title: string;
  notes: string;
  dueDate: DateStr | null;
  dueTime: string | null; // "HH:mm" local, only meaningful with dueDate
  priority: Priority;
  category: string;
  recurrence: Recurrence;
  done: boolean;
  /** Set when the task is deleted; kept so deletion can be undone. */
  deletedAt: string | null;
  /** The text the user typed/pasted, exactly as entered, if created from a command. */
  originalText: string | null;
  sample: boolean;
  createdAt: string;
}

export interface Expense {
  id: string;
  amountMinor: Minor;
  currency: string;
  category: string;
  note: string;
  date: DateStr;
  walletId: string | null;
  originalText: string | null;
  sample: boolean;
}

export interface Goal {
  id: string;
  name: string;
  targetMinor: Minor;
  savedMinor: Minor;
  currency: string;
  sample: boolean;
}

export type DebtDirection = 'owed_to_me' | 'i_owe';

export interface Debt {
  id: string;
  person: string;
  direction: DebtDirection;
  amountMinor: Minor;
  paidMinor: Minor;
  currency: string;
  dueDate: DateStr | null;
  createdAt: string | null;
  sample: boolean;
}

export interface Wallet {
  id: string;
  name: string;
  currency: string;
  openingBalanceMinor: Minor;
  createdAt: string;
  sample?: boolean;
}

export type WalletEntryDirection = 'in' | 'out';

export interface WalletEntry {
  id: string;
  walletId: string;
  direction: WalletEntryDirection;
  amountMinor: Minor;
  date: DateStr;
  note: string;
  sample?: boolean;
}

export interface WalletTransfer {
  id: string;
  fromWalletId: string;
  toWalletId: string;
  amountMinor: Minor;
  date: DateStr;
  note: string;
  sample?: boolean;
}

export interface SyncedContact {
  id: string;
  fullName: string;
  phones: string[];
  emails: string[];
  photoUri: string | null;
  syncedAt: string;
  sample?: boolean;
}

export interface MessGroup {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
  sample?: boolean;
}

export interface MessMember {
  id: string;
  groupId: string;
  name: string;
  contactId: string | null;
  isSelf: boolean;
  sample?: boolean;
}

export interface MessMeal {
  id: string;
  groupId: string;
  memberId: string;
  date: DateStr;
  halfMealUnits: number;
  sample?: boolean;
}

export type MessAllocationMode = 'meals' | 'equal' | 'custom';

export interface MessAllocation {
  memberId: string;
  amountMinor: Minor;
}

export interface MessExpense {
  id: string;
  groupId: string;
  amountMinor: Minor;
  date: DateStr;
  category: string;
  note: string;
  payerMemberId: string;
  walletId: string | null;
  allocationMode: MessAllocationMode;
  mealRangeStart: DateStr | null;
  mealRangeEnd: DateStr | null;
  allocations: MessAllocation[];
  sample?: boolean;
}

export type DailyExpenseFieldType = 'text' | 'number' | 'choice';

export interface DailyExpenseField {
  id: string;
  name: string;
  type: DailyExpenseFieldType;
  options: string[];
  required: boolean;
  sample?: boolean;
}

export interface DailyExpenseSheet {
  id: string;
  name: string;
  currency: string;
  fieldIds: string[];
  createdAt: string;
  sample?: boolean;
}

export interface DailyExpenseEntry {
  id: string;
  sheetId: string;
  date: DateStr;
  amountMinor: Minor;
  currency: string;
  category: string;
  note: string;
  customValues: Record<string, string>;
  sample?: boolean;
}

export interface Settings {
  currency: string;
  theme: 'system' | 'light' | 'dark';
  language: 'en' | 'bn';
}

export type TrashItemType =
  | 'task' | 'expense' | 'debt' | 'goal'
  | 'wallet' | 'wallet_entry' | 'wallet_transfer'
  | 'mess_group' | 'mess_member' | 'mess_meal' | 'mess_expense'
  | 'daily_expense_field' | 'daily_expense_sheet' | 'daily_expense'
  | 'cycle_group' | 'cycle_bill' | 'cycle_income' | 'cycle_payment';

export interface TrashRecord {
  id: string;
  itemType: TrashItemType;
  originalId: string;
  deletedAt: string;
  title: string;
  subtitle?: string;
  data: unknown;
}

export interface AppData {
  schemaVersion: number;
  settings: Settings;
  tasks: Task[];
  expenses: Expense[];
  goals: Goal[];
  debts: Debt[];
  wallets: Wallet[];
  walletEntries: WalletEntry[];
  walletTransfers: WalletTransfer[];
  syncedContacts: SyncedContact[];
  messGroups: MessGroup[];
  messMembers: MessMember[];
  messMeals: MessMeal[];
  messExpenses: MessExpense[];
  dailyExpenseSheets: DailyExpenseSheet[];
  dailyExpenseEntries: DailyExpenseEntry[];
  dailyExpenseFields: DailyExpenseField[];
  trash: TrashRecord[];
  cycleGroups?: CycleGroup[];
  cycleBills?: CycleBill[];
  cycleBillOverrides?: CycleBillOverride[];
  cycleMonthLockEvents?: CycleMonthLockEvent[];
  cycleIncomes?: CycleIncome[];
  cyclePayments?: CyclePayment[];
  cycleMonths?: CycleMonth[];
  receiptAttachments: ReceiptAttachment[];
}

export const EXPENSE_CATEGORIES = [
  'Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Education', 'Family', 'Other',
] as const;

export const TASK_CATEGORIES = ['Personal', 'Work', 'Home', 'Study', 'Health', 'Other'] as const;

export function emptyData(): AppData {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { currency: 'BDT', theme: 'system', language: 'en' },
    tasks: [], expenses: [], goals: [], debts: [],
    wallets: [], walletEntries: [], walletTransfers: [], syncedContacts: [],
    messGroups: [], messMembers: [], messMeals: [], messExpenses: [],
    dailyExpenseSheets: [], dailyExpenseEntries: [], dailyExpenseFields: [],
    trash: [],
    cycleGroups: [], cycleBills: [], cycleBillOverrides: [], cycleMonthLockEvents: [], cycleIncomes: [], cyclePayments: [], cycleMonths: [],
    receiptAttachments: [],
  };
}
