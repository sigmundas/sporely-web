import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const authSource = readFileSync(new URL('./screens/auth.js', import.meta.url), 'utf8')
const turnstileSource = readFileSync(new URL('./turnstile.js', import.meta.url), 'utf8')

test('auth.js has no native-platform captcha bypass', () => {
  assert.equal(
    /BYPASS_TURNSTILE/.test(authSource), false,
    'BYPASS_TURNSTILE must not exist in auth.js',
  )
})

test('auth.js does not skip captchaToken based on isNativeApp', () => {
  // Ensure isNativeApp is not gating any captcha assignment. The token manager
  // handles native platforms by delegating to the bridge, not by omitting the
  // token from the Supabase payload.
  const lines = authSource.split('\n')
  const suspicious = lines.filter(l =>
    l.includes('captchaToken') && l.includes('isNativeApp'))
  assert.deepEqual(suspicious, [], 'no line should combine captchaToken with isNativeApp')
})

test('turnstile.js has no hardcoded production site key', () => {
  // The only allowed literal is the Cloudflare official DEV/test key.
  const forbidden = /0x4AAAAAAC[0-9A-Za-z_]+/g
  assert.equal(forbidden.test(turnstileSource), false)
  assert.equal(forbidden.test(authSource), false)
})

test('signUp, signInWithPassword and resetPasswordForEmail all pass captchaToken', () => {
  assert.match(authSource, /supabase\.auth\.signUp\([\s\S]*?captchaToken/,
    'signUp must pass captchaToken')
  assert.match(authSource, /signInWithPassword\([\s\S]*?captchaToken/,
    'signInWithPassword must pass captchaToken')
  assert.match(authSource, /resetPasswordForEmail\([\s\S]*?captchaToken/,
    'resetPasswordForEmail must pass captchaToken')
})

test('signUp passes emailRedirectTo pointing at the HTTPS App Link callback', () => {
  // The payload constant carries emailRedirectTo:
  assert.match(authSource, /signUpPayload\s*=\s*\{[\s\S]*?emailRedirectTo/)
  assert.match(authSource, /https:\/\/app\.sporely\.no\/auth\/callback\?flow=signup/)
})

test('resend also carries emailRedirectTo', () => {
  assert.match(authSource, /supabase\.auth\.resend\([\s\S]*?emailRedirectTo/)
})

test('bridge never returns the Capacitor App proxy from an async function (thenable trap guard)', () => {
  const source = readFileSync(new URL('./screens/auth-turnstile-mobile.js', import.meta.url), 'utf8')
  // The App plugin proxy has a .then property; returning it from a promise
  // chain causes the runtime to invoke App.then() which errors on native.
  // Every path that references App must wrap it (e.g. { app }) or await it
  // exactly once via a real promise on addListener's return value.
  assert.equal(/return\s+mod\?\.App/.test(source), false, 'must not return App directly from an async function')
  assert.equal(/Promise\.resolve\(App\)/.test(source), false, 'must not Promise.resolve(App)')
  assert.equal(/await\s+App(\b|\.[a-zA-Z])/.test(source.replace(/await\s+App\.addListener/g, '')), false, 'must not await App itself')
})

test('bridge points at the built .html file (not a route that falls back to SPA)', () => {
  const source = readFileSync(new URL('./screens/auth-turnstile-mobile.js', import.meta.url), 'utf8')
  assert.match(source, /\/auth\/turnstile-mobile\.html/)
})

test('bridge iframe sandbox is exactly allow-scripts allow-same-origin', () => {
  const source = readFileSync(new URL('./screens/auth-turnstile-mobile.js', import.meta.url), 'utf8')
  assert.match(source, /sandbox['"]\s*,\s*['"]allow-scripts allow-same-origin['"]/)
})

test('_headers detaches inherited CSP and X-Frame-Options for helper route', () => {
  const source = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  // The Cloudflare Pages detachment syntax must be present for the helper.
  assert.match(source, /\/auth\/turnstile-mobile[\s\S]*?! Content-Security-Policy\b/)
  assert.match(source, /\/auth\/turnstile-mobile[\s\S]*?! Content-Security-Policy-Report-Only\b/)
  assert.match(source, /\/auth\/turnstile-mobile[\s\S]*?! X-Frame-Options\b/)
  // And the reissued CSP allows the Capacitor origins.
  assert.match(source, /frame-ancestors [^;\n]*capacitor:\/\/localhost/)
  // The main app CSP still restricts frame-ancestors to 'self'.
  assert.match(source, /^\/\*\n[\s\S]*?frame-ancestors 'self'/m)
})

test('signInWithIdToken does not receive a captchaToken (SDK does not support it)', () => {
  // Grep the Google native path — the payload must not contain captchaToken.
  const idTokenBlock = authSource.match(/signInWithIdToken\([^)]*\)/g) || []
  for (const b of idTokenBlock) {
    assert.equal(/captchaToken/.test(b), false, `signInWithIdToken must not carry captchaToken: ${b}`)
  }
  // Also assert in google-auth.js.
  const googleSource = readFileSync(new URL('./google-auth.js', import.meta.url), 'utf8')
  const googleIdTokenBlock = googleSource.match(/signInWithIdToken\([\s\S]*?\)/g) || []
  for (const b of googleIdTokenBlock) {
    assert.equal(/captchaToken/.test(b), false, `google-auth signInWithIdToken must not carry captchaToken`)
  }
})
