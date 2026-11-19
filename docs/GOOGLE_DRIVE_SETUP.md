# Google Drive backup setup

Google Drive backup is optional. Everything else in the app, including encrypted backup files you save yourself, works without it.

If you run this repository as it is, the Drive panel in Settings says it isn't set up and the app makes no Google calls. To turn it on you need your own Google Cloud project and an OAuth client for each platform you build.

## Why the client ID isn't in the source

A Google OAuth client ID is not a secret. It ships inside every web page and app that uses it. It's still left out of this repository, for two reasons:

- A client ID only works from the web origins and Android signatures registered in the Google project that owns it. Mine would fail on your localhost or your own domain.
- Sign-ins through someone else's client count against their project, and while the consent screen is in testing mode only their listed test users can sign in.

So each build reads its IDs from environment variables instead. Never put a client secret, service-account JSON or private key in this repository. The app doesn't need any of them.

## 1. Create the Google project

1. Open Google Cloud Console and create a project.
2. Enable the Google Drive API.
3. Set up the OAuth consent screen (Google Auth Platform). Add the app name, a support email and your privacy policy URL.
4. Under Data access, add only `https://www.googleapis.com/auth/drive.file`. With this scope the app sees the files it created and nothing else in the user's Drive.
5. Leave the app in Testing and add your own Google account as a test user.

## 2. Web client

1. Create an OAuth client of type Web application.
2. Under Authorized JavaScript origins add every origin you will open the app from, exactly, with no path and no trailing slash. For example:
   - `http://localhost:8081` for `npx expo start --web`
   - `https://assistant.example.com` for a hosted preview
3. Copy the client ID.
4. Copy `.env.example` to `.env.local` (git ignores it) and fill in:

```
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
```

5. Restart Expo with `npx expo start --web -c` so the value is picked up.

For the GitHub Pages workflow, save the same ID as a repository variable named `GOOGLE_WEB_CLIENT_ID` (Settings > Secrets and variables > Actions > Variables).

Test it in this order: sign in, back up once, check the file appears in the list, download it, then verify and restore it into test data.

## 3. Android client

1. Get the SHA-1 fingerprint of the key that signs your APK. With EAS: `npx eas-cli@latest credentials -p android`.
2. Create an OAuth client of type Android with package name `com.assistant.personal` and that SHA-1.
3. Set `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` in `.env.local` for local builds, or as an EAS environment variable for cloud builds.

Android sign-in has not been tested yet. Google restricts custom URI scheme redirects on Android clients, so the redirect `personalassistant:/oauthredirect` may need the custom scheme option turned on for that client, or a different sign-in method. Expo Go can't test this; use a preview APK.

## 4. iOS client

Create an iOS client for bundle ID `com.assistant.personal` and set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. iOS has not been tested.

## Before calling it done

Drive backup counts as working on a platform only after sign-in, upload, list, download and restore all pass on that platform. Automatic backup stays off by default.
