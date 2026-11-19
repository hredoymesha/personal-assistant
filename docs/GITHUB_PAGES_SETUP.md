# Hosting the web preview

The web version is a static Expo export, so any static host can serve it. This repository ships a GitHub Actions workflow (`.github/workflows/pages.yml`) that builds it and publishes it to GitHub Pages on every push to `main`.

The hosted build always shows a strip at the top that reads "Testing / development preview. Not a final release." It comes from the `EXPO_PUBLIC_PREVIEW_LABEL` variable in the workflow. Local runs and the APK don't show it.

## What stays the same on the web

Tasks, money, Cycle, Daily Expense Sheet, Trash, sample data, import, export and encrypted backups all run in the browser. Data lives in that browser's localStorage, separate from any phone.

Some things are phone-only or behave differently: contacts, the SOS call button and location sharing, and native share sheets. Downloads replace sharing on the web. Reloading the page while offline won't work because there is no service worker.

## Turn on GitHub Pages

1. Make the repository public. Pages on a private repository needs a paid GitHub plan.
2. Settings > Pages > Build and deployment > Source: GitHub Actions.
3. Optional: add the variable `GOOGLE_WEB_CLIENT_ID` (see GOOGLE_DRIVE_SETUP.md). Without it the Drive panel says it isn't set up.
4. Push to `main` or run the "Web preview" workflow by hand from the Actions tab.

The workflow copies `index.html` to `404.html` so links like `/money` open the app instead of a GitHub 404 page, and adds `.nojekyll` so the `_expo` folder isn't dropped.

### Repository subpath

Without a custom domain the site lives at `https://<user>.github.io/<repo>/`. Expo then needs the base path. Add this to `app.json` under `expo`:

```json
"experiments": { "baseUrl": "/<repo>" }
```

A custom subdomain avoids that step, which is why I recommend it below.

## Custom subdomain with Cloudflare DNS

Cloudflare does not hand out free `.com` domains. It gives you free DNS for a domain you already own, plus a free `*.pages.dev` address if you use Cloudflare Pages. If your domain's DNS is already on Cloudflare, adding a subdomain costs nothing.

Example for `assistant.example.com`:

1. In GitHub: Settings > Pages > Custom domain, enter `assistant.example.com` and save.
2. In Cloudflare: DNS > Records > Add record.
   - Type `CNAME`, name `assistant`, target `<user>.github.io`
   - Proxy status: DNS only (grey cloud). GitHub has to see the request directly to issue the HTTPS certificate.
3. Wait for GitHub to show the DNS check as passed, then tick Enforce HTTPS.
4. Add `https://assistant.example.com` to the Web OAuth client's Authorized JavaScript origins.

Your main site and its other records are not touched.

Once HTTPS works you can switch the record to Proxied if you want Cloudflare in front. If you do, set SSL/TLS mode to Full, never Flexible, or you will get a redirect loop.

## Cloudflare Pages instead

Also fine, and it serves the same build:

- Build command: `npx expo export --platform web --output-dir dist`
- Output directory: `dist`
- Environment variables: `EXPO_PUBLIC_PREVIEW_LABEL` and, if wanted, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`

Cloudflare Pages falls back to `index.html` for unknown paths when there's no `404.html`, so no extra routing setup is needed.

## The preview landing page

`public/preview.html` is exported as `/preview.html`. It's a plain page that labels the project as a testing preview and links to the web app, the latest APK release, the source and the privacy policy. Edit the three links at the top of the file before publishing.

## Checking it's live

A setup only counts as done after the address loads over HTTPS, `/money` opens directly, and the preview strip is visible.
