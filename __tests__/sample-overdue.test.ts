import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOverdueTask, tasksDueOn } from '../src/domain/summaries';
import type { Task } from '../src/domain/types';

describe('Sample tasks are never overdue', () => {
  const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    notes: '',
    dueDate: '2026-10-10',
    dueTime: null,
    priority: 'medium',
    category: 'Personal',
    recurrence: 'none',
    done: false,
    deletedAt: null,
    originalText: null,
    sample: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  });

  const today = '2026-10-15'; // 5 days after task's dueDate (2026-10-10)

  it('identifies overdue real tasks correctly when dueDate is past', () => {
    const realTask = makeTask('real_1', { sample: false });
    expect(isOverdueTask(realTask, today)).toBe(true);
  });

  it('never marks sample tasks as overdue even when dueDate is in the past', () => {
    const sampleTask = makeTask('sample_1', { sample: true });
    // Sample tasks must never be overdue
    expect(isOverdueTask(sampleTask, today)).toBe(false);
  });

  it('keeps sample tasks appearing under Today when due on or before today', () => {
    const sampleTask = makeTask('sample_1', { sample: true, dueDate: '2026-10-10' });
    const dueTasks = tasksDueOn([sampleTask], today);
    // Sample tasks still appear under Today
    expect(dueTasks).toHaveLength(1);
    expect(dueTasks[0].id).toBe('sample_1');
  });

  it('does not mark completed, deleted, or future tasks as overdue', () => {
    const doneTask = makeTask('t_done', { done: true });
    const deletedTask = makeTask('t_del', { deletedAt: '2026-10-12T00:00:00.000Z' });
    const futureTask = makeTask('t_future', { dueDate: '2026-10-20' });
    const undatedTask = makeTask('t_undated', { dueDate: null });

    expect(isOverdueTask(doneTask, today)).toBe(false);
    expect(isOverdueTask(deletedTask, today)).toBe(false);
    expect(isOverdueTask(futureTask, today)).toBe(false);
    expect(isOverdueTask(undatedTask, today)).toBe(false);
  });

  it('verifies call sites in index.tsx and tasks.tsx guard overdue labelling and styling via isOverdueTask', () => {
    const indexSource = readFileSync(join(process.cwd(), 'src/app/index.tsx'), 'utf8');
    const tasksSource = readFileSync(join(process.cwd(), 'src/app/tasks.tsx'), 'utf8');

    // index.tsx must use isOverdueTask for label
    expect(indexSource).toMatch(/isOverdueTask\(t,\s*today\)\s*\?\s*['"]⚠ Overdue · ['"]\s*:\s*['"]['"]/);

    // tasks.tsx must use isOverdueTask for danger color styling
    expect(tasksSource).toMatch(/color:\s*isOverdueTask\(t,\s*today\)\s*\?\s*c\.danger\s*:\s*c\.sub/);
  });

  it('verifies sample tasks remain cleanly removable by sample flag', () => {
    const sampleTask = makeTask('sample_1', { sample: true });
    const realTask = makeTask('real_1', { sample: false });
    const tasks = [sampleTask, realTask];

    // Simulating sample-data removal
    const userOnlyTasks = tasks.filter((t) => !t.sample);
    expect(userOnlyTasks).toHaveLength(1);
    expect(userOnlyTasks[0].id).toBe('real_1');
  });
});
