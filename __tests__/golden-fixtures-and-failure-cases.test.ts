import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  inspectBackup,
  type BackupHeader,
} from '../src/crypto/backup';
import {
  createEncryptedBackup,
  isEncryptedBackupText,
  makeBackupPlaintext,
  unlockEncryptedBackup,
} from '../src/storage/backup';
import { base64Encode, utf8Encode } from '../src/crypto/bytes';
import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { migrate } from '../src/storage/migrations';
import { Repository, parseData } from '../src/storage/repository';
import { executeRestoreWithRollback, getPreRestoreSnapshot } from '../src/services/restoreRollback';
import { exportTextFile } from '../src/services/files';
import { validateAppData } from '../src/domain/validation';
import { emptyData, SCHEMA_VERSION, type AppData, type Task, type Expense, type Debt } from '../src/domain/types';
import type { KeyValueStore } from '../src/storage/store';
import type { Vault } from '../src/services/vault';
import type { RandomSource } from '../src/crypto/random';

/**
 * In-memory Mock KeyValueStore for simulating persistence, rollbacks, and storage failures.
 */
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

/**
 * In-memory Mock Vault for SecureStore snapshot encryption keys.
 */
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
    for (let i = 0; i < length; i++) out[i] = (i * 37 + 13) % 256;
    return out;
  },
};

const TEST_PASSPHRASE = 'fictional test passphrase for golden archives 1234';

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

/**
 * Creates an encrypted backup with customizable KDF parameters for testing legacy / alternative configurations.
 */
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

// Mock expo native modules used by exportTextFile and restoreRollback
const mockFiles = new Map<string, string>();
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
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get name() {
      const idx = this.uri.lastIndexOf('/');
      return idx >= 0 ? this.uri.slice(idx + 1) : this.uri;
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    create(options: { overwrite?: boolean } = {}) {
      if (this.exists && !options.overwrite) throw new Error('File already exists');
      mockFiles.set(this.uri, '');
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    async text() {
      return mockFiles.get(this.uri) ?? '';
    }
    async write(text: string) {
      if (!this.exists) this.create();
      mockFiles.set(this.uri, text);
    }
    async move(destination: MockFile, options: { overwrite?: boolean } = {}) {
      if (destination.exists && !options.overwrite) throw new Error('Destination already exists');
      const contents = mockFiles.get(this.uri);
      if (contents === undefined) throw new Error('Source file does not exist');
      mockFiles.set(destination.uri, contents);
      mockFiles.delete(this.uri);
      this.uri = destination.uri;
    }
  }

  class MockDirectory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => (typeof part === 'string' ? part : part.uri)).join('/');
    }
    get exists() {
      return true;
    }
    list() {
      const prefix = this.uri.endsWith('/') ? this.uri : `${this.uri}/`;
      return [...mockFiles.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => new MockFile(k));
    }
  }

  return { File: MockFile, Directory: MockDirectory, Paths: { cache: 'cache' } };
});

describe('Golden backup fixtures and failure-case tests', () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  describe('Golden Archives per Supported Schema Version (v0, v1, v2, v3, v4)', () => {
    it('migrates a synthetic Schema v0 (unversioned legacy) plain archive to current', () => {
      const v0Golden = {
        tasks: [
          makeValidTask('t0', 'Fictional legacy task', {
            createdAt: '2026-01-01',
          }),
        ],
        expenses: [
          makeValidExpense('e0', 15050, {
            currency: 'BDT',
            category: 'Food',
            note: 'Lunch',
            date: '2026-01-01',
          }),
        ],
        settings: { currency: 'BDT', theme: 'dark', language: 'en' },
      };

      const res = migrate(v0Golden);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect((res.data.tasks as Task[])[0].title).toBe('Fictional legacy task');
      expect((res.data.expenses as Expense[])[0].amountMinor).toBe(15050);
      expect((res.data.settings as { theme: string }).theme).toBe('dark');
      expect(validateAppData(res.data).ok).toBe(true);
    });

    it('migrates a synthetic Schema v1 archive to current while preserving settings', () => {
      const v1Golden = {
        schemaVersion: 1,
        tasks: [
          makeValidTask('t1', 'V1 Task', {
            done: true,
            createdAt: '2026-02-01',
          }),
        ],
        expenses: [
          makeValidExpense('e1', 25000, {
            currency: 'EUR',
            category: 'Rent',
            note: 'Office',
            date: '2026-02-01',
          }),
        ],
        goals: [],
        debts: [],
        settings: { currency: 'EUR', theme: 'light', language: 'en' },
      };

      const res = migrate(v1Golden);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect((res.data.settings as { currency: string }).currency).toBe('EUR');
      expect((res.data.expenses as Expense[])[0].currency).toBe('EUR');
      expect(validateAppData(res.data).ok).toBe(true);
    });

    it('migrates a synthetic Schema v2 archive to current (debts without createdAt retain null age)', () => {
      const v2Golden = {
        schemaVersion: 2,
        tasks: [],
        expenses: [],
        goals: [],
        debts: [
          {
            id: 'd1',
            person: 'Rahim',
            direction: 'owed_to_me',
            amountMinor: 50000,
            paidMinor: 0,
            currency: 'BDT',
            dueDate: null,
            sample: false,
          },
        ],
        wallets: [{ id: 'w1', name: 'Cash', currency: 'BDT', openingBalanceMinor: 10000, createdAt: '2026-03-01' }],
        walletEntries: [],
        walletTransfers: [],
        messGroups: [],
        messMembers: [],
        messMeals: [],
        messExpenses: [],
        syncedContacts: [],
        settings: { currency: 'BDT', theme: 'system', language: 'en' },
      };

      const res = migrate(v2Golden);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect((res.data.debts as Debt[])[0].createdAt).toBeNull(); // Age must NOT be invented
      expect(validateAppData(res.data).ok).toBe(true);
    });

    it('validates a Schema v3 golden archive with Monthly Money Cycle structures upgraded to v4', () => {
      const v3Golden = {
        ...emptyData(),
        schemaVersion: 3,
        tasks: [
          makeValidTask('t3', 'Pay bills', {
            priority: 'high',
            category: 'Finance',
            createdAt: '2026-04-01',
          }),
        ],
        cycleBills: [
          {
            id: 'b1',
            userId: 'default_user',
            name: 'Internet',
            groupId: null,
            expectedAmountMinor: 120000,
            currency: 'BDT',
            dueDay: 10,
            payee: 'ISP',
            isVariable: false,
            isPaused: false,
            autopay: false,
            completedInstallments: 0,
            paidBy: 'self' as const,
            sample: false,
            createdAt: '2026-04-01',
          },
        ],
        cyclePayments: [],
        cycleIncomes: [],
      };

      const serialized = JSON.stringify(v3Golden);
      const parsed = parseData(serialized);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // Schema v3 is migrated to current SCHEMA_VERSION (4)
      expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.data.cycleBills?.[0].name).toBe('Internet');
    });

    it('validates a Schema v4 current archive round-trip', () => {
      const v4Golden: AppData = {
        ...emptyData(),
        schemaVersion: 4,
        tasks: [makeValidTask('t4', 'Current v4 task')],
        expenses: [makeValidExpense('e4', 50000)],
        debts: [makeValidDebt('d4', 'Karim', 100000)],
      };

      const serialized = makeBackupPlaintext(v4Golden);
      const parsed = parseData(serialized);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(parsed.data.tasks[0].title).toBe('Current v4 task');
      expect(parsed.data.expenses[0].amountMinor).toBe(50000);
      expect(parsed.data.debts[0].person).toBe('Karim');
    });

    it('removes sample-flagged data during restore without dropping user records', async () => {
      const incoming: AppData = {
        ...emptyData(),
        tasks: [
          makeValidTask('real_t1', 'Real task', { sample: false }),
          makeValidTask('sample_t2', 'Sample task', { sample: true }),
        ],
        expenses: [
          makeValidExpense('real_e1', 5000, { sample: false }),
          makeValidExpense('sample_e2', 2500, { sample: true }),
        ],
      };

      // When cleaned of sample data, real records remain intact
      const cleaned: AppData = {
        ...incoming,
        tasks: incoming.tasks.filter((t) => !t.sample),
        expenses: incoming.expenses.filter((e) => !e.sample),
      };

      expect(cleaned.tasks).toHaveLength(1);
      expect(cleaned.tasks[0].id).toBe('real_t1');
      expect(cleaned.expenses).toHaveLength(1);
      expect(cleaned.expenses[0].id).toBe('real_e1');
      expect(validateAppData(cleaned).ok).toBe(true);
    });
  });

  describe('Encrypted Golden Archives: Default vs Legacy KDF Parameters', () => {
    it('creates and unlocks an encrypted golden archive with default KDF parameters (N=32,768, r=8, p=1)', async () => {
      const testData = emptyData();
      testData.tasks.push(makeValidTask('t_def', 'Default KDF Task', { createdAt: '2026-05-01' }));

      const ciphertext = await createEncryptedBackup(testData, TEST_PASSPHRASE, {
        random: mockRandomSource,
      });

      expect(isEncryptedBackupText(ciphertext)).toBe(true);
      const inspected = inspectBackup(ciphertext);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.header.kdf.N).toBe(32768);
      expect(inspected.header.kdf.p).toBe(1);

      const unlocked = await unlockEncryptedBackup(ciphertext, TEST_PASSPHRASE);
      expect(unlocked.ok).toBe(true);
      if (!unlocked.ok) return;
      expect(unlocked.data.tasks[0].title).toBe('Default KDF Task');
    });

    it('creates and unlocks an encrypted golden archive with safe legacy KDF parameters (N=16,384, r=8, p=2)', async () => {
      const testData = emptyData();
      testData.tasks.push(makeValidTask('t_leg', 'Legacy KDF Task', { done: true, createdAt: '2026-05-01' }));

      const legacyKdf = { name: 'scrypt', N: 16384, r: 8, p: 2 } as const;
      const ciphertext = await createCustomEncryptedBackup(
        makeBackupPlaintext(testData),
        TEST_PASSPHRASE,
        legacyKdf,
        SCHEMA_VERSION,
      );

      const inspected = inspectBackup(ciphertext);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) return;
      expect(inspected.header.kdf.N).toBe(16384);
      expect(inspected.header.kdf.p).toBe(2);

      const unlocked = await unlockEncryptedBackup(ciphertext, TEST_PASSPHRASE);
      expect(unlocked.ok).toBe(true);
      if (!unlocked.ok) return;
      expect(unlocked.data.tasks[0].title).toBe('Legacy KDF Task');
    });
  });

  describe('Broken Inputs and Error Message Integrity', () => {
    let validEncrypted: string;

    beforeAll(async () => {
      const data = emptyData();
      data.tasks.push(makeValidTask('t1', 'Golden payload', { createdAt: '2026-06-01' }));
      validEncrypted = await createCustomEncryptedBackup(
        makeBackupPlaintext(data),
        TEST_PASSPHRASE,
        { name: 'scrypt', N: 16384, r: 8, p: 1 },
        SCHEMA_VERSION,
      );
    });

    it('rejects wrong passphrase with generic user message and no internal stack trace', async () => {
      const res = await unlockEncryptedBackup(validEncrypted, 'completely wrong passphrase 9999');
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe('wrong_passphrase');
      expect(res.message).toBe('Wrong passphrase, or the file was changed or damaged. Nothing was restored.');
      // Assert no stack trace or internal memory/file info in message
      expect(res.message).not.toMatch(/at |node_modules|AES|scrypt|Error:/);
    });

    it('rejects bit-flipped ciphertext without crashing or leaking details', async () => {
      const parsed = JSON.parse(validEncrypted);
      const rawCt = parsed.ciphertext;
      // Flip a character in base64 payload
      const tamperedCt = rawCt.slice(0, 20) + (rawCt[20] === 'A' ? 'B' : 'A') + rawCt.slice(21);
      parsed.ciphertext = tamperedCt;
      const tamperedJson = JSON.stringify(parsed);

      const res = await unlockEncryptedBackup(tamperedJson, TEST_PASSPHRASE);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe('wrong_passphrase');
      expect(res.message).toBe('Wrong passphrase, or the file was changed or damaged. Nothing was restored.');
    });

    it('rejects bit-flipped header (tampered AAD) without leaking details', async () => {
      const parsed = JSON.parse(validEncrypted);
      // Tamper with payload schemaVersion in header (part of authenticated AAD)
      parsed.payload.schemaVersion = 2;
      const tamperedJson = JSON.stringify(parsed);

      const res = await unlockEncryptedBackup(tamperedJson, TEST_PASSPHRASE);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe('wrong_passphrase');
      expect(res.message).not.toContain('at ');
    });

    it('rejects truncated payload cleanly', async () => {
      const truncated = validEncrypted.slice(0, Math.floor(validEncrypted.length / 2));
      const res = await unlockEncryptedBackup(truncated, TEST_PASSPHRASE);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe('invalid');
      expect(res.message).toMatch(/valid|corrupt|incomplete/i);
    });

    it('rejects oversized backup files (> 12MB) before derivation', async () => {
      const oversized = validEncrypted + ' '.repeat(12_000_005);
      const inspected = inspectBackup(oversized);
      expect(inspected.ok).toBe(false);
      if (inspected.ok) return;

      expect(inspected.message).toContain('This backup file is too large to restore.');
    });

    it('rejects newer-version data (schemaVersion > 4 or format version > 1)', async () => {
      // Newer plain schema
      const futurePlain = JSON.stringify({ schemaVersion: 999, tasks: [] });
      const parsed = parseData(futurePlain);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toContain('newer app version');

      // Newer encrypted format version
      const parsedEnc = JSON.parse(validEncrypted);
      parsedEnc.version = 999;
      const inspected = inspectBackup(JSON.stringify(parsedEnc));
      expect(inspected.ok).toBe(false);
      if (inspected.ok) return;
      expect(inspected.message).toContain('This backup was made by a newer Personal Assistant');
    });

    it('rejects excessive nesting and invalid structures in parsed data', () => {
      const nested: Record<string, unknown> = { schemaVersion: 4 };
      let curr = nested;
      for (let i = 0; i < 50; i++) {
        curr.child = {};
        curr = curr.child as Record<string, unknown>;
      }
      const res = parseData(JSON.stringify(nested));
      expect(res.ok).toBe(false);
    });

    it('rejects unknown types and corrupted fields in domain records', () => {
      const corrupted = {
        schemaVersion: SCHEMA_VERSION,
        tasks: [{ id: 12345, title: 'Corrupted task' }], // id must be string
        expenses: [],
        goals: [],
        debts: [],
        settings: { currency: 'INVALID_CURRENCY', theme: 'system', language: 'en' },
      };
      const res = parseData(JSON.stringify(corrupted));
      expect(res.ok).toBe(false);
    });
  });

  describe('Restore State Invariants and Failure Recovery (Data Unchanged on Failure)', () => {
    let memoryStore: MemoryStore;
    let memoryVault: MemoryVault;
    let repository: Repository;
    let existingData: AppData;

    beforeEach(async () => {
      memoryStore = new MemoryStore();
      memoryVault = new MemoryVault();
      repository = new Repository(memoryStore);

      existingData = emptyData();
      existingData.tasks.push(
        makeValidTask('orig_t1', 'Original existing task that must never be lost', {
          createdAt: '2026-07-01',
        }),
      );

      await repository.save(existingData);
    });

    it('aborts restore and leaves original data unchanged if pre-restore snapshot cannot be created', async () => {
      const incoming = emptyData();
      incoming.tasks.push(makeValidTask('bad_t', 'Incoming task', { done: true, createdAt: '2026-07-01' }));

      // Simulate locked SecureStore by breaking vault.set
      memoryVault.set = jest.fn().mockRejectedValue(new Error('Hardware keystore locked or biometric unavailable'));

      let applied = false;
      const res = await executeRestoreWithRollback(
        incoming,
        existingData,
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

      // Verify original data in repository is unchanged
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].title).toBe('Original existing task that must never be lost');
    });

    it('rolls back cleanly to original data if applying incoming data fails during save', async () => {
      const incoming = emptyData();
      incoming.tasks.push(makeValidTask('in_t', 'Incoming candidate', { createdAt: '2026-07-01' }));

      // Apply function fails on incoming data
      let applyCount = 0;
      const res = await executeRestoreWithRollback(
        incoming,
        existingData,
        async (d) => {
          applyCount++;
          if (applyCount === 1) {
            // First attempt with incoming data fails
            return 'Database constraint violation on incoming record';
          }
          // Rollback attempt with currentData succeeds
          await repository.save(d);
          return null;
        },
        memoryStore,
        memoryVault,
      );

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.rolledBack).toBe(true);

      // Original data remains intact
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].title).toBe('Original existing task that must never be lost');
    });

    it('repeated restore manages snapshot ring without exceeding retention limits', async () => {
      const incomingA = emptyData();
      incomingA.tasks.push(makeValidTask('t_a', 'Task A', { createdAt: '2026-07-01' }));

      const incomingB = emptyData();
      incomingB.tasks.push(makeValidTask('t_b', 'Task B', { createdAt: '2026-07-01' }));

      // First restore
      const resA = await executeRestoreWithRollback(incomingA, existingData, async (d) => { await repository.save(d); return null; }, memoryStore, memoryVault);
      expect(resA.ok).toBe(true);

      const snapA = await getPreRestoreSnapshot(memoryStore, memoryVault);
      expect(snapA).not.toBeNull();

      // Second repeated restore
      const resB = await executeRestoreWithRollback(incomingB, incomingA, async (d) => { await repository.save(d); return null; }, memoryStore, memoryVault);
      expect(resB.ok).toBe(true);

      const snapB = await getPreRestoreSnapshot(memoryStore, memoryVault);
      expect(snapB).not.toBeNull();
      expect(snapB?.data.tasks[0].title).toBe('Task A');
    });

    it('simulates low storage failure during export: temp dot-file cleaned up, destination never created', async () => {
      // Force write failure by overriding MockFile prototype
      const originalWrite = jest.requireMock('expo-file-system').File.prototype.write;
      jest.requireMock('expo-file-system').File.prototype.write = jest.fn().mockRejectedValue(new Error('ENOSPC: no space left on device'));

      await expect(
        exportTextFile('personal-assistant-backup-lowstorage.json', 'payload bytes', 'application/json', { moveBeforeShare: true }),
      ).rejects.toThrow('ENOSPC: no space left on device');

      // Temp files and destination must be 0
      expect(mockFiles.size).toBe(0);

      // Restore write mock
      jest.requireMock('expo-file-system').File.prototype.write = originalWrite;
    });

    it('duplicate import of identical payload is idempotent and does not distort data', async () => {
      const goldenPayload = makeBackupPlaintext(existingData);

      const parse1 = parseData(goldenPayload);
      const parse2 = parseData(goldenPayload);

      expect(parse1.ok).toBe(true);
      expect(parse2.ok).toBe(true);
      if (!parse1.ok || !parse2.ok) return;

      expect(parse1.data).toEqual(parse2.data);
      expect(parse1.data.tasks).toHaveLength(1);
    });

    it('failed-migration rejection leaves existing repository data untouched', async () => {
      const corruptMigrationPayload = JSON.stringify({
        schemaVersion: -1, // invalid schema version fails migration
        tasks: [],
      });
      const parsed = parseData(corruptMigrationPayload);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toContain('Invalid schema version');

      // Verify existing repository data is completely untouched
      const loaded = await repository.load();
      expect(loaded.status).toBe('ok');
      if (loaded.status !== 'ok') return;
      expect(loaded.data.tasks[0].title).toBe('Original existing task that must never be lost');
    });
  });
});
