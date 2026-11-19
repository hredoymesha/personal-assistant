import { SCHEMA_VERSION } from '../domain/types';

export interface Migration {
  from: number;
  to: number;
  up: (data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Append new migrations here when SCHEMA_VERSION increases. Never edit old ones.
 * v0 = a payload with no schemaVersion (e.g. a hand-made or very early export).
 */
export const MIGRATIONS: Migration[] = [
  {
    from: 0,
    to: 1,
    up: (d) => ({
      settings: { currency: 'BDT', theme: 'system', language: 'en' },
      tasks: [], expenses: [], goals: [], debts: [],
      ...d,
      schemaVersion: 1,
    }),
  },
  {
    from: 1,
    to: 2,
    up: (d) => ({
      ...d,
      expenses: Array.isArray(d.expenses)
        ? d.expenses.map((expense) =>
          typeof expense === 'object' && expense !== null && !Array.isArray(expense)
            ? { ...expense, walletId: (expense as Record<string, unknown>).walletId ?? null }
            : expense)
        : d.expenses,
      wallets: d.wallets ?? [],
      walletEntries: d.walletEntries ?? [],
      walletTransfers: d.walletTransfers ?? [],
      syncedContacts: d.syncedContacts ?? [],
      messGroups: d.messGroups ?? [],
      messMembers: d.messMembers ?? [],
      messMeals: d.messMeals ?? [],
      messExpenses: d.messExpenses ?? [],
      schemaVersion: 2,
    }),
  },
  {
    from: 2,
    to: 3,
    up: (d) => ({
      ...d,
      debts: Array.isArray(d.debts)
        ? d.debts.map((debt) =>
          typeof debt === 'object' && debt !== null && !Array.isArray(debt)
            ? { ...debt, createdAt: (debt as Record<string, unknown>).createdAt ?? null }
            : debt)
        : d.debts,
      schemaVersion: 3,
    }),
  },
  {
    from: 3,
    to: 4,
    up: (d) => ({
      ...d,
      cycleGroups: Array.isArray(d.cycleGroups) ? d.cycleGroups : [],
      cycleBills: Array.isArray(d.cycleBills) ? d.cycleBills : [],
      cyclePayments: Array.isArray(d.cyclePayments) ? d.cyclePayments : [],
      cycleIncomes: Array.isArray(d.cycleIncomes) ? d.cycleIncomes : [],
      cycleMonths: Array.isArray(d.cycleMonths) ? d.cycleMonths : [],
      schemaVersion: 4,
    }),
  },
  {
    from: 4,
    to: 5,
    up: (d) => ({
      ...d,
      cycleBillOverrides: Array.isArray(d.cycleBillOverrides) ? d.cycleBillOverrides : [],
      schemaVersion: 5,
    }),
  },
  {
    from: 5,
    to: 6,
    up: (d) => ({
      ...d,
      cycleMonthLockEvents: Array.isArray(d.cycleMonthLockEvents) ? d.cycleMonthLockEvents : [],
      schemaVersion: 6,
    }),
  },
  {
    from: 6,
    to: 7,
    up: (d) => ({
      ...d,
      dailyExpenseSheets: Array.isArray(d.dailyExpenseSheets) ? d.dailyExpenseSheets : [],
      dailyExpenseEntries: Array.isArray(d.dailyExpenseEntries) ? d.dailyExpenseEntries : [],
      dailyExpenseFields: Array.isArray(d.dailyExpenseFields) ? d.dailyExpenseFields : [],
      schemaVersion: 7,
    }),
  },
  {
    from: 7,
    to: 8,
    up: (d) => {
      const rawTasks = Array.isArray(d.tasks) ? d.tasks : [];
      const legacyDeletedTasks = rawTasks.filter((t) => typeof t === 'object' && t !== null && !Array.isArray(t) && Boolean((t as Record<string, unknown>).deletedAt));
      const activeTasks = rawTasks.filter((t) => typeof t === 'object' && t !== null && !Array.isArray(t) && !((t as Record<string, unknown>).deletedAt));

      const legacyTrash = legacyDeletedTasks.map((t, idx) => {
        const item = t as Record<string, unknown>;
        return {
          id: `trash_legacy_task_${idx}_${Date.now()}`,
          itemType: 'task',
          originalId: typeof item.id === 'string' ? item.id : `task_legacy_${idx}`,
          deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : new Date().toISOString(),
          title: typeof item.title === 'string' ? item.title : 'Legacy task',
          subtitle: typeof item.category === 'string' ? item.category : undefined,
          data: item,
        };
      });

      const existingTrash = Array.isArray(d.trash) ? d.trash : [];

      return {
        ...d,
        tasks: activeTasks,
        trash: [...existingTrash, ...legacyTrash],
        schemaVersion: 8,
      };
    },
  },
  {
    from: 8,
    to: 9,
    up: (d) => {
      const normalize = (value: unknown): unknown => {
        if (typeof value === 'string') return value.replace(/INR/g, 'BDT').replace(/₹/g, '৳');
        if (Array.isArray(value)) return value.map(normalize);
        if (typeof value === 'object' && value !== null) {
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
        }
        return value;
      };
      return normalize(d) as Record<string, unknown>;
    },
  },
  {
    from: 9,
    to: 10,
    up: (d) => ({
      ...d,
      receiptAttachments: Array.isArray(d.receiptAttachments) ? d.receiptAttachments : [],
      schemaVersion: 10,
    }),
  },
];

export type MigrateResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export function migrate(
  input: unknown,
  migrations: Migration[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): MigrateResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'Data is not an object' };
  }
  let data = input as Record<string, unknown>;
  const raw: unknown = data.schemaVersion === undefined ? 0 : data.schemaVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, error: 'Invalid schema version' };
  }
  let version: number = raw;
  if (version > target) {
    return { ok: false, error: `Data is from a newer app version (v${version}); update Personal Assistant first` };
  }
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) return { ok: false, error: `No migration from v${version}` };
    data = { ...step.up(data), schemaVersion: step.to };
    version = step.to;
  }
  return { ok: true, data };
}
