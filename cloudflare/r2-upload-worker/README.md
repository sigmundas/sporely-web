# Sporely R2 Upload Worker

Cloudflare Worker for authenticated media uploads to the `sporely-media` R2 bucket.

## What It Does

- Accepts `PUT /upload/{key}` requests.
- Validates the caller's Supabase JWT before writing to R2.
- Enforces that the object key starts with the authenticated user's `sub`, for example:
  - `user_uuid/observation_uuid/field_001.jpg`
  - `user_uuid/observation_uuid/thumb_small_field_001.jpg`
- Returns the stored key and optional public URL.

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

## Deploy

1. Review `wrangler.toml`.
2. Bind the `sporely-media` bucket as `MEDIA_BUCKET`.
3. If your Supabase project uses HS256 JWTs, add the secret:
   `wrangler secret put SUPABASE_JWT_SECRET`
4. Deploy:
   `wrangler deploy`

## Request Format

```bash
curl -X PUT "https://upload.sporely.no/upload/<user_id>/<obs_id>/image.jpg" \
  -H "Authorization: Bearer <supabase_access_token>" \
  -H "Content-Type: image/jpeg" \
  -H "Cache-Control: public, max-age=31536000, immutable" \
  --data-binary @image.jpg
```

## Notes

- The Worker validates JWT signatures against Supabase JWKS by default.
- The upload key must begin with the JWT `sub` claim.
- This Worker currently handles uploads only. Delete/list flows can be added later if you want the web app to fully stop touching Supabase Storage.
