import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const assetlinksPath = new URL('../public/.well-known/assetlinks.json', import.meta.url)
const manifestPath = new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url)

test('public/.well-known/assetlinks.json exists', () => {
  assert.equal(existsSync(assetlinksPath), true)
})

test('assetlinks.json declares the correct package and handle_all_urls relation', () => {
  const parsed = JSON.parse(readFileSync(assetlinksPath, 'utf8'))
  assert.ok(Array.isArray(parsed) && parsed.length > 0)
  const entry = parsed[0]
  assert.ok(Array.isArray(entry.relation))
  assert.ok(entry.relation.includes('delegate_permission/common.handle_all_urls'),
    'handle_all_urls relation is required for App Links')
  assert.equal(entry.target?.namespace, 'android_app')
  assert.equal(entry.target?.package_name, 'com.sporelab.sporely')
  const fingerprints = entry.target?.sha256_cert_fingerprints || []
  assert.ok(fingerprints.length >= 1, 'at least one SHA-256 fingerprint required')
  for (const fp of fingerprints) {
    // 32 pairs of hex separated by ':' — exactly the format Android expects.
    assert.match(fp, /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/, `bad fingerprint: ${fp}`)
  }
})

test('AndroidManifest has an autoVerify HTTPS App Link intent filter for /auth/callback', () => {
  const manifest = readFileSync(manifestPath, 'utf8')
  // Presence of autoVerify=true intent filter.
  assert.match(manifest, /<intent-filter[^>]*android:autoVerify="true"/)
  // https scheme + app.sporely.no host + /auth/callback pathPrefix.
  const block = manifest.match(/<intent-filter[^>]*android:autoVerify="true"[\s\S]*?<\/intent-filter>/)?.[0]
  assert.ok(block, 'autoVerify intent-filter block missing')
  assert.match(block, /android:scheme="https"/)
  assert.match(block, /android:host="app\.sporely\.no"/)
  assert.match(block, /android:pathPrefix="\/auth\/callback"/)
  assert.match(block, /category android:name="android\.intent\.category\.BROWSABLE"/)
})

test('AndroidManifest still declares the custom-scheme intent filter for legacy links', () => {
  const manifest = readFileSync(manifestPath, 'utf8')
  assert.match(manifest, /android:scheme="com\.sporelab\.sporely"/)
})

test('dist/.well-known/assetlinks.json is emitted by the build (when dist exists)', () => {
  // This assertion runs only after `npm run build` has produced dist/.
  // If dist/ is absent (fresh checkout), skip rather than fail.
  const distPath = new URL('../dist/.well-known/assetlinks.json', import.meta.url)
  if (!existsSync(new URL('../dist/', import.meta.url))) return
  assert.equal(existsSync(distPath), true, 'dist/.well-known/assetlinks.json must be copied from public/')
  const parsed = JSON.parse(readFileSync(distPath, 'utf8'))
  assert.equal(parsed[0].target.package_name, 'com.sporelab.sporely')
})
