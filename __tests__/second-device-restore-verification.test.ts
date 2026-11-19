import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  inspectBackup,
  type BackupHeader,
} from '../src/crypto/backup';
import {
  createEncryptedBackup,
  unlockEncryptedBackup,
} from '../src/storage/backup';
import { base64Encode, utf8Encode } from '../src/crypto/bytes';
import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { Repository, parseData } from '../src/storage/repository';
import { executeRestoreWithRollback } from '../src/services/restoreRollback';
import { validateAppData } from '../src/domain/validation';
import {
  emptyData,
  SCHEMA_VERSION,
  type AppData,
  type Task,
  type Expense,
  type Debt,
  type Wallet,
  type MessGroup,
  type MessMember,
} from '../src/domain/types';
import type { KeyValueStore } from '../src/storage/store';
import type { Vault } from '../src/services/vault';
import type { RandomSource } from '../src/crypto/random';

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

class MemoryStore implements KeyValueStore {
  public map = new Map<string, string>();
  public failNextWrite = false;

  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failNextWrite) {
      throw new Error('Simulated disk full or storage quota exceeded');
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

class MemoryVault implements Vault {
  private items = new Map<string, string>();
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async get(key: string): Promise<string | null> {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.items.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.items.delete(key);
  }
}

const mockRandomSource: RandomSource = {
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (i * 43 + 7) % 256;
    return out;
  },
};

const TEST_PASSPHRASE = 'fictional test passphrase for second device verification 1234';

function makeValidTask(id: string, title: string, overrides: Partial<Task> = {}): Task {
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

function makeValidExpense(id: string, amountMinor: number, overrides: Partial<Expense> = {}): Expense {
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

function makeValidDebt(id: string, person: string, amountMinor: number, overrides: Partial<Debt> = {}): Debt {
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

async function createCustomEncryptedBackup(
  plaintext: string,
  passphrase: string,
  kdfParams: { name: 'scrypt'; N: number; r: number; p: number },
  schemaVersion: number = SCHEMA_VERSION,
): Promise<string> {
  const salt = mockRandomSource.bytes(16);
  const nonce = mockRandomSource.bytes(12);
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: { ...kdfParams, salt: base64Encode(salt) },
    passphraseNormalization: 'NFKC',
    cipher: { name: 'AES-256-GCM', nonce: base64Encode(nonce) },
    payload: { type: 'ai-o-data', schemaVersion },
  };
  const pw = utf8Encode(passphrase.normalize('NFKC'));
  const key = await scryptAsync(pw, salt, { N: kdfParams.N, r: kdfParams.r, p: kdfParams.p, dkLen: 32 });
  const aad = utf8Encode([
    header.format,
    header.version,
    header.kdf.name,
    header.kdf.N,
    header.kdf.r,
    header.kdf.p,
    header.kdf.salt,
    header.passphraseNormalization,
    header.cipher.name,
    header.cipher.nonce,
    header.payload.type,
    header.payload.schemaVersion,
  ].join('|'));
  const pt = utf8Encode(plaintext);
  const ct = gcm(key, nonce, aad).encrypt(pt);
  return JSON.stringify({ ...header, ciphertext: base64Encode(ct) });
}

describe('Verify old backups still restore; second-device restore', () => {
  describe('Pre-change Golden Files Restore Verification Through Staged Restore Path', () => {
    it('restores legacy v0 golden archive (unversioned, defaults settings, upgrades to schema v4)', async () => {
      const v0GoldenJson = JSON.stringify({
        tasks: [makeValidTask('task-v0-1', 'Legacy v0 task')],
        expenses: [makeValidExpense('exp-v0-1', 25000, { note: 'Pre-change lunch' })],
        goals: [],
        debts: [makeValidDebt('debt-v0-1', 'Rahim', 50000)],
      });

      const store = new MemoryStore();
      const vault = new MemoryVault();
      const repo = new Repository(store);

      const parsed = parseData(v0GoldenJson);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.data.settings.currency).toBe('BDT');
      expect(parsed.data.settings.theme).toBe('system');

      const restoreRes = await executeRestoreWithRollback(
        parsed.data,
        emptyData(),
        async (incoming) => {
          await repo.save(incoming);
          return null;
        },
        store,
        vault,
      );

      expect(restoreRes.ok).toBe(true);

      const loaded = await repo.load();
      expect(loaded.status).toBe('ok');
      expect(loaded.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(loaded.data.tasks[0].title).toBe('Legacy v0 task');
      expect(loaded.data.expenses[0].amountMinor).toBe(25000);
      expect(loaded.data.debts[0].person).toBe('Rahim');

      // Staging key cleaned up
      expect(await store.getItem('aio.data.staging')).toBeNull();
    });

    it('restores schema v1 golden archive preserving custom currency and dark theme', async () => {
      const v1GoldenJson = JSON.stringify({
        schemaVersion: 1,
        tasks: [makeValidTask('task-v1', 'v1 Task', { done: true, category: 'Work' })],
        expenses: [makeValidExpense('exp-v1', 1500, { currency: 'USD', category: 'Software', note: 'Domain renewal' })],
        goals: [],
        debts: [],
        settings: { currency: 'USD', theme: 'dark', language: 'en' },
      });

      const store = new MemoryStore();
      const vault = new MemoryVault();
      const repo = new Repository(store);

      const parsed = parseData(v1GoldenJson);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.data.settings.currency).toBe('USD');
      expect(parsed.data.settings.theme).toBe('dark');

      const restoreRes = await executeRestoreWithRollback(
        parsed.data,
        emptyData(),
        async (incoming) => {
          await repo.save(incoming);
          return null;
        },
        store,
        vault,
      );

      expect(restoreRes.ok).toBe(true);

      const loaded = await repo.load();
      expect(loaded.status).toBe('ok');
      expect(loaded.data.settings.currency).toBe('USD');
      expect(loaded.data.settings.theme).toBe('dark');
    });

    it('restores schema v2 golden archive preserving debts with null createdAt', async () => {
      const v2GoldenJson = JSON.stringify({
        schemaVersion: 2,
        tasks: [],
        expenses: [],
        goals: [],
        debts: [makeValidDebt('debt-v2', 'Karim', 80000, { paidMinor: 10000, createdAt: null })],
        wallets: [{ id: 'w1', name: 'Cash', currency: 'BDT', openingBalanceMinor: 10000, createdAt: '2026-03-01' }],
        walletEntries: [],
        walletTransfers: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        syncedContacts: [],
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
      });

      const store = new MemoryStore();
      const vault = new MemoryVault();
      const repo = new Repository(store);

      const parsed = parseData(v2GoldenJson);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.data.debts[0].createdAt).toBeNull();

      const restoreRes = await executeRestoreWithRollback(
        parsed.data,
        emptyData(),
        async (incoming) => {
          await repo.save(incoming);
          return null;
        },
        store,
        vault,
      );

      expect(restoreRes.ok).toBe(true);
      const loaded = await repo.load();
      expect(loaded.data.debts[0].createdAt).toBeNull();
    });

    it('restores schema v3 golden archive upgrading monthly cycle structures to schema v4', async () => {
      const v3GoldenJson = JSON.stringify({
        schemaVersion: 3,
        tasks: [],
        expenses: [],
        goals: [],
        debts: [],
        wallets: [],
        walletEntries: [],
        walletTransfers: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        syncedContacts: [],
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
        cycleGroups: [{ id: 'grp-1', userId: 'u1', name: 'Utilities', sortOrder: 0, createdAt: '2026-05-01T00:00:00.000Z' }],
        cycleBills: [{
          id: 'bill-1',
          userId: 'u1',
          name: 'Internet Bill',
          group: 'Utilities',
          expectedAmountMinor: 120000,
          currency: 'BDT',
          dueDay: 10,
          payee: 'ISP',
          isVariable: false,
          isPaused: false,
          autopay: false,
          completedInstallments: 0,
          createdAt: '2026-05-01T00:00:00.000Z',
        }],
        cycleIncomes: [{
          id: 'inc-1',
          userId: 'u1',
          source: 'Primary Salary',
          amountMinor: 8500000,
          currency: 'BDT',
          monthKey: '2026-05',
          receivedAt: '2026-05-01',
          isReceived: true,
          createdAt: '2026-05-01T00:00:00.000Z',
        }],
        cyclePayments: [],
        cycleMonths: [],
      });

      const store = new MemoryStore();
      const vault = new MemoryVault();
      const repo = new Repository(store);

      const parsed = parseData(v3GoldenJson);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.data.cycleBills?.[0].name).toBe('Internet Bill');
      expect(parsed.data.cycleIncomes?.[0].amountMinor).toBe(8500000);

      const restoreRes = await executeRestoreWithRollback(
        parsed.data,
        emptyData(),
        async (incoming) => {
          await repo.save(incoming);
          return null;
        },
        store,
        vault,
      );

      expect(restoreRes.ok).toBe(true);
      const loaded = await repo.load();
      expect(loaded.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(loaded.data.cycleBills?.[0].id).toBe('bill-1');
    });

    it('restores encrypted golden archive with legacy KDF (N=16,384, r=8, p=2)', async () => {
      const plaintext = JSON.stringify({
        ...emptyData(),
        tasks: [makeValidTask('t-legacy-kdf', 'Encrypted with legacy KDF')],
      });

      const legacyEncryptedFile = await createCustomEncryptedBackup(
        plaintext,
        TEST_PASSPHRASE,
        { name: 'scrypt', N: 16384, r: 8, p: 2 },
        4,
      );

      const inspectRes = inspectBackup(legacyEncryptedFile);
      expect(inspectRes.ok).toBe(true);

      const unlockRes = await unlockEncryptedBackup(legacyEncryptedFile, TEST_PASSPHRASE);
      expect(unlockRes.ok).toBe(true);
      if (!unlockRes.ok) return;

      const store = new MemoryStore();
      const vault = new MemoryVault();
      const repo = new Repository(store);

      const restoreRes = await executeRestoreWithRollback(
        unlockRes.data,
        emptyData(),
        async (incoming) => {
          await repo.save(incoming);
          return null;
        },
        store,
        vault,
      );

      expect(restoreRes.ok).toBe(true);
      const loaded = await repo.load();
      expect(loaded.data.tasks[0].title).toBe('Encrypted with legacy KDF');
    });
  });

  describe('End-to-End Second-Device Restore Simulation', () => {
    it('proves an encrypted backup created on Device A restores completely and identically on Device B', async () => {
      // 1. Device A: populated production state
      const taskA = makeValidTask('task-a-1', 'Review quarterly financial report', {
        notes: 'Check balance sheet against khata entries',
        dueDate: '2026-11-15',
        dueTime: '14:30',
        priority: 'high',
        category: 'Finance',
      });

      const walletA: Wallet = {
        id: 'wallet-a-1',
        name: 'City Bank Checking',
        currency: 'BDT',
        openingBalanceMinor: 5000000,
        createdAt: '2026-11-01T10:00:00.000Z',
      };

      const expenseA = makeValidExpense('exp-a-1', 145000, {
        category: 'Office',
        note: 'Monitor stand and cables',
        date: '2026-11-05',
        walletId: 'wallet-a-1',
      });

      const debtA = makeValidDebt('debt-a-1', 'Anisul Huq', 250000, {
        paidMinor: 50000,
        dueDate: '2026-12-01',
        createdAt: '2026-11-02T11:00:00.000Z',
      });

      const messA: MessGroup = {
        id: 'mess-a-1',
        name: 'Dhanmondi Flat 4B',
        currency: 'BDT',
        createdAt: '2026-11-01T10:00:00.000Z',
      };

      const memberSelf: MessMember = {
        id: 'm-self',
        groupId: 'mess-a-1',
        name: 'Tanvir (Self)',
        contactId: null,
        isSelf: true,
      };

      const memberOther: MessMember = {
        id: 'm-other',
        groupId: 'mess-a-1',
        name: 'Hasan',
        contactId: null,
        isSelf: false,
      };

      const deviceAState: AppData = {
        ...emptyData(),
        tasks: [taskA],
        expenses: [expenseA],
        goals: [],
        debts: [debtA],
        wallets: [walletA],
        messGroups: [messA],
        messMembers: [memberSelf, memberOther],
        syncedContacts: [{
          id: 'c-1',
          fullName: 'Anisul Huq',
          phones: ['+8801700000000'],
          emails: ['anisul@example.com'],
          photoUri: null,
          syncedAt: '2026-11-02T11:00:00.000Z',
        }],
        settings: { ...emptyData().settings, currency: 'BDT', theme: 'dark' },
      };

      // Device A exports encrypted backup file
      const backupText = await createEncryptedBackup(deviceAState, TEST_PASSPHRASE, {
        random: mockRandomSource,
      });

      expect(typeof backupText).toBe('string');
      expect(backupText.length).toBeGreaterThan(100);

      // 2. Transfer to Device B (fresh phone with completely empty repository and distinct store/vault)
      const deviceBStore = new MemoryStore();
      const deviceBVault = new MemoryVault();
      const deviceBRepo = new Repository(deviceBStore);

      const deviceBInitialLoad = await deviceBRepo.load();
      expect(deviceBInitialLoad.status).toBe('empty');

      // Device B inspects header
      const inspectB = inspectBackup(backupText);
      expect(inspectB.ok).toBe(true);

      // Device B unlocks with passphrase
      const unlockB = await unlockEncryptedBackup(backupText, TEST_PASSPHRASE);
      expect(unlockB.ok).toBe(true);
      if (!unlockB.ok) return;

      // Device B verifies invariants of decrypted payload
      expect(validateAppData(unlockB.data).ok).toBe(true);

      // Device B executes staged restore with rollback snapshot protection
      const restoreBRes = await executeRestoreWithRollback(
        unlockB.data,
        deviceBInitialLoad.data,
        async (incoming) => {
          await deviceBRepo.save(incoming);
          return null;
        },
        deviceBStore,
        deviceBVault,
      );

      expect(restoreBRes.ok).toBe(true);

      // 3. Assertions on Device B persisted state
      const deviceBLoaded = await deviceBRepo.load();
      expect(deviceBLoaded.status).toBe('ok');
      expect(deviceBLoaded.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(deviceBLoaded.data.settings.currency).toBe('BDT');
      expect(deviceBLoaded.data.settings.theme).toBe('dark');
      expect(deviceBLoaded.data.tasks).toHaveLength(1);
      expect(deviceBLoaded.data.tasks[0]).toEqual(taskA);
      expect(deviceBLoaded.data.wallets).toHaveLength(1);
      expect(deviceBLoaded.data.wallets[0]).toEqual(walletA);
      expect(deviceBLoaded.data.expenses).toHaveLength(1);
      expect(deviceBLoaded.data.expenses[0]).toEqual(expenseA);
      expect(deviceBLoaded.data.debts).toHaveLength(1);
      expect(deviceBLoaded.data.debts[0]).toEqual(debtA);
      expect(deviceBLoaded.data.messGroups).toHaveLength(1);
      expect(deviceBLoaded.data.messGroups[0].name).toBe('Dhanmondi Flat 4B');
      expect(deviceBLoaded.data.messMembers).toHaveLength(2);
      expect(deviceBLoaded.data.syncedContacts).toHaveLength(1);

      // 4. Assert Device B staging key is cleaned up
      expect(await deviceBStore.getItem('aio.data.staging')).toBeNull();

      // 5. Assert Device B can undo the restore using its local snapshot
      const allBKeys = await deviceBStore.getAllKeys();
      const snapshotKeys = allBKeys.filter((k) => k.startsWith('aio.restore.snapshot.'));
      expect(snapshotKeys.length).toBeGreaterThanOrEqual(1);

      // 6. Second restore idempotency: restoring again yields identical result
      const secondRestoreRes = await executeRestoreWithRollback(
        unlockB.data,
        deviceBLoaded.data,
        async (incoming) => {
          await deviceBRepo.save(incoming);
          return null;
        },
        deviceBStore,
        deviceBVault,
      );
      expect(secondRestoreRes.ok).toBe(true);

      const deviceBLoadedSecond = await deviceBRepo.load();
      expect(deviceBLoadedSecond.data).toEqual(deviceBLoaded.data);
    });
  });
});
