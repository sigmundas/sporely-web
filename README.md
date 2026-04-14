# Sporely Web

Sporely Web is the mobile companion of Sporely.

It is a small field-friendly app for capturing observations, importing photos from your phone, running Artsorakel lookups, keeping GPS and photo metadata together, and syncing everything to the  Sporely cloud.

It is built as a web app that works on any platform: Just go to [app.sporely.no](https://app.sporely.no) and install it on iOS or Android as a web app. It is also availabe as an Android app that allows importing photos from your Android phone with GPS coordinates. GPS coordinates are stripped when using the web app, but you can still use the app's camera and record coordinates at the time of shooting. 

## How it works with the desktop app

Sporely currently has two apps that work well together:

- `sporely-web` is the lightweight field app. It is for taking or importing photos, sorting out observation groups, doing quick ID lookups, and getting observations into the cloud from your phone.
- `sporely-py` is the desktop app. It is where the deeper work happens: microscopy, calibration, measurements, spore reference data, and more detailed editing.

The basic idea is simple:

- use `sporely-web` when you are out in the field, or when your photos are already on your phone
- use `sporely-py` when you are back at your desk and want the full observation workflow

You can use the desktop app without logging in to the Sporely cloud, if you just want to do offline microscopy work. If you also want to geotag and upload your observations to Artsdatabasen.no or Artportalen.se, it really helps if you use the web app, instead of downloading your photos to your desktop and importing them manually. 

## What The Web App Does

At the moment, `sporely-web` is mainly focused on:

- taking field photos that uploads to Sporely cloud
- importing photos from the mobile device into the Sporely cloud
- grouping imported photos into observations based on capture time
- running Artsorakel suggestions in the active UI language where supported
- storing location and photo metadata
- syncing observations to the shared Supabase-backed backend
- browsing observations, map views, comments, and social features

It is intentionally fairly direct. You take or import photos, review the observation, make a few decisions, and queue or save it.

## Repo Pointers

If you want a bit more context without diving straight into the code:

- database and policy notes: [SUPABASE_DB.md](SUPABASE_DB.md)
- app/code structure: [ARCHITECTURE.md](ARCHITECTURE.md)

## Local Development

Use Node 22 or newer for this repo.

The current Capacitor and Vite setup expects a modern Node runtime, and the project already checks this during build and dev commands.

### Quick Start

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

The app ships with working production defaults for the current Supabase project and Turnstile site key, but `.env.local` is still a good place for local overrides.

## Android

The Android wrapper lives in [`android/`](android/).

Typical build flow:

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

If you want Capacitor to open the Android project in Android Studio:

```bash
npx cap open android
```

If you change Capacitor plugins or plugin configuration, run:

```bash
npx cap sync android
```

## Environment Variables

Client-side Vite variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_TURNSTILE_SITE_KEY`

Server-side / Supabase function secrets are not read from Vite env files. Set them in Supabase instead when serving or deploying the `delete-account` function:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Stack

- Vite 6
- Vanilla JS modules
- Supabase JS v2
- Capacitor Android
- `@capawesome/capacitor-file-picker`

## Translations

The UI currently supports:

- English
- Norwegian
- Swedish
- German

Taxon search and Artsorakel requests follow the active UI locale where the underlying source supports that language.
