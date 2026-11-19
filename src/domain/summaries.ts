import { addDays } from './dates';
import {
  percent,
  sumCurrencyAmounts,
  sumMinor,
  toCurrencyAmount,
  totalsByCurrency,
  type CurrencyAmount,
  type Minor,
  type SupportedCurrency,
} from './money';
import type { AppData, Expense, Goal, MessExpense, Task } from './types';

export const activeTasks = (tasks: Task[]) => tasks.filter((t) => !t.deletedAt);

export function isOverdueTask(task: Task, today: string): boolean {
  return !task.done && !task.sample && !task.deletedAt && task.dueDate !== null && task.dueDate < today;
}

export function tasksDueOn(tasks: Task[], today: string): Task[] {
  return activeTasks(tasks).filter((t) => !t.done && t.dueDate !== null && t.dueDate <= today);
}

export function upcomingTasks(tasks: Task[], today: string, days = 7): Task[] {
  const end = addDays(today, days);
  return activeTasks(tasks)
    .filter((t) => !t.done && t.dueDate !== null && t.dueDate > today && t.dueDate <= end)
    .sort((a, b) => (a.dueDate! + (a.dueTime ?? '')).localeCompare(b.dueDate! + (b.dueTime ?? '')));
}

export function recentExpenses(expenses: Expense[], n = 5): Expense[] {
  return [...expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}

/** Regular expenses plus mess expenses paid from one of the user's wallets. */
export function trackedExpensesForTotals(data: AppData): Expense[] {
  const ownMessExpenses = data.messExpenses.filter((expense) => expense.walletId !== null).map((expense): Expense => {
    const group = data.messGroups.find((item) => item.id === expense.groupId);
    if (!group) throw new Error(`Mess expense ${expense.id} refers to a missing group`);
    return {
      id: expense.id,
      amountMinor: expense.amountMinor,
      currency: group.currency,
      category: expense.category,
      note: expense.note,
      date: expense.date,
      walletId: expense.walletId,
      originalText: null,
      sample: false,
    };
  });
  return [...data.expenses, ...ownMessExpenses];
}

/** Totals for the month containing `today` ("YYYY-MM"), per currency. */
export function monthTotals(expenses: Expense[], today: string): Record<string, Minor> {
  const ym = today.slice(0, 7);
  return totalsByCurrency(expenses.filter((e) => e.date.startsWith(ym)));
}

export function categoryTotals(expenses: Expense[], currency: string): { category: string; total: Minor }[] {
  const m = new Map<string, Minor>();
  for (const e of expenses) {
    if (e.currency === currency) m.set(e.category, sumMinor([m.get(e.category) ?? 0, e.amountMinor]));
  }
  return [...m].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
}

/** Total for one category in one currency. */
export function categoryCurrencyTotal<C extends SupportedCurrency>(
  expenses: Expense[],
  category: string,
  currency: C,
): CurrencyAmount<C> {
  const matching = expenses
    .filter((e) => e.category === category && e.currency === currency)
    .map((e) => toCurrencyAmount(e.amountMinor, currency));
  return sumCurrencyAmounts(matching, currency);
}

export const goalProgress = (g: Goal) => percent(g.savedMinor, g.targetMinor);

export function netDebt(data: AppData, currency: string): { owedToMe: Minor; iOwe: Minor } {
  let owedToMe = 0, iOwe = 0;
  for (const d of data.debts) {
    if (d.currency !== currency) continue;
    const open = d.amountMinor - d.paidMinor;
    if (d.direction === 'owed_to_me') owedToMe = sumMinor([owedToMe, open]);
    else iOwe = sumMinor([iOwe, open]);
  }
  return { owedToMe, iOwe };
}

function assertValidCategory(category: unknown, label: string): string {
  if (typeof category !== 'string' || !category.trim()) {
    throw new Error(`${label} is required and cannot be empty.`);
  }
  const trimmed = category.trim();
  if (trimmed.length > 40) {
    throw new Error(`${label} cannot exceed 40 characters.`);
  }
  return trimmed;
}

/** Moves expenses from one category to another. Returns a new array. */
export function replaceExpenseCategory(
  expenses: Expense[],
  sourceCategory: string,
  targetCategory: string,
): Expense[] {
  const source = assertValidCategory(sourceCategory, 'Source category');
  const target = assertValidCategory(targetCategory, 'Target category');
  if (source === target) return [...expenses];
  return expenses.map((item) => (item.category === source ? { ...item, category: target } : item));
}

/** Same as replaceExpenseCategory, for mess expenses. */
export function replaceMessExpenseCategory(
  expenses: MessExpense[],
  sourceCategory: string,
  targetCategory: string,
): MessExpense[] {
  const source = assertValidCategory(sourceCategory, 'Source category');
  const target = assertValidCategory(targetCategory, 'Target category');
  if (source === target) return [...expenses];
  return expenses.map((item) => (item.category === source ? { ...item, category: target } : item));
}
