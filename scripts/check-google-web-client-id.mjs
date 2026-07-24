#!/usr/bin/env node
// Fails early if VITE_GOOGLE_WEB_CLIENT_ID is not available for the upcoming
// Vite build. Native Android Google Sign-In is compiled at build time; a
// missing value would produce a release that cannot authenticate any user.
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
  process.env.VITE_GOOGLE_WEB_CLIENT_ID || env.VITE_GOOGLE_WEB_CLIENT_ID || '',
).trim()

if (!value) {
  const isCi = !!process.env.CI || !!process.env.GITHUB_ACTIONS
  const hint = isCi
    ? 'Set the VITE_GOOGLE_WEB_CLIENT_ID secret/variable in the workflow environment before running Vite build.'
    : 'Set VITE_GOOGLE_WEB_CLIENT_ID in .env.local (public Google OAuth Web Client ID).'
  console.error(
    '\n[check:google:web-client-id] VITE_GOOGLE_WEB_CLIENT_ID is not set.\n'
    + '  Native Android Google Sign-In requires this Google OAuth Web Client ID at build time.\n'
    + `  ${hint}\n`,
  )
  process.exit(1)
}

if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value)) {
  console.error(
    `\n[check:google:web-client-id] VITE_GOOGLE_WEB_CLIENT_ID does not look like a Google OAuth Web Client ID: ${value}\n`
    + '  Expected format: <project-number>-<hash>.apps.googleusercontent.com\n',
  )
  process.exit(1)
}

console.log(`[check:google:web-client-id] OK (${value.slice(0, 12)}…apps.googleusercontent.com)`)
