import { getRandomBytes } from 'expo-crypto';
import type { RandomSource } from '../crypto/random';

/** Native/web CSPRNG from expo-crypto (OS secure random on phones; crypto.getRandomValues in browsers). */
export const systemRandom: RandomSource = {
  bytes(length: number): Uint8Array {
    const b = getRandomBytes(length);
    if (!(b instanceof Uint8Array) || b.length !== length) throw new Error('Secure random generator failed.');
    return b;
  },
};
