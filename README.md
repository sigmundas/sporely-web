# Sporely Web

Mobile-first PWA and Capacitor Android companion for the desktop Sporely app.
It handles field capture, gallery import, GPS-aware observations, social features,
and Supabase-backed sync.

For schema and policy context, see [SUPABASE_DB.md](SUPABASE_DB.md).
For code structure, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

- Vite 6
- Vanilla JS modules
- Supabase JS v2
- Capacitor Android
- `@capawesome/capacitor-file-picker`

## Local setup

Use Node 22 LTS for this repo. The current dependency set includes
`@capacitor/cli@8`, which declares `node >=22`, and Vite 6 also requires a
modern Node runtime.

```bash
cd /path/to/sporely-web
nvm install 22
nvm use 22
npm install
cp .env.example .env.local
npm run dev
```

The app currently ships working defaults for the production Supabase project and
Turnstile site key, but keeping them in `.env.local` makes local overrides and
future project moves simpler.

## Environment variables

Client-side Vite variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_TURNSTILE_SITE_KEY`

Server-side / Supabase function secrets are not read from Vite env files. Set
them in Supabase instead when serving or deploying the `delete-account` function:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Commands

```bash
npm run dev
npm run build
npm run preview
```

If Capacitor dependencies or plugins change:

```bash
npx cap sync android
```

## Android

Android wrapper files live under [`android/`](/home/as/myapps/sporely-web/android).
Typical flow:

```bash
npm run build
npx cap sync android
npx cap open android
```

## Translations

UI locale support is built into the web app settings for:

- English
- Norwegian Bokmal
- Swedish
- German

Taxon search and Artsorakel requests follow the active UI locale where the
underlying data source supports that language. On the map screen, autocomplete
is limited to taxa already present in the currently loaded observations so
filtering stays fast and observation-focused.
