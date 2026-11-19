/**
 * Automatic Google Drive backup, off by default. The passphrase sits in the secure vault only
 * while the switch is on and is deleted the moment it's turned off. The OS decides when
 * background work runs, so there's no fixed time. Each attempt records when it ran and, if it
 * failed, why.
 */

import { AppData } from '../domain/types';
import { createEncryptedBackup } from '../storage/backup';
import { systemRandom } from './random';
import { KeyValueStore } from '../storage/store';
import { asyncStorageStore } from '../storage/asyncStorageStore';
import { Vault, secureVault } from './vault';
import { getValidAccessToken, FetchFunction } from './googleAuth';
import { findOrCreateBackupFolder, uploadEncryptedBackupFile, enforceRetentionPolicy } from './googleDrive';
import { DriveConfig, getDriveConfig, isDriveFeatureEnabled, getRetentionCopy } from './driveConfig';

export const AUTOBACKUP_PASSPHRASE_KEY = 'aio.autobackup.passphrase';
export const BACKUP_STATUS_STORE_KEY = 'aio.backup.status';

export const AUTO_BACKUP_DISCLOSURE_TEXT =
  'At most once a day, and never guaranteed. The OS decides when background tasks run; no backup runs if the app is force-closed or offline.';

export const BACKUP_RETENTION_NOTE = getRetentionCopy();

export interface BackupStatus {
  enabled: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
}

export const INITIAL_BACKUP_STATUS: BackupStatus = {
  enabled: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: null,
};

export async function getBackupStatus(store: KeyValueStore = asyncStorageStore): Promise<BackupStatus> {
  try {
    const raw = await store.getItem(BACKUP_STATUS_STORE_KEY);
    if (!raw) return INITIAL_BACKUP_STATUS;
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed.enabled),
      lastAttempt: parsed.lastAttempt || null,
      lastSuccess: parsed.lastSuccess || null,
      lastError: parsed.lastError || null,
    };
  } catch {
    return INITIAL_BACKUP_STATUS;
  }
}

export async function recordBackupStatus(
  patch: Partial<BackupStatus>,
  store: KeyValueStore = asyncStorageStore,
): Promise<BackupStatus> {
  const current = await getBackupStatus(store);
  const updated: BackupStatus = { ...current, ...patch };
  await store.setItem(BACKUP_STATUS_STORE_KEY, JSON.stringify(updated));
  return updated;
}

/** Turns automatic backup on or off. Turning it off deletes the stored passphrase. */
export async function setAutoBackupConfig(
  enabled: boolean,
  passphrase?: string,
  vault: Vault = secureVault,
  store: KeyValueStore = asyncStorageStore,
): Promise<void> {
  if (enabled) {
    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error('A backup passphrase is required to enable automated backup.');
    }
    await vault.set(AUTOBACKUP_PASSPHRASE_KEY, passphrase);
    await recordBackupStatus({ enabled: true }, store);
  } else {
    try {
      await vault.remove(AUTOBACKUP_PASSPHRASE_KEY);
    } catch {
      // Ignore if key is not present
    }
    await recordBackupStatus({ enabled: false }, store);
  }
}

export interface AutoBackupDeps {
  vault?: Vault;
  store?: KeyValueStore;
  config?: DriveConfig;
  fetchFn?: FetchFunction;
}

export type AutoBackupResult =
  | { status: 'success'; fileId: string; filename: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string };

/** Runs one automatic backup. Never throws; the result says what happened. */
export async function performAutoBackup(
  data: AppData,
  deps: AutoBackupDeps = {},
): Promise<AutoBackupResult> {
  const vault = deps.vault ?? secureVault;
  const store = deps.store ?? asyncStorageStore;
  const config = deps.config ?? getDriveConfig();
  const fetchFn = deps.fetchFn ?? fetch;

  // 0. Master Feature Flag check
  if (!isDriveFeatureEnabled(config)) {
    return { status: 'skipped', reason: 'Google Drive backup feature is disabled by feature flag.' };
  }

  const nowIso = new Date().toISOString();
  await recordBackupStatus({ lastAttempt: nowIso }, store);

  // 1. Check if enabled and retrieve passphrase
  const status = await getBackupStatus(store);
  if (!status.enabled) {
    return { status: 'skipped', reason: 'Automated backup is turned off.' };
  }

  let passphrase: string | null = null;
  try {
    passphrase = await vault.get(AUTOBACKUP_PASSPHRASE_KEY);
  } catch {
    passphrase = null;
  }

  if (!passphrase) {
    const reason = 'No backup passphrase found in secure vault. Please re-enable automated backup.';
    await recordBackupStatus({ lastError: reason, enabled: false }, store);
    return { status: 'error', error: reason };
  }

  // 3. Obtain valid Google access token
  const accessToken = await getValidAccessToken(vault, config, fetchFn);
  if (!accessToken) {
    const reason = 'Google Drive is disconnected or authorization expired.';
    await recordBackupStatus({ lastError: reason }, store);
    return { status: 'error', error: reason };
  }

  // 4. Encrypt data locally
  let encryptedText: string;
  try {
    encryptedText = await createEncryptedBackup(data, passphrase, { random: systemRandom });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Encryption failed during auto-backup';
    await recordBackupStatus({ lastError: errorMsg }, store);
    return { status: 'error', error: errorMsg };
  }

  // 5. Upload to Google Drive
  const dateFormatted = nowIso.replace(/[:.]/g, '-');
  const filename = `personal-assistant-backup-${dateFormatted}.json`;

  try {
    const folderId = await findOrCreateBackupFolder(accessToken, config.folderName, fetchFn);
    const uploaded = await uploadEncryptedBackupFile(accessToken, filename, encryptedText, folderId, fetchFn);

    try {
      await enforceRetentionPolicy(accessToken, folderId, undefined, fetchFn, undefined, config);
    } catch {
      // Retention pruning failure does not fail the backup itself
    }

    await recordBackupStatus({
      lastSuccess: nowIso,
      lastError: null,
    }, store);

    return { status: 'success', fileId: uploaded.id, filename };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Upload to Google Drive failed';
    await recordBackupStatus({ lastError: errorMsg }, store);
    return { status: 'error', error: errorMsg };
  }
}
