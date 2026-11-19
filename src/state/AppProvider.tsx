import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toDateStr } from '../domain/dates';
import { newId } from '../domain/ids';
import { nextDueDate } from '../domain/recurrence';
import { applyDebtPayment } from '../domain/debts';
import { createTrashRecord, purgeExpiredTrash } from '../domain/trash';
import { sampleData } from '../domain/sample';
import { cleanOrphanedTempFiles } from '../services/files';
import { cleanOrphanedRestoreStaging } from '../services/restoreRollback';
import type {
  AppData, Debt, Expense, Goal, MessAllocation, MessExpense, MessGroup, MessMeal, MessMember,
  Settings, SyncedContact, Task, Wallet, WalletEntry, WalletTransfer, DailyExpenseEntry, DailyExpenseField, DailyExpenseSheet,
  ReceiptAttachment,
} from '../domain/types';
import { emptyData } from '../domain/types';
import { asyncStorageStore } from '../storage/asyncStorageStore';
import { Repository } from '../storage/repository';
import { retryStorageOperation, StorageCoordinator } from '../storage/coordinator';
import { validateAppData, validateDebt, validateExpense, validateTask, validateReceiptAttachment } from '../domain/validation';
import {
  CycleGroup,
  CycleBill,
  CycleBillOverride,
  CycleMonthLockEvent,
  CyclePayment,
  CycleIncome,
  CycleMonth,
  validateCycleGroup,
  validateCycleBill,
  validateCycleBillOverride,
  validateCycleMonthLockEvent,
  validateCyclePayment,
  validateCycleIncome,
} from '../domain/cycle';
import { guardedUpdate } from './guard';
import { applyUndo, createUndo } from './undo';
import { walletIsReferenced } from '../domain/wallets';
import { validateDailyExpenseEntry, validateDailyExpenseField, validateDailyExpenseSheet } from '../domain/expenseSheet';

export type NewTask = Pick<Task, 'title' | 'notes' | 'dueDate' | 'dueTime' | 'priority' | 'category' | 'recurrence'> & { originalText?: string | null };
export type NewExpense = Pick<Expense, 'amountMinor' | 'currency' | 'category' | 'note' | 'date'> & { originalText?: string | null; walletId?: string | null };
export type NewDailyExpenseField = Omit<DailyExpenseField, 'id'>;
export type NewDailyExpenseSheet = Omit<DailyExpenseSheet, 'id' | 'createdAt'>;
export type NewDailyExpenseEntry = Omit<DailyExpenseEntry, 'id'>;

interface Toast { message: string; undo?: () => void }

interface Ctx {
  status: 'loading' | 'ready';
  loadError: string | null;
  saveError: string | null;
  data: AppData;
  today: string;
  toast: Toast | null;
  dismissToast: () => void;
  /** Return an error message when the record fails domain validation (nothing is saved), else null. */
  addTask: (t: NewTask) => Promise<string | null>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<string | null>;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  addExpense: (e: NewExpense) => Promise<string | null>;
  deleteExpense: (id: string) => void;
  addDailyExpenseField: (field: NewDailyExpenseField) => Promise<string | null>;
  updateDailyExpenseField: (id: string, patch: Partial<NewDailyExpenseField>) => Promise<string | null>;
  deleteDailyExpenseField: (id: string) => Promise<string | null>;
  addDailyExpenseSheet: (sheet: NewDailyExpenseSheet) => Promise<string | null>;
  updateDailyExpenseSheet: (id: string, patch: Partial<NewDailyExpenseSheet>) => Promise<string | null>;
  deleteDailyExpenseSheet: (id: string) => Promise<string | null>;
  addDailyExpenseEntry: (entry: NewDailyExpenseEntry) => Promise<string | null>;
  updateDailyExpenseEntry: (id: string, patch: Partial<NewDailyExpenseEntry>) => Promise<string | null>;
  deleteDailyExpenseEntry: (id: string) => Promise<string | null>;
  addWallet: (w: Pick<Wallet, 'name' | 'currency' | 'openingBalanceMinor'>) => Promise<string | null>;
  renameWallet: (id: string, name: string) => Promise<string | null>;
  deleteWallet: (id: string) => Promise<string | null>;
  addWalletEntry: (entry: Pick<WalletEntry, 'walletId' | 'direction' | 'amountMinor' | 'date' | 'note'>) => Promise<string | null>;
  deleteWalletEntry: (id: string) => void;
  addWalletTransfer: (transfer: Pick<WalletTransfer, 'fromWalletId' | 'toWalletId' | 'amountMinor' | 'date' | 'note'>) => Promise<string | null>;
  deleteWalletTransfer: (id: string) => void;
  addMessGroup: (group: Pick<MessGroup, 'name' | 'currency'>, selfName: string) => Promise<string | null>;
  deleteMessGroup: (id: string) => Promise<string | null>;
  addMessMember: (member: Pick<MessMember, 'groupId' | 'name' | 'contactId'>) => Promise<string | null>;
  deleteMessMember: (id: string) => Promise<string | null>;
  addMessMeal: (meal: Pick<MessMeal, 'groupId' | 'memberId' | 'date' | 'halfMealUnits'>) => Promise<string | null>;
  deleteMessMeal: (id: string) => void;
  addMessExpense: (expense: Pick<MessExpense, 'groupId' | 'amountMinor' | 'date' | 'category' | 'note' | 'payerMemberId' | 'walletId' | 'allocationMode' | 'mealRangeStart' | 'mealRangeEnd' | 'allocations'>) => Promise<string | null>;
  deleteMessExpense: (id: string) => void;
  replaceSyncedContacts: (contacts: SyncedContact[]) => Promise<string | null>;
  clearSyncedContacts: () => Promise<string | null>;
  addGoal: (g: Pick<Goal, 'name' | 'targetMinor' | 'currency'>) => void;
  contributeToGoal: (id: string, amountMinor: number) => void;
  deleteGoal: (id: string) => void;
  addDebt: (d: Pick<Debt, 'person' | 'direction' | 'amountMinor' | 'currency' | 'dueDate'>) => Promise<string | null>;
  payDebt: (id: string, amountMinor: number) => Promise<string | null>;
  deleteDebt: (id: string) => void;
  addCycleGroup: (name: string, userId?: string) => Promise<string | null>;
  updateCycleGroup: (id: string, patch: { name?: string; sortOrder?: number }) => Promise<string | null>;
  deleteCycleGroup: (id: string) => Promise<string | null>;
  reorderCycleGroups: (orderedIds: string[]) => Promise<string | null>;
  addCycleBill: (b: Omit<CycleBill, 'id' | 'createdAt' | 'completedInstallments'>) => Promise<string | null>;
  updateCycleBill: (id: string, patch: Partial<CycleBill>) => Promise<string | null>;
  setCycleBillOverride: (billId: string, monthKey: string, patch: Pick<CycleBillOverride, 'expectedAmountMinor' | 'groupId' | 'group'>) => Promise<string | null>;
  deleteCycleBillOverride: (billId: string, monthKey: string) => Promise<string | null>;
  deleteCycleBill: (id: string, deleteLinkedDebt?: boolean) => Promise<string | null>;
  addCyclePayment: (p: Omit<CyclePayment, 'id' | 'createdAt'>) => Promise<string | null>;
  undoCyclePayment: (paymentId: string) => Promise<string | null>;
  addCycleIncome: (inc: Omit<CycleIncome, 'id' | 'createdAt'>) => Promise<string | null>;
  deleteCycleIncome: (id: string) => Promise<string | null>;
  closeCycleMonth: (monthKey: string, notes?: string, reason?: string) => Promise<string | null>;
  reopenCycleMonth: (monthKey: string, reason?: string) => Promise<string | null>;
  setSettings: (s: Partial<Settings>) => void;
  /** Re-validates the whole dataset; returns an error message (and changes nothing) if it is invalid. */
  replaceAll: (d: AppData) => Promise<string | null>;
  loadSample: () => void;
  removeSample: () => void;
  deleteEverything: () => Promise<void>;
  restoreTrash: (id: string) => Promise<string | null>;
  purgeTrash: () => Promise<string | null>;
  deleteTrashItem: (id: string) => Promise<string | null>;
  emptyTrash: () => Promise<string | null>;
  retryLoad: () => void;
  /** Raw text of data that could not be read at startup (for manual recovery), or null. */
  getUnreadableCopy: () => Promise<string | null>;
  addReceipt: (receipt: Pick<ReceiptAttachment, 'recordType' | 'recordId' | 'fileName' | 'mimeType' | 'sizeBytes' | 'dataBase64'>) => Promise<string | null>;
  deleteReceipt: (id: string) => Promise<string | null>;
}

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp must be used inside AppProvider');
  return c;
};

const repo = new Repository(asyncStorageStore);
const storageCoordinator = new StorageCoordinator();

function saveFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Data changed in another tab or app window.')) return error.message;
  if (error instanceof Error && error.message.startsWith('Cannot save over unreadable data.')) return error.message;
  return 'Could not save to this device. Your latest change may be lost.';
}

function shouldRetrySave(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return !error.message.startsWith('Data changed in another tab or app window.')
    && !error.message.startsWith('Cannot save over unreadable data.');
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [data, setDataState] = useState<AppData>(emptyData());
  const [toast, setToast] = useState<Toast | null>(null);
  const dataRef = useRef(data);
  const persistedRawRef = useRef<string | null>(null);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const [today, setToday] = useState(() => toDateStr(new Date()));
  useEffect(() => {
    // Keep "today" correct if the app stays open past midnight.
    const t = setInterval(() => setToday((cur) => { const now = toDateStr(new Date()); return now === cur ? cur : now; }), 30_000);
    return () => clearInterval(t);
  }, []);

  const applyLoaded = useCallback((r: Awaited<ReturnType<Repository['load']>>) => {
    dataRef.current = r.data;
    persistedRawRef.current = r.raw;
    setDataState(r.data);
    setLoadError(r.status === 'error' ? r.error : null);
    setStatus('ready');
  }, []);
  useEffect(() => {
    let alive = true;
    cleanOrphanedTempFiles();
    void cleanOrphanedRestoreStaging();
    void repo.load().then(async (r) => {
      if (!alive) return;
      applyLoaded(r);
      if (r.status !== 'error') {
        try {
          await repo.cleanupLegacyRollbackCopies();
        } catch (error: unknown) {
          if (alive) setSaveError(error instanceof Error ? error.message : 'Legacy rollback-copy cleanup failed.');
        }
      }
    });
    return () => { alive = false; };
  }, [applyLoaded]);

  const commit = useCallback((next: AppData): Promise<string | null> => {
    dataRef.current = next;
    setDataState(next);
    // Serialise writes so an older snapshot can never land after a newer one.
    const write = writeChain.current
      .then(() => retryStorageOperation(
        () => storageCoordinator.runExclusive(() => repo.save(next, persistedRawRef.current)),
        { shouldRetry: shouldRetrySave },
      ))
      .then((savedRaw) => { persistedRawRef.current = savedRaw; setSaveError(null); return null; })
      .catch((error: unknown) => {
        const message = saveFailureMessage(error);
        setSaveError(message);
        return message;
      });
    writeChain.current = write.then(() => undefined);
    return write;
  }, []);

  const mutate = useCallback(async (fn: (d: AppData) => AppData, toastMsg?: string, rollbackOnFailure = false): Promise<string | null> => {
    const before = dataRef.current;
    const g = guardedUpdate(before, fn);
    if (!g.ok) {
      const message = `Change rejected, nothing was saved: ${g.error}`;
      setToast({ message });
      return message;
    }
    const after = g.data;
    const saving = commit(after);
    if (!toastMsg) setToast(null); // an older Undo must not outlive a newer edit
    else {
      const entry = createUndo(before, after);
      setToast({
        message: toastMsg,
        undo: () => {
          const restored = applyUndo(entry, dataRef.current);
          if (restored) { void commit(restored); setToast(null); }
          else setToast({ message: 'Cannot undo: your data changed since.' });
        },
      });
    }
    const error = await saving;
    if (error && rollbackOnFailure && dataRef.current === after) {
      dataRef.current = before;
      setDataState(before);
      setToast({ message: error });
    }
    return error;
  }, [commit]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const value = useMemo<Ctx>(() => {
    const upd = <K extends 'tasks' | 'expenses' | 'goals' | 'debts'>(k: K, id: string, f: (x: AppData[K][number]) => AppData[K][number]) =>
      (d: AppData): AppData => ({ ...d, [k]: (d[k] as { id: string }[]).map((x) => (x.id === id ? f(x as AppData[K][number]) : x)) });
    const withTrash = (d: AppData, itemType: Parameters<typeof createTrashRecord>[0], record: { id: string }, title: string, subtitle?: string): AppData => ({
      ...d,
      trash: [...d.trash, createTrashRecord(itemType, record, record.id, title, subtitle)],
    });
    const withTrashRecords = (d: AppData, records: { itemType: Parameters<typeof createTrashRecord>[0]; record: { id: string }; title: string; subtitle?: string }[]): AppData => ({
      ...d,
      trash: [...d.trash, ...records.map((item) => createTrashRecord(item.itemType, item.record, item.record.id, item.title, item.subtitle))],
    });
    const restoreTrashRecord = (d: AppData, item: AppData['trash'][number]): AppData => {
      const record = item.data;
      switch (item.itemType) {
        case 'task': return d.tasks.some((x) => x.id === item.originalId) ? d : { ...d, tasks: [...d.tasks, { ...(record as AppData['tasks'][number]), deletedAt: null }], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'expense': return d.expenses.some((x) => x.id === item.originalId) ? d : { ...d, expenses: [...d.expenses, record as AppData['expenses'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'goal': return d.goals.some((x) => x.id === item.originalId) ? d : { ...d, goals: [...d.goals, record as AppData['goals'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'debt': return d.debts.some((x) => x.id === item.originalId) ? d : { ...d, debts: [...d.debts, record as AppData['debts'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'wallet': return d.wallets.some((x) => x.id === item.originalId) ? d : { ...d, wallets: [...d.wallets, record as AppData['wallets'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'wallet_entry': return d.walletEntries.some((x) => x.id === item.originalId) ? d : { ...d, walletEntries: [...d.walletEntries, record as AppData['walletEntries'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'wallet_transfer': return d.walletTransfers.some((x) => x.id === item.originalId) ? d : { ...d, walletTransfers: [...d.walletTransfers, record as AppData['walletTransfers'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'mess_group': return d.messGroups.some((x) => x.id === item.originalId) ? d : { ...d, messGroups: [...d.messGroups, record as AppData['messGroups'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'mess_member': return d.messMembers.some((x) => x.id === item.originalId) ? d : { ...d, messMembers: [...d.messMembers, record as AppData['messMembers'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'mess_meal': return d.messMeals.some((x) => x.id === item.originalId) ? d : { ...d, messMeals: [...d.messMeals, record as AppData['messMeals'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'mess_expense': return d.messExpenses.some((x) => x.id === item.originalId) ? d : { ...d, messExpenses: [...d.messExpenses, record as AppData['messExpenses'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'daily_expense_field': {
          if (d.dailyExpenseFields.some((x) => x.id === item.originalId)) return d;
          const field = record as AppData['dailyExpenseFields'][number];
          return {
            ...d,
            dailyExpenseFields: [...d.dailyExpenseFields, field],
            dailyExpenseSheets: d.dailyExpenseSheets.map((sheet) => (
              sheet.fieldIds.includes(field.id) ? sheet : { ...sheet, fieldIds: [...sheet.fieldIds, field.id] }
            )),
            trash: d.trash.filter((x) => x.id !== item.id),
          };
        }
        case 'daily_expense_sheet': return d.dailyExpenseSheets.some((x) => x.id === item.originalId) ? d : { ...d, dailyExpenseSheets: [...d.dailyExpenseSheets, record as AppData['dailyExpenseSheets'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'daily_expense': return d.dailyExpenseEntries.some((x) => x.id === item.originalId) ? d : { ...d, dailyExpenseEntries: [...d.dailyExpenseEntries, record as AppData['dailyExpenseEntries'][number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'cycle_group': {
          if (d.cycleGroups?.some((x) => x.id === item.originalId)) return d;
          const payload = record as { group?: NonNullable<AppData['cycleGroups']>[number]; billIds?: string[] };
          const group = payload.group ?? record as NonNullable<AppData['cycleGroups']>[number];
          const billIds = payload.group ? payload.billIds ?? [] : [];
          return {
            ...d,
            cycleGroups: [...(d.cycleGroups ?? []), group],
            cycleBills: (d.cycleBills ?? []).map((bill) => (
              billIds.includes(bill.id) && !bill.groupId
                ? { ...bill, groupId: group.id, group: group.name }
                : bill
            )),
            trash: d.trash.filter((x) => x.id !== item.id),
          };
        }
        case 'cycle_bill': return d.cycleBills?.some((x) => x.id === item.originalId) ? d : { ...d, cycleBills: [...(d.cycleBills ?? []), record as NonNullable<AppData['cycleBills']>[number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'cycle_income': return d.cycleIncomes?.some((x) => x.id === item.originalId) ? d : { ...d, cycleIncomes: [...(d.cycleIncomes ?? []), record as NonNullable<AppData['cycleIncomes']>[number]], trash: d.trash.filter((x) => x.id !== item.id) };
        case 'cycle_payment': return d.cyclePayments?.some((x) => x.id === item.originalId) ? d : { ...d, cyclePayments: [...(d.cyclePayments ?? []), record as NonNullable<AppData['cyclePayments']>[number]], trash: d.trash.filter((x) => x.id !== item.id) };
      }
    };

    return {
      status, loadError, saveError, data, today, toast,
      dismissToast: () => setToast(null),
      addTask: async (t) => {
        const rec: Task = { ...t, originalText: t.originalText ?? null, id: newId('task'), done: false, deletedAt: null, sample: false, createdAt: new Date().toISOString() };
        const v = validateTask(rec);
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, tasks: [...d.tasks, rec] }), 'Task added', true);
      },
      updateTask: async (id, patch) => {
        const current = dataRef.current.tasks.find((t) => t.id === id);
        if (!current) return 'Task not found';
        const updated: Task = { ...current, ...patch };
        const v = validateTask(updated);
        if (!v.ok) return v.error;
        return mutate(upd('tasks', id, () => updated), undefined, true);
      },
      toggleTask: (id) => {
        const t = dataRef.current.tasks.find((x) => x.id === id);
        if (!t) return;
        const next = !t.done ? nextDueDate(t) : null;
        if (next) mutate(upd('tasks', id, (x) => ({ ...x, dueDate: next })), `Repeats. Next due ${next}`);
        else mutate(upd('tasks', id, (x) => ({ ...x, done: !x.done })), t.done ? 'Marked not done' : 'Task completed');
      },
      deleteTask: (id) => mutate((d) => {
        const task = d.tasks.find((x) => x.id === id);
        return task ? withTrash({ ...d, tasks: d.tasks.filter((x) => x.id !== id) }, 'task', task, task.title, task.category) : d;
      }, 'Task moved to Trash'),
      addExpense: async (e) => {
        const rec: Expense = { ...e, walletId: e.walletId ?? null, originalText: e.originalText ?? null, id: newId('exp'), sample: false };
        const v = validateExpense(rec);
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, expenses: [...d.expenses, rec] }), 'Expense saved', true);
      },
      deleteExpense: (id) => mutate((d) => {
        const expense = d.expenses.find((x) => x.id === id);
        return expense ? withTrash({ ...d, expenses: d.expenses.filter((x) => x.id !== id) }, 'expense', expense, expense.category, expense.date) : d;
      }, 'Expense moved to Trash'),
      addReceipt: async (receipt) => {
        const rec: ReceiptAttachment = { ...receipt, id: newId('receipt'), createdAt: new Date().toISOString() };
        const v = validateReceiptAttachment(rec);
        if (!v.ok) return v.error;
        const total = dataRef.current.receiptAttachments.reduce((sum, item) => sum + item.sizeBytes, 0);
        if (total + rec.sizeBytes > 200 * 1024 * 1024) return 'Receipt storage is full - remove an old receipt before adding another.';
        return mutate((d) => ({ ...d, receiptAttachments: [...d.receiptAttachments, rec] }), 'Receipt attached', true);
      },
      deleteReceipt: async (id) => mutate((d) => ({
        ...d,
        receiptAttachments: d.receiptAttachments.filter((receipt) => receipt.id !== id),
      }), 'Receipt removed', true),
      addDailyExpenseField: async (field) => {
        const rec: DailyExpenseField = { ...field, id: newId('daily_field') };
        const v = validateDailyExpenseField(rec);
        if (!v.ok) return v.error;
        if (dataRef.current.dailyExpenseFields.some((x) => x.name.toLowerCase() === rec.name.toLowerCase())) return 'A daily expense field with this name already exists';
        return mutate((d) => ({
          ...d,
          dailyExpenseFields: [...d.dailyExpenseFields, rec],
          dailyExpenseSheets: d.dailyExpenseSheets.map((sheet) => ({ ...sheet, fieldIds: sheet.fieldIds.includes(rec.id) ? sheet.fieldIds : [...sheet.fieldIds, rec.id] })),
        }), 'Daily expense field added', true);
      },
      updateDailyExpenseField: async (id, patch) => {
        const current = dataRef.current.dailyExpenseFields.find((x) => x.id === id);
        if (!current) return 'Daily expense field not found';
        const rec = { ...current, ...patch };
        const v = validateDailyExpenseField(rec);
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, dailyExpenseFields: d.dailyExpenseFields.map((x) => x.id === id ? v.value : x) }), 'Daily expense field updated', true);
      },
      deleteDailyExpenseField: async (id) => mutate((d) => {
        const field = d.dailyExpenseFields.find((x) => x.id === id);
        if (!field) return d;
        return withTrash({
          ...d,
          dailyExpenseFields: d.dailyExpenseFields.filter((x) => x.id !== id),
          dailyExpenseSheets: d.dailyExpenseSheets.map((s) => ({ ...s, fieldIds: s.fieldIds.filter((fieldId) => fieldId !== id) })),
        }, 'daily_expense_field', field, field.name);
      }, 'Daily expense field moved to Trash', true),
      addDailyExpenseSheet: async (sheet) => {
        const rec: DailyExpenseSheet = { ...sheet, id: newId('daily_sheet'), createdAt: new Date().toISOString() };
        const v = validateDailyExpenseSheet(rec);
        if (!v.ok) return v.error;
        if (dataRef.current.dailyExpenseSheets.some((x) => x.name.toLowerCase() === rec.name.toLowerCase())) return 'A daily expense sheet with this name already exists';
        return mutate((d) => ({ ...d, dailyExpenseSheets: [...d.dailyExpenseSheets, rec] }), 'Daily expense sheet added', true);
      },
      updateDailyExpenseSheet: async (id, patch) => {
        const current = dataRef.current.dailyExpenseSheets.find((x) => x.id === id);
        if (!current) return 'Daily expense sheet not found';
        const rec = { ...current, ...patch };
        const v = validateDailyExpenseSheet(rec);
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, dailyExpenseSheets: d.dailyExpenseSheets.map((x) => x.id === id ? v.value : x) }), 'Daily expense sheet updated', true);
      },
      deleteDailyExpenseSheet: async (id) => mutate((d) => {
        const sheet = d.dailyExpenseSheets.find((x) => x.id === id);
        if (!sheet) return d;
        const entries = d.dailyExpenseEntries.filter((x) => x.sheetId === id);
        return withTrashRecords({
          ...d,
          dailyExpenseSheets: d.dailyExpenseSheets.filter((x) => x.id !== id),
          dailyExpenseEntries: d.dailyExpenseEntries.filter((x) => x.sheetId !== id),
        }, [
          { itemType: 'daily_expense_sheet', record: sheet, title: sheet.name },
          ...entries.map((entry) => ({ itemType: 'daily_expense' as const, record: entry, title: entry.category, subtitle: entry.date })),
        ]);
      }, 'Daily expense sheet moved to Trash', true),
      addDailyExpenseEntry: async (entry) => {
        const rec: DailyExpenseEntry = { ...entry, id: newId('daily_entry') };
        const v = validateDailyExpenseEntry(rec, { fields: dataRef.current.dailyExpenseFields });
        if (!v.ok) return v.error;
        if (!dataRef.current.dailyExpenseSheets.some((x) => x.id === rec.sheetId)) return 'Daily expense sheet not found';
        return mutate((d) => ({ ...d, dailyExpenseEntries: [...d.dailyExpenseEntries, rec] }), 'Daily expense saved', true);
      },
      updateDailyExpenseEntry: async (id, patch) => {
        const current = dataRef.current.dailyExpenseEntries.find((x) => x.id === id);
        if (!current) return 'Daily expense entry not found';
        const rec = { ...current, ...patch };
        const v = validateDailyExpenseEntry(rec, { fields: dataRef.current.dailyExpenseFields });
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, dailyExpenseEntries: d.dailyExpenseEntries.map((x) => x.id === id ? v.value : x) }), 'Daily expense updated', true);
      },
      deleteDailyExpenseEntry: async (id) => mutate((d) => {
        const entry = d.dailyExpenseEntries.find((x) => x.id === id);
        return entry ? withTrash({ ...d, dailyExpenseEntries: d.dailyExpenseEntries.filter((x) => x.id !== id) }, 'daily_expense', entry, entry.category, entry.date) : d;
      }, 'Daily expense moved to Trash', true),
      addWallet: async (w) => {
        const rec: Wallet = { ...w, id: newId('wallet'), createdAt: new Date().toISOString() };
        return mutate((d) => ({ ...d, wallets: [...d.wallets, rec] }), 'Wallet added', true);
      },
      renameWallet: async (id, name) => mutate((d) => ({
        ...d,
        wallets: d.wallets.map((wallet) => wallet.id === id ? { ...wallet, name } : wallet),
      })),
      deleteWallet: async (id) => {
        if (walletIsReferenced(dataRef.current, id)) return "Delete this wallet's linked entries, expenses, transfers and mess expenses first.";
        return mutate((d) => {
          const wallet = d.wallets.find((x) => x.id === id);
          return wallet ? withTrash({ ...d, wallets: d.wallets.filter((x) => x.id !== id) }, 'wallet', wallet, wallet.name, wallet.currency) : d;
        }, 'Wallet moved to Trash', true);
      },
      addWalletEntry: async (entry) => {
        const rec: WalletEntry = { ...entry, id: newId('wallet_entry') };
        return mutate((d) => ({ ...d, walletEntries: [...d.walletEntries, rec] }), 'Wallet entry saved', true);
      },
      deleteWalletEntry: (id) => mutate((d) => {
        const entry = d.walletEntries.find((x) => x.id === id);
        return entry ? withTrash({ ...d, walletEntries: d.walletEntries.filter((x) => x.id !== id) }, 'wallet_entry', entry, entry.note || 'Wallet entry', entry.date) : d;
      }, 'Wallet entry moved to Trash'),
      addWalletTransfer: async (transfer) => {
        const rec: WalletTransfer = { ...transfer, id: newId('wallet_transfer') };
        return mutate((d) => ({ ...d, walletTransfers: [...d.walletTransfers, rec] }), 'Transfer saved', true);
      },
      deleteWalletTransfer: (id) => mutate((d) => {
        const transfer = d.walletTransfers.find((x) => x.id === id);
        return transfer ? withTrash({ ...d, walletTransfers: d.walletTransfers.filter((x) => x.id !== id) }, 'wallet_transfer', transfer, transfer.note || 'Wallet transfer', transfer.date) : d;
      }, 'Transfer moved to Trash'),
      addMessGroup: async (group, selfName) => {
        const rec: MessGroup = { ...group, id: newId('mess'), createdAt: new Date().toISOString() };
        const self: MessMember = { id: newId('member'), groupId: rec.id, name: selfName, contactId: null, isSelf: true };
        return mutate((d) => ({ ...d, messGroups: [rec, ...d.messGroups], messMembers: [...d.messMembers, self] }), 'Mess group added', true);
      },
      deleteMessGroup: async (id) => {
        const d = dataRef.current;
        if (d.messMeals.some((meal) => meal.groupId === id) || d.messExpenses.some((expense) => expense.groupId === id)) {
          return "Remove this group's meal and expense records before deleting it.";
        }
        return mutate((current) => {
          const group = current.messGroups.find((x) => x.id === id);
          const members = current.messMembers.filter((x) => x.groupId === id);
          return group ? withTrashRecords({
            ...current,
            messGroups: current.messGroups.filter((x) => x.id !== id),
            messMembers: current.messMembers.filter((x) => x.groupId !== id),
          }, [
            { itemType: 'mess_group', record: group, title: group.name, subtitle: group.currency },
            ...members.map((member) => ({ itemType: 'mess_member' as const, record: member, title: member.name })),
          ]) : current;
        }, 'Mess group moved to Trash', true);
      },
      addMessMember: async (member) => {
        const rec: MessMember = { ...member, id: newId('member'), isSelf: false };
        return mutate((d) => ({ ...d, messMembers: [...d.messMembers, rec] }), 'Member added', true);
      },
      deleteMessMember: async (id) => {
        const d = dataRef.current;
        if (d.messMembers.find((member) => member.id === id)?.isSelf) return 'The self member cannot be deleted.';
        if (d.messMeals.some((meal) => meal.memberId === id) || d.messExpenses.some((expense) =>
          expense.payerMemberId === id || expense.allocations.some((allocation: MessAllocation) => allocation.memberId === id))) {
          return 'This member has meal or expense history and cannot be deleted.';
        }
        return mutate((current) => {
          const member = current.messMembers.find((x) => x.id === id);
          return member ? withTrash({ ...current, messMembers: current.messMembers.filter((x) => x.id !== id) }, 'mess_member', member, member.name) : current;
        }, 'Member moved to Trash', true);
      },
      addMessMeal: async (meal) => {
        const rec: MessMeal = { ...meal, id: newId('meal') };
        return mutate((d) => ({ ...d, messMeals: [...d.messMeals, rec] }), 'Meal count saved', true);
      },
      deleteMessMeal: (id) => mutate((d) => {
        const meal = d.messMeals.find((x) => x.id === id);
        return meal ? withTrash({ ...d, messMeals: d.messMeals.filter((x) => x.id !== id) }, 'mess_meal', meal, 'Meal count', meal.date) : d;
      }, 'Meal count moved to Trash'),
      addMessExpense: async (expense) => {
        const rec: MessExpense = { ...expense, id: newId('mess_expense') };
        return mutate((d) => ({ ...d, messExpenses: [...d.messExpenses, rec] }), 'Mess expense saved', true);
      },
      deleteMessExpense: (id) => mutate((d) => {
        const expense = d.messExpenses.find((x) => x.id === id);
        return expense ? withTrash({ ...d, messExpenses: d.messExpenses.filter((x) => x.id !== id) }, 'mess_expense', expense, expense.category, expense.date) : d;
      }, 'Mess expense moved to Trash'),
      replaceSyncedContacts: async (contacts) => mutate((d) => ({ ...d, syncedContacts: contacts }), 'Contacts refreshed', true),
      clearSyncedContacts: () => mutate((d) => ({ ...d, syncedContacts: [] }), 'Cached contacts cleared'),
      addGoal: (g) => mutate((d) => ({ ...d, goals: [...d.goals, { ...g, id: newId('goal'), savedMinor: 0, sample: false }] }), 'Goal added'),
      contributeToGoal: (id, amt) => mutate(upd('goals', id, (g) => ({ ...g, savedMinor: g.savedMinor + amt })), 'Savings updated'),
      deleteGoal: (id) => mutate((d) => {
        const goal = d.goals.find((x) => x.id === id);
        return goal ? withTrash({ ...d, goals: d.goals.filter((x) => x.id !== id) }, 'goal', goal, goal.name, goal.currency) : d;
      }, 'Goal moved to Trash'),
      addDebt: async (x) => {
        const rec: Debt = { ...x, id: newId('debt'), paidMinor: 0, createdAt: new Date().toISOString(), sample: false };
        const v = validateDebt(rec);
        if (!v.ok) return v.error;
        return mutate((d) => ({ ...d, debts: [...d.debts, rec] }), 'Debt added', true);
      },
      payDebt: async (id, amountMinor) => {
        const payment = applyDebtPayment(dataRef.current.debts, id, amountMinor);
        if (!payment.ok) return payment.error;
        const updatedDebt = payment.debts.find((d) => d.id === id);
        const newStatus = updatedDebt
          ? (updatedDebt.paidMinor >= updatedDebt.amountMinor ? 'repaid' : (updatedDebt.paidMinor > 0 ? 'partial' : 'unpaid'))
          : 'unpaid';
        return mutate((d) => ({
          ...d,
          debts: payment.debts,
          cycleBills: (d.cycleBills ?? []).map((b) =>
            b.linkedDebtId === id ? { ...b, repayStatus: newStatus } : b
          ),
        }), 'Payment recorded', true);
      },
      deleteDebt: (id) => mutate((d) => {
        const debt = d.debts.find((x) => x.id === id);
        return debt ? withTrash({ ...d, debts: d.debts.filter((x) => x.id !== id) }, 'debt', debt, debt.person, debt.currency) : d;
      }, 'Debt moved to Trash'),
      addCycleGroup: async (name, userId = 'default_user') => {
        const trimmed = name.trim();
        if (!trimmed) return 'Group name cannot be empty';
        const existing = dataRef.current.cycleGroups ?? [];
        if (existing.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())) {
          return 'A group with this name already exists';
        }
        const rec: CycleGroup = {
          id: newId('cgrp'),
          userId,
          name: trimmed,
          sortOrder: existing.length,
          createdAt: new Date().toISOString(),
        };
        const v = validateCycleGroup(rec);
        if (!v.ok) return v.error;
        return mutate((curr) => ({
          ...curr,
          cycleGroups: [...(curr.cycleGroups ?? []), rec],
        }), 'Group created', true);
      },
      updateCycleGroup: async (id, patch) => {
        const target = (dataRef.current.cycleGroups ?? []).find((g) => g.id === id);
        if (!target) return 'Group not found';
        if (patch.name !== undefined && !patch.name.trim()) return 'Group name cannot be empty';
        return mutate((curr) => ({
          ...curr,
          cycleGroups: (curr.cycleGroups ?? []).map((g) =>
            g.id === id ? { ...g, ...patch, name: patch.name ? patch.name.trim() : g.name } : g
          ),
        }), 'Group updated', true);
      },
      deleteCycleGroup: async (id) => {
        return mutate((curr) => {
          const targetGroup = (curr.cycleGroups ?? []).find((g) => g.id === id);
          const targetName = targetGroup?.name.toLowerCase();
          const linkedBillIds = (curr.cycleBills ?? [])
            .filter((b) => b.groupId === id || (targetName && b.group?.toLowerCase() === targetName))
            .map((b) => b.id);
          const next = {
            ...curr,
            cycleGroups: (curr.cycleGroups ?? []).filter((g) => g.id !== id),
            // Ungroup linked bills without deleting the bills
            cycleBills: (curr.cycleBills ?? []).map((b) => {
              if (b.groupId === id || (targetName && b.group?.toLowerCase() === targetName)) {
                return { ...b, groupId: null, group: null };
              }
              return b;
            }),
          };
          if (!targetGroup) return curr;
          return {
            ...next,
            trash: [
              ...next.trash,
              createTrashRecord('cycle_group', { group: targetGroup, billIds: linkedBillIds }, targetGroup.id, targetGroup.name),
            ],
          };
        }, 'Group deleted', true);
      },
      reorderCycleGroups: async (orderedIds) => {
        return mutate((curr) => {
          const groupMap = new Map((curr.cycleGroups ?? []).map((g) => [g.id, g]));
          const reordered: CycleGroup[] = [];
          orderedIds.forEach((id, idx) => {
            const g = groupMap.get(id);
            if (g) {
              reordered.push({ ...g, sortOrder: idx });
              groupMap.delete(id);
            }
          });
          groupMap.forEach((g) => reordered.push({ ...g, sortOrder: reordered.length }));
          return {
            ...curr,
            cycleGroups: reordered,
          };
        }, 'Groups reordered', true);
      },
      addCycleBill: async (b) => {
        const rec: CycleBill = {
          ...b,
          id: newId('bill'),
          paidBy: b.paidBy ?? 'self',
          completedInstallments: 0,
          createdAt: new Date().toISOString(),
        };
        const v = validateCycleBill(rec);
        if (!v.ok) return v.error;

        let newDebt: Debt | null = null;
        if (rec.paidBy && rec.paidBy !== 'self') {
          if (rec.linkedDebtId) {
            const existingDebt = dataRef.current.debts.find((d) => d.id === rec.linkedDebtId);
            if (existingDebt && existingDebt.currency !== rec.currency) {
              return `Currency mismatch: bill currency (${rec.currency}) does not match debt currency (${existingDebt.currency})`;
            }
          } else {
            const debtPerson = (rec.payerName && rec.payerName.trim()) ? rec.payerName.trim() : rec.paidBy;
            newDebt = {
              id: newId('debt'),
              person: debtPerson,
              direction: 'i_owe',
              amountMinor: rec.expectedAmountMinor,
              paidMinor: 0,
              currency: rec.currency,
              dueDate: rec.repayDueDate ?? null,
              createdAt: new Date().toISOString(),
              sample: false,
            };
            const debtValidation = validateDebt(newDebt);
            if (!debtValidation.ok) return debtValidation.error;
            rec.linkedDebtId = newDebt.id;
            rec.repayStatus = 'unpaid';
          }
        }

        return mutate((d) => ({
          ...d,
          cycleBills: [...(d.cycleBills ?? []), rec],
          debts: newDebt ? [...d.debts, newDebt] : d.debts,
        }), 'Bill added', true);
      },
      updateCycleBill: async (id, patch) => {
        const currentBill = dataRef.current.cycleBills?.find((b) => b.id === id);
        if (!currentBill) return 'Bill not found';
        const updated: CycleBill = { ...currentBill, ...patch };
        const v = validateCycleBill(updated);
        if (!v.ok) return v.error;

        const linkedDebtId = updated.linkedDebtId;
        if (linkedDebtId) {
          const debt = dataRef.current.debts.find((d) => d.id === linkedDebtId);
          if (debt && debt.currency !== updated.currency) {
            return `Currency mismatch: bill currency (${updated.currency}) does not match linked debt currency (${debt.currency})`;
          }
        }

        return mutate((d) => ({
          ...d,
          cycleBills: (d.cycleBills ?? []).map((b) => (b.id === id ? updated : b)),
        }), 'Bill updated', true);
      },
      setCycleBillOverride: async (billId, monthKey, patch) => {
        const bill = dataRef.current.cycleBills?.find((item) => item.id === billId);
        if (!bill) return 'Bill not found';
        if (dataRef.current.cycleMonths?.some((m) => m.userId === bill.userId && m.monthKey === monthKey && m.isClosed)) {
          return 'Month is closed. Reopen it before changing this month.';
        }
        if (patch.expectedAmountMinor !== undefined &&
          (!Number.isSafeInteger(patch.expectedAmountMinor) || patch.expectedAmountMinor <= 0)) {
          return 'Override amount must be a positive safe integer minor unit';
        }
        const existing = (dataRef.current.cycleBillOverrides ?? []).find(
          (item) => item.billId === billId && item.userId === bill.userId && item.monthKey === monthKey
        );
        const record: CycleBillOverride = {
          id: existing?.id ?? newId('bill_override'),
          userId: bill.userId,
          billId,
          monthKey,
          ...(existing ?? {}),
          ...patch,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        const v = validateCycleBillOverride(record);
        if (!v.ok) return v.error;
        return mutate((curr) => ({
          ...curr,
          cycleBillOverrides: [
            ...(curr.cycleBillOverrides ?? []).filter((item) => item.id !== record.id),
            record,
          ],
        }), 'Month-specific bill change saved', true);
      },
      deleteCycleBillOverride: async (billId, monthKey) => {
        const bill = dataRef.current.cycleBills?.find((item) => item.id === billId);
        if (!bill) return 'Bill not found';
        if (dataRef.current.cycleMonths?.some((m) => m.userId === bill.userId && m.monthKey === monthKey && m.isClosed)) {
          return 'Month is closed. Reopen it before restoring the recurring bill.';
        }
        return mutate((curr) => ({
          ...curr,
          cycleBillOverrides: (curr.cycleBillOverrides ?? []).filter(
            (item) => !(item.billId === billId && item.userId === bill.userId && item.monthKey === monthKey)
          ),
        }), 'Recurring bill restored for this month', true);
      },
      deleteCycleBill: async (id, deleteLinkedDebt = false) => {
        const currentBill = dataRef.current.cycleBills?.find((b) => b.id === id);
        const linkedDebtId = currentBill?.linkedDebtId;
        return mutate((d) => {
          let nextDebts = d.debts;
          let next = d;
          if (deleteLinkedDebt && linkedDebtId) {
            const linkedDebt = d.debts.find((debt) => debt.id === linkedDebtId);
            nextDebts = d.debts.filter((debt) => debt.id !== linkedDebtId);
            next = linkedDebt ? withTrash(next, 'debt', linkedDebt, linkedDebt.person, linkedDebt.currency) : next;
          }
          next = {
            ...next,
            cycleBills: (d.cycleBills ?? []).filter((b) => b.id !== id),
            cycleBillOverrides: (d.cycleBillOverrides ?? []).filter((item) => item.billId !== id),
            debts: nextDebts,
          };
          return currentBill ? withTrash(next, 'cycle_bill', currentBill, currentBill.name, currentBill.currency) : d;
        }, 'Bill deleted', true);
      },
      addCyclePayment: async (p) => {
        const d = dataRef.current;
        if (d.cycleMonths?.some((m) => m.monthKey === p.monthKey && m.isClosed)) {
          return 'Month is closed. Closed months are read-only to preserve financial records.';
        }
        const rec: CyclePayment = {
          ...p,
          id: newId('cpay'),
          createdAt: new Date().toISOString(),
        };
        const v = validateCyclePayment(rec);
        if (!v.ok) return v.error;
        return mutate((curr) => {
          const bills = (curr.cycleBills ?? []).map((b) => {
            if (b.id === p.billId && b.installmentCount) {
              return { ...b, completedInstallments: b.completedInstallments + 1 };
            }
            return b;
          });
          return {
            ...curr,
            cycleBills: bills,
            cyclePayments: [...(curr.cyclePayments ?? []), rec],
          };
        }, 'Payment recorded', true);
      },
      undoCyclePayment: async (paymentId) => {
        const p = dataRef.current.cyclePayments?.find((x) => x.id === paymentId);
        if (!p) return 'Payment record not found';
        if (dataRef.current.cycleMonths?.some((m) => m.monthKey === p.monthKey && m.isClosed)) {
          return 'Month is closed. Closed months are read-only to preserve financial records.';
        }
        return mutate((curr) => {
          const bills = (curr.cycleBills ?? []).map((b) => {
            if (b.id === p.billId && b.installmentCount && b.completedInstallments > 0) {
              return { ...b, completedInstallments: b.completedInstallments - 1 };
            }
            return b;
          });
          return {
            ...curr,
            cycleBills: bills,
            cyclePayments: (curr.cyclePayments ?? []).filter((x) => x.id !== paymentId),
          };
        }, 'Payment undone', true);
      },
      addCycleIncome: async (inc) => {
        const d = dataRef.current;
        if (d.cycleMonths?.some((m) => m.monthKey === inc.monthKey && m.isClosed)) {
          return 'Month is closed. Closed months are read-only to preserve financial records.';
        }
        const rec: CycleIncome = {
          ...inc,
          id: newId('cinc'),
          createdAt: new Date().toISOString(),
        };
        const v = validateCycleIncome(rec);
        if (!v.ok) return v.error;
        return mutate((curr) => ({
          ...curr,
          cycleIncomes: [...(curr.cycleIncomes ?? []), rec],
        }), 'Income added', true);
      },
      deleteCycleIncome: async (id) => {
        const inc = dataRef.current.cycleIncomes?.find((x) => x.id === id);
        if (inc && dataRef.current.cycleMonths?.some((m) => m.monthKey === inc.monthKey && m.isClosed)) {
          return 'Month is closed. Closed months are read-only to preserve financial records.';
        }
        return mutate((curr) => {
          const income = (curr.cycleIncomes ?? []).find((x) => x.id === id);
          return income ? withTrash({
            ...curr,
            cycleIncomes: (curr.cycleIncomes ?? []).filter((x) => x.id !== id),
          }, 'cycle_income', income, income.source, income.monthKey) : curr;
        }, 'Income moved to Trash', true);
      },
      closeCycleMonth: async (monthKey, notes, reason) => {
        const userId = 'default_user';
        const rec: CycleMonth = {
          id: newId('cmonth'),
          userId,
          monthKey,
          isClosed: true,
          closedAt: new Date().toISOString(),
          notes,
        };
        return mutate((curr) => {
          const current = (curr.cycleMonths ?? []).find((m) => m.userId === userId && m.monthKey === monthKey);
          if (current?.isClosed) throw new Error(`Month ${monthKey} is already locked`);
          const filtered = (curr.cycleMonths ?? []).filter((m) => !(m.userId === userId && m.monthKey === monthKey));
          const event: CycleMonthLockEvent = {
            id: newId('cycle_lock'),
            userId,
            monthKey,
            action: 'closed',
            actor: 'local_owner',
            reason: (reason ?? notes ?? '').trim() || undefined,
            createdAt: new Date().toISOString(),
          };
          const eventValidation = validateCycleMonthLockEvent(event);
          if (!eventValidation.ok) throw new Error(eventValidation.error);
          return {
            ...curr,
            cycleMonths: [...filtered, rec],
            cycleMonthLockEvents: [...(curr.cycleMonthLockEvents ?? []), event],
          };
        }, `Month ${monthKey} closed`, true);
      },
      reopenCycleMonth: async (monthKey, reason) => {
        const userId = 'default_user';
        return mutate((curr) => {
          const current = (curr.cycleMonths ?? []).find((m) => m.userId === userId && m.monthKey === monthKey);
          if (!current?.isClosed) throw new Error(`Month ${monthKey} is not locked`);
          const event: CycleMonthLockEvent = {
            id: newId('cycle_lock'),
            userId,
            monthKey,
            action: 'reopened',
            actor: 'local_owner',
            reason: reason?.trim() || undefined,
            createdAt: new Date().toISOString(),
          };
          const eventValidation = validateCycleMonthLockEvent(event);
          if (!eventValidation.ok) throw new Error(eventValidation.error);
          return {
            ...curr,
            cycleMonths: (curr.cycleMonths ?? []).filter((m) => !(m.userId === userId && m.monthKey === monthKey)),
            cycleMonthLockEvents: [...(curr.cycleMonthLockEvents ?? []), event],
          };
        }, `Month ${monthKey} reopened`, true);
      },
      setSettings: (s) => mutate((d) => ({ ...d, settings: { ...d.settings, ...s } })),
      replaceAll: async (n) => {
        const v = validateAppData(n);
        if (!v.ok) return v.error;
        return mutate(() => v.value, 'Data imported', true);
      },
      loadSample: () => mutate((d) => {
        const s = sampleData(today, d.settings.currency);
        return {
          ...d,
          tasks: [...d.tasks, ...s.tasks],
          expenses: [...d.expenses, ...s.expenses],
          goals: [...d.goals, ...s.goals],
          debts: [...d.debts, ...s.debts],
          cycleGroups: [...(d.cycleGroups ?? []), ...(s.cycleGroups ?? [])],
          cycleBills: [...(d.cycleBills ?? []), ...(s.cycleBills ?? [])],
          cycleBillOverrides: [...(d.cycleBillOverrides ?? []), ...(s.cycleBillOverrides ?? [])],
          cycleMonthLockEvents: [...(d.cycleMonthLockEvents ?? []), ...(s.cycleMonthLockEvents ?? [])],
          cycleIncomes: [...(d.cycleIncomes ?? []), ...(s.cycleIncomes ?? [])],
          cyclePayments: [...(d.cyclePayments ?? []), ...(s.cyclePayments ?? [])],
          cycleMonths: [...(d.cycleMonths ?? []), ...(s.cycleMonths ?? [])],
          wallets: [...d.wallets, ...s.wallets],
          walletEntries: [...d.walletEntries, ...s.walletEntries],
          walletTransfers: [...d.walletTransfers, ...s.walletTransfers],
          syncedContacts: [...d.syncedContacts, ...s.syncedContacts],
          messGroups: [...d.messGroups, ...s.messGroups],
          messMembers: [...d.messMembers, ...s.messMembers],
          messMeals: [...d.messMeals, ...s.messMeals],
          messExpenses: [...d.messExpenses, ...s.messExpenses],
          dailyExpenseFields: [...d.dailyExpenseFields, ...s.dailyExpenseFields],
          dailyExpenseSheets: [...d.dailyExpenseSheets, ...s.dailyExpenseSheets],
          dailyExpenseEntries: [...d.dailyExpenseEntries, ...s.dailyExpenseEntries],
        };
      }, 'Sample data added'),
      removeSample: () => mutate((d) => ({
        ...d,
        tasks: d.tasks.filter((x) => !x.sample),
        expenses: d.expenses.filter((x) => !x.sample),
        goals: d.goals.filter((x) => !x.sample),
        debts: d.debts.filter((x) => !x.sample),
        cycleGroups: (d.cycleGroups ?? []).filter((x) => !x.sample),
        cycleBills: (d.cycleBills ?? []).filter((x) => !x.sample),
        cycleBillOverrides: (d.cycleBillOverrides ?? []).filter((x) => !x.sample),
        cycleIncomes: (d.cycleIncomes ?? []).filter((x) => !x.sample),
        cyclePayments: (d.cyclePayments ?? []).filter((x) => !x.sample),
        cycleMonths: (d.cycleMonths ?? []).filter((x) => !x.sample),
        cycleMonthLockEvents: (d.cycleMonthLockEvents ?? []).filter((x) => !x.sample),
        wallets: d.wallets.filter((x) => !x.sample),
        walletEntries: d.walletEntries.filter((x) => !x.sample),
        walletTransfers: d.walletTransfers.filter((x) => !x.sample),
        syncedContacts: d.syncedContacts.filter((x) => !x.sample),
        messGroups: d.messGroups.filter((x) => !x.sample),
        messMembers: d.messMembers.filter((x) => !x.sample),
        messMeals: d.messMeals.filter((x) => !x.sample),
        messExpenses: d.messExpenses.filter((x) => !x.sample),
        dailyExpenseFields: d.dailyExpenseFields.filter((x) => !x.sample),
        dailyExpenseSheets: d.dailyExpenseSheets.filter((x) => !x.sample),
        dailyExpenseEntries: d.dailyExpenseEntries.filter((x) => !x.sample),
      }), 'Sample data removed'),
      restoreTrash: async (id) => {
        const item = dataRef.current.trash.find((x) => x.id === id);
        if (!item) return 'Trash item not found';
        if (purgeExpiredTrash([item]).length === 0) return 'This item has expired and cannot be restored.';
        const current = dataRef.current;
        const payload = item.data as Record<string, unknown>;
        if (item.itemType === 'wallet_entry' && typeof payload.walletId === 'string' && !current.wallets.some((x) => x.id === payload.walletId)) {
          return 'Cannot restore this wallet entry because its wallet is missing. Restore the wallet first.';
        }
        if (item.itemType === 'wallet_transfer') {
          if (typeof payload.fromWalletId === 'string' && !current.wallets.some((x) => x.id === payload.fromWalletId)) {
            return 'Cannot restore this transfer because its source wallet is missing. Restore the wallet first.';
          }
          if (typeof payload.toWalletId === 'string' && !current.wallets.some((x) => x.id === payload.toWalletId)) {
            return 'Cannot restore this transfer because its destination wallet is missing. Restore the wallet first.';
          }
        }
        if (item.itemType === 'mess_member' && typeof payload.groupId === 'string' && !current.messGroups.some((x) => x.id === payload.groupId)) {
          return 'Cannot restore this member because its mess group is missing. Restore the group first.';
        }
        if (['mess_meal', 'mess_expense'].includes(item.itemType) && typeof payload.groupId === 'string' && !current.messGroups.some((x) => x.id === payload.groupId)) {
          return 'Cannot restore this mess record because its group is missing. Restore the group first.';
        }
        if (item.itemType === 'mess_meal' && typeof payload.memberId === 'string' && !current.messMembers.some((x) => x.id === payload.memberId)) {
          return 'Cannot restore this meal because its member is missing. Restore the member first.';
        }
        if (item.itemType === 'mess_expense' && typeof payload.payerMemberId === 'string' && !current.messMembers.some((x) => x.id === payload.payerMemberId)) {
          return 'Cannot restore this mess expense because its payer is missing. Restore the member first.';
        }
        if (item.itemType === 'daily_expense' && typeof payload.sheetId === 'string' && !current.dailyExpenseSheets.some((x) => x.id === payload.sheetId)) {
          return 'Cannot restore this daily expense because its sheet is missing. Restore the sheet first.';
        }
        if (item.itemType === 'cycle_payment' && typeof payload.billId === 'string' && !current.cycleBills?.some((x) => x.id === payload.billId)) {
          return 'Cannot restore this payment because its bill is missing. Restore the bill first.';
        }
        return mutate((d) => restoreTrashRecord(d, item), 'Item restored from Trash', true);
      },
      purgeTrash: async () => mutate((d) => ({
        ...d,
        trash: purgeExpiredTrash(d.trash),
      }), 'Expired Trash removed', true),
      deleteTrashItem: async (id) => mutate((d) => ({
        ...d,
        trash: d.trash.filter((item) => item.id !== id),
      }), 'Trash item permanently deleted', true),
      emptyTrash: async () => mutate((d) => ({ ...d, trash: [] }), 'Trash emptied permanently', true),
      deleteEverything: async () => {
        await writeChain.current;
        await storageCoordinator.runExclusive(() => repo.clear());
        const fresh = emptyData();
        persistedRawRef.current = null;
        dataRef.current = fresh; setDataState(fresh); setToast(null); setLoadError(null);
      },
      getUnreadableCopy: () => repo.getCorrupt(),
      retryLoad: () => { setStatus('loading'); void repo.load().then(applyLoaded); },
    };
  }, [status, loadError, saveError, data, today, toast, mutate, applyLoaded]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
