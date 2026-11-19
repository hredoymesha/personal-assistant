# Contributing

Issues and pull requests are welcome. A few things keep the app what it is:

- It works without an account, a server, analytics or ads. Please open an issue before adding a paid service, analytics, remote AI or automatic cloud sync.
- Money is always whole minor units (poisha, cents), never floating point, and different currencies are never added together.
- The app never guesses a missing amount, currency, date or category. It asks.
- No `console.*` in `src` (lint enforces it), so nothing personal ends up in logs.

## Before a pull request

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx expo-doctor
```

Add a test for any bug you fix, one that fails without the fix.

Passing these checks doesn't prove a change works on a phone. If you touched sharing, file picking, permissions or layout, say which device you tried it on.

## Don't commit

Secrets, signing keys, `.env` files, real backups or real exported data. See SECURITY.md.
