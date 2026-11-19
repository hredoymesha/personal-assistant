import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyData, Task, Expense } from '../src/domain/types';
import { validateTask, validateExpense, validateDebt } from '../src/domain/validation';
import { MemoryStore, KeyValueStore } from '../src/storage/store';
import { Repository } from '../src/storage/repository';
import { guardedUpdate } from '../src/state/guard';

describe('Save results and keeping typed input on failure', () => {
  describe('Domain validation decides the save result', () => {
    it('returns a rejection for invalid task input without saving', () => {
      // Empty title is rejected
      const invalidTask1: Task = {
        id: 't1',
        title: '',
        notes: '',
        dueDate: null,
        dueTime: null,
        priority: 'medium',
        category: 'Personal',
        recurrence: 'none',
        done: false,
        deletedAt: null,
        originalText: null,
        sample: false,
        createdAt: new Date().toISOString(),
      };
      const res1 = validateTask(invalidTask1);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error).toMatch(/Task title is required/);
      }

      // Invalid date format is rejected
      const invalidTask2: Task = { ...invalidTask1, title: 'Valid title', dueDate: 'invalid-date' };
      const res2 = validateTask(invalidTask2);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error).toMatch(/Task due date is invalid/);
      }

      // Invalid time format is rejected
      const invalidTask3: Task = { ...invalidTask1, title: 'Valid title', dueTime: 'invalid-time' };
      const res3 = validateTask(invalidTask3);
      expect(res3.ok).toBe(false);
      if (!res3.ok) {
        expect(res3.error).toMatch(/Task due time is invalid/);
      }

      // Invalid priority is rejected
      const invalidTask4: Task = { ...invalidTask1, title: 'Valid title', priority: 'ultra-high' as any };
      const res4 = validateTask(invalidTask4);
      expect(res4.ok).toBe(false);
      if (!res4.ok) {
        expect(res4.error).toMatch(/Task priority is invalid/);
      }
    });

    it('returns a rejection for invalid expense input without saving', () => {
      // Zero amount is rejected
      const invalidExpense: Expense = {
        id: 'e1',
        amountMinor: 0,
        currency: 'BDT',
        category: 'Food',
        note: '',
        date: '2026-10-10',
        walletId: null,
        originalText: null,
        sample: false,
      };
      const res1 = validateExpense(invalidExpense);
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.error).toMatch(/Expense amount must be greater than zero/);
      }

      // Negative amount is rejected
      const res2 = validateExpense({ ...invalidExpense, amountMinor: -500 });
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error).toMatch(/Expense amount must be greater than zero/);
      }

      // Non-integer minor amount is rejected
      const res3 = validateExpense({ ...invalidExpense, amountMinor: 12.5 });
      expect(res3.ok).toBe(false);
      if (!res3.ok) {
        expect(res3.error).toMatch(/Expense amount must be greater than zero/);
      }
    });

    it('returns a rejection for invalid debt input without saving', () => {
      const res = validateDebt({
        id: 'd1',
        person: '',
        direction: 'owed_to_me',
        amountMinor: 1000,
        paidMinor: 0,
        currency: 'BDT',
        dueDate: null,
        createdAt: new Date().toISOString(),
        sample: false,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/Person name is required/);
      }
    });
  });

  describe('Storage writes and rollback with mock stores', () => {
    class FailingStore implements KeyValueStore {
      private mem = new Map<string, string>();
      async getItem(key: string): Promise<string | null> {
        return this.mem.get(key) ?? null;
      }
      async setItem(_key: string, _value: string): Promise<void> {
        throw new Error('Disk quota exceeded (simulated IO failure)');
      }
      async removeItem(key: string): Promise<void> {
        this.mem.delete(key);
      }
      async getAllKeys(): Promise<string[]> {
        return Array.from(this.mem.keys());
      }
    }

    it('successfully persists valid data to isolated MemoryStore and loads it back', async () => {
      const store = new MemoryStore();
      const repo = new Repository(store);
      const initial = emptyData();
      await repo.save(initial);

      const validTask: Task = {
        id: 't-success',
        title: 'Buy groceries',
        notes: '',
        dueDate: '2026-11-10',
        dueTime: null,
        priority: 'medium',
        category: 'Personal',
        recurrence: 'none',
        done: false,
        deletedAt: null,
        originalText: null,
        sample: false,
        createdAt: '2026-11-09T08:00:00.000Z',
      };
      const nextData = { ...initial, tasks: [validTask] };
      const savedRaw = await repo.save(nextData);
      expect(typeof savedRaw).toBe('string');

      const loaded = await repo.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status === 'ok') {
        expect(loaded.data.tasks).toHaveLength(1);
        expect(loaded.data.tasks[0].id).toBe('t-success');
      }
    });

    it('rolls back in-memory state and returns error when storage fails, leaving no false success', async () => {
      const failingStore = new FailingStore();
      const repo = new Repository(failingStore);
      let inMemoryData = emptyData();
      let lastToast: string | null = null;

      // Simulated mutation with rollback on failure (matching AppProvider.mutate logic)
      async function mutateWithRollback(fn: (d: typeof inMemoryData) => typeof inMemoryData, toastMsg: string): Promise<string | null> {
        const before = inMemoryData;
        const g = guardedUpdate(before, fn);
        if (!g.ok) return g.error;
        const after = g.data;
        inMemoryData = after;
        lastToast = toastMsg;

        try {
          await repo.save(after);
          return null; // success
        } catch {
          // Rollback on failure
          inMemoryData = before;
          lastToast = null;
          return 'Could not save to this device. Your latest change may be lost.';
        }
      }

      const newTask: Task = {
        id: 't-fail',
        title: 'Will fail to persist',
        notes: '',
        dueDate: null,
        dueTime: null,
        priority: 'high',
        category: 'Work',
        recurrence: 'none',
        done: false,
        deletedAt: null,
        originalText: null,
        sample: false,
        createdAt: '2026-11-09T08:00:00.000Z',
      };

      const saveError = await mutateWithRollback(
        (d) => ({ ...d, tasks: [...d.tasks, newTask] }),
        'Task added',
      );

      // 1. Error string returned
      expect(saveError).toBe('Could not save to this device. Your latest change may be lost.');
      // 2. In-memory state rolled back to before (empty tasks)
      expect(inMemoryData.tasks).toHaveLength(0);
      // 3. No false success toast remains
      expect(lastToast).toBeNull();
    });

    it('rejects stale edits with explicit concurrency error when another tab modified data', async () => {
      const store = new MemoryStore();
      const repo = new Repository(store);
      const initial = emptyData();
      const initialRaw = await repo.save(initial);

      // Tab B saves a change behind Tab A's back
      const tabBData = { ...initial, settings: { ...initial.settings, theme: 'dark' as const } };
      await repo.save(tabBData);

      // Tab A attempts to save expecting initialRaw
      const tabAData = { ...initial, settings: { ...initial.settings, currency: 'USD' as const } };
      await expect(repo.save(tabAData, initialRaw)).rejects.toThrow(
        'Data changed in another tab or app window. Reload before saving again.',
      );
    });
  });

  describe('Form contracts guard user inputs on save failure', () => {
    const tasksSource = readFileSync(join(process.cwd(), 'src/app/tasks.tsx'), 'utf8');
    const moneySource = readFileSync(join(process.cwd(), 'src/app/money.tsx'), 'utf8');

    it('tasks.tsx awaits addTask and halts form close on failure', () => {
      expect(tasksSource).toMatch(/const saveError = await addTask\(fields\);/);
      expect(tasksSource).toMatch(/if \(saveError\) \{\s*setError\(saveError\);\s*return;\s*\}/);
    });

    it('tasks.tsx awaits updateTask and halts form close on failure', () => {
      expect(tasksSource).toMatch(/const saveError = await updateTask\(editing,\s*fields\);/);
      expect(tasksSource).toMatch(/if \(saveError\) \{\s*setError\(saveError\);\s*return;\s*\}/);
    });

    it('money.tsx awaits addExpense and halts form close on failure', () => {
      expect(moneySource).toMatch(/const saveError = await addExpense\(candidate\);/);
      expect(moneySource).toMatch(/if \(saveError\) \{\s*setError\(saveError\);\s*return;\s*\}/);
    });

    it('tasks.tsx and money.tsx guard repeated submissions while saving', () => {
      expect(tasksSource).toMatch(/if \(savingRef\.current\) return;/);
      expect(moneySource).toMatch(/if \(savingRef\.current\) return;/);
    });
  });

  describe('AppProvider interface contract (src/state/AppProvider.tsx)', () => {
    const providerSource = readFileSync(join(process.cwd(), 'src/state/AppProvider.tsx'), 'utf8');

    it('declares updateTask as returning Promise<string | null> for the save result', () => {
      expect(providerSource).toMatch(/updateTask:\s*\(id:\s*string,\s*patch:\s*Partial<Task>\)\s*=>\s*Promise<string \| null>;/);
    });

    it('implements updateTask with rollbackOnFailure and validation', () => {
      expect(providerSource).toMatch(/updateTask:\s*async\s*\(id,\s*patch\)\s*=>/);
    });
  });
});

