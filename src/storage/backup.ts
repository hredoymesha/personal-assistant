import { decryptBackup, encryptBackup, inspectBackup, type CryptoFailure, type EncryptDeps, type DecryptProgressOrOptions } from '../crypto/backup';
import { SCHEMA_VERSION, type AppData } from '../domain/types';
import { parseData } from './repository';

/** The exact document that is backed up (deleted items and trash are not exported). Shared by plain and encrypted exports. */
export function makeBackupPlaintext(data: AppData, pretty = false): string {
  return JSON.stringify({
    ...data,
    tasks: data.tasks.filter((t) => !t.deletedAt),
    trash: [],
  }, null, pretty ? 2 : undefined);
}

export async function createEncryptedBackup(data: AppData, passphrase: string, deps: Omit<EncryptDeps, 'schemaVersion'>): Promise<string> {
  return encryptBackup(makeBackupPlaintext(data), passphrase, { ...deps, schemaVersion: SCHEMA_VERSION });
}

export type UnlockResult = { ok: true; data: AppData } | { ok: false; reason: CryptoFailure | 'data_invalid'; message: string };

/** True if the text looks like a Personal Assistant encrypted backup (used to route pasted/picked files). */
export function isEncryptedBackupText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') && t.slice(0, 400).includes('"ai-o-encrypted-backup"');
}

/**
 * Decrypts, migrates and validates a backup without writing anything, so a wrong passphrase,
 * a tampered file or bad contents can't touch existing data. Restoring is a separate step
 * that only happens after the user reviews and confirms.
 */
export async function unlockEncryptedBackup(text: string, passphrase: string, onProgressOrOptions?: DecryptProgressOrOptions): Promise<UnlockResult> {
  const r = await decryptBackup(text, passphrase, onProgressOrOptions);
  if (!r.ok) return r;
  const parsed = parseData(r.plaintext);
  if (!parsed.ok) return { ok: false, reason: 'data_invalid', message: `The backup unlocked but its data is not valid: ${parsed.error}` };
  return { ok: true, data: parsed.data };
}

export { inspectBackup };
