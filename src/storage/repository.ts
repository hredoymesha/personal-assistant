import type { AppData } from '../domain/types';
import { emptyData, SCHEMA_VERSION } from '../domain/types';
import { validateAppData } from '../domain/validation';
import { migrate } from './migrations';
import type { KeyValueStore } from './store';

export const DATA_KEY = 'aio.data';
export const CORRUPT_KEY = 'aio.data.corrupt';
export const BACKUP_KEY_PREFIX = 'aio.data.v';
export const BACKUP_KEY_SUFFIX = '.backup';
export const RESTORE_STAGING_KEY = 'aio.data.staging';
export const ROLLBACK_CLEANUP_KEY = 'aio.data.rollback-cleanup.v1';
/** Imports larger than this are refused before JSON.parse (guards against freezing the app). */
export const MAX_IMPORT_CHARS = 5_000_000;
/** Maximum object/array nesting depth allowed in import payloads. */
export const MAX_JSON_DEPTH = 16;

export type LoadResult =
  | { status: 'empty'; data: AppData; raw: null }
  | { status: 'ok'; data: AppData; raw: string }
  | { status: 'error'; data: AppData; error: string; raw: string | null };

export function backupKeyForVersion(version: number): string {
  return `${BACKUP_KEY_PREFIX}${version}${BACKUP_KEY_SUFFIX}`;
}

/** Rejects JSON nested deeper than MAX_JSON_DEPTH or using __proto__, constructor or prototype as a key. */
export function checkJsonDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (typeof value !== 'object' || value === null) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!checkJsonDepth(item, depth + 1)) return false;
    }
  } else {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
      if (!checkJsonDepth((value as Record<string, unknown>)[key], depth + 1)) return false;
    }
  }
  return true;
}

/** Parse + migrate + validate raw text. Shared by load and import. */
export function parseData(raw: string): { ok: true; data: AppData } | { ok: false; error: string } {
  if (raw.length > MAX_IMPORT_CHARS) return { ok: false, error: 'Data is too large (maximum 5,000,000 characters)' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: 'Not valid JSON' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Data is not an object' };
  }
  if (!checkJsonDepth(parsed)) {
    return { ok: false, error: 'Data structure is too deeply nested or contains forbidden properties' };
  }
  const m = migrate(parsed);
  if (!m.ok) return m;
  const v = validateAppData(m.data);
  return v.ok ? { ok: true, data: v.value } : { ok: false, error: v.error };
}

export class Repository {
  constructor(private store: KeyValueStore) {}

  /** Never throws, never overwrites unreadable data: a bad payload is copied aside first. */
  async load(): Promise<LoadResult> {
    let raw: string | null;
    try { raw = await this.store.getItem(DATA_KEY); }
    catch { return { status: 'error', data: emptyData(), error: 'Could not read local storage', raw: null }; }
    if (raw === null) return { status: 'empty', data: emptyData(), raw: null };
    const r = parseData(raw);
    if (r.ok) return { status: 'ok', data: r.data, raw };
    try { await this.store.setItem(CORRUPT_KEY, raw); } catch { /* best effort */ }
    return { status: 'error', data: emptyData(), error: r.error, raw };
  }

  /** Raw text of the last unreadable payload, so the user can export it for manual recovery. */
  async getCorrupt(): Promise<string | null> {
    try { return await this.store.getItem(CORRUPT_KEY); } catch { return null; }
  }

  /**
   * Removes rollback copies created by the pre-Trash delete behavior once,
   * but only after the current document has loaded and validated.
   */
  async cleanupLegacyRollbackCopies(): Promise<number> {
    if (await this.store.getItem(ROLLBACK_CLEANUP_KEY) === 'done') return 0;
    const loaded = await this.load();
    if (loaded.status === 'error') throw new Error('Rollback copies were preserved because current data could not be validated.');

    const keys = this.store.getAllKeys
      ? await this.store.getAllKeys()
      : Array.from({ length: SCHEMA_VERSION }, (_, version) => backupKeyForVersion(version));
    const rollbackKeys = keys.filter((key) => /^aio\.data\.v\d+\.backup$/.test(key));
    for (const key of rollbackKeys) await this.store.removeItem(key);
    await this.store.setItem(ROLLBACK_CLEANUP_KEY, 'done');
    return rollbackKeys.length;
  }

  async save(data: AppData, expectedRaw?: string | null): Promise<string> {
    const currentRaw = await this.store.getItem(DATA_KEY);
    if (expectedRaw !== undefined && currentRaw !== expectedRaw) {
      throw new Error('Data changed in another tab or app window. Reload before saving again.');
    }

    if (currentRaw !== null) {
      const previous = parseData(currentRaw);
      if (!previous.ok) throw new Error('Cannot save over unreadable data. Export its recovery copy first.');
      let rawVersion = 0;
      try {
        const parsed: unknown = JSON.parse(currentRaw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const value = (parsed as Record<string, unknown>).schemaVersion;
          rawVersion = value === undefined ? 0 : typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1;
        }
      } catch { rawVersion = -1; }
      if (rawVersion < 0) throw new Error('Cannot save over unreadable data. Export its recovery copy first.');
      const oldVersion = rawVersion;
      if (oldVersion < data.schemaVersion) {
        const key = backupKeyForVersion(oldVersion);
        if ((await this.store.getItem(key)) === null) await this.store.setItem(key, currentRaw);
      }
    }

    const nextRaw = JSON.stringify(data);
    await this.store.setItem(DATA_KEY, nextRaw);
    return nextRaw;
  }

  async clear(): Promise<void> {
    const keysToRemove = new Set<string>();
    keysToRemove.add(DATA_KEY);
    keysToRemove.add(CORRUPT_KEY);
    keysToRemove.add(ROLLBACK_CLEANUP_KEY);
    for (let version = 0; version < SCHEMA_VERSION; version++) {
      keysToRemove.add(backupKeyForVersion(version));
    }

    if (typeof this.store.getAllKeys === 'function') {
      const allKeys = await this.store.getAllKeys();
      for (const key of allKeys) {
        if (key === DATA_KEY || key === CORRUPT_KEY || key.startsWith(BACKUP_KEY_PREFIX) || key.startsWith(`${DATA_KEY}.`)) {
          keysToRemove.add(key);
        }
      }
    }

    for (const key of keysToRemove) {
      await this.store.removeItem(key);
    }
  }
}
