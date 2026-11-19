/**
 * Source of cryptographically secure random bytes, injected into the crypto code.
 * Production: services/random.ts (native CSPRNG via expo-crypto). Tests: Node's crypto.
 * Nothing in Personal Assistant may use Math.random for secrets.
 */
export interface RandomSource { bytes(length: number): Uint8Array }
