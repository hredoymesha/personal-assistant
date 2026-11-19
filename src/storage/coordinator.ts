/** The Web Locks API shape used to protect one read-check-write transaction across browser tabs. */
export interface WebLockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export const APP_DATA_LOCK = 'aio.data.write';

export interface RetryStorageOptions {
  attempts?: number;
  delayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function retryStorageOperation<T>(
  operation: () => Promise<T>,
  { attempts = 2, delayMs = 50, shouldRetry = () => true }: RetryStorageOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(attempts));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !shouldRetry(error)) throw error;
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Storage operation did not complete');
}

function browserLocks(): WebLockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: WebLockManagerLike }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Serializes writes in this app instance and, where supported, across browser tabs.
 * The caller must include its persisted-version check inside `runExclusive`.
 */
export class StorageCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly getLocks: () => WebLockManagerLike | null = browserLocks) {}

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = async () => {
      const locks = this.getLocks();
      return locks ? locks.request(APP_DATA_LOCK, work) : work();
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
