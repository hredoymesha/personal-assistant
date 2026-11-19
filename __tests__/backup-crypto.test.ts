import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../src/crypto/bytes';
import { BACKUP_FORMAT, MAX_BACKUP_FILE_CHARS, MAX_PLAINTEXT_CHARS, decryptBackup, encryptBackup, inspectBackup } from '../src/crypto/backup';
import type { RandomSource } from '../src/crypto/random';
import { parseData } from '../src/storage/repository';
import { createEncryptedBackup, isEncryptedBackupText, makeBackupPlaintext, unlockEncryptedBackup } from '../src/storage/backup';
import { newId } from '../src/domain/ids';
import { sampleData } from '../src/domain/sample';
import { emptyData, type AppData } from '../src/domain/types';
import { parseMoney } from '../src/domain/money';
import { createTrashRecord } from '../src/domain/trash';

const nodeRandom: RandomSource = { bytes: (n) => new Uint8Array(randomBytes(n)) };
const PASS = 'correct horse battery staple';
const deps = { random: nodeRandom };

async function backupWithKdf(N: number, p: number): Promise<string> {
  const salt = new Uint8Array(16).fill(7);
  const nonce = new Uint8Array(12).fill(9);
  const header = {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: 'scrypt' as const, N, r: 8, p, salt: base64Encode(salt) },
    passphraseNormalization: 'NFKC' as const,
    cipher: { name: 'AES-256-GCM' as const, nonce: base64Encode(nonce) },
    payload: { type: 'ai-o-data' as const, schemaVersion: 1 },
  };
  const aad = utf8Encode([
    header.format, header.version, header.kdf.name, N, header.kdf.r, p, header.kdf.salt,
    header.passphraseNormalization, header.cipher.name, header.cipher.nonce,
    header.payload.type, header.payload.schemaVersion,
  ].join('|'));
  const key = await scryptAsync(utf8Encode(PASS.normalize('NFKC')), salt, { N, r: 8, p, dkLen: 32, asyncTick: 10 });
  try {
    const ciphertext = gcm(key, nonce, aad).encrypt(utf8Encode('equivalent KDF profile'));
    return JSON.stringify({ ...header, ciphertext: base64Encode(ciphertext) });
  } finally { key.fill(0); }
}

/** One record of every data type, with Bangla, Banglish, English, Bangla digits, decimals, dates, emoji. */
function fullData(): AppData {
  const d = sampleData('2026-10-10');
  d.tasks.push({ id: newId('task'), title: 'বাজার করার কাজ ২৫০ টাকা', notes: 'Bazar korar jonno ekta task — notes 🛒', dueDate: '2026-10-11', dueTime: '17:30', priority: 'high', category: 'Personal', recurrence: 'weekly', done: false, deletedAt: null, originalText: 'Bazar korar jonno ekta task add koro.', sample: false, createdAt: '2026-10-10T00:00:00.000Z' });
  d.tasks.push({ id: newId('task'), title: 'DELETED TASK MUST NOT EXPORT', notes: '', dueDate: null, dueTime: null, priority: 'low', category: 'Other', recurrence: 'none', done: false, deletedAt: '2026-10-10T00:00:00.000Z', originalText: null, sample: false, createdAt: '2026-10-10T00:00:00.000Z' });
  d.expenses.push({ id: newId('exp'), amountMinor: parseMoney('১২৫০.৫০')!, currency: 'BDT', category: 'Food', note: 'দুপুরের খাবার / lunch er jonno', date: '2026-10-09', walletId: null, originalText: 'আজ দুপুরের খাবারের জন্য ১২৫০.৫০ টাকা খরচ', sample: false });
  d.expenses.push({ id: newId('exp'), amountMinor: 500, currency: 'JPY', category: 'Transport', note: 'ichigo 🍓 ¥500', date: '2026-10-08', walletId: null, originalText: null, sample: false });
  d.goals.push({ id: newId('goal'), name: 'ঈদের কেনাকাটা', targetMinor: 10_000_000, savedMinor: 123_456, currency: 'BDT', sample: false });
  d.debts.push({ id: newId('debt'), person: 'রহিম', direction: 'i_owe', amountMinor: 99_999, paidMinor: 1, currency: 'USD', dueDate: '2026-12-31', createdAt: null, sample: false });
  d.trash.push(createTrashRecord('expense', { id: 'trashed-expense' }, 'trashed-expense', 'Trashed expense'));
  d.settings = { currency: 'USD', theme: 'dark', language: 'bn' };
  return d;
}

let data: AppData, file: string;
beforeAll(async () => { data = fullData(); file = await createEncryptedBackup(data, PASS, deps); }, 60_000);
const mutate = (fn: (f: any) => void) => { const f = JSON.parse(file); fn(f); return JSON.stringify(f); };
const flipB64 = (s: string, at: number) => { const b = base64Decode(s)!; b[at] ^= 1; return base64Encode(b); };

describe('codecs match Node (no dependence on TextEncoder/atob in Hermes)', () => {
  it.each(['', 'a', 'বাংলা ১২৩', 'Banglish ekta', '😀👨‍👩‍👧 ¥€৳', 'a\u0000b', '\u{10FFFF}'])('utf8 + base64 round trip %j', (s) => {
    expect(Buffer.from(utf8Encode(s)).equals(Buffer.from(s, 'utf8'))).toBe(true);
    expect(utf8Decode(utf8Encode(s))).toBe(s);
    const b = utf8Encode(s);
    expect(base64Encode(b)).toBe(Buffer.from(b).toString('base64'));
    expect(Buffer.from(base64Decode(base64Encode(b))!).equals(Buffer.from(b))).toBe(true);
  });
  it('rejects malformed UTF-8 and base64', () => {
    for (const bad of [[0xc0, 0x80], [0xff], [0xe0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x90]]) expect(() => utf8Decode(Uint8Array.from(bad))).toThrow();
    for (const bad of ['abc', 'ab=c', '@@@@', 'AA=A', 'A===']) expect(base64Decode(bad)).toBeNull();
  });
  it('lone surrogates become U+FFFD like TextEncoder', () => {
    expect(Buffer.from(utf8Encode('a\ud800b')).equals(Buffer.from('a\ud800b', 'utf8'))).toBe(true);
  });
});

describe('round trips', () => {
  it('restores every data type exactly (Bangla, Banglish, English, digits, decimals, dates, emoji)', async () => {
    const r = await unlockEncryptedBackup(file, PASS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ ...data, tasks: data.tasks.filter((t) => !t.deletedAt), trash: [] });
    expect(r.data.expenses.find((e) => e.amountMinor === 125050)?.note).toBe('দুপুরের খাবার / lunch er jonno');
    expect(r.data.expenses.find((e) => e.currency === 'JPY')?.amountMinor).toBe(500);
  });
  it('does not export soft-deleted tasks', async () => {
    const r = await unlockEncryptedBackup(file, PASS);
    expect(r.ok && r.data.tasks.some((t) => t.title.includes('DELETED'))).toBe(false);
  });
  it('an empty dataset round-trips', async () => {
    const r = await unlockEncryptedBackup(await createEncryptedBackup(emptyData(), PASS, deps), PASS);
    expect(r.ok && r.data).toEqual(emptyData());
  });
  it('plain export builder still produces the same document the plain importer reads', () => {
    const p = parseData(makeBackupPlaintext(data, true));
    expect(p.ok && p.data.expenses.length).toBe(data.expenses.length);
  });
  it('is identified as an encrypted backup (and plain JSON is not)', () => {
    expect(isEncryptedBackupText(file)).toBe(true);
    expect(isEncryptedBackupText(makeBackupPlaintext(data))).toBe(false);
    expect(isEncryptedBackupText('date,amount\n2026-10-10,5')).toBe(false);
  });
});

describe('passphrases', () => {
  it('NFKC-normalises so the same passphrase typed on another keyboard still works (Bangla য় composed vs decomposed, full-width Latin)', async () => {
    const composed = 'আমারয়তিকথা-গোপন-১২৩৪';
    const decomposed = composed.normalize('NFD');
    expect(composed).not.toBe(decomposed);
    const f = await createEncryptedBackup(emptyData(), composed, deps);
    expect((await unlockEncryptedBackup(f, decomposed)).ok).toBe(true);
    const f2 = await createEncryptedBackup(emptyData(), 'ｐａｓｓｗｏｒｄ-１２３４５', deps);
    expect((await unlockEncryptedBackup(f2, 'password-12345')).ok).toBe(true);
  });
  it('wrong passphrase fails closed with no data', async () => {
    const r = await unlockEncryptedBackup(file, PASS + 'x');
    expect(r).toMatchObject({ ok: false, reason: 'wrong_passphrase' });
    expect((r as any).data).toBeUndefined();
  });
  it('empty passphrase fails', async () => expect((await unlockEncryptedBackup(file, '')).ok).toBe(false));
  it('rejects a short passphrase when creating, and never returns a file', async () => {
    await expect(createEncryptedBackup(data, 'short', deps)).rejects.toThrow(/at least 12/);
    await expect(createEncryptedBackup(data, ' '.repeat(20), deps)).rejects.toThrow(/only spaces/);
    await expect(createEncryptedBackup(data, '১২৩৪৫৬৭৮৯০১২', deps)).resolves.toBeTruthy(); // 12 Bangla digits is long enough
  });
});

describe('tampering and damage are detected', () => {
  it.each([
    ['ciphertext byte', (f: any) => { f.ciphertext = flipB64(f.ciphertext, 10); }],
    ['authentication tag (last byte)', (f: any) => { const b = base64Decode(f.ciphertext)!; b[b.length - 1] ^= 1; f.ciphertext = base64Encode(b); }],
    ['truncated ciphertext', (f: any) => { f.ciphertext = base64Encode(base64Decode(f.ciphertext)!.slice(0, -20)); }],
    ['nonce', (f: any) => { f.cipher.nonce = flipB64(f.cipher.nonce, 0); }],
    ['salt', (f: any) => { f.kdf.salt = flipB64(f.kdf.salt, 0); }],
    ['authenticated metadata (payload schemaVersion)', (f: any) => { f.payload.schemaVersion = 0; }],
    ['KDF cost downgrade (N)', (f: any) => { f.kdf.N = 16384; }],
    ['KDF parallelism', (f: any) => { f.kdf.p = 2; }],
  ])('rejects modified %s', async (_n, fn) => {
    const r = await unlockEncryptedBackup(mutate(fn), PASS);
    expect(r.ok).toBe(false);
  }, 30_000);
});

describe('malformed, unsupported and oversized files are refused before any key derivation', () => {
  const fast = async (text: string) => { const t = Date.now(); const r = inspectBackup(text); expect(Date.now() - t).toBeLessThan(250); return r; };
  it.each([
    ['not json', '{nope', 'invalid'], ['array', '[]', 'invalid'], ['wrong format', JSON.stringify({ format: 'x' }), 'invalid'], ['empty', '', 'invalid'],
  ])('%s', async (_n, text, reason) => expect(await fast(text)).toMatchObject({ ok: false, reason }));
  it('unsupported / newer versions', async () => {
    expect(await fast(mutate((f) => { f.version = 2; }))).toMatchObject({ ok: false, reason: 'newer_version' });
    expect(await fast(mutate((f) => { f.version = 0; }))).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await fast(mutate((f) => { f.version = 1.5; }))).toMatchObject({ ok: false });
    expect(await fast(mutate((f) => { f.cipher.name = 'AES-128-CBC'; }))).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await fast(mutate((f) => { f.kdf.name = 'pbkdf2'; }))).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it('unsafe KDF settings (memory/CPU denial) are rejected up front', async () => {
    for (const k of [{ N: 2 ** 25 }, { N: 2 ** 15 + 1 }, { N: 1024 }, { r: 64 }, { p: 1000 }, { N: '32768' }, { p: 0 }]) {
      expect(await fast(mutate((f) => { Object.assign(f.kdf, k); }))).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });
  it('caps N × p and still decrypts an equivalent valid KDF profile', async () => {
    const equivalent = await backupWithKdf(2 ** 14, 2);
    expect(await decryptBackup(equivalent, PASS)).toMatchObject({ ok: true, plaintext: 'equivalent KDF profile' });
    expect(await fast(mutate((f) => { f.kdf.N = 2 ** 15; f.kdf.p = 4; }))).toMatchObject({ ok: true });
    expect(await fast(mutate((f) => { f.kdf.N = 2 ** 17; f.kdf.p = 2; }))).toMatchObject({ ok: false, reason: 'invalid' });
  }, 30_000);
  it('bad base64 / lengths', async () => {
    for (const fn of [(f: any) => { f.kdf.salt = 'AAAA'; }, (f: any) => { f.cipher.nonce = '@@@@'; }, (f: any) => { f.ciphertext = 'AAAA'; }, (f: any) => { f.ciphertext = 5; }]) {
      expect(await fast(mutate(fn))).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });
  it('oversized files are refused without parsing', async () => {
    const t = Date.now();
    const r = await decryptBackup('x'.repeat(MAX_BACKUP_FILE_CHARS + 1), PASS);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(Date.now() - t).toBeLessThan(250);
  });
  it('refuses to create a backup larger than it can later restore', async () => {
    await expect(encryptBackup('x'.repeat(MAX_PLAINTEXT_CHARS + 1), PASS, { ...deps, schemaVersion: 1 })).rejects.toThrow(/too large/);
  });
  it('a valid envelope whose plaintext is not valid Personal Assistant data is rejected without changing anything', async () => {
    const f = await encryptBackup('{"schemaVersion":1,"settings":"nope"}', PASS, { ...deps, schemaVersion: 1 });
    expect(await unlockEncryptedBackup(f, PASS)).toMatchObject({ ok: false, reason: 'data_invalid' });
    const g = await encryptBackup(JSON.stringify({ ...emptyData(), schemaVersion: 99 }), PASS, { ...deps, schemaVersion: 99 });
    expect(await unlockEncryptedBackup(g, PASS)).toMatchObject({ ok: false, reason: 'data_invalid' }); // from a newer app
  });
});

describe('randomness and file contents', () => {
  it('uses a fresh salt and nonce every time', async () => {
    const a = JSON.parse(await createEncryptedBackup(emptyData(), PASS, deps)), b = JSON.parse(await createEncryptedBackup(emptyData(), PASS, deps));
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.nonce).not.toBe(b.cipher.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(base64Decode(a.kdf.salt)!.length).toBe(16);
    expect(base64Decode(a.cipher.nonce)!.length).toBe(12);
  });
  it('contains no passphrase, key, or readable record text, and declares its format', () => {
    for (const secret of [PASS, 'দুপুরের', 'lunch', 'রহিম', 'Bazar korar', '125050', 'DELETED']) expect(file).not.toContain(secret);
    const f = JSON.parse(file);
    expect(f.format).toBe(BACKUP_FORMAT);
    expect(Object.keys(f).sort()).toEqual(['cipher', 'ciphertext', 'format', 'kdf', 'passphraseNormalization', 'payload', 'version']);
    expect(Object.keys(f.kdf).sort()).toEqual(['N', 'name', 'p', 'r', 'salt']);
    expect(f.kdf).toMatchObject({ name: 'scrypt', N: 32768, r: 8, p: 1 });
  });
  it('fails closed (no file) if the random generator misbehaves', async () => {
    for (const bytes of [() => new Uint8Array(3), () => undefined as unknown as Uint8Array]) {
      await expect(encryptBackup('{}', PASS, { random: { bytes }, schemaVersion: 1 })).rejects.toThrow(/random/i);
    }
  });
  it('errors never contain the passphrase or plaintext', async () => {
    const secretPass = 'SECRET-PASSPHRASE-do-not-leak-1234';
    const msgs: string[] = [];
    try { await createEncryptedBackup(data, secretPass, { random: { bytes: () => new Uint8Array(1) } }); } catch (e) { msgs.push(String((e as Error).message)); }
    const r = await unlockEncryptedBackup(file, secretPass); msgs.push(JSON.stringify(r));
    for (const m of msgs) { expect(m).not.toContain(secretPass); expect(m).not.toContain('দুপুরের'); }
  });
  it('reports progress while deriving the key', async () => {
    const seen: number[] = [];
    await decryptBackup(file, PASS, (p) => seen.push(p));
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0.9);
  });
  it('stops KDF work when cancelled and returns no backup file', async () => {
    let checks = 0;
    await expect(encryptBackup('{}', PASS, {
      ...deps, schemaVersion: 1, shouldCancel: () => ++checks > 1,
    })).rejects.toThrow(/cancelled.*no file was created/i);
    expect(checks).toBeGreaterThan(1);
  }, 30_000);
  it('stops KDF work at the timeout and returns no backup file', async () => {
    await expect(encryptBackup('{}', PASS, { ...deps, schemaVersion: 1, timeoutMs: 1 }))
      .rejects.toThrow(/timed out.*no file was created/i);
  });
});

describe('no secret logging anywhere in src', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []; });
  it('src has no console.* calls', () => {
    const offenders = walk(join(__dirname, '..', 'src')).filter((p) => /\bconsole\s*\./.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
