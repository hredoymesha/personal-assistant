import { addDays, addMonths } from './dates';
import type { Task } from './types';

/** Next due date for a recurring task, or null when it does not recur. */
export function nextDueDate(task: Pick<Task, 'dueDate' | 'recurrence'>): string | null {
  if (!task.dueDate) return null;
  switch (task.recurrence) {
    case 'daily': return addDays(task.dueDate, 1);
    case 'weekly': return addDays(task.dueDate, 7);
    case 'monthly': return addMonths(task.dueDate, 1);
    default: return null;
  }
}
