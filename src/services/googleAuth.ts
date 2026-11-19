/**
 * Google sign-in with OAuth PKCE, done on the device with no server in between.
 * Tokens are kept only in the secure vault and are never included in backups.
 */

import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64Encode, utf8Encode } from '../crypto/bytes';
import { systemRandom } from './random';
import { Vault, secureVault } from './vault';
import { DriveConfig, getDriveConfig, getEffectiveScopes, isDriveConfigured } from './driveConfig';

export const GOOGLE_TOKENS_VAULT_KEY = 'aio.gdrive.tokens';
export const GOOGLE_ACCESS_TOKEN_KEY = 'aio.gdrive.access_token';
export const GOOGLE_REFRESH_TOKEN_KEY = 'aio.gdrive.refresh_token';
export const GOOGLE_EXPIRES_AT_KEY = 'aio.gdrive.expires_at';
export const GOOGLE_SCOPE_KEY = 'aio.gdrive.scope';
export const GOOGLE_TOKEN_TYPE_KEY = 'aio.gdrive.token_type';

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp in ms
  scope: string;
  tokenType: string;
}

export interface GoogleIdentityTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GoogleIdentityTokenClient {
  requestAccessToken(options: { prompt: 'consent' | 'select_account' }): void;
}

interface GoogleIdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: GoogleIdentityTokenResponse) => void;
      }): GoogleIdentityTokenClient;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

export async function requestGoogleIdentityToken(
  clientId: string,
  scope: string,
): Promise<GoogleTokens> {
  if (typeof window === 'undefined') {
    throw new Error('Google browser sign-in is available only on the web.');
  }
  if (!window.google?.accounts.oauth2) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.getElementById('google-identity-services');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Could not load Google sign-in.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = 'google-identity-services';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(script);
    });
  }

  if (!window.google?.accounts.oauth2) {
    throw new Error('Google sign-in is unavailable in this browser.');
  }

  return new Promise<GoogleTokens>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error_description || response.error || 'Google browser sign-in failed.'));
          return;
        }
        const expiresInSeconds = typeof response.expires_in === 'number' ? response.expires_in : 3600;
        resolve({
          accessToken: response.access_token,
          expiresAt: Date.now() + expiresInSeconds * 1000,
          scope: response.scope || scope,
          tokenType: response.token_type || 'Bearer',
        });
      },
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

export class AuthRefreshError extends Error {
  readonly isPermanent: boolean;
  readonly code?: string;

  constructor(message: string, isPermanent: boolean, code?: string) {
    super(message);
    this.name = 'AuthRefreshError';
    this.isPermanent = isPermanent;
    this.code = code;
  }
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export type FetchFunction = (url: string, init?: RequestInit) => Promise<Response>;

function toBase64Url(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Generates a cryptographically secure PKCE code verifier and S256 challenge. */
export function generatePkcePair(random = systemRandom): PkcePair {
  const bytes = random.bytes(32);
  const verifier = toBase64Url(bytes);
  const challengeHash = sha256(utf8Encode(verifier));
  const challenge = toBase64Url(challengeHash);
  return { verifier, challenge };
}

/** Generates an unpredictable OAuth state value for callback validation. */
export function generateOAuthState(random = systemRandom): string {
  return toBase64Url(random.bytes(32));
}

/** Parses and validates the authorization response returned by Google. */
export function parseAuthorizationCallback(url: string, expectedState: string): { code: string } {
  const callback = new URL(url);
  return parseAuthorizationParameters(
    {
      state: callback.searchParams.get('state') ?? '',
      error: callback.searchParams.get('error') ?? '',
      error_description: callback.searchParams.get('error_description') ?? '',
      code: callback.searchParams.get('code') ?? '',
    },
    expectedState,
  );
}

/** Parses and validates OAuth parameters returned by an AuthSession request. */
export function parseAuthorizationParameters(
  params: Record<string, string>,
  expectedState: string,
): { code: string } {
  const returnedState = params.state;
  if (returnedState !== expectedState) {
    throw new Error('Google authorization response failed state validation.');
  }

  const error = params.error;
  if (error) {
    const description = params.error_description;
    throw new Error(description ? `Google authorization failed: ${description}` : `Google authorization failed: ${error}.`);
  }

  const code = params.code;
  if (!code) {
    throw new Error('Google authorization did not return an authorization code.');
  }
  return { code };
}

/** Builds the Google OAuth 2.0 authorization URL. */
export function buildAuthorizationUrl(
  config: DriveConfig = getDriveConfig(),
  challenge: string,
  state: string,
): string {
  if (!isDriveConfigured(config)) {
    throw new Error('Google Drive integration is not configured. Missing Client ID.');
  }

  const scopes = getEffectiveScopes(config).join(' ');
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline', // Requests a refresh token
    prompt: 'consent', // needed to get a refresh token
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Retrieves stored Google tokens from individual secure vault keys. */
export async function getStoredTokens(vault: Vault = secureVault): Promise<GoogleTokens | null> {
  try {
    const accessToken = await vault.get(GOOGLE_ACCESS_TOKEN_KEY);
    const expiresAtRaw = await vault.get(GOOGLE_EXPIRES_AT_KEY);
    if (accessToken && expiresAtRaw) {
      const refreshToken = (await vault.get(GOOGLE_REFRESH_TOKEN_KEY)) || undefined;
      const scope = (await vault.get(GOOGLE_SCOPE_KEY)) || '';
      const tokenType = (await vault.get(GOOGLE_TOKEN_TYPE_KEY)) || 'Bearer';
      return {
        accessToken,
        refreshToken,
        expiresAt: parseInt(expiresAtRaw, 10),
        scope,
        tokenType,
      };
    }

    // Legacy fallback check
    const raw = await vault.get(GOOGLE_TOKENS_VAULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.accessToken === 'string' && typeof parsed?.expiresAt === 'number') {
      return parsed as GoogleTokens;
    }
  } catch {
    // Return null on corrupt or missing tokens
  }
  return null;
}

/** Persists Google tokens across individual keys with WHEN_UNLOCKED_THIS_DEVICE_ONLY. */
export async function saveTokens(tokens: GoogleTokens, vault: Vault = secureVault): Promise<void> {
  const options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  await vault.set(GOOGLE_ACCESS_TOKEN_KEY, tokens.accessToken, options);
  if (tokens.refreshToken) {
    await vault.set(GOOGLE_REFRESH_TOKEN_KEY, tokens.refreshToken, options);
  } else {
    try {
      await vault.remove(GOOGLE_REFRESH_TOKEN_KEY);
    } catch {
      // Ignore
    }
  }
  await vault.set(GOOGLE_EXPIRES_AT_KEY, String(tokens.expiresAt), options);
  await vault.set(GOOGLE_SCOPE_KEY, tokens.scope || '', options);
  await vault.set(GOOGLE_TOKEN_TYPE_KEY, tokens.tokenType || 'Bearer', options);
}

/** Purges stored Google tokens from all individual vault keys. */
export async function clearTokens(vault: Vault = secureVault): Promise<void> {
  const keys = [
    GOOGLE_ACCESS_TOKEN_KEY,
    GOOGLE_REFRESH_TOKEN_KEY,
    GOOGLE_EXPIRES_AT_KEY,
    GOOGLE_SCOPE_KEY,
    GOOGLE_TOKEN_TYPE_KEY,
    GOOGLE_TOKENS_VAULT_KEY,
  ];
  for (const k of keys) {
    try {
      await vault.remove(k);
    } catch {
      // Ignore removal error if vault key is absent
    }
  }
}

/** Exchanges an OAuth authorization code for access and refresh tokens. */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  config: DriveConfig = getDriveConfig(),
  fetchFn: FetchFunction = fetch,
): Promise<GoogleTokens> {
  if (!isDriveConfigured(config)) {
    throw new Error('Google Drive integration is not configured. Missing Client ID.');
  }

  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let detail = '';
    try {
      const body = JSON.parse(errorText);
      detail = typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : '';
    } catch {
      detail = '';
    }
    throw new Error(
      `Google token exchange failed: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`,
    );
  }

  const data = await response.json();
  const expiresInSeconds = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    scope: data.scope || '',
    tokenType: data.token_type || 'Bearer',
  };
}

/** Refreshes an expired access token using the stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  config: DriveConfig = getDriveConfig(),
  fetchFn: FetchFunction = fetch,
): Promise<GoogleTokens> {
  if (!isDriveConfigured(config)) {
    throw new Error('Google Drive integration is not configured. Missing Client ID.');
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AuthRefreshError(
      err instanceof Error ? err.message : 'Network error connecting to Google token endpoint',
      false,
      'network_error',
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let errorCode: string | undefined;
    try {
      const errJson = JSON.parse(errorText);
      errorCode = errJson.error;
    } catch {
      // ignore json parse error
    }

    const isPermanent =
      errorCode === 'invalid_grant' ||
      errorCode === 'unauthorized_client' ||
      errorCode === 'invalid_client' ||
      response.status === 400 ||
      response.status === 401;

    throw new AuthRefreshError(
      `Failed to refresh Google token: HTTP ${response.status} ${errorText}`,
      isPermanent,
      errorCode,
    );
  }

  const data = await response.json();
  const expiresInSeconds = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // Google might not reissue refresh_token
    expiresAt: Date.now() + expiresInSeconds * 1000,
    scope: data.scope || '',
    tokenType: data.token_type || 'Bearer',
  };
}

/** Revokes an access or refresh token with Google's revocation endpoint. */
export async function revokeToken(
  token: string,
  fetchFn: FetchFunction = fetch,
): Promise<boolean> {
  try {
    const body = new URLSearchParams({ token });
    const response = await fetchFn('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Returns an access token that is still valid, refreshing it if it expires within 60 s.
 * Returns null, and clears the tokens, once the refresh token is no longer accepted.
 */
export async function getValidAccessToken(
  vault: Vault = secureVault,
  config: DriveConfig = getDriveConfig(),
  fetchFn: FetchFunction = fetch,
): Promise<string | null> {
  const tokens = await getStoredTokens(vault);
  if (!tokens) return null;

  const now = Date.now();
  // Valid if more than 60 seconds remain
  if (tokens.expiresAt > now + 60_000) {
    return tokens.accessToken;
  }

  // Needs refresh
  if (!tokens.refreshToken) {
    await clearTokens(vault);
    return null;
  }

  try {
    const refreshed = await refreshAccessToken(tokens.refreshToken, config, fetchFn);
    await saveTokens(refreshed, vault);
    return refreshed.accessToken;
  } catch (err) {
    // Only wipe tokens on permanent auth failure (invalid_grant, etc.).
    // Being offline (TypeError, network_error) must not wipe the stored tokens.
    if (err instanceof AuthRefreshError && err.isPermanent) {
      await clearTokens(vault);
    }
    return null;
  }
}

/** Signs out by revoking tokens and wiping them from the vault. */
export async function signOutGoogle(
  vault: Vault = secureVault,
  fetchFn: FetchFunction = fetch,
): Promise<void> {
  const tokens = await getStoredTokens(vault);
  if (tokens) {
    if (tokens.refreshToken) await revokeToken(tokens.refreshToken, fetchFn);
    else if (tokens.accessToken) await revokeToken(tokens.accessToken, fetchFn);
  }
  await clearTokens(vault);
}
