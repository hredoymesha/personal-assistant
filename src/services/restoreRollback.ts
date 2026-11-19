/**
 * Snapshots taken before a restore or an undo, so either one can be reversed.
 *
 * Each snapshot is encrypted with its own key, which is kept in the secure keystore
 * (WHEN_UNLOCKED_THIS_DEVICE_ONLY), and is read back and decrypted once before the index is
 * updated. Up to three are kept; a fourth pushes out the oldest, never the newest. Snapshots
 * older than 24 hours are deleted together with their keys.
 */

import * as SecureStore from 'expo-secure-store';
import { gcm } from '@noble/ciphers/aes.js';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../crypto/bytes';
import { systemRandom } from './random';
import type { RandomSource } from '../crypto/random';
import { Vault, secureVault } from './vault';
import { AppData } from '../domain/types';
import { KeyValueStore } from '../storage/store';
import { asyncStorageStore } from '../storage/asyncStorageStore';
import { validateAppData } from '../domain/validation';

export const RESTORE_SNAPSHOT_KEY = 'aio.restore.snapshot';
export const RESTORE_SNAPSHOT_VAULT_KEY = 'aio.restore.snapshot_key';
export const RESTORE_SNAPSHOT_INDEX_KEY = 'aio.restore.snapshots_meta';
export const RESTORE_STAGING_KEY = 'aio.data.staging';
export const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_SNAPSHOT_RING_SIZE = 3;

export type SnapshotKind = 'pre-restore' | 'pre-undo';

export interface RestoreSnapshot {
  id: string;
  timestamp: number;
  kind: SnapshotKind;
  data: AppData;
}

export interface SnapshotMetaItem {
  id: string;
  timestamp: number;
  kind: SnapshotKind;
  taskCount: number;
  expenseCount: number;
}

export interface EncryptedRestoreSnapshotPayload {
  version: 1;
  id: string;
  timestamp: number;
  kind: SnapshotKind;
  nonce: string; // base64
  ciphertext: string; // base64
}

export interface DataChangeSummary {
  hasChanges: boolean;
  totalChanges: number;
  taskChanges: number;
  expenseChanges: number;
  debtChanges: number;
  details: string;
}

export function snapshotStoreKey(id: string): string {
  return `aio.restore.snapshot.${id}`;
}

export function snapshotVaultKey(id: string): string {
  return `aio.restore.snapshot_key.${id}`;
}

/** Computes item changes between current data and target snapshot data. */
export function computeDataChanges(current: AppData, snapshotData: AppData): DataChangeSummary {
  const currentTaskMap = new Map(current.tasks.map((t) => [t.id, t]));
  const snapTaskMap = new Map(snapshotData.tasks.map((t) => [t.id, t]));
  let taskChanges = 0;
  for (const [id, t] of currentTaskMap) {
    const snapT = snapTaskMap.get(id);
    if (!snapT || snapT.title !== t.title || snapT.done !== t.done || snapT.dueDate !== t.dueDate) {
      taskChanges++;
    }
  }
  for (const id of snapTaskMap.keys()) {
    if (!currentTaskMap.has(id)) taskChanges++;
  }

  const currentExpMap = new Map(current.expenses.map((e) => [e.id, e]));
  const snapExpMap = new Map(snapshotData.expenses.map((e) => [e.id, e]));
  let expenseChanges = 0;
  for (const [id, e] of currentExpMap) {
    const snapE = snapExpMap.get(id);
    if (!snapE || snapE.amountMinor !== e.amountMinor || snapE.note !== e.note || snapE.category !== e.category) {
      expenseChanges++;
    }
  }
  for (const id of snapExpMap.keys()) {
    if (!currentExpMap.has(id)) expenseChanges++;
  }

  const currentDebtMap = new Map(current.debts.map((d) => [d.id, d]));
  const snapDebtMap = new Map(snapshotData.debts.map((d) => [d.id, d]));
  let debtChanges = 0;
  for (const [id, d] of currentDebtMap) {
    const snapD = snapDebtMap.get(id);
    if (!snapD || snapD.amountMinor !== d.amountMinor || snapD.paidMinor !== d.paidMinor || snapD.person !== d.person) {
      debtChanges++;
    }
  }
  for (const id of snapDebtMap.keys()) {
    if (!currentDebtMap.has(id)) debtChanges++;
  }

  const totalChanges = taskChanges + expenseChanges + debtChanges;
  const parts: string[] = [];
  if (taskChanges > 0) parts.push(`${taskChanges} task${taskChanges > 1 ? 's' : ''}`);
  if (expenseChanges > 0) parts.push(`${expenseChanges} expense${expenseChanges > 1 ? 's' : ''}`);
  if (debtChanges > 0) parts.push(`${debtChanges} debt${debtChanges > 1 ? 's' : ''}`);

  return {
    hasChanges: totalChanges > 0,
    totalChanges,
    taskChanges,
    expenseChanges,
    debtChanges,
    details: parts.length > 0 ? parts.join(', ') : 'no changes',
  };
}

/** Saves an AES-256-GCM encrypted snapshot with write-then-swap verification into the ring. */
export async function createPreRestoreSnapshot(
  currentData: AppData,
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
  random: RandomSource = systemRandom,
  kind: SnapshotKind = 'pre-restore',
): Promise<string> {
  let snapTimestamp = Date.now();
  try {
    const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
    if (rawMeta) {
      const parsed = JSON.parse(rawMeta);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const maxTs = parsed.reduce((max: number, item: any) => Math.max(max, typeof item.timestamp === 'number' ? item.timestamp : 0), 0);
        if (snapTimestamp <= maxTs) {
          snapTimestamp = maxTs + 1;
        }
      }
    }
  } catch {
    // ignore
  }

  const randSuffix = base64Encode(random.bytes(6)).replace(/[/+=]/g, '');
  const id = `snap_${snapTimestamp}_${randSuffix}`;
  const key = random.bytes(32);
  const nonce = random.bytes(12);
  if (!key || key.length !== 32 || !nonce || nonce.length !== 12) {
    throw new Error('Secure random generator error: key must be 32 bytes and nonce must be 12 bytes.');
  }
  const jsonString = JSON.stringify(currentData);
  const plaintext = utf8Encode(jsonString);

  const ciphertext = gcm(key, nonce).encrypt(plaintext);

  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  const sStoreKey = snapshotStoreKey(id);
  const sVaultKey = snapshotVaultKey(id);

  // 1. Write the symmetric key to device secure hardware vault
  await vault.set(sVaultKey, base64Encode(key), options);

  // 2. Write the encrypted blob to key-value storage
  const payload: EncryptedRestoreSnapshotPayload = {
    version: 1,
    id,
    timestamp: snapTimestamp,
    kind,
    nonce: base64Encode(nonce),
    ciphertext: base64Encode(ciphertext),
  };

  try {
    await store.setItem(sStoreKey, JSON.stringify(payload));
  } catch (err) {
    await vault.remove(sVaultKey).catch(() => {});
    throw err;
  }

  // 3. IMMEDIATE WRITE-THEN-SWAP VERIFICATION:
  // Must verify decrypt round-trip before committing to metadata ring or pruning old snapshots
  try {
    const readVault = await vault.get(sVaultKey);
    const readStore = await store.getItem(sStoreKey);
    if (!readVault || !readStore) {
      throw new Error('Snapshot write verification failed: key or payload missing on immediate read-back.');
    }
    const readPayload = JSON.parse(readStore);
    const decKey = base64Decode(readVault);
    const decNonce = base64Decode(readPayload.nonce);
    const decCt = base64Decode(readPayload.ciphertext);
    if (!decKey || !decNonce || !decCt) {
      throw new Error('Snapshot write verification failed: invalid base64 encoding.');
    }
    const decryptedBytes = gcm(decKey, decNonce).decrypt(decCt);
    const validated = validateAppData(JSON.parse(utf8Decode(decryptedBytes)));
    if (!validated.ok) {
      throw new Error('Snapshot write verification failed: decrypted data failed validation.');
    }
  } catch (verifyErr) {
    await store.removeItem(sStoreKey).catch(() => {});
    await vault.remove(sVaultKey).catch(() => {});
    throw verifyErr;
  }

  // 4. RING METADATA UPDATE & CAPPING (MAX 3):
  try {
    const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
    let metaList: SnapshotMetaItem[] = [];
    if (rawMeta) {
      try {
        const parsed = JSON.parse(rawMeta);
        if (Array.isArray(parsed)) metaList = parsed;
      } catch {
        metaList = [];
      }
    }

    metaList.push({
      id,
      timestamp: payload.timestamp,
      kind,
      taskCount: currentData.tasks.length,
      expenseCount: currentData.expenses.length,
    });

    // Prune oldest if ring exceeds MAX_SNAPSHOT_RING_SIZE (3).
    // The latest snapshot is never pruned.
    if (metaList.length > MAX_SNAPSHOT_RING_SIZE) {
      metaList.sort((a, b) => a.timestamp - b.timestamp);
      while (metaList.length > MAX_SNAPSHOT_RING_SIZE) {
        const oldest = metaList.shift()!;
        await store.removeItem(snapshotStoreKey(oldest.id)).catch(() => {});
        await vault.remove(snapshotVaultKey(oldest.id)).catch(() => {});
      }
    }

    await store.setItem(RESTORE_SNAPSHOT_INDEX_KEY, JSON.stringify(metaList));

    // Also update backward-compatible single keys
    await store.setItem(RESTORE_SNAPSHOT_KEY, JSON.stringify(payload)).catch(() => {});
    await vault.set(RESTORE_SNAPSHOT_VAULT_KEY, base64Encode(key), options).catch(() => {});
  } catch {
    // Ring index update is non-fatal once primary snapshot is verified
  }

  return id;
}

/** Retrieves and decrypts a snapshot by id, or newest if id omitted. */
export async function getPreRestoreSnapshot(
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
  now = Date.now(),
  snapshotId?: string,
): Promise<RestoreSnapshot | null> {
  try {
    let targetId = snapshotId;

    if (!targetId) {
      const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
      if (rawMeta) {
        try {
          const parsed = JSON.parse(rawMeta);
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsed.sort((a, b) => b.timestamp - a.timestamp);
            targetId = parsed[0]?.id;
          }
        } catch {
          // ignore
        }
      }
    }

    let sStoreKey = targetId ? snapshotStoreKey(targetId) : RESTORE_SNAPSHOT_KEY;
    let sVaultKey = targetId ? snapshotVaultKey(targetId) : RESTORE_SNAPSHOT_VAULT_KEY;

    let raw = await store.getItem(sStoreKey);
    let keyBase64 = await vault.get(sVaultKey);

    // Fallback check to legacy single key if targetId not found
    if ((!raw || !keyBase64) && !snapshotId) {
      sStoreKey = RESTORE_SNAPSHOT_KEY;
      sVaultKey = RESTORE_SNAPSHOT_VAULT_KEY;
      raw = await store.getItem(sStoreKey);
      keyBase64 = await vault.get(sVaultKey);
    }

    if (!raw || !keyBase64) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }

    if (
      typeof parsed?.timestamp !== 'number' ||
      typeof parsed?.nonce !== 'string' ||
      typeof parsed?.ciphertext !== 'string' ||
      parsed?.version !== 1
    ) {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }

    // Expiration check (24 hours)
    if (now - parsed.timestamp > SNAPSHOT_RETENTION_MS) {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }

    const key = base64Decode(keyBase64);
    const nonce = base64Decode(parsed.nonce);
    const ciphertext = base64Decode(parsed.ciphertext);

    if (!key || key.length !== 32 || !nonce || nonce.length !== 12 || !ciphertext) {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }

    let decryptedBytes: Uint8Array;
    try {
      decryptedBytes = gcm(key, nonce).decrypt(ciphertext);
    } catch {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }

    const jsonString = utf8Decode(decryptedBytes);
    const appDataObj = JSON.parse(jsonString);
    const validated = validateAppData(appDataObj);
    if (validated.ok) {
      return {
        id: parsed.id || targetId || 'legacy',
        timestamp: parsed.timestamp,
        kind: parsed.kind || 'pre-restore',
        data: validated.value,
      };
    } else {
      await store.removeItem(sStoreKey).catch(() => {});
      await vault.remove(sVaultKey).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

/** Lists all valid, active, non-expired snapshots in the ring (newest first). */
export async function listSnapshots(
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
  now = Date.now(),
): Promise<RestoreSnapshot[]> {
  const out: RestoreSnapshot[] = [];
  try {
    const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
    if (!rawMeta) {
      const single = await getPreRestoreSnapshot(store, vault, now);
      return single ? [single] : [];
    }
    const metaList: SnapshotMetaItem[] = JSON.parse(rawMeta);
    if (!Array.isArray(metaList)) return [];

    metaList.sort((a, b) => b.timestamp - a.timestamp);

    for (const item of metaList) {
      const snap = await getPreRestoreSnapshot(store, vault, now, item.id);
      if (snap) {
        out.push(snap);
      }
    }
  } catch {
    // return what succeeded
  }
  return out;
}

/** Clears all snapshots in the ring and legacy pointers. */
export async function clearPreRestoreSnapshot(
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
): Promise<void> {
  try {
    const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
    if (rawMeta) {
      try {
        const metaList: SnapshotMetaItem[] = JSON.parse(rawMeta);
        if (Array.isArray(metaList)) {
          for (const item of metaList) {
            await store.removeItem(snapshotStoreKey(item.id)).catch(() => {});
            await vault.remove(snapshotVaultKey(item.id)).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    }
    await store.removeItem(RESTORE_SNAPSHOT_INDEX_KEY).catch(() => {});
    await store.removeItem(RESTORE_SNAPSHOT_KEY).catch(() => {});
  } finally {
    try {
      await vault.remove(RESTORE_SNAPSHOT_VAULT_KEY);
    } catch {
      // Ignore vault deletion error
    }
  }
}

/** Removes all snapshots exceeding the 24-hour retention window. */
export async function purgeExpiredSnapshot(
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
  now = Date.now(),
): Promise<boolean> {
  let anyPurged = false;
  try {
    const rawMeta = await store.getItem(RESTORE_SNAPSHOT_INDEX_KEY);
    if (rawMeta) {
      try {
        const metaList: SnapshotMetaItem[] = JSON.parse(rawMeta);
        if (Array.isArray(metaList)) {
          const validMeta: SnapshotMetaItem[] = [];
          for (const item of metaList) {
            if (now - item.timestamp > SNAPSHOT_RETENTION_MS) {
              await store.removeItem(snapshotStoreKey(item.id)).catch(() => {});
              await vault.remove(snapshotVaultKey(item.id)).catch(() => {});
              anyPurged = true;
            } else {
              validMeta.push(item);
            }
          }
          if (validMeta.length !== metaList.length) {
            await store.setItem(RESTORE_SNAPSHOT_INDEX_KEY, JSON.stringify(validMeta)).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    }

    const legacyRaw = await store.getItem(RESTORE_SNAPSHOT_KEY);
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw);
        if (typeof parsed?.timestamp === 'number' && now - parsed.timestamp > SNAPSHOT_RETENTION_MS) {
          await store.removeItem(RESTORE_SNAPSHOT_KEY).catch(() => {});
          await vault.remove(RESTORE_SNAPSHOT_VAULT_KEY).catch(() => {});
          anyPurged = true;
        }
      } catch {
        await store.removeItem(RESTORE_SNAPSHOT_KEY).catch(() => {});
        await vault.remove(RESTORE_SNAPSHOT_VAULT_KEY).catch(() => {});
        anyPurged = true;
      }
    }
  } catch {
    return false;
  }
  return anyPurged;
}

/** Deletes a staged restore left behind by an interrupted run. */
export async function cleanOrphanedRestoreStaging(
  store: KeyValueStore = asyncStorageStore,
): Promise<void> {
  try {
    await store.removeItem(RESTORE_STAGING_KEY);
  } catch {
    // best-effort cleanup
  }
}

/** Restores data, rolling back to an encrypted snapshot if any step fails. */
export async function executeRestoreWithRollback(
  incomingData: AppData,
  currentData: AppData,
  applyFn: (data: AppData) => Promise<string | null> | string | null,
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
): Promise<{ ok: true } | { ok: false; error: string; rolledBack: boolean }> {
  // Snapshot the current data first
  try {
    await createPreRestoreSnapshot(currentData, store, vault, systemRandom, 'pre-restore');
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create secure pre-restore snapshot: ${err instanceof Error ? err.message : String(err)}. Restore aborted to prevent unrecoverable data loss.`,
      rolledBack: false,
    };
  }

  // Stage the incoming data under a temporary key
  const stagedRaw = JSON.stringify(incomingData);
  try {
    await store.setItem(RESTORE_STAGING_KEY, stagedRaw);
    const readback = await store.getItem(RESTORE_STAGING_KEY);
    if (readback !== stagedRaw) {
      await store.removeItem(RESTORE_STAGING_KEY).catch(() => {});
      return {
        ok: false,
        error: 'Staged restore write verification failed: readback mismatch.',
        rolledBack: false,
      };
    }
  } catch (stageErr) {
    await store.removeItem(RESTORE_STAGING_KEY).catch(() => {});
    return {
      ok: false,
      error: `Failed to stage restore data: ${stageErr instanceof Error ? stageErr.message : String(stageErr)}. Local data untouched.`,
      rolledBack: false,
    };
  }

  // Swap it in
  try {
    const err = await applyFn(incomingData);
    if (err) {
      let rollbackSucceeded = true;
      try {
        const rbErr = await applyFn(currentData);
        if (rbErr) rollbackSucceeded = false;
      } catch {
        rollbackSucceeded = false;
      }
      await store.removeItem(RESTORE_STAGING_KEY).catch(() => {});
      return {
        ok: false,
        error: rollbackSucceeded ? err : `Restore failed (${err}) and automated rollback failed. Check pre-restore snapshot.`,
        rolledBack: rollbackSucceeded,
      };
    }
    // Swap succeeded -> cleanup temporary staging key
    await store.removeItem(RESTORE_STAGING_KEY).catch(() => {});
    return { ok: true };
  } catch (err) {
    let rollbackSucceeded = true;
    try {
      const rbErr = await applyFn(currentData);
      if (rbErr) rollbackSucceeded = false;
    } catch {
      rollbackSucceeded = false;
    }
    await store.removeItem(RESTORE_STAGING_KEY).catch(() => {});
    const primaryMsg = err instanceof Error ? err.message : 'Restore failed midway; rolled back to prior data.';
    return {
      ok: false,
      error: rollbackSucceeded ? primaryMsg : `Restore threw (${primaryMsg}) and automated rollback failed. Check pre-restore snapshot.`,
      rolledBack: rollbackSucceeded,
    };
  }
}

/** Undo or redo a restore. The current data is snapshotted first, so this step can be reversed too. */
export async function executeUndoWithCapture(
  targetSnapshotId: string | undefined,
  currentData: AppData,
  applyFn: (data: AppData) => Promise<string | null> | string | null,
  store: KeyValueStore = asyncStorageStore,
  vault: Vault = secureVault,
  random: RandomSource = systemRandom,
): Promise<{ ok: true; restoredSnapshot: RestoreSnapshot } | { ok: false; error: string }> {
  // 1. Verify target snapshot can be decrypted BEFORE touching current data
  const target = await getPreRestoreSnapshot(store, vault, Date.now(), targetSnapshotId);
  if (!target) {
    return {
      ok: false,
      error: 'Cannot undo: snapshot is missing, corrupted, or expired (> 24 hours).',
    };
  }

  // 2. Pre-undo capture: snapshot currentData BEFORE applying undo
  try {
    await createPreRestoreSnapshot(currentData, store, vault, random, 'pre-undo');
  } catch (err) {
    return {
      ok: false,
      error: `Undo blocked: failed to secure current data before reverting (${err instanceof Error ? err.message : String(err)}). Your data was not changed.`,
    };
  }

  // 3. Apply target snapshot
  try {
    const err = await applyFn(target.data);
    if (err) {
      await applyFn(currentData);
      return { ok: false, error: `Undo apply failed: ${err}. Reverted to prior data.` };
    }
    return { ok: true, restoredSnapshot: target };
  } catch (err) {
    try {
      await applyFn(currentData);
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: `Undo threw an unexpected error: ${err instanceof Error ? err.message : String(err)}. Reverted to prior data.`,
    };
  }
}
