import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from './store';

/**
 * Native: app-sandboxed storage managed by AsyncStorage. Not encrypted by this app.
 * Web: localStorage for this origin. Not encrypted, and separate from the phone's data.
 */
export const asyncStorageStore: KeyValueStore = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
  getAllKeys: () => AsyncStorage.getAllKeys(),
};
