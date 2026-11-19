# Release readiness, version 1.0.0

1.0.0 isn't released. This page tracks what has actually been checked and how. A gate only closes with evidence of its own kind: a passing unit test doesn't prove a phone works, and a browser run doesn't prove a native share sheet works.

Status words: PASS, PARTIAL, FAIL, BLOCKED (can't run yet), NOT RUN.

Last updated: 2026-11-18.

## Fixed identity

- App name: Personal Assistant
- Android package and iOS bundle ID: `com.assistant.personal`
- Version: 1.0.0
- Order: Android first, iOS later

Storage keys and the encrypted backup format still use the older internal `aio` / `ai-o` names. That's on purpose, so existing data and backups keep loading.

## Evidence by kind

| Kind | Status | What it covers |
| --- | --- | --- |
| Source review | PARTIAL | Money is integer minor units, currencies are never mixed, Drive uses the `drive.file` scope only, no client secret or keystore is in the tree, `allowBackup` is false. Not every file has had a line-by-line review. |
| Unit tests | PASS | 40 suites, 621 tests (Jest), plus typecheck, lint and Expo Doctor 20/20. |
| Browser | PARTIAL | The web export loads and the main screens were clicked through at widths from 320 to 1280 px with sample data. Browser Google sign-in reached "Connected". Drive upload and restore were not run. |
| Android, real phone | PARTIAL | Preview APK 1.0.0 (build 1) installed on one Android phone and partly tested on 2026-11-19. Found and fixed: XLSX/PDF export failing on sheet names with ":", calendar layout in the date filter, a squeezed Record button, the toast covering the tab bar. Needs a rebuild and a full pass. |
| iPhone, real phone | NOT RUN | Only Expo Go previews so far, which don't count. |
| Offline | PARTIAL | Reloading the web app offline fails (no service worker). Opening the phone app offline hasn't been tried. |
| Production build | PARTIAL | One EAS preview APK (internal distribution) built 2026-11-18. No production AAB yet. |
| Store submission | NOT RUN | No Play Console or App Store Connect listing. |

## Before a test APK goes on GitHub Releases

- [ ] Preview APK built with EAS, keystore kept on EAS
- [ ] Phone checklist in APK_GUIDE.md passes on at least one Android phone
- [ ] Anything found is fixed and the APK rebuilt
- [ ] Release notes list version, Android 7.0+ requirement, SHA-256 and known limits

## Before Google Play

- [ ] Signed AAB from the `production` profile
- [ ] Privacy policy at a public URL
- [ ] Data safety form, content rating, target audience
- [ ] Store icon, screenshots and description
- [ ] Internal testing track, with tester feedback reviewed
- [ ] Target API level matches Google's current rule

## Before iOS

- [ ] Apple developer account and signing
- [ ] Export compliance answered. The app uses its own AES-256-GCM for backups, so this needs a real answer, not a guess.
- [ ] App Privacy answers
- [ ] TestFlight on a real iPhone

## Open items

- Spreadsheet import uses SheetJS `xlsx` 0.20.3 from the SheetJS CDN, because the fixed versions are not published on npm. The lockfile pins its integrity hash.
- `npm audit --omit=dev` lists more findings in Expo and React Native build-time dependencies. npm's suggested fix is a downgrade, which isn't usable.
- Google Drive on Android and iOS needs its own OAuth clients and hasn't been tried.
- Long lists aren't virtualized and slow down above roughly 10,000 records.
