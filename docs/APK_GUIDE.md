# Building the Android APK

An APK is for testing and direct installs. Google Play takes an Android App Bundle (AAB) instead, built with the `production` profile.

Builds run on Expo's EAS service. You need a free Expo account; the free plan includes a limited number of cloud builds each month. Nothing here needs Android Studio on your computer.

## Which profile

| Profile | Output | Use it for |
| --- | --- | --- |
| `preview` | standalone APK | the test APK you install on phones and attach to a GitHub Release |
| `development` | dev-client APK | debugging with a running Metro server; needs `expo-dev-client`, which isn't installed yet |
| `production` | AAB | Google Play |

For a tester build, use `preview`.

## Steps

1. Run the checks first:

   ```bash
   npm ci
   npm run typecheck
   npm run lint
   npm test
   npx expo-doctor
   ```

2. Log in and link the project. The first time, EAS asks to create the project and writes its ID into `app.json`:

   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```

3. Optional, for Google Drive: add `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` as an EAS environment variable for the preview environment. See GOOGLE_DRIVE_SETUP.md.

4. Build:

   ```bash
   npx eas-cli@latest build --platform android --profile preview
   ```

   On the first build, let EAS generate the Android keystore and keep it on EAS. Don't download it into the project folder, and never commit it. Losing it means future updates can't install over the old app.

5. When the build finishes, EAS shows a download link and a QR code.

## Test on a real phone

Install it and go through this list on at least one Android phone. Note the phone model and Android version.

- The app opens, all five tabs work, the back gesture behaves
- Add, edit, delete and restore from Trash: a task, an expense, a wallet entry, a bill payment
- The keyboard doesn't cover the field you're typing in
- Create an encrypted backup, share it, then verify and restore it
- CSV, XLSX and PDF export from the Daily Expense Sheet open in another app
- Import a CSV through the file picker
- Contacts: permission prompt, then Refresh contacts
- SOS: the call button opens the dialer (don't place the call), Share current location asks for permission
- Close the app fully and open it again with Wi-Fi off: your data is still there
- Google Drive, only if you set up an Android client

Anything that fails goes back into the code before the APK is shared.

## Publishing a test APK on GitHub

Attach the APK to a GitHub Release. Don't commit it to the repository.

Get the checksum on Windows:

```powershell
Get-FileHash .\personal-assistant-1.0.0-preview.apk -Algorithm SHA256
```

or on macOS and Linux:

```bash
shasum -a 256 personal-assistant-1.0.0-preview.apk
```

Release notes should say:

- version and build number
- minimum Android version (Expo SDK 58 needs Android 7.0, API 24, or newer)
- the SHA-256 checksum
- that it's a test build, plus the known limits from the README
- a link to the privacy policy

The link `https://github.com/<user>/<repo>/releases/latest/download/<file>.apk` always points at the newest release, as long as the file name stays the same. That's handy for the preview page.

## Google Play

```bash
npx eas-cli@latest build --platform android --profile production
```

Submit only after the privacy policy is online, the Data safety form is filled in, and the phone tests above pass. New apps and updates have to target the API level Google currently requires, so check that again at submission time.
