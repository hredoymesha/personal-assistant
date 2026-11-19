/**
 * Tiny, strict UTF-8 and base64 codecs. Written out (and tested against Node's own) so the crypto
 * path never depends on TextEncoder/TextDecoder/atob/btoa being present in the JS runtime (Hermes).
 */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate -> U+FFFD (same as TextEncoder)
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Strict: throws on malformed UTF-8 (overlong forms, surrogates, truncation) instead of guessing. */
export function utf8Decode(b: Uint8Array): string {
  const parts: string[] = [];
  let chunk: number[] = [];
  const flush = () => { parts.push(String.fromCharCode(...chunk)); chunk = []; };
  for (let i = 0; i < b.length; ) {
    const x = b[i];
    let cp: number, n: number, min: number;
    if (x < 0x80) { cp = x; n = 1; min = 0; }
    else if (x >= 0xc0 && x < 0xe0) { cp = x & 0x1f; n = 2; min = 0x80; }
    else if (x >= 0xe0 && x < 0xf0) { cp = x & 0x0f; n = 3; min = 0x800; }
    else if (x >= 0xf0 && x < 0xf8) { cp = x & 0x07; n = 4; min = 0x10000; }
    else throw new Error('Invalid UTF-8');
    if (i + n > b.length) throw new Error('Invalid UTF-8');
    for (let k = 1; k < n; k++) {
      if ((b[i + k] & 0xc0) !== 0x80) throw new Error('Invalid UTF-8');
      cp = (cp << 6) | (b[i + k] & 63);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new Error('Invalid UTF-8');
    if (cp >= 0x10000) { const v = cp - 0x10000; chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff)); }
    else chunk.push(cp);
    if (chunk.length > 4096) flush();
    i += n;
  }
  flush();
  return parts.join('');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;

export function base64Encode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < b.length ? ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? ALPHABET[n & 63] : '=';
  }
  return out;
}

/** Strict standard base64 with padding; returns null for anything else. */
export function base64Decode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (LOOKUP[s[i]] << 18) | (LOOKUP[s[i + 1]] << 12) | ((LOOKUP[s[i + 2]] ?? 0) << 6) | (LOOKUP[s[i + 3]] ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
