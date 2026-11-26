# Building the Android APK

Builds run on Expo's EAS service, which needs a free Expo account. Android Studio isn't required.

| Profile | Output | For |
| --- | --- | --- |
| `preview` | APK | installing on phones, GitHub Releases |
| `production` | AAB | Google Play |
| `development` | dev-client APK | debugging; needs `expo-dev-client`, which isn't installed |

## Build

```bash
npm ci
npm test
npx eas-cli@latest login
npx eas-cli@latest init      # first time only, links the EAS project
npx eas-cli@latest build --platform android --profile preview
```

On the first build EAS offers to create the Android signing key. Let it keep the key; don't download it into the project or commit it. Without the same key, later builds can't update an installed copy.

For Google Drive on Android, set `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` as an EAS environment variable (see GOOGLE_DRIVE_SETUP.md).

## Phone check before a release

- All five tabs open, back gesture works
- Add, edit, delete and restore from Trash
- The keyboard doesn't hide the field being typed in
- Encrypted backup: create, share, verify, restore
- Daily sheet: CSV, Excel and PDF export open in other apps; CSV and Excel import
- Contacts permission and refresh
- SOS: dialer opens (don't call), location permission prompt
- Data is still there after closing the app and reopening it offline

## Releasing

The release file is always named `personal-assistant-preview.apk`, so this link keeps pointing at the newest one:

https://github.com/hredoymesha/personal-assistant/releases/latest/download/personal-assistant-preview.apk

A pre-release doesn't count as "latest" on GitHub, so mark releases as normal ones. Put the SHA-256 checksum in the release notes:

```powershell
Get-FileHash .\personal-assistant-preview.apk -Algorithm SHA256
```

Android 7.0 (API 24) or newer is required.

## Google Play

```bash
npx eas-cli@latest build --platform android --profile production
```

Before submitting: privacy policy online, Data safety form filled in, phone check passed, and the target API level Google currently requires.
