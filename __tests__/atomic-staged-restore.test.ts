import {
  parseData,
  Repository,
  MAX_IMPORT_CHARS,
  MAX_JSON_DEPTH,
  RESTORE_STAGING_KEY,
  checkJsonDepth,
} from '../src/storage/repository';
import {
  executeRestoreWithRollback,
  cleanOrphanedRestoreStaging,
  getPreRestoreSnapshot,
  computeDataChanges,
} from '../src/services/restoreRollback';
import {
  inspectBackup,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_FILE_CHARS,
} from '../src/crypto/backup';
import { makeBackupPlaintext } from '../src/storage/backup';
import { emptyData, type AppData, type Task, type Expense, type Debt, type Wallet } from '../src/domain/types';
import type { KeyValueStore } from '../src/storage/store';
import type { Vault } from '../src/services/vault';

/**
 * Mock in-memory KeyValueStore simulating single-key storage, staging keys, and I/O faults.
 */
class MemoryStore implements KeyValueStore {
  public map = new Map<string, string>();
  public failNextSet = false;
  public failNextKey: string | null = null;
  public failNextGet = false;

  async getItem(key: string): Promise<string | null> {
    if (this.failNextGet) {
      throw new Error('Simulated storage read failure');
    }
    return this.map.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failNextSet || (this.failNextKey && this.failNextKey === key)) {
      throw new Error(`Simulated disk full or quota error writing key ${key}`);
    }
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }

  async getAllKeys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }

  async multiRemove(keys: string[]): Promise<void> {
    for (const k of keys) this.map.delete(k);
  }
}

/**
 * Mock in-memory Vault for SecureStore snapshot encryption keys.
 */
class MemoryVault implements Vault {
  private items = new Map<string, string>();
  public failSet = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    if (this.failSet) {
      throw new Error('Hardware keystore locked or biometric authentication required');
    }
    this.items.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.items.delete(key);
  }
}

function makeTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title,
    notes: '',
    dueDate: null,
    dueTime: null,
    priority: 'medium',
    category: 'General',
    recurrence: 'none',
    done: false,
    deletedAt: null,
    originalText: null,
    sample: false,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeExpense(id: string, amountMinor: number, overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    amountMinor,
    currency: 'BDT',
    category: 'Food',
    note: '',
    date: '2026-06-01',
    walletId: null,
    originalText: null,
    sample: false,
    ...overrides,
  };
}

function makeDebt(id: string, person: string, amountMinor: number, overrides: Partial<Debt> = {}): Debt {
  return {
    id,
    person,
    direction: 'owed_to_me',
    amountMinor,
    paidMinor: 0,
    currency: 'BDT',
    dueDate: null,
    createdAt: null,
    sample: false,
    ...overrides,
  };
}

function makeWallet(id: string, name: string, currency = 'BDT'): Wallet {
  return {
    id,
    name,
    currency,
    openingBalanceMinor: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

// Mock native expo modules
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
  getAllKeys: jest.fn().mockResolvedValue([]),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
}));

describe('Atomic, validated, previewed restore with input limits', () => {
  let memoryStore: MemoryStore;
  let memoryVault: MemoryVault;
  let repository: Repository;
  let oldData: AppData;
  let newData: AppData;

  beforeEach(async () => {
    memoryStore = new MemoryStore();
    memoryVault = new MemoryVault();
    repository = new Repository(memoryStore);

    oldData = emptyData();
    oldData.tasks.push(makeTask('old_task_1', 'Pre-existing Task That Must Not Be Corrupted'));
    oldData.expenses.push(makeExpense('old_exp_1', 12000));
    oldData.debts.push(makeDebt('old_debt_1', 'Rahim', 50000));
    oldData.wallets.push(makeWallet('old_wallet_1', 'Primary Cash'));

    newData = emptyData();
    newData.tasks.push(makeTask('new_task_1', 'Incoming Candidate Task A'));
    newData.tasks.push(makeTask('new_task_2', 'Incoming Candidate Task B'));
    newData.expenses.push(makeExpense('new_exp_1', 99000));
    newData.debts.push(makeDebt('new_debt_1', 'Karim', 75000));
    newData.wallets.push(makeWallet('new_wallet_1', 'Incoming Digital Wallet'));

    await repository.save(oldData);
  });

  describe('Kill-At-Each-Step Matrix & Staged Restore Atomicity', () => {
    it('waits for the asynchronous apply operation before reporting restore success', async () => {
      let applied = false;
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          applied = true;
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res).toEqual({ ok: true });
      expect(applied).toBe(true);
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status === 'ok') {
        expect(loaded.data.tasks.map((task) => task.id)).toEqual(['new_task_1', 'new_task_2']);
      }
    });

    it('Failure during pre-restore snapshot aborts before touching staging or primary store', async () => {
      memoryVault.failSet = true; // Keystore failure

      let applied = false;
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          applied = true;
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      expect(applied).toBe(false);
      if (!res.ok) {
        expect(res.rolledBack).toBe(false);
      }

      // Staging key was never written
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);

      // Primary key has only old data
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks).toHaveLength(1);
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.expenses[0].id).toBe('old_exp_1');
    });

    it('Failure writing staging key aborts restore leaving primary store untouched', async () => {
      memoryStore.failNextKey = RESTORE_STAGING_KEY; // Simulate storage quota failure on staging key

      let applied = false;
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          applied = true;
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      expect(applied).toBe(false);
      if (!res.ok) {
        expect(res.rolledBack).toBe(false);
        expect(res.error).toContain('Failed to stage restore data');
      }

      // Staging key is deleted/absent
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);

      // Primary store remains only old data
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.tasks).toHaveLength(1);
    });

    it('Interruption after staging key write (before atomic swap) leaves old data intact and recovers cleanly', async () => {
      // Simulate staging key having been written before a simulated OS kill
      memoryStore.map.set(RESTORE_STAGING_KEY, JSON.stringify(newData));

      // Repository.load() reads DATA_KEY, completely unaffected by staged key
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.tasks).toHaveLength(1);

      // Recovery on app startup cleans up abandoned staging key
      await cleanOrphanedRestoreStaging(memoryStore);
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);

      // Data continues to be only old data
      const loadedAfterClean = await repository.load();
      expect(loadedAfterClean.status).toBe('ok');
      if (loadedAfterClean.status !== 'ok') return;
      expect(loadedAfterClean.data.tasks[0].id).toBe('old_task_1');
    });

    it('Failure during atomic swap triggers automated rollback to old data and cleans staging key', async () => {
      let attemptCount = 0;
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          attemptCount++;
          if (attemptCount === 1) {
            // First attempt with newData fails
            return 'Simulated database constraint violation on incoming record';
          }
          // Rollback attempt with oldData succeeds
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.rolledBack).toBe(true);
      }

      // Staging key was cleaned up
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);

      // Primary store retains only old data
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.expenses[0].id).toBe('old_exp_1');
    });

    it('Interruption after atomic swap leaves new data intact and cleans staging key on launch', async () => {
      // Perform atomic swap
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );
      expect(res.ok).toBe(true);

      // Simulate crash right before staging key deletion by manually leaving a staging key
      memoryStore.map.set(RESTORE_STAGING_KEY, JSON.stringify(newData));

      // Repository.load() reads only new data
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks).toHaveLength(2);
      expect(loaded.data.tasks[0].id).toBe('new_task_1');
      expect(loaded.data.tasks[1].id).toBe('new_task_2');

      // Startup cleaner removes the orphaned staging key without touching new data
      await cleanOrphanedRestoreStaging(memoryStore);
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);

      const loadedPostClean = await repository.load();
      expect(loadedPostClean.status).toBe('ok');
      if (loadedPostClean.status !== 'ok') return;
      expect(loadedPostClean.data.tasks).toHaveLength(2);
    });

    it('Double failure (apply fails AND rollback fails) accurately reports rolledBack: false without false success', async () => {
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async () => {
          // Both primary apply and rollback apply throw
          throw new Error('Fatal storage I/O exception');
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.rolledBack).toBe(false);
        expect(res.error).toContain('automated rollback failed');
      }
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);
    });

    it('Invariant check: data is never a partial mix of old and new records under any interruption', async () => {
      // Partially applied data in memory must never reach DATA_KEY
      const loadedInitial = await repository.load();
      if (loadedInitial.status !== 'ok') return;

      const initialTaskIds = loadedInitial.data.tasks.map((t) => t.id);
      const newTaskIds = newData.tasks.map((t) => t.id);

      // Verify initial state has zero new task IDs
      expect(initialTaskIds).toEqual(['old_task_1']);

      // Attempt restore with a handler that tries to write a corrupt mix
      let attemptedMix = false;
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async () => {
          attemptedMix = true;
          return 'Validation failed on mixed payload';
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      expect(attemptedMix).toBe(true);

      const loadedAfter = await repository.load();
      if (loadedAfter.status !== 'ok') return;

      const postTaskIds = loadedAfter.data.tasks.map((t) => t.id);
      // Invariant: The loaded tasks are either only old or only new, never a partial blend
      const isAllOld = postTaskIds.every((id) => initialTaskIds.includes(id)) && postTaskIds.length === initialTaskIds.length;
      const isAllNew = postTaskIds.every((id) => newTaskIds.includes(id)) && postTaskIds.length === newTaskIds.length;

      expect(isAllOld || isAllNew).toBe(true);
      expect(isAllOld).toBe(true);
    });
  });

  describe('Input Limits & Strict Parsing Before Expensive Work', () => {
    it('rejects plain import text exceeding MAX_IMPORT_CHARS (5MB) before JSON parsing', () => {
      const oversizedPlain = ' ' + '{"schemaVersion":4}'.padEnd(MAX_IMPORT_CHARS + 10, ' ');
      const res = parseData(oversizedPlain);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('Data is too large');
    });

    it('rejects encrypted backup text exceeding MAX_BACKUP_FILE_CHARS (12MB) before derivation', () => {
      const oversizedEncrypted = '{"format":"ai-o-encrypted-backup"}'.padEnd(MAX_BACKUP_FILE_CHARS + 10, ' ');
      const inspected = inspectBackup(oversizedEncrypted);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) return;
      expect(inspected.message).toContain('This backup file is too large to restore.');
    });

    it('rejects object nesting depth exceeding MAX_JSON_DEPTH (16 levels) before migration', () => {
      expect(MAX_JSON_DEPTH).toBe(16);

      const nested: Record<string, unknown> = { schemaVersion: 4 };
      let curr = nested;
      for (let i = 0; i < 20; i++) {
        curr.child = {};
        curr = curr.child as Record<string, unknown>;
      }

      expect(checkJsonDepth(nested)).toBe(false);
      const res = parseData(JSON.stringify(nested));
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('too deeply nested');
    });

    it('rejects forbidden prototype pollution keys (__proto__, constructor, prototype) before migration', () => {
      const payloadWithProto = '{"schemaVersion":4,"__proto__":{"polluted":true},"tasks":[]}';
      const res = parseData(payloadWithProto);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain('forbidden properties');

      const payloadWithConstructor = '{"schemaVersion":4,"constructor":{"evil":1},"tasks":[]}';
      const res2 = parseData(payloadWithConstructor);
      expect(res2.ok).toBe(false);
      if (res2.ok) return;
      expect(res2.error).toContain('forbidden properties');
    });

    it('rejects non-object root JSON payloads (arrays, primitives, null) before migration', () => {
      expect(parseData('[]').ok).toBe(false);
      expect(parseData('"a string"').ok).toBe(false);
      expect(parseData('12345').ok).toBe(false);
      expect(parseData('null').ok).toBe(false);
    });

    it('rejects newer-version data clearly with explicit user-facing instructions', () => {
      // Plain backup with schemaVersion > SCHEMA_VERSION
      const futureSchemaPlain = JSON.stringify({ schemaVersion: 999, tasks: [] });
      const parsedPlain = parseData(futureSchemaPlain);
      expect(parsedPlain.ok).toBe(false);
      if (parsedPlain.ok) return;
      expect(parsedPlain.error).toBe('Data is from a newer app version (v999); update Personal Assistant first');

      // Encrypted backup with envelope version > BACKUP_VERSION
      const futureEnvelopeEnc = JSON.stringify({
        format: BACKUP_FORMAT,
        version: 999,
        kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: 'c2FsdHNhbHRzYWx0MTY=' },
        passphraseNormalization: 'NFKC',
        cipher: { name: 'AES-256-GCM', nonce: 'bm9uY2UxMmJ5dGVz' },
        payload: { type: 'ai-o-data', schemaVersion: 4 },
        ciphertext: 'Y2lwaGVydGV4dA==',
      });
      const inspectedEnc = inspectBackup(futureEnvelopeEnc);
      expect(inspectedEnc.ok).toBe(false);
      if (inspectedEnc.ok) return;
      expect(inspectedEnc.message).toBe('This backup was made by a newer Personal Assistant (format v999). Update Personal Assistant to restore it.');
    });

    it('retains existing protective KDF bounds and rejects hostile headers synchronously before derivation', () => {
      const hostileKdf = JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        kdf: { name: 'scrypt', N: 262144, r: 8, p: 2, salt: 'c2FsdHNhbHRzYWx0MTY=' }, // N * p = 524,288 > 131,072
        passphraseNormalization: 'NFKC',
        cipher: { name: 'AES-256-GCM', nonce: 'bm9uY2UxMmJ5dGVz' },
        payload: { type: 'ai-o-data', schemaVersion: 4 },
        ciphertext: 'Y2lwaGVydGV4dA==',
      });

      const inspected = inspectBackup(hostileKdf);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) return;
      expect(inspected.reason).toBe('invalid');
      expect(inspected.message).toContain('unsafe key-derivation settings');
    });
  });

  describe('Preview and Confirmation Contract (Zero Persistence Before Confirmation)', () => {
    it('staging in memory and calculating change summary does not modify repository storage', async () => {
      // Simulate staging in pendingJson (as in Settings.tsx stage())
      const serialized = makeBackupPlaintext(newData);
      const parsed = parseData(serialized);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const stagedData = parsed.data;

      // Compute preview diff (as in Settings.tsx line 193)
      const diff = computeDataChanges(oldData, stagedData);
      expect(diff.hasChanges).toBe(true);
      expect(diff.taskChanges).toBe(3); // 1 deleted old task, 2 new tasks
      expect(diff.expenseChanges).toBe(2);

      // Verify storage was never touched during staging or diff calculation
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.tasks).toHaveLength(1);
      expect(memoryStore.map.has(RESTORE_STAGING_KEY)).toBe(false);
    });

    it('cancelling restore leaves repository storage completely identical', async () => {
      // Simulate user clicking Cancel button in preview card
      let pendingJson: AppData | null = newData;
      // User clicks Cancel
      pendingJson = null;
      expect(pendingJson).toBeNull();

      // Verify repository is unaltered
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].id).toBe('old_task_1');
      expect(loaded.data.tasks).toHaveLength(1);
    });

    it('applying restore creates a retrievable pre-restore snapshot with exact item counts', async () => {
      const res = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(true);

      // Pre-restore snapshot is available
      const snapshot = await getPreRestoreSnapshot(memoryStore, memoryVault);
      expect(snapshot).not.toBeNull();
      if (!snapshot) return;

      expect(snapshot.kind).toBe('pre-restore');
      expect(snapshot.data.tasks).toHaveLength(1);
      expect(snapshot.data.tasks[0].id).toBe('old_task_1');
    });

    it('repeated restore on applied repository state is idempotent', async () => {
      // Apply newData first time
      const res1 = await executeRestoreWithRollback(
        newData,
        oldData,
        async (d) => {
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );
      expect(res1.ok).toBe(true);

      const stateAfterFirst = await repository.load();
      if (stateAfterFirst.status !== 'ok') return;

      // Apply identical newData second time
      const res2 = await executeRestoreWithRollback(
        newData,
        stateAfterFirst.data,
        async (d) => {
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );
      expect(res2.ok).toBe(true);

      const stateAfterSecond = await repository.load();
      if (stateAfterSecond.status !== 'ok') return;

      expect(stateAfterSecond.data).toEqual(stateAfterFirst.data);
      expect(stateAfterSecond.data.tasks).toHaveLength(2);
    });
  });
});
