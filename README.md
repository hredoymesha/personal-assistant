# Personal Assistant

A local-first app for the everyday admin of running a household or a shared mess: tasks, expenses, savings goals, debts, wallets, monthly bills and meal splits. It runs on Android, iPhone (through Expo Go for now) and in the browser.

Your records stay on the device. There's no account, no server, no ads and no analytics. You can type commands in English, বাংলা or Banglish ("120 taka transport kal"), and nothing is saved until you confirm it.

> Status: testing / development preview. Version 1.0.0 is not released yet. See [docs/RELEASE_READINESS_CHECKLIST.md](docs/RELEASE_READINESS_CHECKLIST.md) for what has and hasn't been tested.

## What's in it

- **Home**: today's tasks, a month summary, and an Emergency SOS panel that can call 999 or share your location when you tap it.
- **Tasks**: due dates, times, priorities, repeating tasks, search and undo.
- **Money**: expenses with receipts, savings goals, debts paid oldest first, wallets with transfers, and mess groups that split meals and shared costs.
- **Cycle**: monthly bills and income, partial payments, month overview, month locking, and a Daily Expense Sheet with custom columns and CSV, XLSX and PDF export.
- **Settings**: theme, currency, sample data, Trash, contacts refresh, passphrase-encrypted backups, and optional Google Drive backup.

Money is stored as whole minor units (poisha, cents), so totals are exact. Amounts in different currencies are never added together.

## Run it

You need Node.js 20 or newer and npm.

```bash
npm install
npx expo start
```

Scan the QR code with Expo Go on Android, or with the Camera app on iPhone. Your phone and computer need to be on the same Wi-Fi. If the old version keeps showing, start with `npx expo start -c`.

For the browser:

```bash
npx expo start --web
```

On Home, tap Load sample data to look around with made-up records. Settings > Remove sample data takes them out again without touching your own entries.

Data in the browser and data on your phone are separate. To move between them, create an encrypted backup on one and restore it on the other.

## Android APK

There's no APK in this repository. Test builds, when they exist, are attached to [GitHub Releases](../../releases) with a SHA-256 checksum. To build your own, see [docs/APK_GUIDE.md](docs/APK_GUIDE.md).

## Google Drive backup

Optional and off until you set it up. You need your own Google Cloud project and an OAuth client for each platform, and the IDs go in `.env.local`, not in the code. Steps: [docs/GOOGLE_DRIVE_SETUP.md](docs/GOOGLE_DRIVE_SETUP.md).

So far Drive sign-in has only been checked in a browser, and upload and restore through Drive still need a full test. In the Android app, Drive sign-in is still being built; until then, create an encrypted backup and pick Drive in the share menu.

## Privacy, briefly

- Local working data is not encrypted by the app. On a phone it sits in the app's private storage; in a browser it sits in localStorage.
- Encrypted backups use AES-256-GCM with a key derived from your passphrase (scrypt). If you lose the passphrase, the backup can't be opened. Nobody can reset it.
- Plain JSON and CSV exports are readable by anyone who gets the file.
- Contacts are read only when you tap Refresh contacts. Location is read only when you tap Share current location.

Full text: [public/privacy-policy.html](public/privacy-policy.html).

## Checks

```bash
npm run typecheck
npm run lint
npm test
npx expo-doctor
npx expo export --platform web --output-dir dist
```

GitHub Actions runs the first three plus the web export on every push and pull request.

## Web preview hosting

`.github/workflows/pages.yml` publishes the web build to GitHub Pages with a "testing preview" strip at the top. Custom domain and Cloudflare notes are in [docs/GITHUB_PAGES_SETUP.md](docs/GITHUB_PAGES_SETUP.md).

## Known limits

- Lists aren't virtualized, so very large data sets (over about 10,000 records) get slow on screen.
- Backups and imports are capped at 5 million characters.
- Reloading the web app while offline doesn't work yet.
- The UI text is English only. The command box understands Bangla.

More detail is in [SECURITY.md](SECURITY.md) and the docs folder.

## License

MIT. See [LICENSE](LICENSE).
