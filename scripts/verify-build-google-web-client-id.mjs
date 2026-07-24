#!/usr/bin/env node
// Verifies the freshly built dist/ contains the VITE_GOOGLE_WEB_CLIENT_ID
// literal, so we never ship an Android APK that was compiled with an empty
// Google Web Client ID (which would silently break native Google Sign-In).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadEnv } from 'vite'

const mode = process.env.NODE_ENV || 'production'
const cwd = process.cwd()
const env = loadEnv(mode, cwd, '')

const expected = String(
  process.env.VITE_GOOGLE_WEB_CLIENT_ID || env.VITE_GOOGLE_WEB_CLIENT_ID || '',
).trim()
if (!expected) {
  console.error('[verify:build:google-web-client-id] VITE_GOOGLE_WEB_CLIENT_ID is missing at verify time.')
  process.exit(1)
}

const distAssetsDir = resolve(cwd, 'dist', 'assets')

let jsFiles
try {
  jsFiles = readdirSync(distAssetsDir).filter(name => name.endsWith('.js'))
} catch (error) {
  console.error(`[verify:build:google-web-client-id] Could not read ${distAssetsDir}: ${error.message}`)
  console.error('  Did the Vite build run first?')
  process.exit(1)
}

for (const name of jsFiles) {
  const full = join(distAssetsDir, name)
  const stats = statSync(full)
  if (!stats.isFile()) continue
  const contents = readFileSync(full, 'utf8')
  if (contents.includes(expected)) {
    console.log(`[verify:build:google-web-client-id] OK (found in dist/assets/${name})`)
    process.exit(0)
  }
}

console.error(
  '\n[verify:build:google-web-client-id] VITE_GOOGLE_WEB_CLIENT_ID was NOT found in any dist/assets/*.js bundle.\n'
  + '  Vite likely compiled the bundle before the env variable was set.\n'
  + '  Ensure VITE_GOOGLE_WEB_CLIENT_ID is exported in the shell / GitHub Actions job env before running the build.\n',
)
process.exit(1)
