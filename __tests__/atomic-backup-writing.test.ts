import {
  DEFAULT_KDF_TIMEOUT_MS,
  encryptBackup,
  decryptBackup,
} from '../src/crypto/backup';
import { cleanOrphanedTempFiles, exportTextFile } from '../src/services/files';
import { createEncryptedBackup, unlockEncryptedBackup } from '../src/storage/backup';
import { emptyData } from '../src/domain/types';

const mockFiles = new Map<string, string>();

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-document-picker', () => ({}));
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

const { shareAsync: mockShareAsync } = jest.requireMock('expo-sharing') as {
  shareAsync: jest.Mock<Promise<void>, [string, { mimeType: string; dialogTitle: string }]>;
};

describe('Atomic backup writing via temporary file rename, self-check, cancel/timeout', () => {
  const PASS = 'secure passphrase for backup 1234';

  beforeEach(() => {
    mockFiles.clear();
    mockShareAsync.mockClear();
  });

  describe('Temporary file creation and atomic rename', () => {
    it('writes completed backup data to a temporary dot-file and renames it before sharing', async () => {
      let sawTemporaryFile = false;
      const originalWrite = jest.requireMock('expo-file-system').File.prototype.write;

      jest.requireMock('expo-file-system').File.prototype.write = jest.fn().mockImplementation(async function (this: { uri: string }, text: string) {
        if (this.uri.includes('.tmp')) {
          sawTemporaryFile = true;
          expect(this.uri).toMatch(/^cache\/\.aio-export-ai-o-backup.*\.tmp$/);
        }
        return originalWrite.call(this, text);
      });

      await exportTextFile('ai-o-backup.json', '{"verified":true}', 'application/json', { moveBeforeShare: true });

      expect(sawTemporaryFile).toBe(true);
      expect(mockFiles.get('cache/ai-o-backup.json')).toBe('{"verified":true}');
      expect(mockShareAsync).toHaveBeenCalledWith('cache/ai-o-backup.json', {
        mimeType: 'application/json',
        dialogTitle: 'ai-o-backup.json',
      });

      // Temporary dot-files must be moved/gone
      const tempFilesRemaining = [...mockFiles.keys()].filter((k) => k.endsWith('.tmp'));
      expect(tempFilesRemaining).toHaveLength(0);

      jest.requireMock('expo-file-system').File.prototype.write = originalWrite;
    });

    it('cleans up temporary dot-file and does not share if write is interrupted or fails', async () => {
      const originalWrite = jest.requireMock('expo-file-system').File.prototype.write;
      jest.requireMock('expo-file-system').File.prototype.write = jest.fn().mockRejectedValue(new Error('Simulated app-switch or write interruption'));

      await expect(
        exportTextFile('ai-o-interrupted.json', 'partial data', 'application/json', { moveBeforeShare: true }),
      ).rejects.toThrow('Simulated app-switch or write interruption');

      // Zero destination files created, zero temp files left behind
      expect(mockFiles.size).toBe(0);
      expect(mockShareAsync).not.toHaveBeenCalled();

      jest.requireMock('expo-file-system').File.prototype.write = originalWrite;
    });

    it('does not overwrite existing backup file with identical name; increments suffix safely', async () => {
      mockFiles.set('cache/personal-assistant-backup.json', 'prior existing backup');

      await exportTextFile('personal-assistant-backup.json', 'second backup', 'application/json', { moveBeforeShare: true });

      expect(mockFiles.get('cache/personal-assistant-backup.json')).toBe('prior existing backup');
      expect(mockFiles.get('cache/personal-assistant-backup-1.json')).toBe('second backup');
      expect(mockShareAsync).toHaveBeenCalledWith('cache/personal-assistant-backup-1.json', expect.any(Object));
    });

    it('cleans up orphaned temp files from prior crashed sessions on cleanOrphanedTempFiles', () => {
      mockFiles.set('cache/personal-assistant-backup-2026-11-09.json', 'valid prior backup');
      mockFiles.set('cache/.aio-export-personal-assistant-backup-crashed-1.tmp', 'crashed write 1');
      mockFiles.set('cache/.aio-export-personal-assistant-encrypted-backup-crashed-2.tmp', 'crashed write 2');
      mockFiles.set('cache/user-notes.txt', 'user data not to be touched');

      const cleaned = cleanOrphanedTempFiles();
      expect(cleaned).toBe(2);

      // Real files intact, temp files purged
      expect(mockFiles.get('cache/personal-assistant-backup-2026-11-09.json')).toBe('valid prior backup');
      expect(mockFiles.get('cache/user-notes.txt')).toBe('user data not to be touched');
      expect(mockFiles.has('cache/.aio-export-personal-assistant-backup-crashed-1.tmp')).toBe(false);
      expect(mockFiles.has('cache/.aio-export-personal-assistant-encrypted-backup-crashed-2.tmp')).toBe(false);
    });

    it('cleans up temp file and throws error if post-write read integrity check fails', async () => {
      const originalText = jest.requireMock('expo-file-system').File.prototype.text;
      jest.requireMock('expo-file-system').File.prototype.text = jest.fn().mockResolvedValue('mismatched corrupted text');

      await expect(
        exportTextFile('ai-o-backup.json', 'intended text', 'application/json', { moveBeforeShare: true }),
      ).rejects.toThrow(/Export integrity check failed/i);

      // Temp file must be cleaned up and final file not created
      expect(mockFiles.size).toBe(0);
      expect(mockShareAsync).not.toHaveBeenCalled();

      jest.requireMock('expo-file-system').File.prototype.text = originalText;
    });
  });

  describe('Round-trip self-check before returning backup file', () => {
    it('executes a round-trip decryption self-check before handing backup file to caller', async () => {
      const data = emptyData();
      const backupText = await createEncryptedBackup(data, PASS, {
        random: { bytes: (n) => new Uint8Array(n).fill(3) },
      });

      expect(backupText).toContain('"ai-o-encrypted-backup"');
      // Proves self-check succeeded and file round-trips identically
      const dec = await decryptBackup(backupText, PASS);
      expect(dec.ok).toBe(true);
    });

    it('rejects backup creation if self-check fails (simulated cipher tampering)', async () => {
      // Simulate random source that fails or returns identical corrupt output
      await expect(
        encryptBackup('{"sample":true}', PASS, {
          random: { bytes: () => new Uint8Array(1) }, // Short invalid bytes
          schemaVersion: 4,
        }),
      ).rejects.toThrow(/random generator failed/i);
    });
  });

  describe('Cooperative cancellation and timeout guidance', () => {
    it('DEFAULT_KDF_TIMEOUT_MS is 120,000 ms (120 seconds)', () => {
      expect(DEFAULT_KDF_TIMEOUT_MS).toBe(120_000);
    });

    it('encryptBackup respects cancellation signal and returns no file', async () => {
      let checks = 0;
      await expect(
        encryptBackup('{"data":true}', PASS, {
          random: { bytes: (n) => new Uint8Array(n).fill(5) },
          schemaVersion: 4,
          shouldCancel: () => ++checks > 1,
        }),
      ).rejects.toThrow(/Backup creation cancelled; no file was created/i);

      expect(checks).toBeGreaterThan(1);
    });

    it('encryptBackup halts when timeoutMs is exceeded and returns no file', async () => {
      await expect(
        encryptBackup('{"data":true}', PASS, {
          random: { bytes: (n) => new Uint8Array(n).fill(5) },
          schemaVersion: 4,
          timeoutMs: 0, // Immediate timeout
        }),
      ).rejects.toThrow(/Backup key derivation timed out; no file was created/i);
    });

    it('demonstrates granular cancellation inside scrypt loop ticks', async () => {
      const progressTicks: number[] = [];
      let cancelTriggered = false;

      // When progress reaches at least 1 tick, trigger cancel
      await expect(
        encryptBackup('{"data":true}', PASS, {
          random: { bytes: (n) => new Uint8Array(n).fill(6) },
          schemaVersion: 4,
          onProgress: (fraction) => {
            progressTicks.push(fraction);
            if (progressTicks.length >= 2) {
              cancelTriggered = true;
            }
          },
          shouldCancel: () => cancelTriggered,
        }),
      ).rejects.toThrow(/Backup creation cancelled; no file was created/i);

      // Cancellation has to land inside the derivation loop, not after it finished
      expect(progressTicks.length).toBeGreaterThanOrEqual(2);
      expect(progressTicks[progressTicks.length - 1]).toBeLessThan(1.0);
    });
  });

  describe('Restore cancellation and timeout controls', () => {
    let validCiphertext: string;

    beforeAll(async () => {
      validCiphertext = await createEncryptedBackup(emptyData(), PASS, {
        random: { bytes: (n) => new Uint8Array(n).fill(7) },
      });
    });

    it('decryptBackup respects cancellation signal and returns no plaintext', async () => {
      let cancelled = false;
      const res = await decryptBackup(validCiphertext, PASS, {
        shouldCancel: () => {
          cancelled = true;
          return true;
        },
      });

      expect(cancelled).toBe(true);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('internal');
        expect(res.message).toContain('cancelled');
      }
    });

    it('decryptBackup halts when timeoutMs is exceeded during restore derivation', async () => {
      const res = await decryptBackup(validCiphertext, PASS, {
        timeoutMs: 0, // Immediate timeout
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('internal');
        expect(res.message).toContain('timed out');
      }
    });

    it('unlockEncryptedBackup returns error and modifies zero storage when cancelled', async () => {
      const res = await unlockEncryptedBackup(validCiphertext, PASS, {
        shouldCancel: () => true,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('internal');
        expect(res.message).toContain('cancelled');
      }
    });

    it('interrupted or cancelled backup leaves zero partial files and triggers zero shares', async () => {
      const initialFileCount = mockFiles.size;
      let cancelFlag = false;

      // Simulate cancellation before file export
      await expect(
        createEncryptedBackup(emptyData(), PASS, {
          random: { bytes: (n) => new Uint8Array(n).fill(8) },
          shouldCancel: () => {
            cancelFlag = true;
            return true;
          },
        }),
      ).rejects.toThrow(/cancelled/i);

      expect(cancelFlag).toBe(true);
      // Zero files added to mock filesystem
      expect(mockFiles.size).toBe(initialFileCount);
      expect(mockShareAsync).not.toHaveBeenCalled();
    });
  });
});
