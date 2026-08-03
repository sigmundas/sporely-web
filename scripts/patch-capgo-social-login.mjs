#!/usr/bin/env node

// Temporary security patch for @capgo/capacitor-social-login 8.3.22.
// Remove this script, the postinstall hook, and the exact-version pin when an
// upstream release removes both credential-bearing GoogleProvider log lines.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packagePath = resolve('node_modules/@capgo/capacitor-social-login/package.json')
const sourcePath = resolve(
  'node_modules/@capgo/capacitor-social-login/android/src/main/java/ee/forgr/capacitor/social/login/GoogleProvider.java',
)
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
if (packageJson.version !== '8.3.22') {
  throw new Error(`Refusing to patch unreviewed @capgo/capacitor-social-login version ${packageJson.version}`)
}

const replacements = [
  {
    unsafe: 'Log.i(SocialLoginPlugin.LOG_TAG, String.format("Google restoreState: %s", object));',
    safe: 'Log.i(SocialLoginPlugin.LOG_TAG, "Google restoreState: restored cached credentials");',
  },
  {
    unsafe: 'Log.d(LOG_TAG, "handleSignInResult: " + result.toString());',
    safe: 'Log.d(LOG_TAG, "handleSignInResult: Google credential received");',
  },
]

let source = readFileSync(sourcePath, 'utf8')
let changed = false
for (const { unsafe, safe } of replacements) {
  if (source.includes(safe)) continue
  if (!source.includes(unsafe)) {
    throw new Error(`Expected @capgo/capacitor-social-login source line was not found: ${unsafe}`)
  }
  source = source.replace(unsafe, safe)
  changed = true
}

if (changed) writeFileSync(sourcePath, source)
console.log(`[patch-capgo-social-login] ${changed ? 'Removed unsafe Google token log payloads' : 'Already patched'} (8.3.22)`)
