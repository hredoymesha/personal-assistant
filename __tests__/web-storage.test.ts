import { inspectWebStorage, requestWebStoragePersistence } from '../src/services/webStorage';

describe('web storage persistence', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  });

  it('reports unsupported when the browser storage API is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    await expect(inspectWebStorage()).resolves.toEqual({
      supported: false,
      persisted: false,
      usageBytes: null,
      quotaBytes: null,
    });
    await expect(requestWebStoragePersistence()).rejects.toThrow('not supported');
  });

  it('reports the browser status and requests persistence', async () => {
    const storage = {
      persisted: jest.fn().mockResolvedValue(false),
      estimate: jest.fn().mockResolvedValue({ usage: 1200, quota: 5000 }),
      persist: jest.fn().mockResolvedValue(true),
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage } });

    await expect(inspectWebStorage()).resolves.toEqual({
      supported: true,
      persisted: false,
      usageBytes: 1200,
      quotaBytes: 5000,
    });
    await expect(requestWebStoragePersistence()).resolves.toBe(true);
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });
});
