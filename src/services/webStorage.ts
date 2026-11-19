export type WebStorageStatus =
  | { supported: false; persisted: false; usageBytes: null; quotaBytes: null }
  | { supported: true; persisted: boolean; usageBytes: number | null; quotaBytes: number | null };

function getStorageManager(): StorageManager | null {
  if (typeof navigator === 'undefined' || !navigator.storage) return null;
  return navigator.storage;
}

export async function inspectWebStorage(): Promise<WebStorageStatus> {
  const storage = getStorageManager();
  if (!storage) return { supported: false, persisted: false, usageBytes: null, quotaBytes: null };
  const [persisted, estimate] = await Promise.all([storage.persisted(), storage.estimate()]);
  return {
    supported: true,
    persisted,
    usageBytes: typeof estimate.usage === 'number' ? estimate.usage : null,
    quotaBytes: typeof estimate.quota === 'number' ? estimate.quota : null,
  };
}

export async function requestWebStoragePersistence(): Promise<boolean> {
  const storage = getStorageManager();
  if (!storage) throw new Error('Persistent browser storage is not supported here.');
  return storage.persist();
}
