import { Platform } from 'react-native';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import {
  DEFAULT_KDF_TIMEOUT_MS,
  decryptBackup,
  encryptBackup,
  inspectBackup,
} from '../crypto/backup';
import { utf8Encode } from '../crypto/bytes';
import type { RandomSource } from '../crypto/random';
import { systemRandom } from './random';

export interface KdfBenchmarkTarget {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly label: string;
  readonly ramBytes: number;
}

/** Settings the speed check tries. All of them are inside SCRYPT_KDF_BOUNDS. */
export const BENCHMARK_TARGETS: readonly KdfBenchmarkTarget[] = [
  { N: 16384, r: 8, p: 1, label: 'N=2^14 (16,384)', ramBytes: 16 * 1024 * 1024 },
  { N: 32768, r: 8, p: 1, label: 'N=2^15 (32,768 - Current Default)', ramBytes: 32 * 1024 * 1024 },
  { N: 65536, r: 8, p: 1, label: 'N=2^16 (65,536)', ramBytes: 64 * 1024 * 1024 },
  { N: 131072, r: 8, p: 1, label: 'N=2^17 (131,072 - OWASP Minimum)', ramBytes: 128 * 1024 * 1024 },
] as const;

export const BENCHMARK_PAYLOAD_BYTES = 1_000_000; // 1 MB synthetic JSON payload

/** Made-up JSON of about the requested size. No user data goes into it. */
export function generateBenchmarkPayload(targetBytes: number = BENCHMARK_PAYLOAD_BYTES): string {
  const prefix = '{"synthetic":true,"benchmark":"kdf","records":[';
  const suffix = ']}';
  const row = '{"id":"syn-1","val":"abcdefghijklmnopqrstuvwxyz0123456789"},';
  const needed = targetBytes - prefix.length - suffix.length;
  const repeatCount = Math.max(1, Math.floor(needed / row.length));
  const body = prefix + row.repeat(repeatCount);
  const padNeeded = targetBytes - body.length - suffix.length;
  const pad = padNeeded > 0 ? '{"pad":"' + '0'.repeat(Math.max(0, padNeeded - 12)) + '"}' : '';
  return body + pad + suffix;
}

export interface KdfBenchmarkResultRow {
  target: KdfBenchmarkTarget;
  status: 'pass' | 'fail' | 'timeout' | 'cancelled';
  pureKdfMs?: number;
  encrypt1MbMs?: number;
  decrypt1MbMs?: number;
  archiveValid?: boolean;
  error?: string;
}

export interface CancellationBenchmarkResult {
  status: 'pass' | 'fail';
  targetN: number;
  cancelLatencyMs: number;
  error?: string;
}

export interface FullBenchmarkSuiteResult {
  deviceMetadata: {
    timestamp: string;
    platform: string;
    isDev: boolean;
  };
  payloadBytes: number;
  rows: KdfBenchmarkResultRow[];
  cancellation?: CancellationBenchmarkResult;
}

export interface RunBenchmarkOptions {
  targets?: readonly KdfBenchmarkTarget[];
  payloadBytes?: number;
  timeoutMs?: number;
  passphrase?: string;
  onProgress?: (progress: { currentTargetIndex: number; totalTargets: number; stage: string; percent: number }) => void;
  shouldCancel?: () => boolean;
  random?: RandomSource;
}

/** How long scrypt takes to stop after cancel is pressed. */
export async function measureCancellationLatency(
  targetN: number = 16384,
  random: RandomSource = systemRandom,
): Promise<CancellationBenchmarkResult> {
  const salt = random.bytes(16);
  const pw = utf8Encode('benchmark-cancellation-passphrase-12345');
  let cancelTriggeredAt = 0;
  let shouldCancel = false;

  try {
    const p = scryptAsync(pw, salt, {
      N: targetN,
      r: 8,
      p: 1,
      dkLen: 32,
      asyncTick: 10,
      onProgress: () => {
        if (!shouldCancel) {
          shouldCancel = true;
          cancelTriggeredAt = Date.now();
        }
        if (shouldCancel) {
          throw new Error('Benchmark cancellation triggered');
        }
      },
    });

    await p;
    return {
      status: 'fail',
      targetN,
      cancelLatencyMs: 0,
      error: 'Derivation completed without responding to cancellation',
    };
  } catch {
    const cancelLatencyMs = Date.now() - cancelTriggeredAt;
    return {
      status: 'pass',
      targetN,
      cancelLatencyMs,
    };
  } finally {
    pw.fill(0);
  }
}

/** Runs the benchmarks one after another; running them together would skew both timing and memory. */
export async function runKdfBenchmark(
  options: RunBenchmarkOptions = {},
): Promise<FullBenchmarkSuiteResult> {
  const targets = options.targets ?? BENCHMARK_TARGETS;
  const payloadBytes = options.payloadBytes ?? BENCHMARK_PAYLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_KDF_TIMEOUT_MS;
  const passphrase = options.passphrase ?? 'benchmark-secure-passphrase-12345';
  const random = options.random ?? systemRandom;
  const isDev = typeof __DEV__ !== 'undefined' && Boolean(__DEV__);

  const payload = generateBenchmarkPayload(payloadBytes);
  const rows: KdfBenchmarkResultRow[] = [];

  for (let idx = 0; idx < targets.length; idx++) {
    const target = targets[idx];
    if (options.shouldCancel?.()) {
      rows.push({ target, status: 'cancelled', error: 'Benchmark cancelled by user' });
      break;
    }

    options.onProgress?.({
      currentTargetIndex: idx,
      totalTargets: targets.length,
      stage: `Running ${target.label}...`,
      percent: Math.round((idx / targets.length) * 100),
    });

    // 1. Pure KDF timing
    let pureKdfMs: number | undefined;
    try {
      const pw = utf8Encode(passphrase);
      const salt = random.bytes(16);
      const startKdf = Date.now();
      await scryptAsync(pw, salt, {
        N: target.N,
        r: target.r,
        p: target.p,
        dkLen: 32,
        asyncTick: 10,
        onProgress: () => {
          if (options.shouldCancel?.()) throw new Error('Benchmark cancelled');
          if (Date.now() - startKdf >= timeoutMs) throw new Error('TIMEOUT');
        },
      });
      pureKdfMs = Date.now() - startKdf;
      pw.fill(0);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      rows.push({
        target,
        status: errMsg === 'TIMEOUT' ? 'timeout' : errMsg === 'Benchmark cancelled' ? 'cancelled' : 'fail',
        error: errMsg,
      });
      continue;
    }

    // Yield to JS event loop between steps
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2. Encrypt 1 MB timing
    let encrypt1MbMs: number | undefined;
    let encryptedText: string | undefined;
    try {
      const startEnc = Date.now();
      encryptedText = await encryptBackup(payload, passphrase, {
        random,
        schemaVersion: 1,
        kdfParams: { N: target.N, r: target.r, p: target.p },
        shouldCancel: options.shouldCancel,
        timeoutMs,
      });
      encrypt1MbMs = Date.now() - startEnc;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      rows.push({
        target,
        status: errMsg.includes('timed out') ? 'timeout' : errMsg.includes('cancelled') ? 'cancelled' : 'fail',
        pureKdfMs,
        error: errMsg,
      });
      continue;
    }

    // Yield to JS event loop
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 3. Decrypt 1 MB timing & archive verification
    let decrypt1MbMs: number | undefined;
    let archiveValid = false;
    try {
      const inspected = inspectBackup(encryptedText);
      if (!inspected.ok) throw new Error(`Inspection failed: ${inspected.message}`);

      const startDec = Date.now();
      const openResult = await decryptBackup(encryptedText, passphrase, {
        shouldCancel: options.shouldCancel,
        timeoutMs,
      });
      decrypt1MbMs = Date.now() - startDec;

      if (!openResult.ok) {
        throw new Error(openResult.message);
      }
      archiveValid = openResult.plaintext === payload;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      rows.push({
        target,
        status: errMsg.includes('timed out') ? 'timeout' : errMsg.includes('cancelled') ? 'cancelled' : 'fail',
        pureKdfMs,
        encrypt1MbMs,
        error: errMsg,
      });
      continue;
    }

    rows.push({
      target,
      status: 'pass',
      pureKdfMs,
      encrypt1MbMs,
      decrypt1MbMs,
      archiveValid,
    });

    // Yield before next target
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // 4. Measure cancellation latency
  let cancellation: CancellationBenchmarkResult | undefined;
  if (!options.shouldCancel?.()) {
    try {
      cancellation = await measureCancellationLatency(16384, random);
    } catch (err) {
      cancellation = {
        status: 'fail',
        targetN: 16384,
        cancelLatencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  options.onProgress?.({
    currentTargetIndex: targets.length,
    totalTargets: targets.length,
    stage: 'Benchmark complete',
    percent: 100,
  });

  return {
    deviceMetadata: {
      timestamp: new Date().toISOString(),
      platform: Platform.OS,
      isDev,
    },
    payloadBytes,
    rows,
    cancellation,
  };
}
