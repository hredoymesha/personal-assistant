/**
 * Storage boundary. Everything above this file talks to KeyValueStore, so the
 * native and web backends (and any future encrypted or synced backend) are swappable.
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys?(): Promise<readonly string[]>;
}

export class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  async getItem(k: string) { return this.m.get(k) ?? null; }
  async setItem(k: string, v: string) { this.m.set(k, v); }
  async removeItem(k: string) { this.m.delete(k); }
  async getAllKeys(): Promise<readonly string[]> { return Array.from(this.m.keys()); }
}
