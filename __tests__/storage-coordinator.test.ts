import { APP_DATA_LOCK, StorageCoordinator, retryStorageOperation, type WebLockManagerLike } from '../src/storage/coordinator';

describe('StorageCoordinator', () => {
  it('runs the storage transaction through the browser lock', async () => {
    const requested: string[] = [];
    const locks: WebLockManagerLike = {
      request: async <T,>(name: string, callback: () => Promise<T>) => {
        requested.push(name);
        return callback();
      },
    };
    const coordinator = new StorageCoordinator(() => locks);

    await expect(coordinator.runExclusive(async () => 'saved')).resolves.toBe('saved');

    expect(requested).toEqual([APP_DATA_LOCK]);
  });

  it('serializes transactions in this app instance when no browser lock exists', async () => {
    const coordinator = new StorageCoordinator(() => null);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.runExclusive(async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = coordinator.runExclusive(async () => { order.push('second'); });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('retries one transient storage failure and returns the later result', async () => {
    let attempts = 0;
    await expect(retryStorageOperation(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary write failure');
        return 'saved';
      },
      { delayMs: 0 },
    )).resolves.toBe('saved');
    expect(attempts).toBe(2);
  });

  it('does not retry a conflict or unreadable-data failure', async () => {
    let attempts = 0;
    await expect(retryStorageOperation(
      async () => {
        attempts += 1;
        throw new Error('Data changed in another tab or app window. Reload before saving again.');
      },
      {
        delayMs: 0,
        shouldRetry: (error) => !(error instanceof Error && error.message.startsWith('Data changed in another tab')),
      },
    )).rejects.toThrow(/changed in another tab/);
    expect(attempts).toBe(1);
  });
});
