import { emptyData } from '../src/domain/types';
import { MemoryStore } from '../src/storage/store';
import {
  BACKUP_KEY_PREFIX,
  DATA_KEY,
  ROLLBACK_CLEANUP_KEY,
  Repository,
  backupKeyForVersion,
} from '../src/storage/repository';

describe('legacy rollback-copy cleanup', () => {
  it('cleans matching rollback copies once after valid data loads', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    await store.setItem(DATA_KEY, JSON.stringify(emptyData()));
    await store.setItem(backupKeyForVersion(1), 'legacy-copy');
    await store.setItem(`${BACKUP_KEY_PREFIX}7.backup`, 'current-schema-copy');
    await store.setItem('aio.data.v7.backup.extra', 'not-a-rollback-key');

    await expect(repo.cleanupLegacyRollbackCopies()).resolves.toBe(2);
    expect(await store.getItem(backupKeyForVersion(1))).toBeNull();
    expect(await store.getItem(`${BACKUP_KEY_PREFIX}7.backup`)).toBeNull();
    expect(await store.getItem('aio.data.v7.backup.extra')).toBe('not-a-rollback-key');
    expect(await store.getItem(ROLLBACK_CLEANUP_KEY)).toBe('done');
    await expect(repo.cleanupLegacyRollbackCopies()).resolves.toBe(0);
  });

  it('preserves rollback copies when the current document is invalid', async () => {
    const store = new MemoryStore();
    const repo = new Repository(store);
    const key = backupKeyForVersion(1);
    await store.setItem(DATA_KEY, '{not-json');
    await store.setItem(key, 'recovery-copy');

    await expect(repo.cleanupLegacyRollbackCopies()).rejects.toThrow('current data could not be validated');
    expect(await store.getItem(key)).toBe('recovery-copy');
    expect(await store.getItem(ROLLBACK_CLEANUP_KEY)).toBeNull();
  });
});
