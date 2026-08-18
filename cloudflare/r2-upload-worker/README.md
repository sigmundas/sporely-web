# Sporely R2 Upload Worker

Cloudflare Worker for authenticated media uploads to the `sporely-media` R2 bucket.

## What It Does

- Accepts authenticated `GET`, `PUT`, and `DELETE` requests at `/upload/{key}`.
- Accepts authenticated `POST /artsorakel` and `POST /artsorakel/media` requests that forward image identification to Artsdatabanken's Artsorakel `/identify` API. The Worker attaches the server-side `ARTSORAKEL_API_TOKEN` bearer credential so browsers never see it.
- Validates the caller's Supabase JWT before writing to R2.
- Enforces that the object key starts with the authenticated user's `sub`, for example:
  - `user_uuid/observation_uuid/field_001.jpg`
  - `user_uuid/observation_uuid/thumb_field_001.jpg`
- Returns the stored key and optional public URL.
- Tracks successful upload/delete byte deltas in `public.profiles`.
- Enforces free-tier storage limits when `storage_quota_bytes` or `FREE_STORAGE_QUOTA_BYTES` is set.

## Expected Bindings and Vars

See `wrangler.toml` and `wrangler.toml.example`.

- `MEDIA_BUCKET`
- `MEDIA_STORAGE_MODE` (current production value: `legacy`)
- `SUPABASE_URL`
- `MEDIA_PUBLIC_BASE_URL`
- `ALLOWED_ORIGINS`
- `MAX_UPLOAD_BYTES`
- optional `SUPABASE_JWT_AUDIENCE`
- optional `SUPABASE_JWT_ISSUER`
- optional `SUPABASE_JWKS_URL`
- optional `SUPABASE_JWT_SECRET`
- secret `SUPABASE_SERVICE_ROLE_KEY` for profile storage tally/quota updates
- secret `ARTSORAKEL_API_TOKEN` — Artsdatabanken Artsorakel `/identify` bearer token. Required for `/artsorakel` and `/artsorakel/media` routes.
- optional `FREE_STORAGE_QUOTA_BYTES`

## Deploy

1. Review `wrangler.toml`.
2. Bind the `sporely-media` bucket as `MEDIA_BUCKET`.
3. If your Supabase project uses HS256 JWTs, add the secret:
   `wrangler secret put SUPABASE_JWT_SECRET`
4. Run `supabase/profile-storage-usage.sql` in Supabase SQL Editor.
5. Add the service role key secret:
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
6. Add the Artsorakel bearer token secret (required for `/artsorakel*`):
   `npx wrangler secret put ARTSORAKEL_API_TOKEN`
7. Deploy:
   `wrangler deploy`

## Request Format

```bash
curl -X PUT "https://upload.sporely.no/upload/<user_id>/<obs_id>/image.jpg" \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: image/jpeg" \
  -H "Cache-Control: public, max-age=31536000, immutable" \
  --data-binary @image.jpg
```

```bash
curl "https://upload.sporely.no/upload/<user_id>/<obs_id>/image.jpg" \
  -H "Authorization: Bearer <supabase_access_token>" \
  --output image.jpg
```

```bash
curl -X POST "https://upload.sporely.no/artsorakel/media" \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: application/json" \
  --data '{"keys":["<user_id>/<obs_id>/image.jpg"],"variant":"medium"}'
```

## Public media bucket CORS (`media.sporely.no`)

`cors.json` in this directory is the CORS policy for the **`sporely-media` R2
bucket** (served publicly via the `media.sporely.no` custom domain). It is NOT
part of `wrangler deploy` — it must be applied to the bucket separately:

```bash
npx wrangler r2 bucket cors set sporely-media --file cloudflare/r2-upload-worker/cors.json
```

(or paste the JSON into Cloudflare dashboard → R2 → `sporely-media` →
Settings → CORS policy.)

Why it matters: Stage B cache-first thumbnails call `fetch(publicUrl)` from
JS to warm the persistent blob cache. Unlike plain `<img src>` rendering,
a JS `fetch` requires `Access-Control-Allow-Origin` on the response. The
Capacitor Android WebView runs at origin `https://localhost`, so that origin
(and every other app origin) must be in `AllowedOrigins` or cache warming
fails with a CORS error.

- `AllowedOrigins` mirrors the Worker `ALLOWED_ORIGINS` allowlist in
  `wrangler.toml` — keep the two in sync; `wrangler.toml` is the source of
  truth for app origins.
- Only `GET`/`HEAD` are allowed: the browser never writes to the bucket
  directly (all uploads go through this Worker at `upload.sporely.no`).
- R2 bucket CORS supports exact origins only — LAN-dev origins
  (`https://192.168.x.x:5173`) cannot be listed. That is acceptable: the web
  client falls back to a direct `<img src>` render when cache warming is
  CORS-blocked, so images still display; only the persistent cache warm is
  skipped on LAN dev.
- After changing the policy, purge the Cloudflare cache for
  `media.sporely.no` (previously cached responses may lack the CORS headers).

## Notes

- The Worker validates JWT signatures against Supabase JWKS by default.
- The upload key must begin with the JWT `sub` claim.
- The Worker updates storage tallies for original images and generated thumbnails. `image_count` counts original images only.

## Cloudflare Images Prototype

Stage 3 for the web client is intentionally left as a design note rather than a live code path here.

- Default flag: `USE_CLOUDFLARE_IMAGES_PROCESSING=false`
- Intended behavior when enabled:
  - accept the original upload bytes at the Worker
  - resize and encode full-size and thumbnail derivatives through Cloudflare Images
  - store only transformed outputs in R2
  - account quota/storage against stored transformed bytes, not the incoming original bytes
- Not implemented here because the binding and account-side Cloudflare Images configuration are not available in this local repository.

If we later add the binding, the Worker should keep JWT/path-prefix enforcement unchanged and gate the new branch behind the flag so the current R2-only path remains canonical by default.
