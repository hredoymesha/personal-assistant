import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './bytes';
import type { RandomSource } from './random';

/**
 * Passphrase-protected backup file.
 *
 *   key        = scrypt(NFKC(passphrase) as UTF-8, salt[16], N=2^15, r=8, p=1) -> 32 bytes
 *   ciphertext = AES-256-GCM(key, nonce[12], plaintext, AAD = every non-secret header field)
 *
 * Only reputable primitives (@noble/hashes, @noble/ciphers, MIT, pure JS) are used; nothing custom.
 * Neither the passphrase nor the key is ever written. A fresh salt (=> a fresh key) and nonce are
 * generated per backup, so a nonce is never reused under one key. The header is authenticated, so
 * editing any of it (KDF cost, schema number, ...) makes decryption fail.
 */
export const BACKUP_FORMAT = 'ai-o-encrypted-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_FILE_CHARS = 12_000_000;
export const MAX_PLAINTEXT_CHARS = 5_000_000;
export const MIN_PASSPHRASE_CHARS = 12;
export const DEFAULT_KDF_TIMEOUT_MS = 120_000;
const GCM_TAG_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_CHARS * 3 + GCM_TAG_BYTES;

/**
 * Cost is limited by pure-JS speed on phones (Hermes has no JIT): in a no-JIT proxy test scrypt N=2^15
 * took ~11 s on a desktop CPU and PBKDF2-600k took ~72 s. These params are stored in each file, so a
 * future version can raise them; restore accepts files made with stronger settings up to the bounds below.
 */
export const DEFAULT_KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const;

export interface ScryptKdfBounds {
  readonly minN: number;
  readonly maxN: number;
  readonly r: number;
  readonly minP: number;
  readonly maxP: number;
  readonly maxTotalWork: number;
  readonly maxEstimatedMemoryBytes: number;
}

/**
 * Limits for KDF settings read from a backup header, so a crafted file can't make restore
 * burn minutes of CPU or hundreds of MB of memory: N is a power of two from 2^14 to 2^17,
 * r is 8, p is 1 to 4, N*p is at most 2^17 and 128*r*N at most 128 MB.
 */
export const SCRYPT_KDF_BOUNDS: ScryptKdfBounds = {
  minN: 2 ** 14, // 16,384: Minimum cost for brute-force resistance
  maxN: 2 ** 17, // 131,072: Maximum N to prevent mobile OOM/CPU denial
  r: 8, // Fixed scrypt block size parameter
  minP: 1, // Minimum parallelism
  maxP: 4, // Maximum parallelism
  maxTotalWork: 2 ** 17, // 131,072: Maximum N * p work cap
  maxEstimatedMemoryBytes: 128 * 8 * (2 ** 17), // 134,217,728 bytes (128 MB max memory)
} as const;

export const KDF_BOUNDS = SCRYPT_KDF_BOUNDS;
export const MAX_KDF_WORK = SCRYPT_KDF_BOUNDS.maxTotalWork;

export interface BackupHeader {
  format: string;
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  passphraseNormalization: 'NFKC';
  cipher: { name: 'AES-256-GCM'; nonce: string };
  payload: { type: 'ai-o-data'; schemaVersion: number };
}
export type BackupFile = BackupHeader & { ciphertext: string };

export type CryptoFailure = 'invalid' | 'unsupported' | 'newer_version' | 'too_large' | 'wrong_passphrase' | 'passphrase_too_short' | 'internal';
export type InspectResult = { ok: true; header: BackupHeader; file: BackupFile } | { ok: false; reason: CryptoFailure; message: string };
export type OpenResult = { ok: true; plaintext: string; schemaVersion: number } | { ok: false; reason: CryptoFailure; message: string };

const bad = (reason: CryptoFailure, message: string) => ({ ok: false as const, reason, message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function passphraseLength(p: string): number { return [...p.normalize('NFKC')].length; }

/** The exact bytes authenticated alongside the ciphertext. Built field by field, never from JSON key order. */
function aadFor(h: BackupHeader): Uint8Array {
  return utf8Encode([h.format, h.version, h.kdf.name, h.kdf.N, h.kdf.r, h.kdf.p, h.kdf.salt, h.passphraseNormalization, h.cipher.name, h.cipher.nonce, h.payload.type, h.payload.schemaVersion].join('|'));
}

/** Validates size, format, version and every parameter BEFORE any expensive key derivation. */
export function inspectBackup(text: string): InspectResult {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_FILE_CHARS) return bad('too_large', 'This backup file is too large to restore.');
  let f: unknown;
  try { f = JSON.parse(text); } catch { return bad('invalid', 'This is not a valid Personal Assistant backup file.'); }
  if (!isObj(f) || f.format !== BACKUP_FORMAT) return bad('invalid', 'This is not a Personal Assistant encrypted backup.');
  if (typeof f.version !== 'number' || !Number.isInteger(f.version) || f.version < 1) return bad('unsupported', 'Unsupported backup version.');
  if (f.version > BACKUP_VERSION) return bad('newer_version', `This backup was made by a newer Personal Assistant (format v${f.version}). Update Personal Assistant to restore it.`);
  const { kdf, cipher, payload } = f as { kdf?: unknown; cipher?: unknown; payload?: unknown };
  if (!isObj(kdf) || kdf.name !== 'scrypt') return bad('unsupported', 'Unsupported key-derivation method.');
  const { N, r, p } = kdf as { N?: unknown; r?: unknown; p?: unknown };
  if (
    typeof N !== 'number' || !Number.isInteger(N) || N < SCRYPT_KDF_BOUNDS.minN || N > SCRYPT_KDF_BOUNDS.maxN || (N & (N - 1)) !== 0
    || typeof r !== 'number' || !Number.isInteger(r) || r !== SCRYPT_KDF_BOUNDS.r
    || typeof p !== 'number' || !Number.isInteger(p) || p < SCRYPT_KDF_BOUNDS.minP || p > SCRYPT_KDF_BOUNDS.maxP
    || N * p > SCRYPT_KDF_BOUNDS.maxTotalWork
    || (128 * r * N) > SCRYPT_KDF_BOUNDS.maxEstimatedMemoryBytes
  ) {
    return bad('invalid', 'The backup has invalid or unsafe key-derivation settings (backup uses unsupported/dangerous settings).');
  }
  const salt = typeof kdf.salt === 'string' ? base64Decode(kdf.salt) : null;
  if (!salt || salt.length !== 16) return bad('invalid', 'The backup is damaged (salt).');
  if (f.passphraseNormalization !== 'NFKC') return bad('unsupported', 'Unsupported passphrase handling.');
  if (!isObj(cipher) || cipher.name !== 'AES-256-GCM') return bad('unsupported', 'Unsupported cipher.');
  const nonce = typeof cipher.nonce === 'string' ? base64Decode(cipher.nonce) : null;
  if (!nonce || nonce.length !== 12) return bad('invalid', 'The backup is damaged (nonce).');
  if (!isObj(payload) || payload.type !== 'ai-o-data' || typeof payload.schemaVersion !== 'number' || !Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 0) return bad('invalid', 'The backup is damaged (payload description).');
  const ct = typeof f.ciphertext === 'string' ? base64Decode(f.ciphertext) : null;
  if (!ct || ct.length < GCM_TAG_BYTES) return bad('invalid', 'The backup is damaged (data).');
  if (ct.length > MAX_CIPHERTEXT_BYTES) return bad('too_large', 'This backup is too large to restore.');
  const header: BackupHeader = {
    format: BACKUP_FORMAT, version: f.version,
    kdf: { name: 'scrypt', N, r, p, salt: kdf.salt as string },
    passphraseNormalization: 'NFKC',
    cipher: { name: 'AES-256-GCM', nonce: cipher.nonce as string },
    payload: { type: 'ai-o-data', schemaVersion: payload.schemaVersion },
  };
  return { ok: true, header, file: { ...header, ciphertext: f.ciphertext as string } };
}

async function deriveKey(passphrase: string, h: BackupHeader, onProgress?: (p: number) => void, shouldStop?: () => void): Promise<Uint8Array> {
  const pw = utf8Encode(passphrase.normalize('NFKC'));
  const reportProgress = onProgress || shouldStop
    ? (fraction: number) => { shouldStop?.(); onProgress?.(fraction); }
    : undefined;
  try {
    return await scryptAsync(pw, base64Decode(h.kdf.salt)!, { N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, dkLen: 32, asyncTick: 10, onProgress: reportProgress });
  } finally { pw.fill(0); }
}

export interface EncryptDeps {
  random: RandomSource;
  onProgress?: (fraction: number) => void;
  schemaVersion: number;
  shouldCancel?: () => boolean;
  timeoutMs?: number;
  kdfParams?: { N: number; r: number; p: number };
}

/** Throws (never returns a file) if anything is wrong; there is no plaintext fallback. */
export async function encryptBackup(plaintext: string, passphrase: string, deps: EncryptDeps): Promise<string> {
  if (passphraseLength(passphrase) < MIN_PASSPHRASE_CHARS) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`);
  if (!/\S/.test(passphrase)) throw new Error('Passphrase cannot be only spaces.');
  if (plaintext.length > MAX_PLAINTEXT_CHARS) throw new Error('Your data is too large to back up in this format.');
  const salt = deps.random.bytes(16);
  const nonce = deps.random.bytes(12);
  if (salt?.length !== 16 || nonce?.length !== 12) throw new Error('Secure random generator failed; nothing was written.');
  let kdf: BackupHeader['kdf'] = { ...DEFAULT_KDF, salt: base64Encode(salt) };
  if (deps.kdfParams) {
    const { N, r, p } = deps.kdfParams;
    if (
      typeof N !== 'number' || !Number.isInteger(N) || N < SCRYPT_KDF_BOUNDS.minN || N > SCRYPT_KDF_BOUNDS.maxN || (N & (N - 1)) !== 0
      || typeof r !== 'number' || !Number.isInteger(r) || r !== SCRYPT_KDF_BOUNDS.r
      || typeof p !== 'number' || !Number.isInteger(p) || p < SCRYPT_KDF_BOUNDS.minP || p > SCRYPT_KDF_BOUNDS.maxP
      || N * p > SCRYPT_KDF_BOUNDS.maxTotalWork
      || (128 * r * N) > SCRYPT_KDF_BOUNDS.maxEstimatedMemoryBytes
    ) {
      throw new Error('Requested KDF parameters violate security bounds.');
    }
    kdf = { name: 'scrypt', N, r, p, salt: base64Encode(salt) };
  }
  const header: BackupHeader = {
    format: BACKUP_FORMAT, version: BACKUP_VERSION,
    kdf,
    passphraseNormalization: 'NFKC',
    cipher: { name: 'AES-256-GCM', nonce: base64Encode(nonce) },
    payload: { type: 'ai-o-data', schemaVersion: deps.schemaVersion },
  };
  const startedAt = Date.now();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_KDF_TIMEOUT_MS;
  const checkCanContinue = () => {
    if (deps.shouldCancel?.()) throw new Error('Backup creation cancelled; no file was created.');
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Backup key derivation timed out; no file was created.');
  };
  checkCanContinue();
  const key = await deriveKey(passphrase, header, deps.onProgress, checkCanContinue);
  try {
    checkCanContinue();
    const pt = utf8Encode(plaintext);
    const ct = gcm(key, nonce, aadFor(header)).encrypt(pt);
    // Self-check before handing a file to the user: it must decrypt back to exactly the input.
    const back = gcm(key, nonce, aadFor(header)).decrypt(ct);
    if (back.length !== pt.length || back.some((b, i) => b !== pt[i])) throw new Error('Backup self-check failed; nothing was written.');
    return JSON.stringify({ ...header, ciphertext: base64Encode(ct) });
  } finally { key.fill(0); }
}

export interface DecryptOptions {
  onProgress?: (fraction: number) => void;
  shouldCancel?: () => boolean;
  timeoutMs?: number;
}

export type DecryptProgressOrOptions = ((fraction: number) => void) | DecryptOptions;

/** Fails closed: any wrong passphrase / tampering / damage returns an error and no plaintext. */
export async function decryptBackup(
  text: string,
  passphrase: string,
  optionsOrProgress?: DecryptProgressOrOptions,
): Promise<OpenResult> {
  const info = inspectBackup(text);
  if (!info.ok) return info;
  if (!passphrase) return bad('wrong_passphrase', 'Enter the backup passphrase.');

  const onProgress = typeof optionsOrProgress === 'function' ? optionsOrProgress : optionsOrProgress?.onProgress;
  const shouldCancel = typeof optionsOrProgress === 'object' ? optionsOrProgress?.shouldCancel : undefined;
  const timeoutMs = typeof optionsOrProgress === 'object' ? (optionsOrProgress?.timeoutMs ?? DEFAULT_KDF_TIMEOUT_MS) : DEFAULT_KDF_TIMEOUT_MS;
  const startedAt = Date.now();
  const checkCanContinue = () => {
    if (shouldCancel?.()) throw new Error('Backup decryption cancelled; nothing was restored.');
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Backup key derivation timed out; nothing was restored.');
  };

  let key: Uint8Array | null = null;
  try {
    checkCanContinue();
    key = await deriveKey(passphrase, info.header, onProgress, checkCanContinue);
    const pt = gcm(key, base64Decode(info.header.cipher.nonce)!, aadFor(info.header)).decrypt(base64Decode(info.file.ciphertext)!);
    let plaintext: string;
    try { plaintext = utf8Decode(pt); } catch { return bad('invalid', 'The backup decrypted but its contents are not valid text.'); }
    if (plaintext.length > MAX_PLAINTEXT_CHARS) return bad('too_large', 'The backup contents are too large.');
    return { ok: true, plaintext, schemaVersion: info.header.payload.schemaVersion };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('cancelled') || msg.includes('timed out')) {
      return bad('internal', msg);
    }
    // AES-GCM cannot tell a wrong passphrase from modified data, and we deliberately don't try to.
    return bad('wrong_passphrase', 'Wrong passphrase, or the file was changed or damaged. Nothing was restored.');
  } finally { key?.fill(0); }
}
