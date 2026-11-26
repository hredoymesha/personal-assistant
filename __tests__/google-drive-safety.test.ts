import * as SecureStore from 'expo-secure-store';
import { sampleData } from '../src/domain/sample';
import { BACKUP_FORMAT, BACKUP_VERSION, inspectBackup } from '../src/crypto/backup';
import { migrate } from '../src/storage/migrations';
import { SCHEMA_VERSION, AppData } from '../src/domain/types';
import { validateAppData } from '../src/domain/validation';
import { Vault } from '../src/services/vault';
import {
  executeRestoreWithRollback,
  executeUndoWithCapture,
  getPreRestoreSnapshot,
  listSnapshots,
  clearPreRestoreSnapshot,
  purgeExpiredSnapshot,
  createPreRestoreSnapshot,
  computeDataChanges,
  RESTORE_SNAPSHOT_KEY,
  RESTORE_SNAPSHOT_VAULT_KEY,
  RESTORE_SNAPSHOT_INDEX_KEY,
  SNAPSHOT_RETENTION_MS,
  MAX_SNAPSHOT_RING_SIZE,
  snapshotStoreKey,
  snapshotVaultKey,
} from '../src/services/restoreRollback';
import {
  computeSha256Hex,
  fetchWithRetry,
  findOrCreateBackupFolder,
  uploadEncryptedBackupFile,
  downloadBackupFile,
  enforceRetentionPolicy,
  DriveError,
} from '../src/services/googleDrive';
import {
  saveTokens,
  clearTokens,
  getValidAccessToken,
  GOOGLE_ACCESS_TOKEN_KEY,
  GOOGLE_REFRESH_TOKEN_KEY,
} from '../src/services/googleAuth';
import {
  AUTO_BACKUP_DISCLOSURE_TEXT,
  performAutoBackup,
} from '../src/services/autoBackup';
import {
  isDriveFeatureEnabled,
  getRetentionCopy,
  DEFAULT_RETENTION_MAX_BACKUPS,
  DriveConfig,
} from '../src/services/driveConfig';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  getItem: jest.fn(),
  removeItem: jest.fn(),
  getAllKeys: jest.fn(),
  multiGet: jest.fn(),
  multiSet: jest.fn(),
  multiRemove: jest.fn(),
  clear: jest.fn(),
}));

// In-memory KeyValueStore mock
class MemoryStore {
  private map = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

// In-memory Vault mock tracking set options
class MockVault implements Vault {
  public data = new Map<string, string>();
  public lastSetOptions: SecureStore.SecureStoreOptions | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async set(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void> {
    this.lastSetOptions = options;
    this.data.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe('Google Drive backup safety', () => {
  describe('Restore rollback snapshot & 24-hour undo window', () => {
    it('creates pre-restore snapshot and rolls back cleanly when restore fails midway', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const initialData = sampleData('2026-11-09');
      const badIncomingData = { ...sampleData('2026-11-09'), version: 999 as any };

      let appliedState = initialData;
      const applyFn = (d: any) => {
        if (d.version === 999) {
          throw new Error('Database write error during restore');
        }
        appliedState = d;
        return null;
      };

      const result = await executeRestoreWithRollback(badIncomingData, initialData, applyFn, store as any, vault);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rolledBack).toBe(true);
        expect(result.error).toMatch(/Database write error/);
      }
      expect(appliedState).toEqual(initialData);

      const snapshot = await getPreRestoreSnapshot(store as any, vault);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.data).toEqual(initialData);

      // Purging unexpired snapshot leaves it intact
      const purgedBefore = await purgeExpiredSnapshot(store as any, vault, snapshot!.timestamp + 1000);
      expect(purgedBefore).toBe(false);

      // Purging after 24 hours removes both store item and vault key
      const purgedAfter = await purgeExpiredSnapshot(store as any, vault, snapshot!.timestamp + SNAPSHOT_RETENTION_MS + 1000);
      expect(purgedAfter).toBe(true);
      expect(await store.getItem(RESTORE_SNAPSHOT_KEY)).toBeNull();
      expect(await vault.get(RESTORE_SNAPSHOT_VAULT_KEY)).toBeNull();
    });

    it('allows user to trigger Undo restore within 24h, reapplies previous local data, and clears snapshot', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const localDeviceData = sampleData('2026-11-09');
      const restoredIncomingData = { ...sampleData('2026-11-09'), expenses: [] };

      let currentDeviceState: AppData = localDeviceData;

      // Successful restore
      const restoreRes = await executeRestoreWithRollback(
        restoredIncomingData,
        currentDeviceState,
        (d) => { currentDeviceState = d; return null; },
        store as any,
        vault,
      );
      expect(restoreRes.ok).toBe(true);
      expect(currentDeviceState).toEqual(restoredIncomingData);

      // Local snapshot is preserved for undo
      const snapshot = await getPreRestoreSnapshot(store as any, vault);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.data).toEqual(localDeviceData);

      // User clicks "Undo restore": reapplies snapshot.data
      currentDeviceState = snapshot!.data;
      expect(currentDeviceState).toEqual(localDeviceData);
      await clearPreRestoreSnapshot(store as any, vault);

      // Snapshot and vault key are cleared
      expect(await getPreRestoreSnapshot(store as any, vault)).toBeNull();
      expect(await store.getItem(RESTORE_SNAPSHOT_KEY)).toBeNull();
      expect(await vault.get(RESTORE_SNAPSHOT_VAULT_KEY)).toBeNull();
    });

    it('stores snapshot as an AES-256-GCM encrypted blob with zero plaintext AppData in KeyValueStore', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const base = sampleData('2026-11-09');
      const sensitiveData: AppData = {
        ...base,
        tasks: [
          {
            ...base.tasks[0],
            id: 'task-secret-999',
            title: 'SENSITIVE_SECRET_SALARY_TASK_98765',
          },
        ],
        expenses: [
          {
            ...base.expenses[0],
            id: 'exp-secret-111',
            note: 'RAHIM_01711999999_SECRET_NOTE',
          },
        ],
      };

      await createPreRestoreSnapshot(sensitiveData, store as any, vault);

      const rawStored = await store.getItem(RESTORE_SNAPSHOT_KEY);
      expect(rawStored).not.toBeNull();
      expect(typeof rawStored).toBe('string');

      // Raw stored string must not contain any plaintext secrets or fields
      expect(rawStored).not.toContain('SENSITIVE_SECRET_SALARY_TASK_98765');
      expect(rawStored).not.toContain('RAHIM_01711999999');
      expect(rawStored).not.toContain('SECRET_NOTE');
      expect(rawStored).not.toContain('task-secret-999');
      expect(rawStored).not.toContain('exp-secret-111');

      // Raw stored structure is an encrypted payload envelope
      const parsedEnvelope = JSON.parse(rawStored!);
      expect(parsedEnvelope.version).toBe(1);
      expect(typeof parsedEnvelope.timestamp).toBe('number');
      expect(typeof parsedEnvelope.nonce).toBe('string');
      expect(typeof parsedEnvelope.ciphertext).toBe('string');
      expect(parsedEnvelope.data).toBeUndefined(); // no plain data field

      // Decryption with vault key restores full data
      const restored = await getPreRestoreSnapshot(store as any, vault);
      expect(restored).not.toBeNull();
      expect(restored?.data.tasks[0].title).toBe('SENSITIVE_SECRET_SALARY_TASK_98765');
      expect(restored?.data.expenses[0].note).toBe('RAHIM_01711999999_SECRET_NOTE');
    });

    it('reading snapshot without vault key fails closed, returns null, and never reveals data', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const testData = sampleData('2026-11-09');

      await createPreRestoreSnapshot(testData, store as any, vault);

      // Simulate snapshot on another device or wiped keystore: wipe all keys from vault
      vault.data.clear();

      // Must return null cleanly without throwing
      const resultWithoutKey = await getPreRestoreSnapshot(store as any, vault);
      expect(resultWithoutKey).toBeNull();

      // Re-create snapshot to test tampered / corrupted ciphertext in store
      const id = await createPreRestoreSnapshot(testData, store as any, vault);
      const sKey = snapshotStoreKey(id);
      const validStored = await store.getItem(sKey);
      expect(validStored).not.toBeNull();
      const parsed = JSON.parse(validStored!);
      // Corrupt ciphertext
      parsed.ciphertext = 'AAAA' + parsed.ciphertext.slice(4);
      await store.setItem(sKey, JSON.stringify(parsed));
      await store.setItem(RESTORE_SNAPSHOT_KEY, JSON.stringify(parsed));

      const corruptedResult = await getPreRestoreSnapshot(store as any, vault);
      expect(corruptedResult).toBeNull();
    });

    it('failed snapshot write aborts restore completely and leaves local data untouched', async () => {
      const store = new MemoryStore();
      const failingVault = new MockVault();
      failingVault.set = async () => {
        throw new Error('Device Keystore / SecureStore hardware error');
      };

      const initialData = sampleData('2026-11-09');
      const incomingData = { ...sampleData('2026-11-09'), tasks: [] };

      let applyCalled = false;
      const applyFn = (d: any) => {
        applyCalled = true;
        return null;
      };

      const result = await executeRestoreWithRollback(incomingData, initialData, applyFn, store as any, failingVault);

      // Restore must fail
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Failed to create secure pre-restore snapshot/);
        expect(result.rolledBack).toBe(false); // Aborted before anything was touched
      }

      // applyFn was never executed
      expect(applyCalled).toBe(false);

      // No partial or corrupt snapshot left in store or vault
      expect(await store.getItem(RESTORE_SNAPSHOT_KEY)).toBeNull();
      expect(await failingVault.get(RESTORE_SNAPSHOT_VAULT_KEY)).toBeNull();
    });

    it('stores snapshot key with WHEN_UNLOCKED_THIS_DEVICE_ONLY for device isolation', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const data = sampleData('2026-11-09');

      await createPreRestoreSnapshot(data, store as any, vault);

      expect(vault.lastSetOptions).toEqual({
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    });

    // Undo snapshots

    it('undo captures pre-undo state so redo returns restore-applied data identically', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const initialLocalData = sampleData('2026-11-09');
      const restoredIncomingData: AppData = {
        ...sampleData('2026-11-09'),
        tasks: [
          {
            ...sampleData('2026-11-09').tasks[0],
            id: 'task-cloud-unique',
            title: 'CLOUD_RESTORED_TASK_ABC',
          },
        ],
      };

      let currentDeviceData = initialLocalData;
      const applyFn = (d: AppData) => {
        currentDeviceData = d;
        return null;
      };

      // Initial restore: captures initialLocalData as 'pre-restore'
      const restoreRes = await executeRestoreWithRollback(restoredIncomingData, currentDeviceData, applyFn, store as any, vault);
      expect(restoreRes.ok).toBe(true);
      expect(currentDeviceData.tasks[0].title).toBe('CLOUD_RESTORED_TASK_ABC');

      // Perform UNDO: captures restoredIncomingData as 'pre-undo' and applies initialLocalData
      const undoSnapshot = await getPreRestoreSnapshot(store as any, vault);
      expect(undoSnapshot).not.toBeNull();
      expect(undoSnapshot?.kind).toBe('pre-restore');

      const undoRes = await executeUndoWithCapture(undoSnapshot!.id, currentDeviceData, applyFn, store as any, vault);
      expect(undoRes.ok).toBe(true);
      expect(currentDeviceData).toEqual(initialLocalData);

      // Perform REDO: retrieves latest snapshot ('pre-undo') and reapplies restoredIncomingData
      const redoTargetSnapshot = await getPreRestoreSnapshot(store as any, vault);
      expect(redoTargetSnapshot).not.toBeNull();
      expect(redoTargetSnapshot?.kind).toBe('pre-undo');

      const redoRes = await executeUndoWithCapture(redoTargetSnapshot!.id, currentDeviceData, applyFn, store as any, vault);
      expect(redoRes.ok).toBe(true);
      expect(currentDeviceData.tasks[0].title).toBe('CLOUD_RESTORED_TASK_ABC');
      expect(currentDeviceData).toEqual(restoredIncomingData);
    });

    it('successive restores preserve multiple undo targets in the ring', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const state0 = sampleData('2026-11-09');
      const state1: AppData = {
        ...sampleData('2026-11-09'),
        tasks: [{ ...sampleData('2026-11-09').tasks[0], title: 'STATE_1_TASK' }],
      };
      const state2: AppData = {
        ...sampleData('2026-11-09'),
        tasks: [{ ...sampleData('2026-11-09').tasks[0], title: 'STATE_2_TASK' }],
      };

      let currentState = state0;
      const apply = (d: AppData) => { currentState = d; return null; };

      // Restore 1 (state0 -> state1)
      await executeRestoreWithRollback(state1, currentState, apply, store as any, vault);

      // Restore 2 (state1 -> state2)
      await executeRestoreWithRollback(state2, currentState, apply, store as any, vault);

      // Ring must have both undo targets
      const allSnaps = await listSnapshots(store as any, vault);
      expect(allSnaps.length).toBe(2);
      expect(allSnaps[0].data.tasks[0].title).toBe('STATE_1_TASK'); // newest snapshot
      expect(allSnaps[1].data.tasks[0].title).toBe(state0.tasks[0].title); // earlier snapshot
    });

    it('ring capping: 4th snapshot purges the oldest snapshot and preserves latest 3 intact', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();

      const snapIds: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const testData: AppData = {
          ...sampleData('2026-11-09'),
          tasks: [{ ...sampleData('2026-11-09').tasks[0], id: `task-ring-${i}`, title: `RING_ITEM_${i}` }],
        };
        const id = await createPreRestoreSnapshot(testData, store as any, vault);
        snapIds.push(id);
      }

      // Metadata ring must hold at most 3 items
      const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
      expect(rawMeta).not.toBeNull();
      const meta = JSON.parse(rawMeta!);
      expect(meta.length).toBe(MAX_SNAPSHOT_RING_SIZE);
      expect(meta.map((m: any) => m.id)).toEqual([snapIds[1], snapIds[2], snapIds[3]]);

      // Oldest (snapIds[0]) store blob and vault key must be purged
      expect(await store.getItem(snapshotStoreKey(snapIds[0]))).toBeNull();
      expect(await vault.get(snapshotVaultKey(snapIds[0]))).toBeNull();

      // Latest 3 must be intact and fully decryptable
      for (let i = 1; i < 4; i++) {
        const snap = await getPreRestoreSnapshot(store as any, vault, Date.now(), snapIds[i]);
        expect(snap).not.toBeNull();
        expect(snap?.data.tasks[0].title).toBe(`RING_ITEM_${i + 1}`);
      }
    });

    it('failed snapshot write or verify aborts undo and leaves data untouched', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const initialData = sampleData('2026-11-09');

      await createPreRestoreSnapshot(initialData, store as any, vault);

      const modifiedCurrentData: AppData = {
        ...sampleData('2026-11-09'),
        tasks: [{ ...sampleData('2026-11-09').tasks[0], title: 'MODIFIED_LOCAL_DATA' }],
      };

      let currentDeviceState = modifiedCurrentData;
      let applyCalled = false;
      const applyFn = (d: AppData) => {
        applyCalled = true;
        currentDeviceState = d;
        return null;
      };

      // Mock random to return invalid byte length to trigger write verification failure
      const brokenRandom = {
        bytes: (n: number) => (n === 32 ? new Uint8Array(16) : new Uint8Array(n)), // invalid 16-byte key
      };

      const result = await executeUndoWithCapture(
        undefined,
        currentDeviceState,
        applyFn,
        store as any,
        vault,
        brokenRandom as any,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Undo blocked: failed to secure current data/);
      }
      expect(applyCalled).toBe(false);
      expect(currentDeviceState).toEqual(modifiedCurrentData);
    });

    it('corrupted or un-decryptable snapshot fails closed and is never applied', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();
      const initialData = sampleData('2026-11-09');

      const id = await createPreRestoreSnapshot(initialData, store as any, vault);

      // Corrupt the stored ciphertext blob
      const rawStored = await store.getItem(snapshotStoreKey(id));
      const parsed = JSON.parse(rawStored!);
      parsed.ciphertext = 'CORRUPTED_CIPHERTEXT_1234567890';
      await store.setItem(snapshotStoreKey(id), JSON.stringify(parsed));

      let applyCalled = false;
      const applyFn = () => {
        applyCalled = true;
        return null;
      };

      const result = await executeUndoWithCapture(id, initialData, applyFn, store as any, vault);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Cannot undo: snapshot is missing, corrupted, or expired/);
      }
      expect(applyCalled).toBe(false);
    });

    it('all snapshots in the ring contain zero plaintext in raw storage', async () => {
      const store = new MemoryStore();
      const vault = new MockVault();

      const secretStrings = ['SALARY_SECRET_TASK_9999', 'RAHIM_SECRET_EXPENSE_7777', 'SECRET_DEBT_PERSON_8888'];
      const sensitiveData: AppData = {
        ...sampleData('2026-11-09'),
        tasks: [{ ...sampleData('2026-11-09').tasks[0], title: secretStrings[0] }],
        expenses: [{ ...sampleData('2026-11-09').expenses[0], note: secretStrings[1] }],
      };

      const id = await createPreRestoreSnapshot(sensitiveData, store as any, vault);

      const rawBlob = await store.getItem(snapshotStoreKey(id));
      expect(rawBlob).not.toBeNull();
      for (const secret of secretStrings) {
        expect(rawBlob).not.toContain(secret);
      }

      const parsed = JSON.parse(rawBlob!);
      expect(parsed.version).toBe(1);
      expect(parsed.nonce).toBeDefined();
      expect(parsed.ciphertext).toBeDefined();
      expect(parsed.data).toBeUndefined();
    });

    it('computeDataChanges accurately detects 0 changes vs multiple changes', () => {
      const dataA = sampleData('2026-11-09');
      const dataSame = { ...sampleData('2026-11-09') };

      const diff0 = computeDataChanges(dataA, dataSame);
      expect(diff0.hasChanges).toBe(false);
      expect(diff0.totalChanges).toBe(0);
      expect(diff0.details).toBe('no changes');

      const dataModified: AppData = {
        ...dataA,
        tasks: [
          ...dataA.tasks,
          {
            id: 'new-task-1',
            title: 'New Added Task',
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
            createdAt: '2026-11-09T00:00:00.000Z',
          },
        ],
        expenses: [
          {
            ...dataA.expenses[0],
            amountMinor: 999999 as any,
          },
          ...dataA.expenses.slice(1),
        ],
      };

      const diffChanges = computeDataChanges(dataModified, dataA);
      expect(diffChanges.hasChanges).toBe(true);
      expect(diffChanges.totalChanges).toBe(2);
      expect(diffChanges.taskChanges).toBe(1);
      expect(diffChanges.expenseChanges).toBe(1);
      expect(diffChanges.details).toContain('1 task');
      expect(diffChanges.details).toContain('1 expense');
    });
  });
  describe('Schema version two-way proof (old migration vs future block)', () => {
    it('(a) versionless or older schema files are migrated and apply cleanly', () => {
      // Versionless legacy payload (schemaVersion = 0 / undefined)
      const { schemaVersion: _v, ...legacyPayload } = sampleData('2026-11-09');

      const migrationResult = migrate(legacyPayload);
      expect(migrationResult.ok).toBe(true);
      if (migrationResult.ok) {
        expect(migrationResult.data.schemaVersion).toBe(SCHEMA_VERSION);
        expect(Array.isArray(migrationResult.data.wallets)).toBe(true);
        expect(Array.isArray(migrationResult.data.messGroups)).toBe(true);

        // Validation accepts migrated data
        const val = validateAppData(migrationResult.data);
        expect(val.ok).toBe(true);
      }
    });

    it('(b) future schemaVersion is blocked and local data is untouched', () => {
      const futureData = {
        schemaVersion: SCHEMA_VERSION + 1,
        tasks: [],
      };
      const result = migrate(futureData);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/newer app version/);
      }

      // Envelope check
      const futureEnvelope = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION + 1,
        kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' },
        passphraseNormalization: 'NFKC',
        cipher: { name: 'AES-256-GCM', nonce: 'AAAAAAAAAAAA' },
        payload: { type: 'ai-o-data', schemaVersion: SCHEMA_VERSION },
        ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==',
      };
      const inspectRes = inspectBackup(JSON.stringify(futureEnvelope));
      expect(inspectRes.ok).toBe(false);
      if (!inspectRes.ok) {
        expect(inspectRes.reason).toBe('newer_version');
      }
    });
  });
  describe('Configurable retention, safety rules, and disable switch', () => {
    const baseConfig: DriveConfig = {
      enabled: true,
      clientId: 'test-client',
      redirectUri: 'uri',
      folderName: 'Personal Assistant Backups',
      enableFullDriveScope: false,
      retention: { enabled: true, maxBackups: DEFAULT_RETENTION_MAX_BACKUPS },
    };

    it('reads user-facing copy from centralized config (keeps N or disabled)', () => {
      expect(getRetentionCopy(baseConfig)).toBe('Older backups are removed automatically (keeps 5).');

      const customConfig: DriveConfig = {
        ...baseConfig,
        retention: { enabled: true, maxBackups: 10 },
      };
      expect(getRetentionCopy(customConfig)).toBe('Older backups are removed automatically (keeps 10).');

      const disabledConfig: DriveConfig = {
        ...baseConfig,
        retention: { enabled: false, maxBackups: 5 },
      };
      expect(getRetentionCopy(disabledConfig)).toBe('Automatic cloud backup cleanup is disabled.');
    });

    it('safety rules: only deletes Personal Assistant owned files, never deletes newest backup, respects disabled switch', async () => {
      const mockFiles = [
        { id: 'newest-1', name: 'b1', createdTime: '2026-11-09T05:00:00Z', owner: 'aio' },
        { id: 'second-2', name: 'b2', createdTime: '2026-11-09T04:00:00Z', owner: 'aio' },
        { id: 'user-foreign-file', name: 'manual-doc.pdf', createdTime: '2026-11-09T03:00:00Z', owner: 'other_user' },
        { id: 'old-aio-4', name: 'b4', createdTime: '2026-11-09T02:00:00Z', owner: 'aio' },
      ];

      const deletedIds: string[] = [];
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET' && url.includes('/files?q=')) {
          return new Response(JSON.stringify({
            files: mockFiles.map((f) => ({
              id: f.id,
              name: f.name,
              createdTime: f.createdTime,
              appProperties: { owner: f.owner },
            })),
          }), { status: 200 });
        }
        if (init?.method === 'DELETE') {
          deletedIds.push(url.split('/').pop()!);
          return new Response(null, { status: 204 });
        }
        return new Response('', { status: 200 });
      };

      // Case A: Retention disabled switch -> 0 files deleted
      const disabledCfg: DriveConfig = { ...baseConfig, retention: { enabled: false, maxBackups: 1 } };
      const resDisabled = await enforceRetentionPolicy('token', 'f', undefined, mockFetch as any, undefined, disabledCfg);
      expect(resDisabled.deleted).toBe(0);
      expect(deletedIds).toEqual([]);

      // Case B: maxBackups = 1 -> Must keep newest-1, must not delete foreign file, deletes second-2 and old-aio-4
      const activeCfg: DriveConfig = { ...baseConfig, retention: { enabled: true, maxBackups: 1 } };
      const resActive = await enforceRetentionPolicy('token', 'f', 1, mockFetch as any, undefined, activeCfg);
      expect(resActive.deleted).toBe(2);
      expect(deletedIds).toEqual(['second-2', 'old-aio-4']);
      expect(deletedIds).not.toContain('user-foreign-file');
      expect(deletedIds).not.toContain('newest-1');
    });
  });
  describe('Privacy and storage disclosure copy', () => {
    it('states that connecting Drive sends encrypted backups to personal Google Drive with no Personal Assistant server', () => {
      const privacyParagraph =
        'By default, everything stays on this device. Personal Assistant has no server, database, analytics or user accounts. If you connect Google Drive, your encrypted backups are uploaded directly from this device to your own personal Google Drive account in the “Personal Assistant Backups/” folder, and no data ever passes through a Personal Assistant server.';
      expect(privacyParagraph).toContain('uploaded directly from this device to your own personal Google Drive account');
      expect(privacyParagraph).toContain('no data ever passes through a Personal Assistant server');
    });
  });
  describe('Master runtime feature flag gates all Drive actions', () => {
    it('when enabled is false, isDriveFeatureEnabled is false and auto-backup skips immediately without vault calls', async () => {
      const disabledConfig: DriveConfig = {
        enabled: false,
        clientId: 'some-client-id',
        redirectUri: 'uri',
        folderName: 'Personal Assistant Backups',
        enableFullDriveScope: false,
        retention: { enabled: true, maxBackups: 5 },
      };

      expect(isDriveFeatureEnabled(disabledConfig)).toBe(false);

      let vaultTouched = false;
      const probeVault: Vault = {
        isAvailable: async () => { vaultTouched = true; return true; },
        get: async () => { vaultTouched = true; return null; },
        set: async () => { vaultTouched = true; },
        remove: async () => { vaultTouched = true; },
      };

      const result = await performAutoBackup(sampleData('2026-11-09'), {
        config: disabledConfig,
        vault: probeVault,
      });

      expect(result.status).toBe('skipped');
      if (result.status === 'skipped') {
        expect(result.reason).toContain('feature is disabled by feature flag');
      }
      expect(vaultTouched).toBe(false);
    });
  });
  describe('Token storage security in expo-secure-store', () => {
    it('stores tokens via WHEN_UNLOCKED_THIS_DEVICE_ONLY and never plain storage', async () => {
      const vault = new MockVault();
      const tokens = {
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        expiresAt: Date.now() + 3600_000,
        scope: 'https://www.googleapis.com/auth/drive.file',
        tokenType: 'Bearer',
      };

      await saveTokens(tokens, vault);

      expect(vault.lastSetOptions?.keychainAccessible).toBe(SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
      expect(await vault.get(GOOGLE_ACCESS_TOKEN_KEY)).toBe('secret-access-token');
      expect(await vault.get(GOOGLE_REFRESH_TOKEN_KEY)).toBe('secret-refresh-token');

      // Purge wipes all
      await clearTokens(vault);
      expect(await vault.get(GOOGLE_ACCESS_TOKEN_KEY)).toBeNull();
      expect(await vault.get(GOOGLE_REFRESH_TOKEN_KEY)).toBeNull();
    });
  });
  describe('SHA-256 payload integrity check on upload and download', () => {
    it('computes sha256 metadata on upload and throws corrupt_file on corrupted download', async () => {
      const payload = JSON.stringify({ hello: 'world', timestamp: 12345 });
      const expectedChecksum = computeSha256Hex(payload);

      let uploadedAppProperties: any;
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (url.includes('/upload/drive/v3/files')) {
          const body = String(init?.body || '');
          if (body.includes('"sha256"')) {
            uploadedAppProperties = { sha256: expectedChecksum, owner: 'aio' };
          }
          return new Response(JSON.stringify({
            id: 'file-123',
            name: 'test-backup.json',
            size: '100',
            mimeType: 'application/json',
          }), { status: 200 });
        }
        if (url.includes('?fields=id,name,appProperties,sha256Checksum')) {
          return new Response(JSON.stringify({
            id: 'file-123',
            appProperties: uploadedAppProperties,
          }), { status: 200 });
        }
        if (url.includes('alt=media')) {
          return new Response(payload + 'CORRUPTED_TAMPER', { status: 200 });
        }
        return new Response('', { status: 200 });
      };

      const uploadResult = await uploadEncryptedBackupFile('token', 'test-backup.json', payload, 'folder-id', mockFetch as any);
      expect(uploadResult.sha256).toBe(expectedChecksum);
      expect(uploadedAppProperties?.sha256).toBe(expectedChecksum);

      await expect(
        downloadBackupFile('token', 'file-123', mockFetch as any, undefined, { maxAttempts: 1 }),
      ).rejects.toThrow(DriveError);

      try {
        await downloadBackupFile('token', 'file-123', mockFetch as any, undefined, { maxAttempts: 1 });
      } catch (err: any) {
        expect(err.kind).toBe('corrupt_file');
        expect(err.message).toMatch(/integrity verification failed/);
      }
    });
  });
  describe('Google Drive REST API error mapping', () => {
    it('correctly maps storageQuotaExceeded, insufficientPermissions, rateLimitExceeded, 401, 404, and 5xx (no 507)', async () => {
      const testCases = [
        {
          status: 403,
          body: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } },
          expectedKind: 'quota_exceeded',
        },
        {
          status: 403,
          body: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
          expectedKind: 'forbidden',
        },
        {
          status: 429,
          body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
          expectedKind: 'rate_limited',
        },
        {
          status: 401,
          body: { error: { message: 'Invalid Credentials' } },
          expectedKind: 'auth_expired',
        },
        {
          status: 404,
          body: { error: { message: 'File Not Found' } },
          expectedKind: 'not_found',
        },
        {
          status: 503,
          body: { error: { message: 'Backend Error' } },
          expectedKind: 'server_error',
        },
      ];

      for (const tc of testCases) {
        const mockFetch = async () => new Response(JSON.stringify(tc.body), { status: tc.status });
        try {
          await findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any, { maxAttempts: 1 });
          fail(`Expected status ${tc.status} to throw`);
        } catch (err: any) {
          expect(err).toBeInstanceOf(DriveError);
          expect(err.kind).toBe(tc.expectedKind);
        }
      }
    });
  });
  describe('fetchWithRetry retry policy', () => {
    it('retries 429 and 5xx up to 3 times respecting Retry-After, and never retries 401 or 403', async () => {
      let attempts503 = 0;
      const sleepDelays: number[] = [];
      const sleepFn = async (ms: number) => {
        sleepDelays.push(ms);
      };

      const mockFetch503 = async () => {
        attempts503++;
        if (attempts503 < 3) {
          return new Response('Transient 503', {
            status: 503,
            headers: { 'Retry-After': '2' },
          });
        }
        return new Response(JSON.stringify({ files: [{ id: 'folder-1' }] }), { status: 200 });
      };

      const res = await fetchWithRetry('https://example.com', {}, mockFetch503 as any, {
        maxAttempts: 3,
        sleepFn,
      });
      expect(res.status).toBe(200);
      expect(attempts503).toBe(3);
      expect(sleepDelays[0]).toBe(2000);

      let attempts401 = 0;
      const mockFetch401 = async () => {
        attempts401++;
        return new Response('Unauthorized', { status: 401 });
      };
      const res401 = await fetchWithRetry('https://example.com', {}, mockFetch401 as any, {
        maxAttempts: 3,
        sleepFn,
      });
      expect(res401.status).toBe(401);
      expect(attempts401).toBe(1);
    });
  });
  describe('Distinguish refresh failure from offline network errors', () => {
    it('preserves tokens on network/offline errors and purges only on invalid_grant', async () => {
      const mockVault = new MockVault();
      const expiredTokens = {
        accessToken: 'expired-access',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() - 1000,
        scope: 'scope',
        tokenType: 'Bearer',
      };
      await saveTokens(expiredTokens, mockVault);

      const offlineFetch = async () => {
        throw new TypeError('Network request failed: device offline');
      };

      const tokenAfterOffline = await getValidAccessToken(
        mockVault,
        { enabled: true, clientId: 'id', redirectUri: 'uri', folderName: 'f', enableFullDriveScope: false, retention: { enabled: true, maxBackups: 5 } },
        offlineFetch as any,
      );
      expect(tokenAfterOffline).toBeNull();
      expect(await mockVault.get(GOOGLE_REFRESH_TOKEN_KEY)).toBe('valid-refresh-token');

      const invalidGrantFetch = async () => {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }), { status: 400 });
      };

      const tokenAfterInvalidGrant = await getValidAccessToken(
        mockVault,
        { enabled: true, clientId: 'id', redirectUri: 'uri', folderName: 'f', enableFullDriveScope: false, retention: { enabled: true, maxBackups: 5 } },
        invalidGrantFetch as any,
      );
      expect(tokenAfterInvalidGrant).toBeNull();
      expect(await mockVault.get(GOOGLE_REFRESH_TOKEN_KEY)).toBeNull();
      expect(await mockVault.get(GOOGLE_ACCESS_TOKEN_KEY)).toBeNull();
    });
  });
  describe('Folder duplicate avoidance & createdTime ordering', () => {
    it('queries with orderBy=createdTime, picks earliest existing folder, and sets appProperties on create', async () => {
      let queryUsed = '';
      let createdBody: any;

      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET' && url.includes('/files?q=')) {
          queryUsed = url;
          return new Response(JSON.stringify({
            files: [
              { id: 'earliest-folder-id', name: 'Personal Assistant Backups' },
              { id: 'later-duplicate-folder-id', name: 'Personal Assistant Backups' },
            ],
          }), { status: 200 });
        }
        if (init?.method === 'POST' && url.includes('/files')) {
          createdBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 'new-folder-id' }), { status: 200 });
        }
        return new Response('', { status: 200 });
      };

      const folderId = await findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any);
      expect(queryUsed).toContain('orderBy=createdTime');
      expect(folderId).toBe('earliest-folder-id');

      const mockFetchEmpty = async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({ files: [] }), { status: 200 });
        }
        if (init?.method === 'POST') {
          createdBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 'created-folder-id' }), { status: 200 });
        }
        return new Response('', { status: 200 });
      };

      const newFolderId = await findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetchEmpty as any);
      expect(newFolderId).toBe('created-folder-id');
      expect(createdBody.appProperties).toEqual({ owner: 'aio' });
    });
  });
  describe('Resumable upload for payloads > 4MB', () => {
    it('uses resumable upload protocol when payload exceeds threshold and multipart when below', async () => {
      let protocolUsed = '';
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (url.includes('uploadType=resumable')) {
          protocolUsed = 'resumable';
          return new Response(null, {
            status: 200,
            headers: { Location: 'https://www.googleapis.com/upload/session-xyz' },
          });
        }
        if (url.includes('session-xyz')) {
          return new Response(JSON.stringify({
            id: 'file-resumable',
            name: 'big-backup.json',
            size: '5000000',
            mimeType: 'application/json',
          }), { status: 200 });
        }
        if (url.includes('uploadType=multipart')) {
          protocolUsed = 'multipart';
          return new Response(JSON.stringify({
            id: 'file-multipart',
            name: 'small-backup.json',
            size: '100',
            mimeType: 'application/json',
          }), { status: 200 });
        }
        return new Response('', { status: 200 });
      };

      await uploadEncryptedBackupFile('token', 'small-backup.json', 'small content', 'folder-1', mockFetch as any, 1000);
      expect(protocolUsed).toBe('multipart');

      await uploadEncryptedBackupFile('token', 'big-backup.json', 'large content exceeding custom 5-byte threshold', 'folder-1', mockFetch as any, 5);
      expect(protocolUsed).toBe('resumable');
    });
  });
  describe('Disclosure copy accuracy', () => {
    it('matches the disclosure copy and never mentions 3 AM', () => {
      expect(AUTO_BACKUP_DISCLOSURE_TEXT).toBe(
        'At most once a day, and never guaranteed. The OS decides when background tasks run; no backup runs if the app is force-closed or offline.',
      );
      expect(AUTO_BACKUP_DISCLOSURE_TEXT).not.toMatch(/রাত ৩টা/);
      expect(AUTO_BACKUP_DISCLOSURE_TEXT).not.toMatch(/3 AM/i);
    });
  });
});
