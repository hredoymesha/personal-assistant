import { cleanOrphanedTempFiles, exportTextFile, pickTextFile } from '../src/services/files';

const mockFiles = new Map<string, string>();

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;

    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((part) => typeof part === 'string' ? part : part.uri).join('/');
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

const { isAvailableAsync: mockIsAvailableAsync, shareAsync: mockShareAsync } = jest.requireMock('expo-sharing') as {
  isAvailableAsync: jest.Mock<Promise<boolean>, []>;
  shareAsync: jest.Mock<Promise<void>, [string, { mimeType: string; dialogTitle: string }]>;
};

describe('exportTextFile on native platforms', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockIsAvailableAsync.mockReset().mockResolvedValue(true);
    mockShareAsync.mockReset().mockResolvedValue(undefined);
  });

  it('writes to a temporary file and moves the completed export before sharing', async () => {
    mockShareAsync.mockImplementation(async (uri) => {
      expect(mockFiles.get(uri)).toBe('encrypted data');
      expect(uri).toBe('cache/backup.json');
    });

    await exportTextFile('backup.json', 'encrypted data', 'application/json', { moveBeforeShare: true });

    expect([...mockFiles.entries()]).toEqual([['cache/backup.json', 'encrypted data']]);
    expect(mockShareAsync).toHaveBeenCalledWith('cache/backup.json', {
      mimeType: 'application/json',
      dialogTitle: 'backup.json',
    });
  });

  it('does not replace an earlier export when the requested filename already exists', async () => {
    mockFiles.set('cache/backup.json', 'previous backup');

    await exportTextFile('backup.json', 'new backup', 'application/json', { moveBeforeShare: true });

    expect(mockFiles.get('cache/backup.json')).toBe('previous backup');
    expect(mockFiles.get('cache/backup-1.json')).toBe('new backup');
    expect(mockShareAsync).toHaveBeenCalledWith('cache/backup-1.json', expect.any(Object));
  });

  it('does not write a cache file when sharing is unavailable', async () => {
    mockIsAvailableAsync.mockResolvedValue(false);

    await expect(exportTextFile('backup.json', 'data', 'application/json', { moveBeforeShare: true }))
      .rejects.toThrow('Sharing is not available on this device');

    expect(mockFiles.size).toBe(0);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('keeps the existing direct-write behavior for other exports', async () => {
    mockFiles.set('cache/export.csv', 'older export');

    await exportTextFile('export.csv', 'new export', 'text/csv');

    expect([...mockFiles.entries()]).toEqual([['cache/export.csv', 'new export']]);
    expect(mockShareAsync).toHaveBeenCalledWith('cache/export.csv', {
      mimeType: 'text/csv',
      dialogTitle: 'export.csv',
    });
  });

  it('cleans up temporary dot-file if writing or moving fails', async () => {
    // Force write failure by overriding MockFile prototype or simulating error
    const originalWrite = jest.requireMock('expo-file-system').File.prototype.write;
    jest.requireMock('expo-file-system').File.prototype.write = jest.fn().mockRejectedValue(new Error('Disk write error'));

    await expect(exportTextFile('failed-backup.json', 'data', 'application/json', { moveBeforeShare: true }))
      .rejects.toThrow('Disk write error');

    // All temporary files must be cleaned up; mockFiles must be empty
    expect(mockFiles.size).toBe(0);
    expect(mockShareAsync).not.toHaveBeenCalled();

    // Restore original write implementation
    jest.requireMock('expo-file-system').File.prototype.write = originalWrite;
  });

  it('cleanOrphanedTempFiles removes old crashed dot-temp files without touching real data', () => {
    mockFiles.set('cache/personal-assistant-backup-2026-11-09.json', 'valid backup');
    mockFiles.set('cache/.aio-export-personal-assistant-backup-crashed-12345.tmp', 'half written');
    mockFiles.set('cache/.aio-export-personal-assistant-encrypted-backup-old.tmp', 'crashed 2');
    mockFiles.set('cache/other-cache.txt', 'do not touch');

    const cleaned = cleanOrphanedTempFiles();
    expect(cleaned).toBe(2);

    expect(mockFiles.has('cache/personal-assistant-backup-2026-11-09.json')).toBe(true);
    expect(mockFiles.has('cache/other-cache.txt')).toBe(true);
    expect(mockFiles.has('cache/.aio-export-personal-assistant-backup-crashed-12345.tmp')).toBe(false);
    expect(mockFiles.has('cache/.aio-export-personal-assistant-encrypted-backup-old.tmp')).toBe(false);
  });

  it('fails and cleans temp file if written integrity check mismatches', async () => {
    const originalText = jest.requireMock('expo-file-system').File.prototype.text;
    jest.requireMock('expo-file-system').File.prototype.text = jest.fn().mockResolvedValue('corrupted bytes');

    await expect(exportTextFile('backup.json', 'good bytes', 'application/json', { moveBeforeShare: true }))
      .rejects.toThrow(/Export integrity check failed/i);

    expect(mockFiles.size).toBe(0);
    expect(mockShareAsync).not.toHaveBeenCalled();

    jest.requireMock('expo-file-system').File.prototype.text = originalText;
  });
});

describe('temp-file ownership and cache lifecycle (mocked filesystem, not real OS behavior)', () => {
  const filePrototype = (jest.requireMock('expo-file-system') as { File: { prototype: Record<string, unknown> } }).File.prototype;
  const { getDocumentAsync: mockGetDocument } = jest.requireMock('expo-document-picker') as {
    getDocumentAsync: jest.Mock;
  };
  const originals = { write: filePrototype.write, move: filePrototype.move, text: filePrototype.text, delete: filePrototype.delete };

  beforeEach(() => {
    mockFiles.clear();
    mockIsAvailableAsync.mockReset().mockResolvedValue(true);
    mockShareAsync.mockReset().mockResolvedValue(undefined);
    mockGetDocument.mockReset();
  });

  afterEach(() => {
    Object.assign(filePrototype, originals);
  });

  it('cleanup removes only Personal Assistant-owned temp files; unrelated and legacy-pattern .tmp files stay', () => {
    mockFiles.set('cache/.aio-export-backup.json.1-0.tmp', 'owned orphan');
    mockFiles.set('cache/.other-library-upload.tmp', 'someone else');
    mockFiles.set('cache/.personal-assistant-backup-legacy.tmp', 'generic dot-tmp that Personal Assistant no longer claims');
    mockFiles.set('cache/ai-o-backup.json', 'final backup');

    expect(cleanOrphanedTempFiles()).toBe(1);

    expect(mockFiles.has('cache/.aio-export-backup.json.1-0.tmp')).toBe(false);
    expect(mockFiles.get('cache/.other-library-upload.tmp')).toBe('someone else');
    expect(mockFiles.get('cache/.personal-assistant-backup-legacy.tmp')).toBe('generic dot-tmp that Personal Assistant no longer claims');
    expect(mockFiles.get('cache/ai-o-backup.json')).toBe('final backup');
  });

  it('a second export starting cleanup does not delete the temp file of an export still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realWrite = originals.write as (this: unknown, text: string) => Promise<void>;
    let first = true;
    filePrototype.write = async function (this: unknown, text: string) {
      if (first) {
        first = false;
        await gate;
      }
      return realWrite.call(this, text);
    };

    const exportA = exportTextFile('a.json', 'payload A', 'application/json', { moveBeforeShare: true });
    for (let i = 0; i < 20 && ![...mockFiles.keys()].some((k) => k.includes('.aio-export-a.json')); i++) await Promise.resolve();
    expect([...mockFiles.keys()].some((k) => k.includes('.aio-export-a.json'))).toBe(true);

    await exportTextFile('b.json', 'payload B', 'application/json', { moveBeforeShare: true });
    expect([...mockFiles.keys()].some((k) => k.includes('.aio-export-a.json'))).toBe(true);

    release();
    await exportA;
    expect(mockFiles.get('cache/a.json')).toBe('payload A');
    expect(mockFiles.get('cache/b.json')).toBe('payload B');
    expect([...mockFiles.keys()].filter((k) => k.endsWith('.tmp'))).toHaveLength(0);
  });

  it('the completed export stays on disk after the share call returns (recipient lifetime is unknown)', async () => {
    await exportTextFile('kept.json', 'shared payload', 'application/json', { moveBeforeShare: true });
    expect(mockFiles.get('cache/kept.json')).toBe('shared payload');
    cleanOrphanedTempFiles();
    expect(mockFiles.get('cache/kept.json')).toBe('shared payload');
  });

  it('a failed move leaves no final file, no temp file, and never opens the share sheet', async () => {
    filePrototype.move = jest.fn().mockRejectedValue(new Error('Disk full during move'));

    await expect(exportTextFile('m.json', 'data', 'application/json', { moveBeforeShare: true }))
      .rejects.toThrow('Disk full during move');

    expect(mockFiles.size).toBe(0);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('picked restore: the app-made cache copy is deleted after a successful read', async () => {
    mockFiles.set('cache/DocumentPicker/restore.json', 'backup text');
    mockGetDocument.mockResolvedValue({ canceled: false, assets: [{ uri: 'cache/DocumentPicker/restore.json' }] });

    await expect(pickTextFile()).resolves.toBe('backup text');

    expect(mockFiles.has('cache/DocumentPicker/restore.json')).toBe(false);
  });

  it('picked restore: the cache copy is deleted when reading fails', async () => {
    mockFiles.set('cache/DocumentPicker/restore.json', 'backup text');
    mockGetDocument.mockResolvedValue({ canceled: false, assets: [{ uri: 'cache/DocumentPicker/restore.json' }] });
    filePrototype.text = jest.fn().mockRejectedValue(new Error('read failed'));

    await expect(pickTextFile()).rejects.toThrow('read failed');

    expect(mockFiles.has('cache/DocumentPicker/restore.json')).toBe(false);
  });

  it('picked restore: a file outside the app cache (the user original) is never deleted', async () => {
    mockFiles.set('external/Downloads/restore.json', 'user original');
    mockGetDocument.mockResolvedValue({ canceled: false, assets: [{ uri: 'external/Downloads/restore.json' }] });

    await expect(pickTextFile()).resolves.toBe('user original');

    expect(mockFiles.get('external/Downloads/restore.json')).toBe('user original');
  });

  it('picked restore: cancelling touches nothing', async () => {
    mockFiles.set('external/Downloads/restore.json', 'user original');
    mockGetDocument.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickTextFile()).resolves.toBeNull();

    expect([...mockFiles.keys()]).toEqual(['external/Downloads/restore.json']);
  });

  it('picked restore: a failing cache-copy delete does not change the returned text', async () => {
    mockFiles.set('cache/DocumentPicker/restore.json', 'backup text');
    mockGetDocument.mockResolvedValue({ canceled: false, assets: [{ uri: 'cache/DocumentPicker/restore.json' }] });
    filePrototype.delete = jest.fn(() => { throw new Error('locked'); });

    await expect(pickTextFile()).resolves.toBe('backup text');
  });
});

describe('Export safety correction: CSV and unreadable-data recovery dump use the verified safe-write path (mocked filesystem)', () => {
  const filePrototype = (jest.requireMock('expo-file-system') as { File: { prototype: Record<string, unknown> } }).File.prototype;
  const originals = { write: filePrototype.write, move: filePrototype.move, text: filePrototype.text };
  const csv = 'date,amount,note\n2026-11-09,"1,250.50","say ""hi""\nsecond line"\n2026-11-10,à§³300,à¦šà¦¾\n';
  const dump = '\uFEFF{"schemaVersion":3,"expenses":[ <<corrupt>> \r\n\t"unterminated';

  beforeEach(() => {
    mockFiles.clear();
    mockIsAvailableAsync.mockReset().mockResolvedValue(true);
    mockShareAsync.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.assign(filePrototype, originals);
  });

  it.each([
    ['expenses CSV', 'personal-assistant-expenses-2026-11-09.csv', 'text/csv', csv],
    ['unreadable-data dump', 'personal-assistant-unreadable-data-2026-11-09.txt', 'text/plain', dump],
  ])('%s: exact content, previous same-name export untouched, shared only after the final move', async (_label, name, mime, content) => {
    mockFiles.set(`cache/${name}`, 'previous export');
    const stem = name.replace(/\.[^.]+$/, '');
    const ext = name.slice(name.lastIndexOf('.'));
    mockShareAsync.mockImplementation(async (uri: string) => {
      expect(uri).toBe(`cache/${stem}-1${ext}`);
      expect(mockFiles.get(uri)).toBe(content);
      expect([...mockFiles.keys()].filter((k) => k.endsWith('.tmp'))).toHaveLength(0);
    });

    await exportTextFile(name, content, mime, { moveBeforeShare: true });

    expect(mockFiles.get(`cache/${name}`)).toBe('previous export');
    expect(mockFiles.get(`cache/${stem}-1${ext}`)).toBe(content);
    expect(mockShareAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['write', () => { filePrototype.write = jest.fn().mockRejectedValue(new Error('write failed')); }, 'write failed'],
    ['read-back', () => { filePrototype.text = jest.fn().mockResolvedValue('different'); }, 'Export integrity check failed'],
    ['move', () => { filePrototype.move = jest.fn().mockRejectedValue(new Error('move failed')); }, 'move failed'],
  ])('%s failure: no share, no false success, earlier export intact, no leftovers', async (_label, breakIt, message) => {
    mockFiles.set('cache/personal-assistant-expenses-2026-11-09.csv', 'previous export');
    breakIt();

    await expect(exportTextFile('personal-assistant-expenses-2026-11-09.csv', csv, 'text/csv', { moveBeforeShare: true }))
      .rejects.toThrow(message);

    expect([...mockFiles.entries()]).toEqual([['cache/personal-assistant-expenses-2026-11-09.csv', 'previous export']]);
    expect(mockShareAsync).not.toHaveBeenCalled();
  });

  it('both settings callers pass moveBeforeShare: true (source check; no React renderer here)', () => {
    const fs = jest.requireActual<typeof import('fs')>('fs');
    const path = jest.requireActual<typeof import('path')>('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'settings.tsx'), 'utf8');
    const calls = source.split('\n').filter((line) => line.includes('exportTextFile('));
    expect(calls).toHaveLength(3);
    for (const line of calls) expect(line).toContain('moveBeforeShare: true');
  });
});

describe('Web platform fallback and picker behavior', () => {
  const { Platform } = jest.requireMock('react-native') as { Platform: { OS: string } };
  const { getDocumentAsync: mockGetDocument } = jest.requireMock('expo-document-picker') as {
    getDocumentAsync: jest.Mock;
  };

  afterEach(() => {
    Platform.OS = 'android';
  });

  it('web: cleanOrphanedTempFiles returns 0 immediately without native filesystem access', () => {
    Platform.OS = 'web';
    mockFiles.set('cache/.aio-export-stale.tmp', 'stale');
    expect(cleanOrphanedTempFiles()).toBe(0);
    expect(mockFiles.has('cache/.aio-export-stale.tmp')).toBe(true);
  });

  it('web: pickTextFile reads from asset.file without calling native File operations', async () => {
    Platform.OS = 'web';
    mockGetDocument.mockResolvedValue({
      canceled: false,
      assets: [{
        uri: 'blob:http://localhost/uuid',
        file: { text: async () => 'web backup content' },
      }],
    });

    await expect(pickTextFile()).resolves.toBe('web backup content');
  });
});
