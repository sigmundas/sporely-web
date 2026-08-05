# Cloudflare Turnstile — rollout and verification

Turnstile protects the Supabase Auth endpoints that support `captchaToken`:

- email/password **signup** (`supabase.auth.signUp`)
- email/password **sign-in** (`supabase.auth.signInWithPassword`)
- password-reset email (`supabase.auth.resetPasswordForEmail`)

Google social login (`signInWithIdToken` on Android, `signInWithOAuth` on
web) is **not** Turnstile-protected. The installed `@supabase/auth-js`
does not accept `captchaToken` on `signInWithIdToken`. Any Cloudflare
Turnstile setting flipped in Supabase must be verified against Google
sign-in as a mandatory regression test — see the checklist below.

## Manual rollout order

Do **not** flip Supabase's Bot Protection toggle before both platforms
have been physically verified to generate tokens.

### 1. Cloudflare (Turnstile)

1. Cloudflare Dashboard → Turnstile → Add site.
2. Name: `Sporely Auth`.
3. Widget mode: **Managed**.
4. Hostname: `app.sporely.no` (only — do not add localhost,
   capacitor://, or Android package names; Turnstile hostname config is
   domain-based, and the Android app loads the widget from
   `https://app.sporely.no/auth/turnstile-mobile`).
5. Copy the **site key** and **secret**. The secret goes into Supabase
   in step 4. The site key goes into the deployment env var in step 2.

### 2. Deployment

1. Set `VITE_TURNSTILE_SITE_KEY=<site key>` in the Cloudflare Pages
   project environment (Production + Preview).
2. Deploy the web app. Confirm
   `https://app.sporely.no/auth/turnstile-mobile` loads and shows the
   widget when opened directly in a browser (it will report "No parent
   handshake received." after 5 s — that is expected outside the iframe).
3. Build and release the Android app with the new bundle
   (`npm run android:build:release`).

### 3. Physical verification (before enabling Supabase)

Use a physical device. Local Cloudflare test keys will not work against
production Supabase.

- Web (`https://app.sporely.no`)
  - Signup — Turnstile widget appears; a solved challenge produces a
    `captchaToken` (verifiable in the Turnstile dashboard as a solve).
  - Password sign-in — same.
  - Password recovery — same.
- Android
  - Signup — an in-app overlay opens
    `https://app.sporely.no/auth/turnstile-mobile`, the widget solves,
    the overlay closes, signup proceeds.
  - Password sign-in — same.
  - Password recovery — same.
  - Android **Back** during the challenge closes the overlay and leaves
    the auth form usable.
  - Expired challenge — solve, wait, retry: widget resets and a new
    token can be obtained.
  - Offline mid-challenge — challenge fails closed with a visible
    error; going back online and retrying succeeds.
  - Google native login (`signInWithIdToken`) still works unchanged.

Only after every item above passes: continue to step 4.

### 4. Supabase (Bot and Abuse Protection)

1. Supabase Dashboard → Authentication → Bot and Abuse Protection.
2. Provider: **Cloudflare Turnstile**.
3. Paste the Turnstile secret from step 1.
4. Save.

### 5. Post-enable verification

- Send a raw signup without `captcha_token`:
  ```
  curl -X POST https://<project>.supabase.co/auth/v1/signup \
    -H 'apikey: <anon key>' -H 'Content-Type: application/json' \
    -d '{"email":"test@example.com","password":"correct-horse-battery-9!"}'
  ```
  Supabase must reject with a captcha error.
- Re-run the physical device checklist. **In particular, re-verify
  Google native login** — the SDK not accepting `captchaToken` on
  `signInWithIdToken` does not by itself prove Supabase's server gate
  ignores that route.

## Reversibility

To disable, un-toggle Bot Protection in the Supabase dashboard. The
client keeps sending `captchaToken`; Supabase will simply ignore it.

## Local development

`VITE_TURNSTILE_SITE_KEY` is optional in dev builds. When unset, the
manager uses Cloudflare's official test site key
`1x00000000000000000000AA`, which always passes. Production builds
**fail** if the env var is missing (see `vite.config.js`).

## Files of interest

- `src/turnstile.js` — token manager (single-use, fail-closed).
- `src/screens/auth-turnstile-mobile.js` — Android iframe overlay bridge.
- `auth/turnstile-mobile.html` + `auth/turnstile-mobile.js` — hosted
  helper page loaded by Android as an iframe over `app.sporely.no`.
- `public/_headers` — route-scoped CSP for `/auth/turnstile-mobile`.
- `src/screens/auth.js` — Supabase auth wiring.
- `src/turnstile.test.js`, `src/turnstile.regression.test.js`,
  `src/screens/auth-turnstile-mobile.test.js` — tests.
