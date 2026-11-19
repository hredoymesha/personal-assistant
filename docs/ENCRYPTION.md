# Encrypted backups

A backup file is encrypted with AES-256-GCM. The key comes from your passphrase through scrypt (N = 32768, r = 8, p = 1) with a fresh random salt for every file, so two backups made with the same passphrase still use different keys. The file header (format, KDF settings, schema version) is authenticated too, so editing any of it makes the file fail to open.

The passphrase is the only way in. The app never stores it and nobody can recover it. Keep it somewhere other than the backup file itself.

The code is in `src/crypto/backup.ts`. It uses the `@noble/hashes` and `@noble/ciphers` libraries; nothing is home-made.

## What happens on restore

1. The file is read and its header checked. Settings that would take unreasonable time or memory are refused before any work starts.
2. You enter the passphrase.
3. The data is decrypted, upgraded to the current schema if it's older, and validated.
4. You see a summary of what's inside.
5. Nothing changes until you type REPLACE and confirm. Right after, you can still undo.

A wrong passphrase or a damaged file stops at step 3 and leaves your data as it was. The app can't tell which of the two it was, so it says so instead of guessing.

## Plain exports

JSON and CSV exports are plain text. Anyone who gets the file can read it. Use an encrypted backup when that matters.

## What isn't encrypted

- The working data inside the app: on a phone it's in the app's private storage, in a browser it's in localStorage. The app doesn't add its own encryption there.
- Plain-text exports, as above.

## Not tested yet

- How long scrypt takes on a range of phones. It's usually 5 to 30 seconds, but that's from a small sample.
- Sharing and picking backup files on many different Android phones.
