/**
 * Settings panel for Google Drive backup: connect, back up now, list backups, restore through
 * the usual preview-and-confirm flow, delete a cloud copy, and the automatic backup switch.
 */

import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { AppData } from '../domain/types';
import { DEFAULT_KDF_TIMEOUT_MS, MIN_PASSPHRASE_CHARS } from '../crypto/backup';
import { createEncryptedBackup } from '../storage/backup';
import { systemRandom } from '../services/random';
import {
  isDriveConfigured,
  getDriveConfig,
  isDriveFeatureEnabled,
  getRetentionCopy,
  getEffectiveScopes,
} from '../services/driveConfig';
import {
  getStoredTokens,
  getValidAccessToken,
  exchangeCodeForTokens,
  signOutGoogle,
  saveTokens,
  parseAuthorizationParameters,
  requestGoogleIdentityToken,
} from '../services/googleAuth';
import {
  DriveBackupFile,
  findOrCreateBackupFolder,
  uploadEncryptedBackupFile,
  listBackupFiles,
  downloadBackupFile,
  deleteCloudBackupFile,
  enforceRetentionPolicy,
} from '../services/googleDrive';
import {
  getBackupStatus,
  setAutoBackupConfig,
  BackupStatus,
  INITIAL_BACKUP_STATUS,
  AUTO_BACKUP_DISCLOSURE_TEXT,
} from '../services/autoBackup';
import { Banner, Button, Card, Field, Loading, ProgressBar } from './components';
import { space, type, useTheme } from './theme';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

export interface GoogleDriveBackupProps {
  data: AppData;
  today: string;
  onRestoreRequested: (backupData: AppData) => void;
  onSetMessage: (msg: { tone: 'info' | 'danger'; text: string } | null) => void;
}

export function GoogleDriveBackupSection({
  data,
  today: _today,
  onRestoreRequested,
  onSetMessage,
}: GoogleDriveBackupProps) {
  const { c } = useTheme();


  // Auth & Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Cloud files & listing
  const [cloudFiles, setCloudFiles] = useState<DriveBackupFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // "Back up now" modal state
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadPassphrase, setUploadPassphrase] = useState('');
  const [uploadPassphraseConfirm, setUploadPassphraseConfirm] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Auto-backup configuration
  const [backupStatus, setBackupStatus] = useState<BackupStatus>(INITIAL_BACKUP_STATUS);
  const [showAutoBackupPassForm, setShowAutoBackupPassForm] = useState(false);
  const [autoBackupPassInput, setAutoBackupPassInput] = useState('');

  // Delete cloud file confirmation
  const [fileToDelete, setFileToDelete] = useState<DriveBackupFile | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);

  // Restore action
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);
  const [fileToRestoreText, setFileToRestoreText] = useState<string | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreUnlocking, setRestoreUnlocking] = useState(false);

  const enabled = isDriveFeatureEnabled();
  const configured = isDriveConfigured();
  const driveConfig = getDriveConfig();
  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'personalassistant',
    path: 'oauthredirect',
  });
  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: driveConfig.clientId || 'unconfigured',
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      scopes: [getDriveConfig().enableFullDriveScope
        ? 'https://www.googleapis.com/auth/drive'
        : 'https://www.googleapis.com/auth/drive.file'],
      usePKCE: true,
    },
    GOOGLE_DISCOVERY,
  );

  // Load auth and backup status (skipped if feature flag disabled)
  useEffect(() => {
    let alive = true;
    async function loadInitial() {
      if (!enabled) {
        if (alive) {
          setLoadingAuth(false);
        }
        return;
      }
      try {
        const [tokens, status] = await Promise.all([
          getStoredTokens(),
          getBackupStatus(),
        ]);
        if (!alive) return;
        setIsConnected(tokens !== null);
        setBackupStatus(status);

        if (tokens !== null && configured) {
          const token = await getValidAccessToken();
          if (token && alive) {
            const config = getDriveConfig();
            const folderId = await findOrCreateBackupFolder(token, config.folderName);
            const files = await listBackupFiles(token, folderId);
            if (alive) setCloudFiles(files);
          }
        }
      } catch {
        // Fall back to the defaults
      } finally {
        if (alive) {
          setLoadingAuth(false);
        }
      }
    }
    void loadInitial();
    return () => { alive = false; };
  }, [configured, enabled]);

  // Fetch file list when connected
  const refreshCloudFiles = async () => {
    setLoadingFiles(true);
    try {
      const token = await getValidAccessToken();
      if (!token) {
        setIsConnected(false);
        setCloudFiles([]);
        return;
      }
      const config = getDriveConfig();
      const folderId = await findOrCreateBackupFolder(token, config.folderName);
      const files = await listBackupFiles(token, folderId);
      setCloudFiles(files);
    } catch (err) {
      onSetMessage({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Could not list Google Drive backups',
      });
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleSignIn = async () => {
    if (!configured) {
      onSetMessage({ tone: 'danger', text: 'Google Drive is not configured yet. Add the OAuth client ID first.' });
      return;
    }

    setSigningIn(true);
    setAuthError(null);
    try {
      if (Platform.OS === 'web') {
        const scope = getEffectiveScopes(driveConfig).join(' ');
        const tokens = await requestGoogleIdentityToken(driveConfig.clientId, scope);
        await saveTokens(tokens);
        setIsConnected(true);
        onSetMessage({ tone: 'info', text: 'Connected to Google Drive.' });
        return;
      }
      if (!request?.codeVerifier) {
        throw new Error('Google sign-in is not ready yet. Please try again.');
      }
      const result = await promptAsync();
      if (result.type !== 'success') {
        throw new Error('Google sign-in was cancelled before authorization completed.');
      }

      const { code } = parseAuthorizationParameters(result.params, request.state);
      const config = { ...driveConfig, redirectUri: request.redirectUri };
      const tokens = await exchangeCodeForTokens(code, request.codeVerifier, config);
      await saveTokens(tokens);
      setIsConnected(true);
      onSetMessage({ tone: 'info', text: 'Connected to Google Drive.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not connect to Google Drive.';
      setAuthError(message);
      onSetMessage({
        tone: 'danger',
        text: message,
      });
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOutGoogle();
    setIsConnected(false);
    setCloudFiles([]);
    onSetMessage({ tone: 'info', text: 'Disconnected from Google Drive.' });
  };

  // Perform "Back up to Drive now"
  const handleBackUpNow = async () => {
    if (uploadPassphrase.length < MIN_PASSPHRASE_CHARS) {
      return setUploadError(`Passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`);
    }
    if (uploadPassphrase !== uploadPassphraseConfirm) {
      return setUploadError('Passphrases do not match.');
    }

    setUploadBusy(true);
    setUploadError(null);
    setUploadProgress(0);

    try {
      const token = await getValidAccessToken();
      if (!token) {
        throw new Error('Google Drive is not connected or authorization expired.');
      }

      // Local encryption
      const encryptedText = await createEncryptedBackup(data, uploadPassphrase, {
        random: systemRandom,
        onProgress: setUploadProgress,
      });

      // Upload to Drive
      const config = getDriveConfig();
      const folderId = await findOrCreateBackupFolder(token, config.folderName);
      const nowIso = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `personal-assistant-backup-${nowIso}.json`;

      await uploadEncryptedBackupFile(token, filename, encryptedText, folderId);
      try {
        await enforceRetentionPolicy(token, folderId, 5);
      } catch {
        // Retention enforcement failure does not invalidate the successful upload
      }

      setShowUploadForm(false);
      setUploadPassphrase('');
      setUploadPassphraseConfirm('');
      onSetMessage({ tone: 'info', text: 'Encrypted backup uploaded to Google Drive successfully.' });
      void refreshCloudFiles();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Could not upload backup to Google Drive.');
    } finally {
      setUploadBusy(false);
    }
  };

  // Toggle automated backup
  const handleToggleAutoBackup = async () => {
    if (backupStatus.enabled) {
      // Turn OFF immediately
      await setAutoBackupConfig(false);
      const updated = await getBackupStatus();
      setBackupStatus(updated);
      onSetMessage({ tone: 'info', text: 'Automated backup disabled. Passphrase wiped from device vault.' });
    } else {
      // Need passphrase to turn ON
      setShowAutoBackupPassForm(true);
    }
  };

  const handleConfirmAutoBackupEnable = async () => {
    if (autoBackupPassInput.length < MIN_PASSPHRASE_CHARS) {
      return onSetMessage({
        tone: 'danger',
        text: `Passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.`,
      });
    }
    try {
      await setAutoBackupConfig(true, autoBackupPassInput);
      const updated = await getBackupStatus();
      setBackupStatus(updated);
      setShowAutoBackupPassForm(false);
      setAutoBackupPassInput('');
      onSetMessage({
        tone: 'info',
        text: 'Automated backup enabled. Passphrase securely stored in hardware keystore for background backups.',
      });
    } catch (err) {
      onSetMessage({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Could not enable automated backup.',
      });
    }
  };

  // Download & start restore
  const handleStartRestore = async (file: DriveBackupFile) => {
    setDownloadingFileId(file.id);
    setRestoreError(null);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Google Drive authorization has expired.');
      const content = await downloadBackupFile(token, file.id);
      setFileToRestoreText(content);
      setRestorePassphrase('');
    } catch (err) {
      onSetMessage({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Could not download backup from Drive.',
      });
    } finally {
      setDownloadingFileId(null);
    }
  };

  // Unlock downloaded file using unlockEncryptedBackup
  const handleUnlockAndPreview = async () => {
    if (!fileToRestoreText) return;
    setRestoreUnlocking(true);
    setRestoreError(null);
    try {
      const { unlockEncryptedBackup } = await import('../storage/backup');
      const res = await unlockEncryptedBackup(fileToRestoreText, restorePassphrase);
      if (!res.ok) {
        setRestoreError(res.message);
        return;
      }
      // Pass unlocked AppData to the caller's preview engine
      setFileToRestoreText(null);
      setRestorePassphrase('');
      onRestoreRequested(res.data);
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Failed to decrypt backup.');
    } finally {
      setRestoreUnlocking(false);
    }
  };

  // Confirm cloud backup delete
  const handleConfirmDeleteCloudFile = async () => {
    if (!fileToDelete) return;
    setDeletingFile(true);
    try {
      const token = await getValidAccessToken();
      if (!token) throw new Error('Google Drive authorization has expired.');
      await deleteCloudBackupFile(token, fileToDelete.id);
      onSetMessage({ tone: 'info', text: `Deleted "${fileToDelete.name}" from Google Drive.` });
      setFileToDelete(null);
      void refreshCloudFiles();
    } catch (err) {
      onSetMessage({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Could not delete backup from Google Drive.',
      });
    } finally {
      setDeletingFile(false);
    }
  };

  if (!enabled) {
    return null;
  }

  if (loadingAuth) {
    return <Card><Loading /></Card>;
  }

  return (
    <>
      <Card>
        <Text style={[type.secondary, { color: c.sub, marginBottom: 8 }]}>
          Backups go only to your own Google Drive account. Personal Assistant has no server and never receives them.
        </Text>

        {!configured ? (
          <View style={{ marginTop: 8 }}>
            <Banner
              tone="warn"
              text={Platform.OS === 'web'
                ? "Google Drive backup isn't set up in this build. Encrypted backup files still work without it."
                : 'Google Drive sign-in for the phone app is still being built. For now, tap Create encrypted backup above and pick Drive in the share menu to keep a copy there.'}
            />
          </View>
        ) : (
          <View style={{ marginTop: 8 }}>
            {authError ? <Banner tone="danger" text={authError} /> : null}
            <View style={[st.rowBetween, { marginVertical: 6 }]}>
              <Text style={[type.secondary, { color: c.text }]}>
                Status: {isConnected ? '✓ Connected to Google Drive' : 'Disconnected'}
              </Text>
              {isConnected ? (
                <Button kind="secondary" label="Disconnect" onPress={handleSignOut} />
              ) : (
                <Button
                  label={signingIn ? 'Connecting…' : 'Connect Google Drive'}
                  onPress={handleSignIn}
                  disabled={signingIn}
                />
              )}
            </View>

            {isConnected ? (
              <>
                {!showUploadForm ? (
                  <Button
                    label="Back up to Drive now"
                    onPress={() => { setShowUploadForm(true); setUploadError(null); }}
                    style={{ marginTop: 8 }}
                  />
                ) : (
                  <View style={[st.subCard, { borderColor: c.border }]}>
                    <Text style={[type.cardTitle, { color: c.text, marginBottom: 4 }]}>
                      Create encrypted Drive backup
                    </Text>
                    <Field
                      label={`Backup passphrase - minimum ${MIN_PASSPHRASE_CHARS} chars`}
                      value={uploadPassphrase}
                      onChangeText={setUploadPassphrase}
                      secureTextEntry
                    />
                    <Field
                      label="Confirm passphrase"
                      value={uploadPassphraseConfirm}
                      onChangeText={setUploadPassphraseConfirm}
                      secureTextEntry
                    />
                    {uploadError ? <Text style={[type.secondary, { color: c.danger, marginBottom: 8 }]}>{uploadError}</Text> : null}
                    {uploadBusy ? (
                      <View style={{ marginVertical: 8 }}>
                        <Text style={[type.caption, { color: c.sub, marginBottom: 4 }]}>
                          Deriving key and uploading to Google Drive… stops after {Math.round(DEFAULT_KDF_TIMEOUT_MS / 1000)}s.
                        </Text>
                        <ProgressBar pct={Math.round(uploadProgress * 100)} label="Derivation progress" />
                      </View>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <Button
                        label={uploadBusy ? 'Uploading…' : 'Upload to Drive'}
                        disabled={uploadBusy}
                        onPress={handleBackUpNow}
                        style={{ flex: 1 }}
                      />
                      <Button
                        kind="secondary"
                        label="Cancel"
                        disabled={uploadBusy}
                        onPress={() => setShowUploadForm(false)}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </View>
                )}

                <View style={[st.subCard, { borderColor: c.border, marginTop: 12 }]}>
                  <View style={st.rowBetween}>
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text style={[type.cardTitle, { color: c.text }]}>Automated Cloud Backup</Text>
                      <Text style={[type.caption, { color: c.sub, marginTop: 2 }]}>
                        {backupStatus.enabled ? 'Enabled: at most once a day, never guaranteed' : 'Disabled - default'}
                      </Text>
                    </View>
                    <Button
                      kind={backupStatus.enabled ? 'danger' : 'secondary'}
                      label={backupStatus.enabled ? 'Turn OFF' : 'Turn ON'}
                      onPress={handleToggleAutoBackup}
                    />
                  </View>

                  {showAutoBackupPassForm ? (
                    <View style={{ marginTop: 8 }}>
                      <Banner
                        tone="warn"
                        text="Enabling automated backup saves your passphrase in your device's secure hardware keystore so the OS can run backups without prompting."
                      />
                      <Field
                        label="Enter passphrase to store for auto-backups"
                        value={autoBackupPassInput}
                        onChangeText={setAutoBackupPassInput}
                        secureTextEntry
                      />
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <Button label="Save & Enable" onPress={handleConfirmAutoBackupEnable} style={{ flex: 1 }} />
                        <Button kind="secondary" label="Cancel" onPress={() => setShowAutoBackupPassForm(false)} style={{ flex: 1 }} />
                      </View>
                    </View>
                  ) : null}

                  <Text style={[type.caption, { color: c.sub, marginTop: 8 }]}>
                    • {AUTO_BACKUP_DISCLOSURE_TEXT}
                  </Text>
                </View>

                <View style={{ marginTop: 8, paddingHorizontal: 4 }}>
                  <Text style={[type.caption, { color: c.sub }]}>
                    Last attempt: {backupStatus.lastAttempt ? new Date(backupStatus.lastAttempt).toLocaleString() : 'Never'}
                    {backupStatus.lastSuccess ? ` · Last success: ${new Date(backupStatus.lastSuccess).toLocaleString()}` : ''}
                  </Text>
                  {backupStatus.lastError ? (
                    <Text style={[type.caption, { color: c.danger, marginTop: 2 }]}>
                      Error: {backupStatus.lastError}
                    </Text>
                  ) : null}
                </View>

                <View style={{ marginTop: 12 }}>
                  <View style={st.rowBetween}>
                    <Text style={[type.secondary, { color: c.text, fontWeight: '700' }]}>
                      Backups on Google Drive ({cloudFiles.length})
                    </Text>
                    <Button kind="secondary" label="Refresh" onPress={refreshCloudFiles} disabled={loadingFiles} />
                  </View>
                  <Text style={[type.caption, { color: c.sub, marginTop: 4, marginBottom: 4 }]}>
                    • {getRetentionCopy()}
                  </Text>

                  {loadingFiles ? (
                    <Loading />
                  ) : cloudFiles.length === 0 ? (
                    <Text style={[type.secondary, { color: c.sub, marginVertical: 8 }]}>
                      No backups found in &quot;Personal Assistant Backups/&quot; on Google Drive.
                    </Text>
                  ) : (
                    cloudFiles.map((file) => (
                      <View key={file.id} style={[st.fileRow, { borderBottomColor: c.border }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[type.caption, { color: c.text, fontWeight: '600' }]} numberOfLines={1}>
                            {file.name}
                          </Text>
                          <Text style={[type.caption, { color: c.sub }]}>
                            {file.createdTime ? new Date(file.createdTime).toLocaleString() : 'Unknown date'}
                            {file.sizeBytes !== undefined ? ` · ${(file.sizeBytes / 1024).toFixed(1)} KB` : ''}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 6 }}>
                          <Button
                            kind="secondary"
                            label={downloadingFileId === file.id ? 'Fetching…' : 'Restore'}
                            disabled={downloadingFileId === file.id}
                            onPress={() => handleStartRestore(file)}
                          />
                          <Button
                            kind="danger"
                            label="Delete"
                            onPress={() => setFileToDelete(file)}
                          />
                        </View>
                      </View>
                    ))
                  )}
                </View>
              </>
            ) : null}
          </View>
        )}
      </Card>

      {fileToRestoreText ? (
        <Card>
          <Text style={[type.cardTitle, { color: c.text, marginBottom: 4 }]}>
            Restore from Google Drive
          </Text>
          <Text style={[type.secondary, { color: c.sub, marginBottom: 8 }]}>
            Enter the passphrase used when creating this backup. It will be decrypted and verified in memory before touching your data.
          </Text>
          <Field
            label="Backup passphrase"
            value={restorePassphrase}
            onChangeText={setRestorePassphrase}
            secureTextEntry
          />
          {restoreError ? (
            <Text style={[type.secondary, { color: c.danger, marginVertical: 6 }]}>{restoreError}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Button
              label={restoreUnlocking ? 'Decrypting…' : 'Review Decrypted Data'}
              disabled={restoreUnlocking || !restorePassphrase}
              onPress={handleUnlockAndPreview}
              style={{ flex: 1 }}
            />
            <Button
              kind="secondary"
              label="Cancel"
              disabled={restoreUnlocking}
              onPress={() => { setFileToRestoreText(null); setRestorePassphrase(''); }}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : null}

      {fileToDelete ? (
        <Card>
          <Text style={[type.cardTitle, { color: c.danger, fontWeight: '800', marginBottom: 6 }]}>
            Delete Cloud Backup?
          </Text>
          <Text style={[type.secondary, { color: c.text, marginBottom: 4 }]}>
            {`Are you sure you want to permanently delete "${fileToDelete.name}" from your Google Drive?`}
          </Text>
          <Text style={[type.caption, { color: c.sub, marginBottom: 12 }]}>
            • This only deletes the copy in Google Drive. Nothing on this device changes.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              kind="danger"
              label={deletingFile ? 'Deleting…' : 'Yes, Delete from Drive'}
              disabled={deletingFile}
              onPress={handleConfirmDeleteCloudFile}
              style={{ flex: 1 }}
            />
            <Button
              kind="secondary"
              label="Cancel"
              disabled={deletingFile}
              onPress={() => setFileToDelete(null)}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : null}
    </>
  );
}

const st = StyleSheet.create({
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardHeading: {
    fontWeight: '800',
    fontSize: 16,
  },
  subCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: space.md,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
