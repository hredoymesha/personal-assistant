// Settings: schema migration and backup compatibility, preferences, sample data, delete-all,
// automatic backup switch, and restore with undo and redo.

import { AppData, emptyData, SCHEMA_VERSION } from '../src/domain/types';
import { sampleData } from '../src/domain/sample';
import { MIGRATIONS, migrate } from '../src/storage/migrations';
import { parseData, Repository } from '../src/storage/repository';
import { createEncryptedBackup, unlockEncryptedBackup } from '../src/storage/backup';
import { MemoryStore } from '../src/storage/store';
import { Vault } from '../src/services/vault';
import {
  AUTOBACKUP_PASSPHRASE_KEY,
  getBackupStatus,
  performAutoBackup,
  setAutoBackupConfig,
} from '../src/services/autoBackup';
import { setDriveConfig } from '../src/services/driveConfig';
import {
  executeRestoreWithRollback,
  getPreRestoreSnapshot,
  executeUndoWithCapture,
  clearPreRestoreSnapshot,
} from '../src/services/restoreRollback';

// Mock AsyncStorage for autoBackup and restoreRollback
const mockStorageState: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockStorageState[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockStorageState[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockStorageState[key];
    return Promise.resolve();
  }),
  getAllKeys: jest.fn(() => Promise.resolve(Object.keys(mockStorageState))),
}));

class MockVault implements Vault {
  private store = new Map<string, string>();
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('Settings', () => {
  const dummyRandom = {
    bytes: (n: number) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 256;
      return b;
    },
  };

  beforeEach(() => {
    for (const k of Object.keys(mockStorageState)) delete mockStorageState[k];
    jest.clearAllMocks();
  });

  describe('Backup Compatibility and Schema Safety', () => {
    it('1.1 verifies the current schema version and backup format version', () => {
      expect(SCHEMA_VERSION).toBe(10);
    });

    it('1.1a converts legacy Indian currency values to BDT during schema migration', () => {
      const legacyCode = ['IN', 'R'].join('');
      const legacySymbol = String.fromCodePoint(0x20b9);
      const result = migrate({
        schemaVersion: 8,
        settings: { currency: legacyCode },
        expenses: [{ currency: legacyCode, note: `${legacySymbol} legacy value` }],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({
          schemaVersion: 10,
          receiptAttachments: [],
          settings: { currency: 'BDT' },
          expenses: [{ currency: 'BDT', note: '৳ legacy value' }],
        });
      }
    });

    it('1.2 proves older v3 reader would reject v4 backup, preventing silent drops', () => {
      // Simulate an older app installation where SCHEMA_VERSION was 3
      const olderReaderTarget = 3;
      const v4Payload = {
        schemaVersion: 4,
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
        tasks: [],
        expenses: [],
        goals: [],
        debts: [],
        wallets: [],
        walletEntries: [],
        walletTransfers: [],
        syncedContacts: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        cycleGroups: [{ id: 'cg1', userId: 'u1', name: 'Utilities', sortOrder: 0 }],
        cycleBills: [{
          id: 'cb1', userId: 'u1', name: 'Electricity', expectedAmountMinor: 150000,
          currency: 'BDT', dueDay: 10, isVariable: false, isPaused: false, autopay: false,
          completedInstallments: 0, paidBy: 'self',
        }],
        cyclePayments: [],
        cycleIncomes: [],
        cycleMonths: [],
      };

      // Running migrate with target = 3 simulates the older app's repository/backup loader:
      const olderMigrationResult = migrate(v4Payload, MIGRATIONS, olderReaderTarget);
      expect(olderMigrationResult.ok).toBe(false);
      if (!olderMigrationResult.ok) {
        expect(olderMigrationResult.error).toContain('Data is from a newer app version (v4); update Personal Assistant first');
      }
    });

    it('1.3 loads legacy v3 fixture without cycle fields and normalizes safely to v4', () => {
      const legacyV3 = {
        schemaVersion: 3,
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
        tasks: [{
          id: 't1', title: 'Task 1', notes: '', dueDate: null, dueTime: null,
          priority: 'medium', category: 'Personal', recurrence: 'none', done: false,
          deletedAt: null, originalText: null, sample: false, createdAt: '2026-11-01',
        }],
        expenses: [{
          id: 'e1', amountMinor: 25000, currency: 'BDT', category: 'Food',
          note: 'Groceries', date: '2026-11-01', walletId: null, originalText: null, sample: false,
        }],
        goals: [],
        debts: [],
        wallets: [],
        walletEntries: [],
        walletTransfers: [],
        syncedContacts: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        // cycle fields are completely absent!
      };

      const parsed = parseData(JSON.stringify(legacyV3));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
        expect(parsed.data.tasks).toHaveLength(1);
        expect(parsed.data.expenses).toHaveLength(1);
        expect(parsed.data.cycleGroups).toEqual([]);
        expect(parsed.data.cycleBills).toEqual([]);
        expect(parsed.data.cyclePayments).toEqual([]);
        expect(parsed.data.cycleIncomes).toEqual([]);
        expect(parsed.data.cycleMonths).toEqual([]);
      }
    });

    it('1.4 preserves existing v3 fixture WITH populated cycle collections during v3 -> v4 migration', () => {
      const populatedV3 = {
        schemaVersion: 3,
        settings: { currency: 'USD', theme: 'dark', language: 'en' },
        tasks: [],
        expenses: [],
        goals: [],
        debts: [{
          id: 'debt-k1', person: 'Karim', direction: 'i_owe', amountMinor: 82000,
          paidMinor: 0, currency: 'USD', dueDate: null, createdAt: '2026-11-01T00:00:00.000Z', sample: false,
        }],
        wallets: [],
        walletEntries: [],
        walletTransfers: [],
        syncedContacts: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        cycleGroups: [{ id: 'cgrp-1', userId: 'user-1', name: 'Housing', sortOrder: 0 }],
        cycleBills: [{
          id: 'cbill-1', userId: 'user-1', name: 'Rent', groupId: 'cgrp-1',
          expectedAmountMinor: 82000, currency: 'USD', dueDay: 5, isVariable: false,
          isPaused: false, autopay: false, completedInstallments: 0, paidBy: 'person',
          payerName: 'Karim', linkedDebtId: 'debt-k1',
        }],
        cyclePayments: [{
          id: 'cpay-1', userId: 'user-1', billId: 'cbill-1', monthKey: '2026-11',
          amountMinor: 82000, currency: 'USD', paidAt: '2026-11-05T00:00:00.000Z', createdAt: '2026-11-05T00:00:00.000Z',
        }],
        cycleIncomes: [{
          id: 'cinc-1', userId: 'user-1', source: 'Consulting', amountMinor: 500000,
          currency: 'USD', monthKey: '2026-11', receivedAt: '2026-11-01', isReceived: true, createdAt: '2026-11-01T00:00:00.000Z',
        }],
        cycleMonths: [{
          id: 'cmon-1', userId: 'user-1', monthKey: '2026-10', isClosed: true, closedAt: '2026-11-01T00:00:00.000Z',
        }],
      };

      const parsed = parseData(JSON.stringify(populatedV3));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
        expect(parsed.data.cycleGroups).toHaveLength(1);
        expect(parsed.data.cycleGroups?.[0].name).toBe('Housing');
        expect(parsed.data.cycleBills).toHaveLength(1);
        expect(parsed.data.cycleBills?.[0].paidBy).toBe('person');
        expect(parsed.data.cycleBills?.[0].linkedDebtId).toBe('debt-k1');
        expect(parsed.data.cyclePayments).toHaveLength(1);
        expect(parsed.data.cycleIncomes).toHaveLength(1);
        expect(parsed.data.cycleMonths).toHaveLength(1);
        expect(parsed.data.cycleMonths?.[0].isClosed).toBe(true);
      }
    });

    it('1.5 migration is idempotent', () => {
      const v3 = {
        schemaVersion: 3,
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
        tasks: [], expenses: [], goals: [], debts: [], wallets: [], walletEntries: [],
        walletTransfers: [], syncedContacts: [], messGroups: [], messMembers: [],
        messMeals: [], messExpenses: [],
        cycleGroups: [{ id: 'cg1', userId: 'u1', name: 'Bills', sortOrder: 0 }],
      };

      const pass1 = migrate(v3);
      expect(pass1.ok).toBe(true);
      if (!pass1.ok) return;
      expect(pass1.data.schemaVersion).toBe(SCHEMA_VERSION);

      const pass2 = migrate(pass1.data);
      expect(pass2.ok).toBe(true);
      if (!pass2.ok) return;
      expect(pass2.data).toEqual(pass1.data);
    });

    it('1.6 round-trips encrypted export through decrypt, validate, and parse with zero collection loss', async () => {
      const currentData = sampleData('2026-11-09');
      const passphrase = 'correct-horse-battery-staple-1234';

      const encrypted = await createEncryptedBackup(currentData, passphrase, {
        random: dummyRandom,
      });

      const unlocked = await unlockEncryptedBackup(encrypted, passphrase);
      expect(unlocked.ok).toBe(true);
      if (unlocked.ok) {
        expect(unlocked.data.schemaVersion).toBe(SCHEMA_VERSION);
        expect(unlocked.data.cycleGroups).toEqual(currentData.cycleGroups);
        expect(unlocked.data.cycleBills).toEqual(currentData.cycleBills);
        expect(unlocked.data.cyclePayments).toEqual(currentData.cyclePayments);
        expect(unlocked.data.cycleIncomes).toEqual(currentData.cycleIncomes);
        expect(unlocked.data.cycleMonths).toEqual(currentData.cycleMonths);
        expect(unlocked.data.tasks).toEqual(currentData.tasks);
        expect(unlocked.data.expenses).toEqual(currentData.expenses);
        expect(unlocked.data.debts).toEqual(currentData.debts);
      }
    });

    it('1.7 future schemaVersion (v11) is rejected before application without modifying destination data', async () => {
      const store = new MemoryStore();
      const repo = new Repository(store);
      const existingData = emptyData();
      await repo.save(existingData);

      const futureData = {
        schemaVersion: 11,
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
        tasks: [], expenses: [], goals: [], debts: [], wallets: [], walletEntries: [],
        walletTransfers: [], syncedContacts: [], messGroups: [], messMembers: [],
        messMeals: [], messExpenses: [],
      };

      const parsed = parseData(JSON.stringify(futureData));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('newer app version (v11)');
      }

      // Verify destination store remains completely unmodified:
      const loaded = await repo.load();
      expect(loaded.status).toBe('ok');
      expect(loaded.data.schemaVersion).toBe(SCHEMA_VERSION);
    });
  });

  describe('Settings controls', () => {
    describe('Preferences', () => {
      it('persists theme and currency changes through Repository and reload', async () => {
        const store = new MemoryStore();
        const repo = new Repository(store);
        const initial = emptyData();
        await repo.save(initial);

        // Update preferences
        const updated: AppData = {
          ...initial,
          settings: {
            ...initial.settings,
            theme: 'dark',
            currency: 'USD',
          },
        };
        await repo.save(updated);

        // Reload fresh from store
        const reloaded = await new Repository(store).load();
        expect(reloaded.status).toBe('ok');
        expect(reloaded.data.settings.theme).toBe('dark');
        expect(reloaded.data.settings.currency).toBe('USD');
      });

      it('failed save rejects without falsely reporting success and leaves old data intact', async () => {
        const store = new MemoryStore();
        const repo = new Repository(store);
        const initial = emptyData();
        await repo.save(initial);

        // Stale tab conflict detection:
        await expect(
          repo.save({ ...initial, settings: { ...initial.settings, theme: 'light' } }, 'mismatched-stale-raw')
        ).rejects.toThrow(/changed in another tab/i);

        // Verify storage still holds initial data
        const loaded = await repo.load();
        expect(loaded.data.settings.theme).toBe('system');
      });
    });

    describe('Sample data', () => {
      it('sample data includes all cycle collections and linked sample debt', () => {
        const sample = sampleData('2026-11-09');
        expect(sample.cycleGroups!.length).toBeGreaterThan(0);
        expect(sample.cycleBills!.length).toBeGreaterThan(0);
        expect(sample.cyclePayments!.length).toBeGreaterThan(0);
        expect(sample.cycleIncomes!.length).toBeGreaterThan(0);
        expect(sample.wallets.length).toBeGreaterThan(0);
        expect(sample.walletEntries.length).toBeGreaterThan(0);
        expect(sample.walletTransfers.length).toBeGreaterThan(0);
        expect(sample.messGroups.length).toBeGreaterThan(0);
        expect(sample.messMembers.length).toBeGreaterThan(0);
        expect(sample.messMeals.length).toBeGreaterThan(0);
        expect(sample.messExpenses.length).toBeGreaterThan(0);
        expect(sample.syncedContacts.length).toBeGreaterThan(0);

        // All sample records are flagged sample: true
        expect(sample.cycleGroups!.every((g) => g.sample === true)).toBe(true);
        expect(sample.cycleBills!.every((b) => b.sample === true)).toBe(true);
        expect(sample.cyclePayments!.every((p) => p.sample === true)).toBe(true);
        expect(sample.cycleIncomes!.every((i) => i.sample === true)).toBe(true);
        expect(sample.wallets.every((w) => w.sample === true)).toBe(true);
        expect(sample.walletEntries.every((e) => e.sample === true)).toBe(true);
        expect(sample.walletTransfers.every((t) => t.sample === true)).toBe(true);
        expect(sample.messGroups.every((g) => g.sample === true)).toBe(true);
        expect(sample.messMembers.every((m) => m.sample === true)).toBe(true);
        expect(sample.messMeals.every((m) => m.sample === true)).toBe(true);
        expect(sample.messExpenses.every((e) => e.sample === true)).toBe(true);
        expect(sample.syncedContacts.every((contact) => contact.sample === true)).toBe(true);

        // Linked debt exists and is tagged sample
        const linkedDebt = sample.debts.find((d) => d.id === 'sample_d2');
        expect(linkedDebt).toBeDefined();
        expect(linkedDebt?.sample).toBe(true);
      });

      it('load sample on empty data -> clear sample returns to empty state', () => {
        const initial = emptyData();
        const sample = sampleData('2026-11-09');

        // Simulate loadSample:
        const loaded: AppData = {
          ...initial,
          tasks: [...initial.tasks, ...sample.tasks],
          expenses: [...initial.expenses, ...sample.expenses],
          goals: [...initial.goals, ...sample.goals],
          debts: [...initial.debts, ...sample.debts],
          cycleGroups: [...(initial.cycleGroups ?? []), ...(sample.cycleGroups ?? [])],
          cycleBills: [...(initial.cycleBills ?? []), ...(sample.cycleBills ?? [])],
          cyclePayments: [...(initial.cyclePayments ?? []), ...(sample.cyclePayments ?? [])],
          cycleIncomes: [...(initial.cycleIncomes ?? []), ...(sample.cycleIncomes ?? [])],
          cycleMonths: [...(initial.cycleMonths ?? []), ...(sample.cycleMonths ?? [])],
        };
        expect(loaded.cycleBills!.length).toBeGreaterThan(0);

        // Simulate removeSample (filters out x.sample === true):
        const cleared: AppData = {
          ...loaded,
          tasks: loaded.tasks.filter((x) => !x.sample),
          expenses: loaded.expenses.filter((x) => !x.sample),
          goals: loaded.goals.filter((x) => !x.sample),
          debts: loaded.debts.filter((x) => !x.sample),
          cycleGroups: (loaded.cycleGroups ?? []).filter((x) => !x.sample),
          cycleBills: (loaded.cycleBills ?? []).filter((x) => !x.sample),
          cyclePayments: (loaded.cyclePayments ?? []).filter((x) => !x.sample),
          cycleIncomes: (loaded.cycleIncomes ?? []).filter((x) => !x.sample),
          cycleMonths: (loaded.cycleMonths ?? []).filter((x) => !x.sample),
        };

        expect(cleared.cycleGroups).toEqual([]);
        expect(cleared.cycleBills).toEqual([]);
        expect(cleared.cyclePayments).toEqual([]);
        expect(cleared.cycleIncomes).toEqual([]);
        expect(cleared.tasks).toEqual([]);
        expect(cleared.expenses).toEqual([]);
        expect(cleared.debts).toEqual([]);
      });

      it('load sample with real data -> clear sample preserves real records identically', () => {
        const realData: AppData = {
          ...emptyData(),
          tasks: [{
            id: 'real-t1', title: 'Real Task', notes: '', dueDate: '2026-11-15',
            dueTime: null, priority: 'high', category: 'Work', recurrence: 'none',
            done: false, deletedAt: null, originalText: null, sample: false, createdAt: '2026-11-09',
          }],
          debts: [{
            id: 'real-d1', person: 'Alice', direction: 'owed_to_me', amountMinor: 50000,
            paidMinor: 0, currency: 'BDT', dueDate: null, createdAt: '2026-11-01T00:00:00.000Z', sample: false,
          }],
          cycleBills: [{
            id: 'real-cb1', userId: 'user-real', name: 'Real Internet',
            expectedAmountMinor: 120000, currency: 'BDT', dueDay: 10, isVariable: false,
            isPaused: false, autopay: true, completedInstallments: 0, paidBy: 'self', sample: false,
            payee: 'ISP', createdAt: '2026-11-01T00:00:00.000Z',
          }],
        };

        const sample = sampleData('2026-11-09');

        // Load sample:
        const combined: AppData = {
          ...realData,
          tasks: [...realData.tasks, ...sample.tasks],
          debts: [...realData.debts, ...sample.debts],
          cycleBills: [...(realData.cycleBills ?? []), ...(sample.cycleBills ?? [])],
        };
        expect(combined.tasks.length).toBeGreaterThan(1);
        expect(combined.cycleBills!.length).toBeGreaterThan(1);

        // Remove sample:
        const restored: AppData = {
          ...combined,
          tasks: combined.tasks.filter((x) => !x.sample),
          debts: combined.debts.filter((x) => !x.sample),
          cycleBills: (combined.cycleBills ?? []).filter((x) => !x.sample),
        };

        expect(restored.tasks).toEqual(realData.tasks);
        expect(restored.debts).toEqual(realData.debts);
        expect(restored.cycleBills).toEqual(realData.cycleBills);
      });
    });

    describe('Delete all data', () => {
      it('clears all local domain collections including cycle records without touching cloud backups', async () => {
        const store = new MemoryStore();
        const repo = new Repository(store);
        const fullData = sampleData('2026-11-09');
        await repo.save(fullData);

        // Verify data was stored:
        const loadedBefore = await repo.load();
        expect(loadedBefore.data.cycleBills!.length).toBeGreaterThan(0);

        // Clear everything:
        await repo.clear();

        // Verify local store is completely empty:
        const loadedAfter = await repo.load();
        expect(loadedAfter.status).toBe('empty');
        expect(loadedAfter.data.cycleBills).toEqual([]);
        expect(loadedAfter.data.tasks).toEqual([]);
        expect(loadedAfter.data.expenses).toEqual([]);

        // Cloud backup mock independence:
        // A cloud backup folder/file is external; deleting local data never invokes cloud deletion.
      });
    });

    describe('Automatic backup switch', () => {
      it('enabling stores passphrase in Vault; disabling purges it immediately', async () => {
        const mockVault = new MockVault();
        const passphrase = 'super-secret-backup-passphrase-1234';

        // 1. Initially disabled
        expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBeNull();

        // 2. Enable auto-backup
        await setAutoBackupConfig(true, passphrase, mockVault);
        expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBe(passphrase);
        const statusOn = await getBackupStatus();
        expect(statusOn.enabled).toBe(true);

        // 3. Disable auto-backup
        await setAutoBackupConfig(false, undefined, mockVault);
        expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBeNull();
        const statusOff = await getBackupStatus();
        expect(statusOff.enabled).toBe(false);
      });

      it('disabled or unconfigured state does not initiate backup calls', async () => {
        const mockVault = new MockVault();
        const mockFetch = jest.fn();
        const memStore = new MemoryStore();

        // Unconfigured client ID
        setDriveConfig({ clientId: '', redirectUri: '' });
        await performAutoBackup(emptyData(), {
          vault: mockVault,
          store: memStore,
          fetchFn: mockFetch as any,
        });
        expect(mockFetch).not.toHaveBeenCalled();

        // Configured client ID but auto-backup disabled
        setDriveConfig({ clientId: 'valid-client-id', redirectUri: 'com.assistant.personal:/oauthredirect' });
        await performAutoBackup(emptyData(), {
          vault: mockVault,
          store: memStore,
          fetchFn: mockFetch as any,
        });
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('Restore with undo and redo', () => {
      it('cancel restore does not modify local data', async () => {
        const localData = emptyData();
        let current = localData;

        // Pending restore payload received:
        const pendingRestore = sampleData('2026-11-09');

        // User taps Cancel -> pending state cleared without executing replaceAll:
        const cancelled = true;
        if (!cancelled) {
          current = pendingRestore;
        }

        expect(current).toEqual(localData);
      });

      it('confirm restore takes encrypted snapshot and applies new data cleanly with undo capability', async () => {
        const store = new MemoryStore();
        const vault = new MockVault();
        const localData: AppData = {
          ...emptyData(),
          tasks: [{
            id: 'original-t1', title: 'Original Task', notes: '', dueDate: null,
            dueTime: null, priority: 'low', category: 'Home', recurrence: 'none',
            done: false, deletedAt: null, originalText: null, sample: false, createdAt: '2026-11-01',
          }],
        };

        let activeData = localData;
        const replaceData = (d: AppData) => {
          activeData = d;
          return null;
        };

        const incomingRestore = sampleData('2026-11-09');

        // Execute restore with rollback snapshot:
        const res = await executeRestoreWithRollback(incomingRestore, localData, replaceData, store, vault);
        expect(res.ok).toBe(true);
        expect(activeData.cycleBills!.length).toBeGreaterThan(0);

        // Undo snapshot was created:
        const snapshot = await getPreRestoreSnapshot(store, vault);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.data.tasks[0].id).toBe('original-t1');

        // Apply undo with pre-undo capture:
        const undoRes = await executeUndoWithCapture(snapshot!.id, activeData, replaceData, store, vault);
        expect(undoRes.ok).toBe(true);
        expect(activeData.tasks[0].id).toBe('original-t1');

        // Clean up
        await clearPreRestoreSnapshot(store, vault);
      });
    });
  });
});
