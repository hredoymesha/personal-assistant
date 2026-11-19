import * as SecureStore from 'expo-secure-store';

/** The phone's secure key store (iOS Keychain / Android Keystore-backed storage). No web implementation exists. */
export interface Vault {
  isAvailable(): Promise<boolean>;
  set(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  get(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

export const secureVault: Vault = {
  isAvailable: async () => {
    if (typeof window !== 'undefined') {
      try {
        const key = '__aio_vault_check';
        window.sessionStorage.setItem(key, '1');
        window.sessionStorage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    }
    try {
      return await SecureStore.isAvailableAsync();
    } catch {
      return false;
    }
  },
  set: async (k, v) => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(k, v);
      return;
    }
    await SecureStore.setItemAsync(k, v);
  },
  get: async (k) => {
    if (typeof window !== 'undefined') {
      return window.sessionStorage.getItem(k);
    }
    return SecureStore.getItemAsync(k);
  },
  remove: async (k) => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(k);
      return;
    }
    await SecureStore.deleteItemAsync(k);
  },
};
