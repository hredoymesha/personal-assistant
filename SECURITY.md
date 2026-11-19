# Security

## Reporting a problem

If you find a security issue, please don't open a public issue. Use GitHub's private vulnerability reporting on this repository (Security > Report a vulnerability) and include the steps to reproduce it.

## What never goes in this repository

- OAuth client secrets or Google service-account files
- Android keystores, Apple signing keys or their passwords
- EAS, App Store or Play Console API keys
- `.env` files with anything private in them
- Real exported data or backup passphrases

Google OAuth client IDs are public by design, but this repo still leaves them out: each build reads them from `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID`. See docs/GOOGLE_DRIVE_SETUP.md.

## How data is handled

- Everything is stored locally. There is no server, account, analytics or ads SDK.
- The app's working data isn't encrypted by the app itself. Encrypted backups are; see docs/ENCRYPTION.md.
- Google Drive uses only the `drive.file` scope, so the app can see the files it created and nothing else in your Drive. Sign-in tokens are kept in the phone's secure storage, or in the browser tab's session storage on the web.
- Automatic Drive backup is off by default and hasn't been tested on a phone yet.
- Contacts and location are read only when you tap the button that needs them.

## Dependencies

`npm audit` reports advisories in Expo and React Native build tooling. Spreadsheet import uses SheetJS `xlsx` 0.20.3 from the SheetJS CDN because the fixed versions aren't published on npm; the lockfile pins its integrity hash.
