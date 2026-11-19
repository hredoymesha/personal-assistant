import { randomBytes } from 'node:crypto';
import type { RandomSource } from '../src/crypto/random';
import { runSelfTest } from '../src/services/selfTest';
import type { Vault } from '../src/services/vault';

const random: RandomSource = { bytes: (n) => new Uint8Array(randomBytes(n)) };
const memVault = (opts: { available?: boolean; corrupt?: boolean; keep?: boolean } = {}): Vault & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, isAvailable: async () => opts.available ?? true,
    set: async (k, v) => { m.set(k, opts.corrupt ? v + 'x' : v); },
    get: async (k) => m.get(k) ?? null,
    remove: async (k) => { if (!opts.keep) m.delete(k); } };
};

describe('self-test', () => {
  it('passes on a healthy runtime and leaves no vault entry behind', async () => {
    const vault = memVault();
    const r = await runSelfTest({ random, vault, includeKdf: true });
    expect(r.map((x) => x.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(vault.m.size).toBe(0);
  }, 60_000);
  it('skips the vault where unavailable (web) and still runs the rest', async () => {
    const r = await runSelfTest({ random, vault: memVault({ available: false }), includeKdf: false });
    expect(r.find((x) => x.name.includes('vault'))?.status).toBe('skip');
    expect(r.filter((x) => x.status === 'fail')).toEqual([]);
  });
  it('detects a vault that corrupts values, or fails to delete', async () => {
    expect((await runSelfTest({ random, vault: memVault({ corrupt: true }), includeKdf: false })).find((x) => x.name.includes('vault'))?.status).toBe('fail');
    expect((await runSelfTest({ random, vault: memVault({ keep: true }), includeKdf: false })).find((x) => x.name.includes('vault'))?.status).toBe('fail');
  });
  it('detects a broken random generator', async () => {
    for (const bytes of [(n: number) => new Uint8Array(n), (n: number) => new Uint8Array(n - 1)]) {
      const r = await runSelfTest({ random: { bytes }, vault: memVault(), includeKdf: false });
      expect(r[0].status).toBe('fail');
    }
  });
  it('reports no secrets: details are short fixed strings', async () => {
    const r = await runSelfTest({ random, vault: memVault(), includeKdf: false });
    for (const x of r) expect(x.detail.length).toBeLessThan(80);
  });
});
