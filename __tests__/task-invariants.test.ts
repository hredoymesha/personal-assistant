import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays } from '../src/domain/dates';
import { nextDueDate } from '../src/domain/recurrence';
import { isOverdueTask, tasksDueOn } from '../src/domain/summaries';
import type { Task } from '../src/domain/types';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  notes: '',
  dueDate: '2026-03-08',
  dueTime: null,
  priority: 'medium',
  category: 'Personal',
  recurrence: 'none',
  done: false,
  deletedAt: null,
  originalText: null,
  sample: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('task invariants', () => {
  it('records monthly recurrence from January 31 as February 28, then remains on the 28th', () => {
    const february = nextDueDate({ dueDate: '2026-01-31', recurrence: 'monthly' });
    expect(february).toBe('2026-02-28');
    expect(nextDueDate({ dueDate: february, recurrence: 'monthly' })).toBe('2026-03-28');
  });

  it('uses the leap-day boundary for monthly recurrence', () => {
    expect(nextDueDate({ dueDate: '2028-01-31', recurrence: 'monthly' })).toBe('2028-02-29');
  });

  it('keeps task dates on local calendar days across daylight-saving transitions', () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
      expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('marks only earlier-due, active, non-sample, unfinished tasks overdue', () => {
    expect(isOverdueTask(task('late', { dueDate: '2026-03-07' }), '2026-03-08')).toBe(true);
    for (const candidate of [
      task('today'),
      task('future', { dueDate: '2026-03-09' }),
      task('undated', { dueDate: null }),
      task('done', { done: true, dueDate: '2026-03-07' }),
      task('deleted', { deletedAt: '2026-03-08T00:00:00.000Z' }),
      task('sample', { sample: true, dueDate: '2026-03-07' }),
    ]) {
      expect(isOverdueTask(candidate, '2026-03-08')).toBe(false);
    }
  });

  it('returns no due tasks for an empty list and handles a large task list', () => {
    expect(tasksDueOn([], '2026-03-08')).toEqual([]);
    const many = Array.from({ length: 10_000 }, (_, index) =>
      task(String(index), { dueDate: index % 2 === 0 ? '2026-03-08' : '2026-03-09' }));
    expect(tasksDueOn(many, '2026-03-08')).toHaveLength(5_000);
  });

  it('retains case-insensitive substring search for diacritics and Bangla text', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/tasks.tsx'), 'utf8');
    expect(source).toMatch(/\.toLowerCase\(\)\.includes\(needle\)/);

    const items = [
      task('accented', { title: 'Café preparation' }),
      task('bangla', { title: 'বাজারের তালিকা' }),
    ];
    const matches = (query: string) => {
      const needle = query.trim().toLowerCase();
      return items.filter((item) =>
        (item.title + ' ' + item.notes + ' ' + item.category).toLowerCase().includes(needle));
    };
    expect(matches('CAFÉ').map((item) => item.id)).toEqual(['accented']);
    expect(matches('বাজার').map((item) => item.id)).toEqual(['bangla']);
  });

  it('guards repeated task-save taps while an add is pending', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/tasks.tsx'), 'utf8');
    expect(source).toMatch(/if \(savingRef\.current\) return;/);
    expect(source).toMatch(/savingRef\.current = true;\s*setSaving\(true\);\s*try\s*\{\s*const saveError = await addTask/);
    expect(source).toMatch(/disabled=\{saving\}/);
  });
});
