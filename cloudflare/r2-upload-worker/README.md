# Sporely R2 Upload Worker

Cloudflare Worker for authenticated media uploads to the `sporely-media` R2 bucket.

## What It Does

- Accepts authenticated `GET`, `PUT`, and `DELETE` requests at `/upload/{key}`.
- Accepts authenticated `POST /artsorakel/media` requests that identify saved R2 images without browser-side image downloads.
- Validates the caller's Supabase JWT before writing to R2.
- Enforces that the object key starts with the authenticated user's `sub`, for example:
  - `user_uuid/observation_uuid/field_001.jpg`
  - `user_uuid/observation_uuid/thumb_small_field_001.jpg`
- Returns the stored key and optional public URL.
- Tracks successful upload/delete byte deltas in `public.profiles`.
- Enforces free-tier storage limits when `storage_quota_bytes` or `FREE_STORAGE_QUOTA_BYTES` is set.

## Expected Bindings and Vars

See `wrangler.toml` and `wrangler.toml.example`.

- `MEDIA_BUCKET`
- `SUPABASE_URL`
- `MEDIA_PUBLIC_BASE_URL`
- `ALLOWED_ORIGINS`
- `MAX_UPLOAD_BYTES`
- optional `SUPABASE_JWT_AUDIENCE`
- optional `SUPABASE_JWT_ISSUER`
- optional `SUPABASE_JWKS_URL`
- optional `SUPABASE_JWT_SECRET`
- secret `SUPABASE_SERVICE_ROLE_KEY` for profile storage tally/quota updates
- optional `FREE_STORAGE_QUOTA_BYTES`

## Deploy

1. Review `wrangler.toml`.
2. Bind the `sporely-media` bucket as `MEDIA_BUCKET`.
3. If your Supabase project uses HS256 JWTs, add the secret:
   `wrangler secret put SUPABASE_JWT_SECRET`
4. Run `supabase/profile-storage-usage.sql` in Supabase SQL Editor.
5. Add the service role key secret:
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
6. Deploy:
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

## Notes

- The Worker validates JWT signatures against Supabase JWKS by default.
- The upload key must begin with the JWT `sub` claim.
- The Worker updates storage tallies for original images and generated thumbnails. `image_count` counts original images only.
