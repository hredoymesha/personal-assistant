import type { AppData } from '../domain/types';

/** An undo snapshot is only safe to apply if nothing else has changed the data since. */
export interface UndoEntry { before: AppData; after: AppData }

export function createUndo(before: AppData, after: AppData): UndoEntry {
  return { before, after };
}

/** Returns the data to restore, or null when later edits make undo unsafe (never clobbers newer work). */
export function applyUndo(entry: UndoEntry, current: AppData): AppData | null {
  return current === entry.after ? entry.before : null;
}
