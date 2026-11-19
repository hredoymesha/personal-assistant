import type { AppData } from '../domain/types';
import { validateAppData } from '../domain/validation';

/**
 * Applies a change only if the whole resulting dataset still validates, so the app never
 * saves something it would refuse to load on the next start.
 */
export function guardedUpdate(before: AppData, fn: (d: AppData) => AppData): { ok: true; data: AppData } | { ok: false; error: string } {
  let after: AppData;
  try { after = fn(before); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Change failed' }; }
  const v = validateAppData(after);
  return v.ok ? { ok: true, data: v.value } : { ok: false, error: v.error };
}
