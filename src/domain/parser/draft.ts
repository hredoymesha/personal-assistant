import { isValidDateStr, isValidTimeStr } from '../dates';
import { isSupportedCurrency, parseMoney } from '../money';
import type { Expense, Task } from '../types';
import { EXPENSE_CATEGORIES } from '../types';
import { validateExpense, validateTask } from '../validation';
import type { CommandDraft, DraftField } from './parse';

export type NewExpenseInput = Pick<Expense, 'amountMinor' | 'currency' | 'category' | 'note' | 'date' | 'originalText'>;
export type NewTaskInput = Pick<Task, 'title' | 'notes' | 'dueDate' | 'dueTime' | 'priority' | 'category' | 'recurrence' | 'originalText'>;

export type CommandAction =
  | { type: 'addExpense'; value: NewExpenseInput }
  | { type: 'addTask'; value: NewTaskInput };

export interface DraftCheck {
  /** Blocking problems per field. Confirm must stay disabled while this is non-empty. */
  issues: Partial<Record<DraftField | 'form', string>>;
  /** Present only when the draft is complete and passes the same validators as manual entry. */
  action: CommandAction | null;
}

/**
 * Single source of truth for "can this draft be saved?". Called on the initial parse and after
 * every edit, so the preview, the Confirm button and the saved record can never disagree.
 */
export function checkDraft(d: CommandDraft, today: string): DraftCheck {
  const issues: DraftCheck['issues'] = {};
  const q = (f: DraftField, fallback: string) => d.questions[f] ?? fallback;

  if (!d.kind) issues.kind = q('kind', 'Choose what to create.');

  const title = d.title.trim();
  if (d.kind && d.kind !== 'expense' && !title) issues.title = q('title', 'A title is required.');
  if (title.length > (d.kind === 'expense' ? 500 : 200)) issues.title = 'That description is too long.';

  // An unresolved ambiguity on an OPTIONAL field must still surface; otherwise it would be dropped silently.
  // (The UI clears a field's question once the user edits that field.)
  if (d.date === null && d.questions.date) issues.date = d.questions.date;
  if (d.time === null && d.questions.time) issues.time = d.questions.time;
  if (d.date !== null && !isValidDateStr(d.date)) issues.date = 'Use a real date like 2026-10-31.';
  if (d.time !== null && !isValidTimeStr(d.time)) issues.time = 'Use 24-hour time like 17:30.';
  if (d.time !== null && d.date === null) issues.time = 'A time needs a date.';

  let amountMinor: number | null = null;
  if (d.kind === 'expense') {
    if (!d.currency) issues.currency = q('currency', 'Choose a currency.');
    else if (!isSupportedCurrency(d.currency)) issues.currency = 'That currency is not supported.';
    amountMinor = parseMoney(d.amountText, d.currency ?? 'BDT');
    if (amountMinor === null || amountMinor === 0) {
      issues.amount = d.amountText.trim() ? 'Enter a positive amount with valid decimals, e.g. 250 or 250.50.' : q('amount', 'Enter an amount.');
    }
    if (!d.date) issues.date = q('date', 'Choose the date.');
    else if (isValidDateStr(d.date) && d.date > today) issues.date = 'An expense cannot be dated in the future.';
    if (!d.category) issues.category = q('category', 'Choose a category.');
    else if (!(EXPENSE_CATEGORIES as readonly string[]).includes(d.category)) issues.category = 'Unknown category.';
  } else if (d.kind === 'reminder') {
    if (!d.date) issues.date = q('date', 'A reminder needs a date.');
    else if (isValidDateStr(d.date) && d.date < today) issues.date = 'A reminder cannot be in the past.';
  }

  if (Object.keys(issues).length) return { issues, action: null };

  // Final gate: the exact domain validators used for manually-entered records.
  if (d.kind === 'expense') {
    const value: NewExpenseInput = { amountMinor: amountMinor!, currency: d.currency!, category: d.category!, note: title, date: d.date!, originalText: d.original };
    const v = validateExpense({ ...value, id: 'preview', sample: false });
    return v.ok ? { issues, action: { type: 'addExpense', value } } : { issues: { form: v.error }, action: null };
  }
  const value: NewTaskInput = { title, notes: '', dueDate: d.date, dueTime: d.time, priority: d.priority, category: 'Personal', recurrence: 'none', originalText: d.original };
  const v = validateTask({ ...value, id: 'preview', done: false, deletedAt: null, sample: false, createdAt: '' });
  return v.ok ? { issues, action: { type: 'addTask', value } } : { issues: { form: v.error }, action: null };
}
