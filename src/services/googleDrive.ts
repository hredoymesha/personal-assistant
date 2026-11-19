/**
 * Google Drive REST calls. Backups go into the "Personal Assistant Backups" folder.
 * Every function takes an optional fetch so tests run without a network.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8Encode } from '../crypto/bytes';
import { FetchFunction } from './googleAuth';
import {
  DEFAULT_DRIVE_FOLDER_NAME,
  DEFAULT_RETENTION_MAX_BACKUPS,
  DriveConfig,
  getDriveConfig,
} from './driveConfig';

export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024; // 4 MB

export interface DriveBackupFile {
  id: string;
  name: string;
  createdTime: string;
  sizeBytes?: number;
  mimeType: string;
  sha256?: string;
  owner?: string;
}

export type DriveErrorKind =
  | 'auth_expired'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'forbidden'
  | 'not_found'
  | 'server_error'
  | 'corrupt_file'
  | 'network_error'
  | 'unknown';

export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  readonly status?: number;

  constructor(message: string, kind: DriveErrorKind, status?: number) {
    super(message);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Computes hex-encoded SHA-256 string for the given text. */
export function computeSha256Hex(text: string): string {
  const hash = sha256(utf8Encode(text));
  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Executes an HTTP fetch with retry handling for 429 and 5xx errors.
 * Respects Retry-After header if present, and never retries 401 or 403.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  fetchFn: FetchFunction = fetch,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleepFn = options.sleepFn ?? defaultSleep;

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new DriveError(
          err instanceof Error ? err.message : 'Network error connecting to Google Drive',
          'network_error',
        );
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleepFn(delay);
      continue;
    }

    // Never retry 401 (auth) or 403 (forbidden/quota)
    if (response.status === 401 || response.status === 403) {
      return response;
    }

    // Retry only on 429 and 5xx
    const isRetryable =
      response.status === 429 ||
      (response.status >= 500 && response.status < 600);

    if (isRetryable && attempt < maxAttempts) {
      let delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      const retryAfterHeader = response.headers?.get?.('Retry-After');
      if (retryAfterHeader) {
        const parsedSeconds = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
          delayMs = parsedSeconds * 1000;
        }
      } else {
        // Slight jitter
        delayMs += Math.floor(Math.random() * 100);
      }
      await sleepFn(delayMs);
      continue;
    }

    return response;
  }

  return await fetchFn(url, init);
}

function handleHttpError(status: number, responseText: string): never {
  let reason: string | undefined;
  let message: string | undefined;
  try {
    const json = JSON.parse(responseText);
    reason = json?.error?.errors?.[0]?.reason;
    message = json?.error?.message;
  } catch {
    // responseText is not JSON
  }

  if (status === 401) {
    throw new DriveError(
      'Google authorization has expired. Please reconnect Google Drive.',
      'auth_expired',
      401,
    );
  }

  if (reason === 'storageQuotaExceeded') {
    throw new DriveError(
      'Google Drive storage quota exceeded. Free up space in your Google Account.',
      'quota_exceeded',
      status,
    );
  }

  if (reason === 'insufficientPermissions' || status === 403) {
    if (
      responseText.toLowerCase().includes('quota') ||
      responseText.toLowerCase().includes('storage')
    ) {
      throw new DriveError(
        message || 'Google Drive storage quota exceeded. Free up space in your Google Account.',
        'quota_exceeded',
        status,
      );
    }
    throw new DriveError(
      message || 'Insufficient permissions to perform this operation on Google Drive.',
      'forbidden',
      status,
    );
  }

  if (
    reason === 'rateLimitExceeded' ||
    reason === 'userRateLimitExceeded' ||
    status === 429
  ) {
    throw new DriveError(
      message || 'Google Drive request limit reached. Please wait a moment before retrying.',
      'rate_limited',
      status,
    );
  }

  if (status === 404) {
    throw new DriveError(
      message || 'Requested backup file was not found on Google Drive.',
      'not_found',
      404,
    );
  }

  if (status >= 500 && status < 600) {
    throw new DriveError(
      message || `Google Drive server error (HTTP ${status}). Please try again later.`,
      'server_error',
      status,
    );
  }

  throw new DriveError(
    message || `Google Drive request failed: HTTP ${status} ${responseText}`,
    'unknown',
    status,
  );
}

/** Finds or creates the dedicated Personal Assistant backup folder on Google Drive. */
export async function findOrCreateBackupFolder(
  accessToken: string,
  folderName = DEFAULT_DRIVE_FOLDER_NAME,
  fetchFn: FetchFunction = fetch,
  retryOptions?: RetryOptions,
): Promise<string> {
  const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime&fields=files(id,name)`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    fetchFn,
    retryOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    handleHttpError(response.status, text);
  }

  const data = await response.json();
  if (Array.isArray(data.files) && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create folder if it doesn't exist
  const createRes = await fetchWithRetry(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: {
          owner: 'aio',
        },
      }),
    },
    fetchFn,
    retryOptions,
  );

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    handleHttpError(createRes.status, text);
  }

  const createdData = await createRes.json();
  return createdData.id;
}

/** Uploads an encrypted backup file to the specified Google Drive folder. */
export async function uploadEncryptedBackupFile(
  accessToken: string,
  filename: string,
  encryptedText: string,
  folderId: string,
  fetchFn: FetchFunction = fetch,
  resumableThresholdBytes = RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  retryOptions?: RetryOptions,
): Promise<DriveBackupFile> {
  const checksum = computeSha256Hex(encryptedText);
  const payloadBytes = utf8Encode(encryptedText);
  const payloadSize = payloadBytes.length;

  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: 'application/json',
    appProperties: {
      sha256: checksum,
      owner: 'aio',
    },
  };

  // If payload exceeds threshold, use Resumable Upload protocol
  if (payloadSize > resumableThresholdBytes) {
    const initRes = await fetchWithRetry(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'application/json',
          'X-Upload-Content-Length': String(payloadSize),
        },
        body: JSON.stringify(metadata),
      },
      fetchFn,
      retryOptions,
    );

    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '');
      handleHttpError(initRes.status, text);
    }

    const sessionUri = initRes.headers.get('Location') || initRes.headers.get('location');
    if (!sessionUri) {
      throw new DriveError('Google Drive resumable upload session URI missing in response.', 'unknown');
    }

    const uploadRes = await fetchWithRetry(
      sessionUri,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payloadSize),
        },
        body: encryptedText,
      },
      fetchFn,
      retryOptions,
    );

    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => '');
      handleHttpError(uploadRes.status, text);
    }

    const file = await uploadRes.json();
    return {
      id: file.id,
      name: file.name,
      createdTime: file.createdTime || new Date().toISOString(),
      sizeBytes: typeof file.size === 'string' ? parseInt(file.size, 10) : payloadSize,
      mimeType: file.mimeType || 'application/json',
      sha256: checksum,
    };
  }

  // Multipart upload for files under threshold
  const boundary = '-------aio_backup_boundary_' + Date.now();
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${encryptedText}\r\n` +
    `--${boundary}--`;

  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size,mimeType,appProperties';

  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    },
    fetchFn,
    retryOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    handleHttpError(response.status, text);
  }

  const file = await response.json();
  return {
    id: file.id,
    name: file.name,
    createdTime: file.createdTime || new Date().toISOString(),
    sizeBytes: typeof file.size === 'string' ? parseInt(file.size, 10) : payloadSize,
    mimeType: file.mimeType || 'application/json',
    sha256: checksum,
  };
}

/** Lists all Personal Assistant backup files in the backup folder, ordered newest first. */
export async function listBackupFiles(
  accessToken: string,
  folderId: string,
  fetchFn: FetchFunction = fetch,
  retryOptions?: RetryOptions,
): Promise<DriveBackupFile[]> {
  const query = `'${folderId}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&fields=files(id,name,createdTime,size,mimeType,appProperties)`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    fetchFn,
    retryOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    handleHttpError(response.status, text);
  }

  const data = await response.json();
  const rawFiles: unknown[] = Array.isArray(data.files) ? data.files : [];
  return rawFiles.map((f: any) => ({
    id: String(f.id),
    name: String(f.name),
    createdTime: String(f.createdTime || ''),
    sizeBytes: typeof f.size === 'string' ? parseInt(f.size, 10) : undefined,
    mimeType: String(f.mimeType || ''),
    sha256: f.appProperties?.sha256,
    owner: f.appProperties?.owner,
  }));
}

/** Downloads a backup's encrypted text and checks its SHA-256 when one is known. */
export async function downloadBackupFile(
  accessToken: string,
  fileId: string,
  fetchFn: FetchFunction = fetch,
  expectedSha256?: string,
  retryOptions?: RetryOptions,
): Promise<string> {
  let targetSha256 = expectedSha256;

  // Retrieve metadata for stored sha256 appProperties if not supplied directly
  if (!targetSha256) {
    try {
      const metaRes = await fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,appProperties,sha256Checksum`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        fetchFn,
        retryOptions,
      );
      if (metaRes.ok) {
        const metaJson = await metaRes.json();
        targetSha256 = metaJson?.appProperties?.sha256 || metaJson?.sha256Checksum;
      }
    } catch {
      // Ignore metadata fetch error and proceed to download
    }
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    fetchFn,
    retryOptions,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    handleHttpError(response.status, text);
  }

  const content = await response.text();

  // Verify integrity
  if (targetSha256) {
    const computed = computeSha256Hex(content);
    if (computed.toLowerCase() !== targetSha256.toLowerCase()) {
      throw new DriveError(
        'Backup file integrity verification failed (SHA-256 mismatch). File may be corrupted or tampered.',
        'corrupt_file',
      );
    }
  }

  return content;
}

/** Deletes a specific cloud backup file from Google Drive. */
export async function deleteCloudBackupFile(
  accessToken: string,
  fileId: string,
  fetchFn: FetchFunction = fetch,
  retryOptions?: RetryOptions,
): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;

  const response = await fetchWithRetry(
    url,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    fetchFn,
    retryOptions,
  );

  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => '');
    handleHttpError(response.status, text);
  }
}

/**
 * Keeps the newest N backups and deletes the rest. Does nothing when retention is off, only
 * touches files this app created (appProperties.owner === 'aio'), and always keeps the latest
 * successful backup.
 */
export async function enforceRetentionPolicy(
  accessToken: string,
  folderId: string,
  maxBackups?: number,
  fetchFn: FetchFunction = fetch,
  retryOptions?: RetryOptions,
  config: DriveConfig = getDriveConfig(),
): Promise<{ kept: number; deleted: number }> {
  const retentionConfig = config.retention ?? { enabled: true, maxBackups: DEFAULT_RETENTION_MAX_BACKUPS };
  if (!retentionConfig.enabled) {
    // Retention is disabled via switch: never delete any backups
    return { kept: -1, deleted: 0 };
  }

  const effectiveMax = Math.max(1, maxBackups ?? retentionConfig.maxBackups ?? DEFAULT_RETENTION_MAX_BACKUPS);
  const files = await listBackupFiles(accessToken, folderId, fetchFn, retryOptions);

  if (files.length <= effectiveMax) {
    return { kept: files.length, deleted: 0 };
  }

  // Safety rule: Never delete the latest successful backup (index 0 is protected)
  // Safety rule: Only delete files that were created by Personal Assistant (owner === 'aio')
  const candidates = files.slice(effectiveMax);
  const toDelete = candidates.filter((f) => f.owner === 'aio');

  let deletedCount = 0;
  for (const file of toDelete) {
    try {
      await deleteCloudBackupFile(accessToken, file.id, fetchFn, retryOptions);
      deletedCount++;
    } catch {
      // Continue deleting remaining candidates even if one fails
    }
  }

  return { kept: files.length - deletedCount, deleted: deletedCount };
}
