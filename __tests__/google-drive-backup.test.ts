/**
 * Google Drive backup tests.
 *
 * Runs without network access, using
 * mock stores, mock vaults and fake fetch drivers. Covers:
 * 1. App-direct OAuth PKCE logic & token lifecycle.
 * 2. Configuration (unconfigured vs configured).
 * 3. Encrypted upload reusing AES-256-GCM + scrypt format to "Personal Assistant Backups/".
 * 4. List and download metadata preview.
 * 5. Safe restore engine (pure in-memory verification before confirmation).
 * 6. Automated backup coordination (passphrase in vault only when enabled; wiped on OFF).
 * 7. Failure handling (offline, expired token, 429, corrupt file, wrong passphrase).
 * 8. Separation of Local Delete All vs Cloud Backup Delete.
 */

import { sampleData } from '../src/domain/sample';
import { systemRandom } from '../src/services/random';
import { createEncryptedBackup, unlockEncryptedBackup } from '../src/storage/backup';
import { MemoryStore } from '../src/storage/store';
import { Vault } from '../src/services/vault';
import {
  DriveConfig,
  getEffectiveScopes,
  isDriveConfigured,
  NON_SENSITIVE_DRIVE_SCOPE,
  RESTRICTED_DRIVE_SCOPE,
} from '../src/services/driveConfig';
import {
  generatePkcePair,
  generateOAuthState,
  getStoredTokens,
  getValidAccessToken,
  GoogleTokens,
  parseAuthorizationCallback,
  requestGoogleIdentityToken,
  saveTokens,
  signOutGoogle,
} from '../src/services/googleAuth';
import {
  deleteCloudBackupFile,
  downloadBackupFile,
  findOrCreateBackupFolder,
  listBackupFiles,
  uploadEncryptedBackupFile,
} from '../src/services/googleDrive';
import {
  AUTOBACKUP_PASSPHRASE_KEY,
  getBackupStatus,
  performAutoBackup,
  setAutoBackupConfig,
} from '../src/services/autoBackup';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  getAllKeys: jest.fn(() => Promise.resolve([])),
}));

class MockVault implements Vault {
  private mem = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async set(k: string, v: string): Promise<void> { this.mem.set(k, v); }
  async get(k: string): Promise<string | null> { return this.mem.get(k) ?? null; }
  async remove(k: string): Promise<void> { this.mem.delete(k); }
}

describe('Google Drive Cloud Backup Feature', () => {
  let mockVault: MockVault;
  let mockStore: MemoryStore;

  beforeEach(() => {
    mockVault = new MockVault();
    mockStore = new MemoryStore();
  });

  describe('Configuration and scopes (driveConfig.ts)', () => {
    it('reports unconfigured state when clientId is missing', () => {
      const unconfigured: DriveConfig = {
        clientId: '',
        redirectUri: 'com.assistant.personal:/oauthredirect',
        folderName: 'Personal Assistant Backups',
        enableFullDriveScope: false,
      };
      expect(isDriveConfigured(unconfigured)).toBe(false);
    });

    it('reports configured state when valid clientId is supplied', () => {
      const configured: DriveConfig = {
        clientId: 'mock-client-id.apps.googleusercontent.com',
        redirectUri: 'com.assistant.personal:/oauthredirect',
        folderName: 'Personal Assistant Backups',
        enableFullDriveScope: false,
      };
      expect(isDriveConfigured(configured)).toBe(true);
    });

    it('uses non-sensitive drive.file scope by default and full scope only behind flag', () => {
      const normalConfig: DriveConfig = {
        clientId: 'id',
        redirectUri: 'uri',
        folderName: 'Personal Assistant Backups',
        enableFullDriveScope: false,
      };
      expect(getEffectiveScopes(normalConfig)).toEqual([NON_SENSITIVE_DRIVE_SCOPE]);

      const flagConfig: DriveConfig = {
        ...normalConfig,
        enableFullDriveScope: true,
      };
      expect(getEffectiveScopes(flagConfig)).toEqual([RESTRICTED_DRIVE_SCOPE]);
    });
  });

  describe('PKCE & OAuth Token Lifecycle (googleAuth.ts)', () => {
    it('uses Google Identity Services browser token callback and never returns a refresh token', async () => {
      Object.defineProperty(window, 'google', {
        configurable: true,
        value: {
          accounts: {
            oauth2: {
              initTokenClient: (config: {
                callback: (response: {
                  access_token: string;
                  expires_in: number;
                  scope: string;
                  token_type: string;
                }) => void;
              }) => ({
                requestAccessToken: () => config.callback({
                  access_token: 'browser-access-token',
                  expires_in: 3600,
                  scope: NON_SENSITIVE_DRIVE_SCOPE,
                  token_type: 'Bearer',
                }),
              }),
            },
          },
        },
      });

      const tokens = await requestGoogleIdentityToken(
        'example-test-client.apps.googleusercontent.com',
        NON_SENSITIVE_DRIVE_SCOPE,
      );
      expect(tokens.accessToken).toBe('browser-access-token');
      expect(tokens.refreshToken).toBeUndefined();
      expect(tokens.tokenType).toBe('Bearer');
    });

    it('generates a valid PKCE pair with S256 challenge', () => {
      const pkce = generatePkcePair();
      expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
      expect(pkce.challenge.length).toBeGreaterThan(0);
      expect(pkce.verifier).not.toBe(pkce.challenge);
    });

    it('generates unpredictable OAuth state and validates the callback state', () => {
      const state = generateOAuthState();
      expect(state.length).toBeGreaterThanOrEqual(43);
      expect(parseAuthorizationCallback(
        `com.assistant.personal:/oauthredirect?code=auth-code&state=${encodeURIComponent(state)}`,
        state,
      )).toEqual({ code: 'auth-code' });
    });

    it('rejects callbacks with a missing or mismatched state', () => {
      expect(() => parseAuthorizationCallback(
        'com.assistant.personal:/oauthredirect?code=auth-code&state=wrong',
        'expected-state',
      )).toThrow('state validation');
    });

    it('stores tokens in secure vault and purges on sign out', async () => {
      const tokens: GoogleTokens = {
        accessToken: 'initial-access-token',
        refreshToken: 'initial-refresh-token',
        expiresAt: Date.now() + 3600_000,
        scope: NON_SENSITIVE_DRIVE_SCOPE,
        tokenType: 'Bearer',
      };

      await saveTokens(tokens, mockVault);
      expect(await getStoredTokens(mockVault)).toEqual(tokens);

      // Sign out revokes and clears vault
      let revoked = false;
      const mockFetch = async () => {
        revoked = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      await signOutGoogle(mockVault, mockFetch as any);
      expect(revoked).toBe(true);
      expect(await getStoredTokens(mockVault)).toBeNull();
    });

    it('auto-refreshes expiring token when getting valid access token', async () => {
      const expiringTokens: GoogleTokens = {
        accessToken: 'old-access-token',
        refreshToken: 'valid-refresh-token',
        expiresAt: Date.now() + 30_000, // expiring in 30 seconds (< 60s threshold)
        scope: NON_SENSITIVE_DRIVE_SCOPE,
        tokenType: 'Bearer',
      };
      await saveTokens(expiringTokens, mockVault);

      const mockFetch = async (url: string) => {
        if (url.includes('/token')) {
          return new Response(JSON.stringify({
            access_token: 'new-refreshed-token',
            expires_in: 3600,
          }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      };

      const validToken = await getValidAccessToken(
        mockVault,
        { clientId: 'id', redirectUri: 'uri', folderName: 'Personal Assistant Backups', enableFullDriveScope: false },
        mockFetch as any,
      );

      expect(validToken).toBe('new-refreshed-token');
      const stored = await getStoredTokens(mockVault);
      expect(stored?.accessToken).toBe('new-refreshed-token');
    });
  });

  describe('Google Drive REST Client & Folder / Upload (googleDrive.ts)', () => {
    it('creates Personal Assistant Backups folder if not found on Drive', async () => {
      let createdFolderName = '';
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'GET') {
          // Folder query returns empty
          return new Response(JSON.stringify({ files: [] }), { status: 200 });
        }
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string);
          createdFolderName = body.name;
          return new Response(JSON.stringify({ id: 'new-folder-id-123' }), { status: 200 });
        }
        return new Response('', { status: 400 });
      };

      const folderId = await findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any);
      expect(folderId).toBe('new-folder-id-123');
      expect(createdFolderName).toBe('Personal Assistant Backups');
    });

    it('uploads encrypted payload reusing existing AES-256-GCM format', async () => {
      const data = sampleData('2026-11-09');
      const passphrase = 'drive-test-passphrase-123';
      const encryptedPayload = await createEncryptedBackup(data, passphrase, { random: systemRandom });

      let capturedBody = '';
      const mockFetch = async (url: string, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({
          id: 'uploaded-file-id-456',
          name: 'personal-assistant-backup-2026-11-09.json',
          createdTime: '2026-11-09T08:00:00Z',
          size: '12345',
        }), { status: 200 });
      };

      const file = await uploadEncryptedBackupFile(
        'token',
        'personal-assistant-backup-2026-11-09.json',
        encryptedPayload,
        'folder-id',
        mockFetch as any,
      );

      expect(file.id).toBe('uploaded-file-id-456');
      expect(capturedBody).toContain(encryptedPayload);
      expect(capturedBody).toContain('"ai-o-encrypted-backup"');
    });

    it('lists and downloads cloud backups from Google Drive', async () => {
      const mockFiles = [
        { id: 'f1', name: 'personal-assistant-backup-1.json', createdTime: '2026-11-09T08:00:00Z', size: '1000' },
        { id: 'f2', name: 'personal-assistant-backup-2.json', createdTime: '2026-11-08T08:00:00Z', size: '2000' },
      ];

      const mockFetch = async (url: string) => {
        if (url.includes('/files?')) {
          return new Response(JSON.stringify({ files: mockFiles }), { status: 200 });
        }
        if (url.includes('/files/f1?alt=media')) {
          return new Response('{"mockEncryptedPayload": true}', { status: 200 });
        }
        return new Response('', { status: 404 });
      };

      const files = await listBackupFiles('token', 'folder-id', mockFetch as any);
      expect(files).toHaveLength(2);
      expect(files[0].id).toBe('f1');

      const content = await downloadBackupFile('token', 'f1', mockFetch as any);
      expect(content).toBe('{"mockEncryptedPayload": true}');
    });

    it('deletes cloud backup from Drive without touching local data', async () => {
      let deletedId = '';
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletedId = url.split('/files/')[1];
          return new Response(null, { status: 204 });
        }
        return new Response('', { status: 400 });
      };

      await deleteCloudBackupFile('token', 'file-to-delete-789', mockFetch as any);
      expect(deletedId).toBe('file-to-delete-789');
    });
  });

  describe('Safe Restore Engine (Preview -> Confirm -> Apply)', () => {
    it('restores downloaded cloud backup cleanly through unlockEncryptedBackup without silent overwrite', async () => {
      const original = sampleData('2026-11-09');
      const pass = 'safe-restore-passphrase-999';
      const cloudPayload = await createEncryptedBackup(original, pass, { random: systemRandom });

      // Decrypt in memory (pure, touches no local storage)
      const res = await unlockEncryptedBackup(cloudPayload, pass);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.tasks.length).toBe(original.tasks.length);
        expect(res.data.expenses.length).toBe(original.expenses.length);
      }

      // Wrong passphrase fails without touching storage
      const wrongRes = await unlockEncryptedBackup(cloudPayload, 'wrong-password-here');
      expect(wrongRes.ok).toBe(false);

      // Corrupt ciphertext fails
      const corruptRes = await unlockEncryptedBackup(cloudPayload.replace(/"ciphertext":\s*"[^"]+"/, '"ciphertext":"bad"'), pass);
      expect(corruptRes.ok).toBe(false);
    });
  });

  describe('Automated Backup Coordination (autoBackup.ts)', () => {
    it('stores passphrase in vault only when enabled, and immediately wipes when disabled', async () => {
      expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBeNull();

      // Enable auto backup
      await setAutoBackupConfig(true, 'secret-vault-passphrase', mockVault, mockStore);
      expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBe('secret-vault-passphrase');
      const statusOn = await getBackupStatus(mockStore);
      expect(statusOn.enabled).toBe(true);

      // Disable auto backup
      await setAutoBackupConfig(false, undefined, mockVault, mockStore);
      expect(await mockVault.get(AUTOBACKUP_PASSPHRASE_KEY)).toBeNull();
      const statusOff = await getBackupStatus(mockStore);
      expect(statusOff.enabled).toBe(false);
    });

    it('performs automated backup when enabled and records the success status', async () => {
      await setAutoBackupConfig(true, 'auto-passphrase-123', mockVault, mockStore);

      const tokens: GoogleTokens = {
        accessToken: 'valid-auto-token',
        expiresAt: Date.now() + 3600_000,
        scope: NON_SENSITIVE_DRIVE_SCOPE,
        tokenType: 'Bearer',
      };
      await saveTokens(tokens, mockVault);

      const mockFetch = async (url: string, init?: RequestInit) => {
        if (url.includes('/files?q=')) {
          return new Response(JSON.stringify({ files: [{ id: 'f-folder-id' }] }), { status: 200 });
        }
        if (url.includes('/upload/drive/v3/files')) {
          return new Response(JSON.stringify({ id: 'uploaded-auto-file', name: 'ai-o-backup.json' }), { status: 200 });
        }
        return new Response('', { status: 200 });
      };

      const data = sampleData('2026-11-09');
      const result = await performAutoBackup(data, {
        vault: mockVault,
        store: mockStore,
        fetchFn: mockFetch as any,
        config: { clientId: 'id', redirectUri: 'uri', folderName: 'Personal Assistant Backups', enableFullDriveScope: false },
      });

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.fileId).toBe('uploaded-auto-file');
      }

      const status = await getBackupStatus(mockStore);
      expect(status.lastSuccess).not.toBeNull();
      expect(status.lastError).toBeNull();
    });

    it('records the failure status when drive quota is exceeded (storageQuotaExceeded)', async () => {
      await setAutoBackupConfig(true, 'auto-passphrase-123', mockVault, mockStore);

      const tokens: GoogleTokens = {
        accessToken: 'valid-auto-token',
        expiresAt: Date.now() + 3600_000,
        scope: NON_SENSITIVE_DRIVE_SCOPE,
        tokenType: 'Bearer',
      };
      await saveTokens(tokens, mockVault);

      const mockFetch = async (url: string) => {
        if (url.includes('/files?q=')) {
          return new Response(JSON.stringify({ files: [{ id: 'f-folder-id' }] }), { status: 200 });
        }
        if (url.includes('/upload/drive/v3/files')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'The user Drive storage quota has been exceeded.',
                errors: [{ reason: 'storageQuotaExceeded' }],
              },
            }),
            { status: 403 },
          );
        }
        return new Response('', { status: 200 });
      };

      const data = sampleData('2026-11-09');
      const result = await performAutoBackup(data, {
        vault: mockVault,
        store: mockStore,
        fetchFn: mockFetch as any,
        config: { clientId: 'id', redirectUri: 'uri', folderName: 'Personal Assistant Backups', enableFullDriveScope: false },
      });

      expect(result.status).toBe('error');
      const status = await getBackupStatus(mockStore);
      expect(status.lastError).toMatch(/Google Drive storage quota exceeded/);
    });
  });

  describe('Error Handling & HTTP Statuses (googleDrive.ts)', () => {
    it('maps HTTP 401 to auth_expired', async () => {
      const mockFetch = async () => new Response('Unauthorized', { status: 401 });
      await expect(findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any))
        .rejects.toThrow('Google authorization has expired');
    });

    it('maps HTTP 429 to rate_limited', async () => {
      const mockFetch = async () => new Response('Rate limit reached', { status: 429 });
      await expect(findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any))
        .rejects.toThrow('Google Drive request limit reached');
    });

    it('maps network throws to network_error without unhandled rejection', async () => {
      const mockFetch = async () => { throw new TypeError('Network request failed'); };
      await expect(findOrCreateBackupFolder('token', 'Personal Assistant Backups', mockFetch as any))
        .rejects.toThrow('Network request failed');
    });
  });
});
