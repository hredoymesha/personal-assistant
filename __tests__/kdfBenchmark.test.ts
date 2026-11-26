import { randomBytes } from 'node:crypto';
import {
  BENCHMARK_TARGETS,
  generateBenchmarkPayload,
  measureCancellationLatency,
  runKdfBenchmark,
} from '../src/services/kdfBenchmark';
import {
  decryptBackup,
  DEFAULT_KDF,
  encryptBackup,
  inspectBackup,
  SCRYPT_KDF_BOUNDS,
} from '../src/crypto/backup';
import type { RandomSource } from '../src/crypto/random';

describe('KDF speed check', () => {
  const testRandom: RandomSource = { bytes: (n) => new Uint8Array(randomBytes(n)) };

  // Target parameter bounds validation
  it('conforms to SCRYPT_KDF_BOUNDS for all 4 benchmark targets', () => {
    expect(BENCHMARK_TARGETS).toHaveLength(4);
    const expectedNs = [16384, 32768, 65536, 131072];

    for (let i = 0; i < BENCHMARK_TARGETS.length; i++) {
      const target = BENCHMARK_TARGETS[i];
      expect(target.N).toBe(expectedNs[i]);
      expect(target.r).toBe(8);
      expect(target.p).toBe(1);
      expect(target.N).toBeGreaterThanOrEqual(SCRYPT_KDF_BOUNDS.minN);
      expect(target.N).toBeLessThanOrEqual(SCRYPT_KDF_BOUNDS.maxN);
      expect(target.N * target.p).toBeLessThanOrEqual(SCRYPT_KDF_BOUNDS.maxTotalWork);
      expect(128 * target.r * target.N).toBeLessThanOrEqual(SCRYPT_KDF_BOUNDS.maxEstimatedMemoryBytes);
      expect(target.ramBytes).toBe(128 * target.r * target.N);
    }
  });

  // Synthetic payload generation
  it('generates valid synthetic JSON payload of the requested size without personal data', () => {
    const payload = generateBenchmarkPayload(10_000);
    expect(payload.length).toBeGreaterThanOrEqual(9_900);
    expect(payload.length).toBeLessThanOrEqual(10_100);

    const parsed = JSON.parse(payload);
    expect(parsed.synthetic).toBe(true);
    expect(parsed.benchmark).toBe('kdf');
    expect(Array.isArray(parsed.records)).toBe(true);
    expect(payload).not.toContain('Anisur');
    expect(payload).not.toContain('+880');
  });

  // encryptBackup kdfParams extension and boundary enforcement
  it('encryptBackup accepts kdfParams within bounds and decrypts cleanly', async () => {
    const random = testRandom;
    const plaintext = '{"synthetic":true,"test":"kdfParams"}';
    const passphrase = 'valid-passphrase-12345';

    // Test with N=16384 (Option b)
    const encryptedN14 = await encryptBackup(plaintext, passphrase, {
      random,
      schemaVersion: 1,
      kdfParams: { N: 16384, r: 8, p: 1 },
    });

    const inspected = inspectBackup(encryptedN14);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.header.kdf.N).toBe(16384);
      expect(inspected.header.kdf.r).toBe(8);
      expect(inspected.header.kdf.p).toBe(1);
    }

    const decrypted = await decryptBackup(encryptedN14, passphrase);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.plaintext).toBe(plaintext);
    }
  });

  // encryptBackup rejects unsafe or out-of-bounds kdfParams
  it('encryptBackup rejects out-of-bounds KDF parameters', async () => {
    const random = testRandom;
    const plaintext = 'test';
    const passphrase = 'valid-passphrase-12345';

    // N too low (below 2^14)
    await expect(
      encryptBackup(plaintext, passphrase, {
        random,
        schemaVersion: 1,
        kdfParams: { N: 8192, r: 8, p: 1 },
      }),
    ).rejects.toThrow('Requested KDF parameters violate security bounds.');

    // N too high (above 2^17)
    await expect(
      encryptBackup(plaintext, passphrase, {
        random,
        schemaVersion: 1,
        kdfParams: { N: 262144, r: 8, p: 1 },
      }),
    ).rejects.toThrow('Requested KDF parameters violate security bounds.');

    // Non-power-of-two N
    await expect(
      encryptBackup(plaintext, passphrase, {
        random,
        schemaVersion: 1,
        kdfParams: { N: 30000, r: 8, p: 1 },
      }),
    ).rejects.toThrow('Requested KDF parameters violate security bounds.');
  });

  // Default KDF preservation
  it('preserves DEFAULT_KDF when kdfParams is omitted', async () => {
    const random = testRandom;
    const encrypted = await encryptBackup('data', 'valid-passphrase-12345', {
      random,
      schemaVersion: 1,
    });
    const inspected = inspectBackup(encrypted);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.header.kdf.N).toBe(DEFAULT_KDF.N);
      expect(inspected.header.kdf.r).toBe(DEFAULT_KDF.r);
      expect(inspected.header.kdf.p).toBe(DEFAULT_KDF.p);
    }
  });

  // Cancellation measurement helper
  it('measures cancellation latency when aborted during derivation', async () => {
    const random = testRandom;
    const cancelRes = await measureCancellationLatency(16384, random);
    expect(cancelRes.status).toBe('pass');
    expect(cancelRes.targetN).toBe(16384);
    expect(cancelRes.cancelLatencyMs).toBeGreaterThanOrEqual(0);
  });

  // runKdfBenchmark end to end, with a fast run
  it('executes lightweight benchmark run reporting pure KDF, encrypt, decrypt and archive validity', async () => {
    const random = testRandom;
    const progressLog: string[] = [];

    const result = await runKdfBenchmark({
      targets: [{ N: 16384, r: 8, p: 1, label: 'Test N=16384', ramBytes: 16 * 1024 * 1024 }],
      payloadBytes: 1_000, // Lightweight 1 KB for fast unit test
      passphrase: 'benchmark-test-passphrase-12345',
      random,
      onProgress: (p) => progressLog.push(p.stage),
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.status).toBe('pass');
    expect(row.pureKdfMs).toBeGreaterThanOrEqual(0);
    expect(row.encrypt1MbMs).toBeGreaterThanOrEqual(0);
    expect(row.decrypt1MbMs).toBeGreaterThanOrEqual(0);
    expect(row.archiveValid).toBe(true);
    expect(result.cancellation?.status).toBe('pass');
    expect(progressLog.length).toBeGreaterThan(0);
  });

  // Cooperative cancellation in runKdfBenchmark
  it('halts benchmark run when shouldCancel returns true', async () => {
    const random = testRandom;
    let cancelCalled = false;

    const result = await runKdfBenchmark({
      targets: [
        { N: 16384, r: 8, p: 1, label: 'Target 1', ramBytes: 16 * 1024 * 1024 },
        { N: 32768, r: 8, p: 1, label: 'Target 2', ramBytes: 32 * 1024 * 1024 },
      ],
      payloadBytes: 500,
      random,
      shouldCancel: () => {
        if (!cancelCalled) {
          cancelCalled = true;
          return false;
        }
        return true;
      },
    });

    expect(result.rows.some((r) => r.status === 'cancelled')).toBe(true);
  });
});
