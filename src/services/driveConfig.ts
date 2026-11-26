/**
 * Google Drive settings: OAuth scopes, folder name and retention.
 * Client IDs come from EXPO_PUBLIC_GOOGLE_*_CLIENT_ID at build time. A client ID is public,
 * but each platform needs its own OAuth client, and a fork must use its own Google project.
 * Without one the Drive panel says it isn't set up and makes no calls.
 */

import { Platform } from 'react-native';

export interface RetentionConfig {
  /** Whether automatic retention pruning is active. */
  enabled: boolean;
  /** Number of latest backups to retain (default 5). */
  maxBackups: number;
}

export interface DriveConfig {
  /** Master runtime feature flag. When false, Google Drive backup is entirely disabled. Defaults to true. */
  enabled?: boolean;
  /** OAuth 2.0 Web / Installed App Client ID. */
  clientId: string;
  /** OAuth 2.0 Redirect URI. */
  redirectUri: string;
  /** Google Drive folder where Personal Assistant encrypted backups are stored. */
  folderName: string;
  /** Whether the full Google Drive scope is enabled (feature flag). */
  enableFullDriveScope: boolean;
  /** Backup retention policy configuration. */
  retention?: RetentionConfig;
}

export const DEFAULT_DRIVE_FOLDER_NAME = 'Personal Assistant Backups';
export const DEFAULT_RETENTION_MAX_BACKUPS = 5;

/** Non-sensitive scope: only accesses files created by Personal Assistant. */
export const NON_SENSITIVE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Restricted scope: broad Google Drive access (behind feature flag). */
export const RESTRICTED_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Picks the OAuth client for the running platform. Empty means not set up. */
export function platformClientId(os: string = Platform.OS): string {
  let id: string | undefined;
  if (os === 'web') id = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  else if (os === 'android') id = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  else if (os === 'ios') id = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  return (id ?? '').trim();
}

let currentConfig: DriveConfig = {
  enabled: true,
  clientId: platformClientId(),
  redirectUri: 'personalassistant:/oauthredirect',
  folderName: DEFAULT_DRIVE_FOLDER_NAME,
  enableFullDriveScope: false, // Default false; full scope is behind this flag
  retention: {
    enabled: true,
    maxBackups: DEFAULT_RETENTION_MAX_BACKUPS,
  },
};

export function getDriveConfig(): Readonly<DriveConfig> {
  return currentConfig;
}

export function setDriveConfig(patch: Partial<DriveConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...patch,
    retention: patch.retention
      ? { ...currentConfig.retention, ...patch.retention }
      : currentConfig.retention,
  };
}

/** Checks whether the master Google Drive feature flag is enabled. */
export function isDriveFeatureEnabled(config: DriveConfig = currentConfig): boolean {
  return config.enabled !== false;
}

export function isDriveConfigured(config: DriveConfig = currentConfig): boolean {
  return isDriveFeatureEnabled(config) && typeof config.clientId === 'string' && config.clientId.trim().length > 0;
}

export function getEffectiveScopes(config: DriveConfig = currentConfig): readonly string[] {
  return config.enableFullDriveScope
    ? [RESTRICTED_DRIVE_SCOPE]
    : [NON_SENSITIVE_DRIVE_SCOPE];
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  enabled: true,
  maxBackups: DEFAULT_RETENTION_MAX_BACKUPS,
};

/** Returns the user-facing retention copy based on active configuration. */
export function getRetentionCopy(config: DriveConfig = currentConfig): string {
  const ret = config.retention ?? DEFAULT_RETENTION_CONFIG;
  if (!ret.enabled) {
    return 'Automatic cloud backup cleanup is disabled.';
  }
  return `Older backups are removed automatically (keeps ${ret.maxBackups}).`;
}

export { SCRYPT_KDF_BOUNDS, type ScryptKdfBounds } from '../crypto/backup';
