import { emptyData, SCHEMA_VERSION } from '../src/domain/types';
import { sampleData } from '../src/domain/sample';
import { BACKUP_KEY_SUFFIX, BACKUP_KEY_PREFIX, CORRUPT_KEY, DATA_KEY, MAX_IMPORT_CHARS, Repository, backupKeyForVersion, parseData } from '../src/storage/repository';
import { guardedUpdate } from '../src/state/guard';
import { migrate } from '../src/storage/migrations';
import { MemoryStore } from '../src/storage/store';

describe('Repository (simulates close/reopen)', () => {
  it('reports empty on first run', async () => {
    expect((await new Repository(new MemoryStore()).load()).status).toBe('empty');
  });

  it('persists across a new Repository instance on the same store', async () => {
    const store = new MemoryStore();
    const d = sampleData('2026-10-10');
    await new Repository(store).save(d);
    const r = await new Repository(store).load();
    expect(r.status).toBe('ok');
    expect(r.data).toEqual(d);
  });

  it('keeps corrupt data aside instead of destroying it', async () => {
    const store = new MemoryStore();
    await store.setItem(DATA_KEY, '{not json');
    const r = await new Repository(store).load();
    expect(r.status).toBe('error');
    expect(await store.getItem(CORRUPT_KEY)).toBe('{not json');
    expect(await store.getItem(DATA_KEY)).toBe('{not json');
  });

  it('rejects structurally invalid data', async () => {
    const store = new MemoryStore();
    const bad = emptyData() as any;
    bad.expenses = [{ id: 'x', amountMinor: 1.5 }];
    await store.setItem(DATA_KEY, JSON.stringify(bad));
    expect((await new Repository(store).load()).status).toBe('error');
  });

  it('clear removes everything', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    await repo.save(emptyData());
    await store.setItem(backupKeyForVersion(0), '{"legacy":true}');
    await repo.clear();
    expect(await store.getItem(DATA_KEY)).toBeNull();
    expect(await store.getItem(backupKeyForVersion(0))).toBeNull();
    expect(await store.getItem(CORRUPT_KEY)).toBeNull();
  });

  it('clear removes all copies, all schema backups, and any scanned aio.data key while preserving unrelated keys', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    await repo.save(emptyData());
    await store.setItem(CORRUPT_KEY, '{"bad":true}');
    await store.setItem(backupKeyForVersion(0), '{"v0":true}');
    await store.setItem(backupKeyForVersion(1), '{"v1":true}');
    await store.setItem(backupKeyForVersion(2), '{"v2":true}');
    await store.setItem(backupKeyForVersion(3), '{"v3":true}');
    await store.setItem('aio.data.v99.backup', '{"future":true}');
    await store.setItem('aio.data.orphaned', '{"orphaned":true}');
    // Unrelated keys belonging to other scopes/apps:
    await store.setItem('unrelated.user.preference', 'dark');
    await store.setItem('another_app_key', 'keep_me');

    await repo.clear();

    // App-owned data and backups must all be gone:
    expect(await store.getItem(DATA_KEY)).toBeNull();
    expect(await store.getItem(CORRUPT_KEY)).toBeNull();
    expect(await store.getItem(backupKeyForVersion(0))).toBeNull();
    expect(await store.getItem(backupKeyForVersion(1))).toBeNull();
    expect(await store.getItem(backupKeyForVersion(2))).toBeNull();
    expect(await store.getItem(backupKeyForVersion(3))).toBeNull();
    expect(await store.getItem('aio.data.v99.backup')).toBeNull();
    expect(await store.getItem('aio.data.orphaned')).toBeNull();

    // Unrelated keys must be preserved:
    expect(await store.getItem('unrelated.user.preference')).toBe('dark');
    expect(await store.getItem('another_app_key')).toBe('keep_me');
  });

  it('clear propagates removal failure and is safe when keys are absent', async () => {
    // Safe when keys absent:
    const emptyStore = new MemoryStore();
    const repo = new Repository(emptyStore);
    await expect(repo.clear()).resolves.toBeUndefined();

    // Propagates removal failure:
    const failingStore = new MemoryStore();
    failingStore.removeItem = async () => {
      throw new Error('Disk I/O error during removeItem');
    };
    const failingRepo = new Repository(failingStore);
    await expect(failingRepo.clear()).rejects.toThrow('Disk I/O error during removeItem');
  });

  it('keeps the original legacy document before saving its migrated form', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const oldRaw = JSON.stringify({ tasks: [] });
    await store.setItem(DATA_KEY, oldRaw);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    await repo.save(loaded.data, loaded.raw);

    expect(await store.getItem(backupKeyForVersion(0))).toBe(oldRaw);
    expect((await repo.load()).status).toBe('ok');
  });

  it('keeps the original v1 document before saving its current migration', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const oldRaw = JSON.stringify({
      schemaVersion: 1,
      settings: { currency: 'BDT', theme: 'system', language: 'en' },
      tasks: [],
      expenses: [],
      goals: [],
      debts: [],
    });
    await store.setItem(DATA_KEY, oldRaw);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    await repo.save(loaded.data, loaded.raw);

    expect(await store.getItem(backupKeyForVersion(1))).toBe(oldRaw);
    expect((await repo.load()).data.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('keeps the original v2 document and migrates legacy debts without inventing their age', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const oldData = {
      schemaVersion: 2,
      settings: { currency: 'BDT', theme: 'system', language: 'en' },
      tasks: [],
      expenses: [],
      goals: [],
      debts: [{
        id: 'legacy-debt',
        person: 'Sample person',
        direction: 'i_owe',
        amountMinor: 500,
        paidMinor: 100,
        currency: 'BDT',
        dueDate: null,
        sample: false,
      }],
      wallets: [],
      walletEntries: [],
      walletTransfers: [],
      syncedContacts: [],
      messGroups: [],
      messMembers: [],
      messMeals: [],
      messExpenses: [],
    };
    const oldRaw = JSON.stringify(oldData);
    await store.setItem(DATA_KEY, oldRaw);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    await repo.save(loaded.data, loaded.raw);

    expect(await store.getItem(backupKeyForVersion(2))).toBe(oldRaw);
    const current = await repo.load();
    expect(current.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(current.data.debts[0].createdAt).toBeNull();
  });

  it('keeps the original v3 document and migrates to v4 while preserving any populated cycle collections', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const oldV3Data = {
      schemaVersion: 3,
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
        id: 'cb1', userId: 'u1', name: 'Power', expectedAmountMinor: 10000,
        currency: 'BDT', dueDay: 10, isVariable: false, isPaused: false, autopay: false,
        completedInstallments: 0, paidBy: 'self',
      }],
      cyclePayments: [],
      cycleIncomes: [],
      cycleMonths: [],
    };
    const oldRaw = JSON.stringify(oldV3Data);
    await store.setItem(DATA_KEY, oldRaw);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    await repo.save(loaded.data, loaded.raw);

    expect(await store.getItem(backupKeyForVersion(3))).toBe(oldRaw);
    const current = await repo.load();
    expect(current.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(current.data.cycleGroups).toHaveLength(1);
    expect(current.data.cycleBills).toHaveLength(1);
    expect(current.data.cycleBills?.[0]?.name).toBe('Power');
  });

  it('preserves the current document when a capacity-limited store cannot keep a migration copy', async () => {
    class CapacityStore extends MemoryStore {
      constructor(private readonly capacity: number) { super(); }
      async setItem(key: string, value: string): Promise<void> {
        const existing = await this.getItem(key);
        let currentTotal = 0;
        for (const currentKey of await this.getAllKeys()) {
          currentTotal += (currentKey === key ? value : (await this.getItem(currentKey) ?? '')).length;
        }
        if (currentTotal - (existing?.length ?? 0) > this.capacity) {
          throw new Error('Storage capacity exceeded');
        }
        return super.setItem(key, value);
      }
    }

    const oldData = {
      schemaVersion: 3,
      settings: { currency: 'BDT', theme: 'system', language: 'en' },
      tasks: [], expenses: [], goals: [], debts: [], wallets: [], walletEntries: [],
      walletTransfers: [], syncedContacts: [], messGroups: [], messMembers: [],
      messMeals: [], messExpenses: [],
    };
    const oldRaw = JSON.stringify(oldData);
    const store = new CapacityStore(oldRaw.length + 1);
    await store.setItem(DATA_KEY, oldRaw);
    const repo = new Repository(store);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    await expect(repo.save(loaded.data, loaded.raw)).rejects.toThrow(/capacity/i);
    expect(await store.getItem(DATA_KEY)).toBe(oldRaw);
    expect(await store.getItem(backupKeyForVersion(3))).toBe(oldRaw);
  });

  it('refuses to overwrite a newer document written by another app window', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const first = emptyData();
    await repo.save(first);
    const loaded = await repo.load();
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;

    const newer = { ...first, settings: { ...first.settings, theme: 'dark' as const } };
    await repo.save(newer);

    await expect(repo.save({ ...first, settings: { ...first.settings, theme: 'light' as const } }, loaded.raw))
      .rejects.toThrow(/changed in another tab/i);
    expect((await repo.load()).data.settings.theme).toBe('dark');
  });

  it('uses the versioned backup key naming convention', () => {
    expect(backupKeyForVersion(2)).toBe(`${BACKUP_KEY_PREFIX}2${BACKUP_KEY_SUFFIX}`);
  });
});

describe('migrate', () => {
  it('upgrades unversioned (v0) data to current', () => {
    const r = migrate({ tasks: [] });
    expect(r.ok && r.data.schemaVersion).toBe(SCHEMA_VERSION);
  });
  it('adds an empty month lock history when migrating schema v5', () => {
    const r = migrate({ schemaVersion: 5, cycleMonths: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.schemaVersion).toBe(SCHEMA_VERSION);
      expect(r.data.cycleMonthLockEvents).toEqual([]);
    }
  });
  it('refuses data from a newer app', () => {
    expect(migrate({ schemaVersion: 99 }).ok).toBe(false);
  });
  it('runs chained migrations in order', () => {
    const steps = [
      { from: 1, to: 2, up: (d: any) => ({ ...d, a: 1 }) },
      { from: 2, to: 3, up: (d: any) => ({ ...d, b: d.a + 1 }) },
    ];
    const r = migrate({ schemaVersion: 1 }, steps, 3);
    expect(r).toEqual({ ok: true, data: { schemaVersion: 3, a: 1, b: 2 } });
  });
  it('fails when a step is missing', () => {
    expect(migrate({ schemaVersion: 1 }, [], 2).ok).toBe(false);
  });
  it('rejects non-objects and bad versions', () => {
    expect(migrate([]).ok).toBe(false);
    expect(migrate({ schemaVersion: 'x' }).ok).toBe(false);
  });
});

describe('recovery of unreadable data (regression: the "copy kept aside" had no way to be retrieved)', () => {
  it('getCorrupt returns the preserved raw text', async () => {
    const store = new MemoryStore();
    await store.setItem(DATA_KEY, '{broken');
    const repo = new Repository(store);
    await repo.load();
    expect(await repo.getCorrupt()).toBe('{broken');
  });
  it('getCorrupt is null when nothing was preserved', async () => {
    expect(await new Repository(new MemoryStore()).getCorrupt()).toBeNull();
  });
});

describe('import size limit', () => {
  it('rejects absurdly large payloads before parsing', () => {
    const r = parseData('{"x":"' + 'a'.repeat(MAX_IMPORT_CHARS) + '"}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('Data is too large (maximum 5,000,000 characters)');
  });
});

describe('guardedUpdate (regression: an unsafe sum could write data that failed validation on next launch)', () => {
  it('rejects a change that makes the dataset invalid and keeps the old data', () => {
    const d = sampleData('2026-10-10');
    const r = guardedUpdate(d, (x) => ({ ...x, goals: x.goals.map((g) => ({ ...g, savedMinor: g.savedMinor + Number.MAX_SAFE_INTEGER })) }));
    expect(r.ok).toBe(false);
  });
  it('accepts valid changes and returns the validated data', () => {
    const d = sampleData('2026-10-10');
    const r = guardedUpdate(d, (x) => ({ ...x, goals: x.goals.map((g) => ({ ...g, savedMinor: g.savedMinor + 100 })) }));
    expect(r.ok && r.data.goals[0].savedMinor).toBe(2500100);
  });
});
