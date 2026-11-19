import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEFAULT_KDF,
  decryptBackup,
  encryptBackup,
  inspectBackup,
  SCRYPT_KDF_BOUNDS,
  type BackupFile,
} from '../src/crypto/backup';
import { base64Encode, utf8Encode } from '../src/crypto/bytes';
import { unlockEncryptedBackup } from '../src/storage/backup';

describe('Protective Scrypt Work Cap and Memory Bounds on Encrypted Backups', () => {
  const PASS = 'correct battery horse staple 1234';

  function makeRawBackup(kdfOverrides: Record<string, unknown>): string {
    const salt = new Uint8Array(16);
    salt.fill(7);
    const nonce = new Uint8Array(12);
    nonce.fill(9);

    const file: BackupFile = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      kdf: {
        name: 'scrypt',
        N: 32768,
        r: 8,
        p: 1,
        salt: base64Encode(salt),
        ...kdfOverrides,
      },
      passphraseNormalization: 'NFKC',
      cipher: {
        name: 'AES-256-GCM',
        nonce: base64Encode(nonce),
      },
      payload: {
        type: 'ai-o-data',
        schemaVersion: 4,
      },
      ciphertext: base64Encode(new Uint8Array(32)), // dummy 32-byte ciphertext with tag
    };

    return JSON.stringify(file);
  }

  describe('Centralized KDF bounds and memory limit configuration', () => {
    it('exports SCRYPT_KDF_BOUNDS with required protective parameters', () => {
      expect(SCRYPT_KDF_BOUNDS.minN).toBe(16384); // 2^14
      expect(SCRYPT_KDF_BOUNDS.maxN).toBe(131072); // 2^17
      expect(SCRYPT_KDF_BOUNDS.r).toBe(8);
      expect(SCRYPT_KDF_BOUNDS.minP).toBe(1);
      expect(SCRYPT_KDF_BOUNDS.maxP).toBe(4);
      expect(SCRYPT_KDF_BOUNDS.maxTotalWork).toBe(131072); // 2^17 (N * p limit)
      expect(SCRYPT_KDF_BOUNDS.maxEstimatedMemoryBytes).toBe(134217728); // 128 MB (128 * 8 * 2^17)
    });

    it('uses default KDF parameters that sit safely within all protective bounds', () => {
      expect(DEFAULT_KDF.name).toBe('scrypt');
      expect(DEFAULT_KDF.N).toBe(32768);
      expect(DEFAULT_KDF.r).toBe(8);
      expect(DEFAULT_KDF.p).toBe(1);

      const totalWork = DEFAULT_KDF.N * DEFAULT_KDF.p;
      expect(totalWork).toBeLessThanOrEqual(SCRYPT_KDF_BOUNDS.maxTotalWork);

      const mem = 128 * DEFAULT_KDF.r * DEFAULT_KDF.N;
      expect(mem).toBe(33554432); // 32 MB
      expect(mem).toBeLessThanOrEqual(SCRYPT_KDF_BOUNDS.maxEstimatedMemoryBytes);
    });
  });

  describe('Fast, synchronous upfront rejection of hostile/dangerous KDF settings', () => {
    it('rejects excessive N (CPU/Memory exhaustion) before key derivation starts', () => {
      for (const dangerousN of [2 ** 18, 2 ** 20, 2 ** 25]) {
        const raw = makeRawBackup({ N: dangerousN });
        const start = Date.now();
        const res = inspectBackup(raw);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(100); // Must be instant (< 100ms) without executing KDF
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe('invalid');
          expect(res.message).toMatch(/invalid or unsafe key-derivation settings/i);
        }
      }
    });

    it('rejects excessive parallelism p (CPU starvation) before key derivation starts', () => {
      for (const dangerousP of [5, 10, 100, 1000]) {
        const raw = makeRawBackup({ p: dangerousP });
        const start = Date.now();
        const res = inspectBackup(raw);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe('invalid');
          expect(res.message).toMatch(/invalid or unsafe key-derivation settings/i);
        }
      }
    });

    it('rejects combined N * p exceeding maxTotalWork cap (131,072)', () => {
      // N = 2^17 (131,072) with p = 2 => N * p = 262,144 (> 131,072)
      const raw1 = makeRawBackup({ N: 2 ** 17, p: 2 });
      const res1 = inspectBackup(raw1);
      expect(res1.ok).toBe(false);
      if (!res1.ok) expect(res1.reason).toBe('invalid');

      // N = 2^16 (65,536) with p = 4 => N * p = 262,144 (> 131,072)
      const raw2 = makeRawBackup({ N: 2 ** 16, p: 4 });
      const res2 = inspectBackup(raw2);
      expect(res2.ok).toBe(false);
      if (!res2.ok) expect(res2.reason).toBe('invalid');
    });

    it('rejects non-power-of-two N, fractional, and negative/zero parameters', () => {
      const invalidSettings = [
        { N: 32769 }, // Not power of 2
        { N: 50000 }, // Not power of 2
        { N: 1024 }, // Too small (min is 16384)
        { N: -32768 }, // Negative
        { N: 0 }, // Zero
        { N: 32768.5 }, // Fractional
        { p: 0 }, // Zero p
        { p: -1 }, // Negative p
        { p: 1.5 }, // Fractional p
        { r: 16 }, // Unsupported r != 8
        { r: 4 }, // Unsupported r != 8
        { r: 0 }, // Invalid r
        { N: '32768' }, // Non-number
        { p: '1' }, // Non-number
      ];

      for (const override of invalidSettings) {
        const raw = makeRawBackup(override);
        const res = inspectBackup(raw);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe('invalid');
          expect(res.message).toMatch(/invalid or unsafe key-derivation settings/i);
        }
      }
    });
  });

  describe('Decrypt and Unlock integration with hostile parameter rejection', () => {
    it('decryptBackup rejects hostile KDF settings immediately without deriving keys', async () => {
      const hostileBackup = makeRawBackup({ N: 2 ** 24 });
      const start = Date.now();
      const res = await decryptBackup(hostileBackup, PASS);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(150); // Derivation never started
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('invalid');
        expect(res.message).toMatch(/invalid or unsafe key-derivation settings/i);
      }
    });

    it('unlockEncryptedBackup rejects hostile KDF settings without storage side effects', async () => {
      const hostileBackup = makeRawBackup({ N: 2 ** 22, p: 2 });
      const res = await unlockEncryptedBackup(hostileBackup, PASS);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('invalid');
        expect(res.message).toMatch(/invalid or unsafe key-derivation settings/i);
      }
    });

    it('accepts and decrypts valid equivalent KDF profiles within bounds', async () => {
      // Encrypt with valid equivalent profile N=2^14 (16,384), r=8, p=2 (work = 32,768 <= 131,072)
      const salt = new Uint8Array(16);
      salt.fill(42);
      const nonce = new Uint8Array(12);
      nonce.fill(24);
      const N = 2 ** 14;
      const r = 8;
      const p = 2;

      const header = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        kdf: { name: 'scrypt' as const, N, r, p, salt: base64Encode(salt) },
        passphraseNormalization: 'NFKC' as const,
        cipher: { name: 'AES-256-GCM' as const, nonce: base64Encode(nonce) },
        payload: { type: 'ai-o-data' as const, schemaVersion: 4 },
      };

      const aad = utf8Encode([
        header.format, header.version, header.kdf.name, N, r, p, header.kdf.salt,
        header.passphraseNormalization, header.cipher.name, header.cipher.nonce,
        header.payload.type, header.payload.schemaVersion,
      ].join('|'));

      const key = await scryptAsync(utf8Encode(PASS.normalize('NFKC')), salt, { N, r, p, dkLen: 32, asyncTick: 10 });
      const plaintext = 'valid equivalent profile test';
      const ciphertext = gcm(key, nonce, aad).encrypt(utf8Encode(plaintext));

      const file = JSON.stringify({ ...header, ciphertext: base64Encode(ciphertext) });

      // Inspection passes
      const insp = inspectBackup(file);
      expect(insp.ok).toBe(true);

      // Decryption succeeds
      const dec = await decryptBackup(file, PASS);
      expect(dec.ok).toBe(true);
      if (dec.ok) {
        expect(dec.plaintext).toBe(plaintext);
        expect(dec.schemaVersion).toBe(4);
      }
    });
  });

  describe('Cooperative cancellation and timeout safeguards', () => {
    it('supports cancellation during decryptBackup', async () => {
      // Create a valid normal backup
      const file = await encryptBackup('{"test":true}', PASS, {
        random: { bytes: (n) => new Uint8Array(n).fill(1) },
        schemaVersion: 4,
      });

      let checks = 0;
      const res = await decryptBackup(file, PASS, {
        shouldCancel: () => ++checks > 1,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('internal');
        expect(res.message).toMatch(/cancelled/i);
      }
    });

    it('supports timeout during decryptBackup', async () => {
      const file = await encryptBackup('{"test":true}', PASS, {
        random: { bytes: (n) => new Uint8Array(n).fill(2) },
        schemaVersion: 4,
      });

      const res = await decryptBackup(file, PASS, {
        timeoutMs: 0, // Immediate timeout
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('internal');
        expect(res.message).toMatch(/timed out/i);
      }
    });
  });
});
