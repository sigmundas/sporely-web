#!/usr/bin/env node
// Fails early if VITE_MEDIA_UPLOAD_BASE_URL is not available for the upcoming
// Vite build. The media upload worker URL is compiled in at build time, and the
// client deliberately refuses the Supabase Storage fallback when it is empty
// (R2 is canonical), so a missing value produces a release where every upload
// fails loudly at runtime.
//
// Loads env in the same order Vite does (process.env, then .env / .env.local /
// .env.[mode] / .env.[mode].local), so this passes in CI (env vars supplied by
// the workflow) and locally (developer's .env.local).

import { loadEnv } from 'vite'

const mode = process.env.NODE_ENV || 'production'
const cwd = process.cwd()
const env = loadEnv(mode, cwd, '')

// Vite's loadEnv() intentionally ignores process.env; merge it back in so that
// CI-provided environment variables are visible here.
const value = String(
  process.env.VITE_MEDIA_UPLOAD_BASE_URL || env.VITE_MEDIA_UPLOAD_BASE_URL || '',
).trim()

if (!value) {
  const isCi = !!process.env.CI || !!process.env.GITHUB_ACTIONS
  const hint = isCi
    ? 'Set the VITE_MEDIA_UPLOAD_BASE_URL variable in the workflow environment before running Vite build.'
    : 'Set VITE_MEDIA_UPLOAD_BASE_URL in .env.local (e.g. https://upload.sporely.no).'
  console.error(
    '\n[check:media:upload-base-url] VITE_MEDIA_UPLOAD_BASE_URL is not set.\n'
    + '  Media uploads require the Cloudflare upload worker base URL at build time;\n'
    + '  the client refuses the Supabase Storage fallback because R2 is canonical.\n'
    + `  ${hint}\n`,
  )
  process.exit(1)
}

let parsed
try {
  parsed = new URL(value)
} catch {
  console.error(
    `\n[check:media:upload-base-url] VITE_MEDIA_UPLOAD_BASE_URL is not a valid URL: ${value}\n`
    + '  Expected an absolute origin such as https://upload.sporely.no\n',
  )
  process.exit(1)
}

if (parsed.protocol !== 'https:') {
  console.error(
    `\n[check:media:upload-base-url] VITE_MEDIA_UPLOAD_BASE_URL must use https: ${value}\n`,
  )
  process.exit(1)
}

console.log(`[check:media:upload-base-url] OK (${value})`)
