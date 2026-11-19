import { File, Directory, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

let tempFileSequence = 0;

/**
 * Ownership marker for Personal Assistant's own disposable export temp files. Only files that carry this exact
 * prefix (and the `.tmp` suffix) are ever eligible for orphan cleanup - a generic `.*.tmp` pattern
 * could match files created by other libraries that share the cache directory.
 */
export const OWNED_TEMP_PREFIX = '.aio-export-';
const OWNED_TEMP_SUFFIX = '.tmp';

/**
 * Names of temp files created by an export that is still in flight in this JS process.
 * Orphan cleanup skips these, so starting a second export never deletes the first one's temp file.
 */
const activeTempNames = new Set<string>();

function fileNameWithSuffix(filename: string, suffix: number): string {
  if (suffix === 0) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : '';
  return `${stem}-${suffix}${extension}`;
}

/**
 * Removes Personal Assistant-owned temp files (prefix `.aio-export-`, suffix `.tmp`) left behind by interrupted
 * writes or prior app crashes. Never touches: completed/shared exports (their names carry no temp
 * prefix), temp files of an export currently in flight, or any file this module did not name.
 * Cleanup failures are swallowed - they cannot affect user data.
 */
export function cleanOrphanedTempFiles(): number {
  if (Platform.OS === 'web') return 0;
  let cleanedCount = 0;
  try {
    const cacheDir = new Directory(Paths.cache);
    const entries = cacheDir.list();
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      const name = entry.name;
      if (!name.startsWith(OWNED_TEMP_PREFIX) || !name.endsWith(OWNED_TEMP_SUFFIX)) continue;
      if (activeTempNames.has(name)) continue;
      try {
        entry.delete();
        cleanedCount++;
      } catch {
        // Ignore individual delete failure
      }
    }
  } catch {
    // Listing can fail when the cache is unavailable; nothing to clean up then
  }
  return cleanedCount;
}

function createTempFile(filename: string): File {
  cleanOrphanedTempFiles();
  let file: File;
  let tempName: string;
  do {
    tempName = `${OWNED_TEMP_PREFIX}${filename}.${Date.now()}-${tempFileSequence++}${OWNED_TEMP_SUFFIX}`;
    file = new File(Paths.cache, tempName);
  } while (file.exists);
  file.create();
  activeTempNames.add(tempName);
  return file;
}

async function moveToAvailableName(file: File, filename: string): Promise<void> {
  for (let suffix = 0; suffix < 1000; suffix++) {
    const destination = new File(Paths.cache, fileNameWithSuffix(filename, suffix));
    if (destination.exists) continue;
    try {
      await file.move(destination);
      return;
    } catch (error) {
      if (!destination.exists) throw error;
    }
  }
  throw new Error('Could not choose an available name for the exported file.');
}

/** User-initiated export. Web: browser download. Native: write to cache, then open the share sheet. */
export async function exportTextFile(filename: string, text: string, mime: string, options: { moveBeforeShare?: boolean } = {}): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  let file: File;
  if (options.moveBeforeShare) {
    file = createTempFile(filename);
    const tempName = file.name;
    try {
      await file.write(text);
      const written = await file.text();
      if (written !== text) {
        throw new Error('Export integrity check failed: written data does not match input.');
      }
      await moveToAvailableName(file, filename);
    } catch (error) {
      try {
        if (file.exists) file.delete();
      } catch {
        // Ignore deletion failure during error cleanup
      }
      throw error;
    } finally {
      // The temp name is no longer in flight (moved to its final name, or deleted above).
      activeTempNames.delete(tempName);
    }
  } else {
    file = new File(Paths.cache, filename);
    file.create({ overwrite: true });
    await file.write(text);
  }
  // The completed export is deliberately left in place after sharing: the share API does not report
  // when the receiving app has finished reading the URI, so the OS reclaims the cache instead.
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: filename });
}

export async function exportBinaryFile(filename: string, bytes: Uint8Array, mime: string): Promise<void> {
  if (Platform.OS === 'web') {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    return;
  }
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  const file = createTempFile(filename);
  const tempName = file.name;
  try {
    await file.write(bytes);
    await moveToAvailableName(file, filename);
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // Ignore deletion failure during error cleanup
    }
    throw error;
  } finally {
    activeTempNames.delete(tempName);
  }
  await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: filename });
}

function isInsideCache(file: File): boolean {
  const cacheUri = new Directory(Paths.cache).uri;
  const prefix = cacheUri.endsWith('/') ? cacheUri : `${cacheUri}/`;
  return file.uri.startsWith(prefix);
}

/**
 * User-initiated import: returns the chosen file's text, or null if cancelled.
 * The picker is asked for a cache copy; that copy is Personal Assistant's disposable file and is deleted once its
 * text has been read (or reading failed). The user's original document is never touched, and a
 * picked URI outside the app cache is never deleted.
 */
export async function pickTextFile(): Promise<string | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/csv', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  if (asset.file) return await asset.file.text(); // web
  const copy = new File(asset.uri);
  try {
    return await copy.text();
  } finally {
    try {
      if (isInsideCache(copy) && copy.exists) copy.delete();
    } catch {
      // Cleanup failure must never affect the restored text or user data.
    }
  }
}

export async function pickBinaryFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '*/*'], copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  if (asset.file) return { name: asset.name, bytes: new Uint8Array(await asset.file.arrayBuffer()) };
  const copy = new File(asset.uri);
  try {
    return { name: asset.name, bytes: await copy.bytes() };
  } finally {
    try {
      if (isInsideCache(copy) && copy.exists) copy.delete();
    } catch {
      // Cleanup failure must never affect the picked data.
    }

  }
}

export async function pickReceiptFile(): Promise<{ name: string; mimeType: string; bytes: Uint8Array } | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: ['image/*', 'application/pdf'], copyToCacheDirectory: true });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  if (asset.size !== undefined && asset.size > 10 * 1024 * 1024) throw new Error('Receipt files must be 10 MB or smaller.');
  if (asset.file) return { name: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', bytes: new Uint8Array(await asset.file.arrayBuffer()) };
  const copy = new File(asset.uri);
  try {
    const bytes = await copy.bytes();
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Receipt files must be 10 MB or smaller.');
    return { name: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', bytes };
  } finally {
    try {
      if (isInsideCache(copy) && copy.exists) copy.delete();
    } catch {
      // Cleanup failure cannot affect the selected receipt.
    }
  }
}
