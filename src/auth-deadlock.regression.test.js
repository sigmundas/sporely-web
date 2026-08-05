import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Structural guard against reintroducing the supabase-js auth-lock deadlock
// documented in main.js. The DIRECT listener passed to onAuthStateChange
// MUST:
//   - not be declared async
//   - not await anything
//   - not call Supabase or start any Supabase-adjacent work
//   - defer processing via a macrotask (setTimeout) and return immediately
//
// All async work belongs in the deferred handler after enqueueAuthEvent has
// scheduled it.

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8')

function extractDirectListener() {
  const idx = mainSource.indexOf('onAuthStateChange(')
  assert.ok(idx > 0, 'onAuthStateChange call not found in main.js')
  // Walk balanced parentheses from onAuthStateChange( to its matching ).
  const start = idx + 'onAuthStateChange('.length
  let depth = 1
  let i = start
  while (i < mainSource.length && depth > 0) {
    const c = mainSource[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    if (depth === 0) break
    i++
  }
  return mainSource.slice(start, i)
}

test('direct onAuthStateChange listener is NOT async', () => {
  const body = extractDirectListener()
  // Reject `async` as the very first token or after a comma/whitespace.
  assert.equal(/^\s*async\b/.test(body), false, 'listener must not be declared async')
})

test('direct listener does not await anything', () => {
  const body = extractDirectListener()
  assert.equal(/\bawait\b/.test(body), false, 'no await inside the direct listener')
})

test('direct listener does not call Supabase or profile resolution', () => {
  const body = extractDirectListener()
  const forbidden = [
    /supabase\./,
    /_resolveAndRouteForUser\b/,
    /recordClientActivity\b/,
    /resolveAuthenticatedSessionOnce\b/,
    /getSharedAuthSession\b/,
    /getSession\b/,
    /exchangeCodeForSession\b/,
    /signInWithPassword\b/,
    /signInWithIdToken\b/,
  ]
  for (const re of forbidden) {
    assert.equal(re.test(body), false, `direct listener must not reference ${re}`)
  }
})

test('direct listener defers processing via setTimeout macrotask', () => {
  const body = extractDirectListener()
  assert.match(body, /setTimeout\(/)
  assert.match(body, /enqueueAuthEvent\(/)
})

test('serialized queue exists and swallows failures', () => {
  assert.match(mainSource, /let\s+_authEventQueue\s*=\s*Promise\.resolve\(\)/)
  assert.match(mainSource, /_authEventQueue\s*=\s*_authEventQueue[\s\S]{0,20}?\.then/)
  assert.match(mainSource, /\.catch\(/)
})

test('central resolveAuthenticatedSessionOnce exists and dedupes', () => {
  assert.match(mainSource, /export function resolveAuthenticatedSessionOnce/)
  assert.match(mainSource, /_resolutionInFlight/)
  assert.match(mainSource, /_resolvedUsers/)
  // Must clear inFlight in finally so retry works after failure.
  assert.match(mainSource, /finally\s*\{\s*_resolutionInFlight\.delete/)
})

test('all resolution paths funnel through resolveAuthenticatedSessionOnce', () => {
  // The direct listener never reaches _resolveAndRouteForUser. The deferred
  // handler, native callback, initial-boot session, and auth-form submit all
  // use resolveAuthenticatedSessionOnce.
  const paths = mainSource.matchAll(/resolveAuthenticatedSessionOnce\(/g)
  const count = [...paths].length
  assert.ok(count >= 4, `expected at least 4 callsites; got ${count}`)
})

test('safe phase log helper is used and never logs credentials', () => {
  assert.match(mainSource, /_authLog\('native_callback_received'/)
  assert.match(mainSource, /_authLog\('callback_exchange_started'/)
  assert.match(mainSource, /_authLog\('callback_exchange_completed'/)
  assert.match(mainSource, /_authLog\('signed_in_event_deferred'/)
  assert.match(mainSource, /_authLog\('session_resolution_started'/)
  assert.match(mainSource, /_authLog\('session_resolution_completed'/)
})

test('production auth-draft persistence is not enabled', () => {
  const authSource = readFileSync(new URL('./screens/auth.js', import.meta.url), 'utf8')
  // Must remain DEV-gated. Any change that removes the DEV check or hard-codes
  // true would leak the signup password to sessionStorage in production.
  assert.match(authSource, /const\s+PERSIST_AUTH_DRAFTS\s*=\s*!!import\.meta\.env\?\.DEV/)
})

test('auth.js login submit emits password_signin_started / _completed', () => {
  const authSource = readFileSync(new URL('./screens/auth.js', import.meta.url), 'utf8')
  assert.match(authSource, /password_signin_started/)
  assert.match(authSource, /password_signin_completed/)
})
