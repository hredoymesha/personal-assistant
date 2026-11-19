import { gcm } from '@noble/ciphers/aes.js';
import { decryptBackup, encryptBackup } from '../crypto/backup';
import { base64Decode, base64Encode, utf8Encode } from '../crypto/bytes';
import type { RandomSource } from '../crypto/random';
import type { Vault } from './vault';

export interface SelfTestResult { name: string; status: 'pass' | 'fail' | 'skip'; detail: string; ms?: number }

const TEST_KEY = 'aio.selftest.v1';
const SAMPLE = 'নমুনা ডেটা / sample ১২৩.৫০ ৳, not real data';

async function timed(name: string, fn: () => Promise<string>): Promise<SelfTestResult> {
  const t = Date.now();
  try { const detail = await fn(); return { name, status: 'pass', detail, ms: Date.now() - t }; }
  catch (e) { return { name, status: 'fail', detail: e instanceof Error ? e.message : 'failed', ms: Date.now() - t }; }
}

/**
 * Read-only diagnostics for the device/runtime: touches NO user data and writes only a throwaway
 * random value that it deletes again. Output contains no secrets (only pass/fail, sizes and timings).
 */
export async function runSelfTest(deps: { random: RandomSource; vault: Vault; includeKdf: boolean; onProgress?: (fraction: number) => void }): Promise<SelfTestResult[]> {
  const out: SelfTestResult[] = [];

  out.push(await timed('Secure random numbers', async () => {
    const a = deps.random.bytes(32), b = deps.random.bytes(32);
    if (a.length !== 32 || b.length !== 32) throw new Error('wrong length');
    if (a.every((x) => x === a[0])) throw new Error('constant output');
    if (a.every((x, i) => x === b[i])) throw new Error('repeated output');
    return '32-byte draws are distinct';
  }));

  out.push(await timed('AES-256-GCM in this JavaScript engine', async () => {
    const key = deps.random.bytes(32), nonce = deps.random.bytes(12), aad = utf8Encode('selftest');
    const pt = utf8Encode(SAMPLE);
    const ct = gcm(key, nonce, aad).encrypt(pt);
    const back = gcm(key, nonce, aad).decrypt(ct);
    if (back.length !== pt.length || back.some((x, i) => x !== pt[i])) throw new Error('round trip mismatch');
    const bad = ct.slice(); bad[0] ^= 1;
    let rejected = false;
    try { gcm(key, nonce, aad).decrypt(bad); } catch { rejected = true; }
    if (!rejected) throw new Error('tampered data was accepted');
    key.fill(0);
    return 'round trip OK, tampering rejected';
  }));

  if (await deps.vault.isAvailable().catch(() => false)) {
    out.push(await timed('Secure key vault (Keychain / Keystore)', async () => {
      const value = base64Encode(deps.random.bytes(32));
      try {
        await deps.vault.set(TEST_KEY, value);
        const got = await deps.vault.get(TEST_KEY);
        if (got !== value) throw new Error('value read back does not match');
        const b = base64Decode(got ?? '');
        if (!b || b.length !== 32) throw new Error('value corrupted');
      } finally { await deps.vault.remove(TEST_KEY).catch(() => undefined); }
      if ((await deps.vault.get(TEST_KEY)) !== null) throw new Error('test value was not deleted');
      return 'stored, read back and deleted a throwaway key';
    }));
  } else out.push({ name: 'Secure key vault (Keychain / Keystore)', status: 'skip', detail: 'Not available on this platform (expected in a web browser).' });

  if (deps.includeKdf) {
    let ct = '';
    out.push(await timed('Encrypt a backup (password key derivation)', async () => {
      ct = await encryptBackup(SAMPLE, 'self-test passphrase 12345', { random: deps.random, schemaVersion: 1, onProgress: (f) => deps.onProgress?.(f / 2) });
      return `encrypted ${SAMPLE.length}-char sample`;
    }));
    if (ct) {
      out.push(await timed('Decrypt a backup (password key derivation)', async () => {
        const r = await decryptBackup(ct, 'self-test passphrase 12345', (f) => deps.onProgress?.(0.5 + f / 2));
        if (!r.ok || r.plaintext !== SAMPLE) throw new Error('backup round trip failed');
        return 'sample restored exactly';
      }));
    }
  }
  return out;
}
