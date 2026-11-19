import type {
  DailyExpenseEntry, Debt, Expense, Goal, Task, TrashItemType, TrashRecord,
  CycleBill, CycleGroup, CycleIncome, CyclePayment, MessExpense, MessGroup, MessMeal, MessMember,
  Wallet, WalletEntry, WalletTransfer, DailyExpenseField, DailyExpenseSheet,
} from './types';
import { newId } from './ids';

export type TrashValidationResult = { ok: true; value: TrashRecord } | { ok: false; error: string };

const ok = (value: TrashRecord): TrashValidationResult => ({ ok: true, value });
const fail = (error: string): TrashValidationResult => ({ ok: false, error });

export function validateTrashRecord(value: unknown): TrashValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Trash record must be an object');
  const v = value as Record<string, unknown>;

  if (typeof v.id !== 'string' || !v.id || v.id.length > 64) return fail('Trash record id is invalid');
  if (
    ![
      'task', 'expense', 'debt', 'goal', 'wallet', 'wallet_entry', 'wallet_transfer',
      'mess_group', 'mess_member', 'mess_meal', 'mess_expense',
      'daily_expense_field', 'daily_expense_sheet', 'daily_expense',
      'cycle_group', 'cycle_bill', 'cycle_income', 'cycle_payment',
    ].includes(v.itemType as string)
  ) {
    return fail('Trash record itemType is invalid');
  }
  if (typeof v.originalId !== 'string' || !v.originalId) return fail('Trash record originalId is invalid');
  if (typeof v.deletedAt !== 'string' || !v.deletedAt) return fail('Trash record deletedAt is invalid');
  if (typeof v.title !== 'string') return fail('Trash record title is invalid');
  if (v.subtitle !== undefined && typeof v.subtitle !== 'string') return fail('Trash record subtitle is invalid');
  if (!v.data || typeof v.data !== 'object' || Array.isArray(v.data)) return fail('Trash record data payload is invalid');

  return ok({
    id: v.id,
    itemType: v.itemType as TrashItemType,
    originalId: v.originalId,
    deletedAt: v.deletedAt,
    title: v.title.slice(0, 120),
    subtitle: v.subtitle ? String(v.subtitle).slice(0, 120) : undefined,
    data: v.data as Task | Expense | Debt | Goal | Wallet | WalletEntry | WalletTransfer
      | MessGroup | MessMember | MessMeal | MessExpense | DailyExpenseField | DailyExpenseSheet
      | DailyExpenseEntry | CycleGroup | CycleBill | CycleIncome | CyclePayment,
  });
}

export function createTrashRecord(
  itemType: TrashItemType,
  data: unknown,
  originalId: string,
  title: string,
  subtitle?: string,
  deletedAt = new Date().toISOString(),
): TrashRecord {
  return {
    id: newId(`trash_${itemType}`),
    itemType,
    originalId,
    deletedAt,
    title: title.slice(0, 120),
    ...(subtitle ? { subtitle: subtitle.slice(0, 120) } : {}),
    data,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysRemainingInTrash(deletedAt: string, now: Date = new Date(), retentionDays = 30): number {
  const deletedTime = new Date(deletedAt).getTime();
  if (Number.isNaN(deletedTime)) return 0;
  const elapsedMs = now.getTime() - deletedTime;
  const elapsedDays = Math.floor(elapsedMs / MS_PER_DAY);
  return Math.max(0, retentionDays - elapsedDays);
}

export function isTrashExpired(deletedAt: string, now: Date = new Date(), retentionDays = 30): boolean {
  return daysRemainingInTrash(deletedAt, now, retentionDays) === 0;
}

export function purgeExpiredTrash(trash: TrashRecord[], now: Date = new Date(), retentionDays = 30): TrashRecord[] {
  return trash.filter((item) => !isTrashExpired(item.deletedAt, now, retentionDays));
}
