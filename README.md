# Personal Assistant

An app for the day-to-day admin of a household or a shared mess: tasks, expenses, savings goals, debts, wallets, monthly bills and meal splits. It runs on Android and in the browser.

Everything stays on the device. No account, no server, no ads, no analytics. You can type entries in English, বাংলা or Banglish ("120 taka transport kal") and check them before they're saved.

This is a testing preview of version 1.0.0. It isn't on Google Play yet.

- Try it in the browser: https://assistant.hredoymesha.com
- Android APK: [latest release](https://github.com/hredoymesha/personal-assistant/releases/latest)

## Features

- Home: today's tasks, a month summary, and an Emergency SOS panel that can call 999 or share your location when you tap it.
- Tasks: due dates, times, priorities, repeating tasks, search and undo.
- Money: expenses with receipts, savings goals, debts paid oldest first, wallets with transfers, and mess groups that split meals and shared costs.
- Cycle: monthly bills and income, partial payments, a month overview, month locking, and a daily expense sheet with custom columns and CSV, Excel and PDF export.
- Settings: theme, currency, sample data, Trash, contacts, passphrase-encrypted backups and optional Google Drive backup.

Money is stored in whole poisha or cents, so totals are exact, and amounts in different currencies are never added together.

## Running it

You need Node.js 20 or newer.

```bash
npm install
npx expo start
```

Scan the QR code with Expo Go. Phone and computer have to be on the same Wi-Fi. For the browser version run `npx expo start --web`.

Tap Load sample data on Home to look around with made-up records. Settings > Remove sample data takes them out again.

Phone and browser data are separate. To move data between them, make an encrypted backup on one and restore it on the other.

## Building the APK

The APK is built with Expo's EAS service; see [docs/APK_GUIDE.md](docs/APK_GUIDE.md). Release builds are attached to [GitHub Releases](https://github.com/hredoymesha/personal-assistant/releases) with their SHA-256 checksum.

## Google Drive backup

Optional, and off until set up with your own Google Cloud project; see [docs/GOOGLE_DRIVE_SETUP.md](docs/GOOGLE_DRIVE_SETUP.md). Once set up, it works in the browser. Sign-in from the Android app isn't finished yet, so on a phone, create an encrypted backup and save it to Drive from the share menu.

## Privacy

- The app doesn't encrypt its working data. On a phone it sits in the app's private storage; in a browser, in localStorage.
- Backups are encrypted with AES-256-GCM using a key derived from your passphrase. A lost passphrase can't be recovered.
- Plain JSON and CSV exports are readable by anyone who has the file.
- Contacts and location are only read when you tap the button that needs them.

More in [public/privacy-policy.html](public/privacy-policy.html), [docs/ENCRYPTION.md](docs/ENCRYPTION.md) and [SECURITY.md](SECURITY.md).

## Development

```bash
npm run typecheck
npm run lint
npm test
```

GitHub Actions runs these and a web export on every push. Pushes to `main` also publish the web version to GitHub Pages (`.github/workflows/pages.yml`).

## Known limits

- Tested on one Android phone so far, and not on iPhone.
- Reloading the web version while offline doesn't work.
- Long lists slow down past roughly 10,000 records.
- Backups and imports are capped at 5 million characters.
- The interface is in English; the command box also understands Bangla.

## License

MIT. See [LICENSE](LICENSE).
