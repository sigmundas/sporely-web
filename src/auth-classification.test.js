// Stage B1 refinement tests. Cover the refined explicit-auth classifier
// and the new reachability probe. Both live in `auth-classification.js`
// so tests can import them without pulling main.js's whole module graph.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  EXPLICIT_AUTH_REJECT_TAGS,
  isExplicitAuthRejection,
  isTransportSessionError,
  probeBackendReachability,
} from './auth-classification.js'

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8')

// Tags that used to be classified as "explicit rejection" in the initial
// B1 draft but are now REMOVED — a bare expired access JWT is not a
// server-confirmed session rejection.
const REMOVED_FROM_EXPLICIT_REJECT_TAGS = [
  'jwt expired',
  'jwt malformed',
  'no user found with that email',
]

test('classifier includes every server-confirmed rejection tag', () => {
  for (const tag of EXPLICIT_AUTH_REJECT_TAGS) {
    assert.equal(isExplicitAuthRejection(new Error(tag)), true, `tag "${tag}" must be classified as explicit rejection`)
  }
})

test('classifier EXCLUDES tags that were removed for Stage B1 refinement', () => {
  for (const tag of REMOVED_FROM_EXPLICIT_REJECT_TAGS) {
    assert.equal(isExplicitAuthRejection(new Error(tag)), false, `tag "${tag}" must NOT deny cached boot after refinement`)
  }
})

test('classifier: expired access JWT does NOT count as explicit rejection', () => {
  // A bare "jwt expired" is common on every offline launch (access tokens
  // are short-lived by design). It must not deny cached boot.
  assert.equal(isExplicitAuthRejection(new Error('JWT expired')), false)
  assert.equal(isExplicitAuthRejection({ message: 'JWT expired', status: 401 }), false)
  assert.equal(isExplicitAuthRejection({ message: 'invalid claim: missing sub claim (jwt malformed)' }), false)
})

test('classifier: invalid_refresh_token counts as explicit rejection', () => {
  assert.equal(isExplicitAuthRejection({ message: 'Invalid Refresh Token: Refresh Token Not Found', code: 'refresh_token_not_found' }), true)
  assert.equal(isExplicitAuthRejection({ message: 'invalid_refresh_token', status: 400 }), true)
  assert.equal(isExplicitAuthRejection({ error: 'invalid_grant', error_description: 'Refresh Token Not Found' }), true)
})

test('classifier: session_not_found / user_not_found count as explicit rejection', () => {
  assert.equal(isExplicitAuthRejection({ message: 'session_not_found' }), true)
  assert.equal(isExplicitAuthRejection({ message: 'user_not_found' }), true)
})

test('classifier: transport-shape errors are NOT explicit rejections', () => {
  assert.equal(isExplicitAuthRejection(new Error('Failed to fetch')), false)
  assert.equal(isExplicitAuthRejection(new Error('Network request failed')), false)
  assert.equal(isExplicitAuthRejection({ message: 'timed out', status: 0 }), false)
  assert.equal(isExplicitAuthRejection({ message: 'aborted' }), false)
  assert.equal(isExplicitAuthRejection({ message: 'internal server error', status: 502 }), false)
})

test('transport-error classifier recognises Failed to fetch / 5xx / status 0', () => {
  assert.equal(isTransportSessionError(new Error('Failed to fetch')), true)
  assert.equal(isTransportSessionError({ message: 'timeout', status: 0 }), true)
  assert.equal(isTransportSessionError({ message: 'internal server error', status: 502 }), true)
  assert.equal(isTransportSessionError({ message: 'invalid_refresh_token' }), false)
})

test('structural: classifier module does NOT list `jwt expired` / `jwt malformed` after refinement', () => {
  // Anchor the change so a future refactor cannot silently re-add these.
  // Strip comments before scanning so plan-explaining prose does not
  // trigger the guard.
  const raw = readFileSync(new URL('./auth-classification.js', import.meta.url), 'utf8')
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
  assert.equal(/['"]jwt expired['"]/i.test(source), false, "`jwt expired` must not appear in the classifier tag list")
  assert.equal(/['"]jwt malformed['"]/i.test(source), false, "`jwt malformed` must not appear in the classifier tag list")
  // Confirm the retained tags are still there.
  assert.match(source, /['"]invalid_refresh_token['"]/)
  assert.match(source, /['"]refresh_token_not_found['"]/)
  assert.match(source, /['"]session_not_found['"]/)
  assert.match(source, /['"]user_not_found['"]/)
})

test('structural: main.js delegates to the classifier module (no local reject-tag literal drift)', () => {
  // main.js's _isExplicitAuthRejection is a thin wrapper around the
  // classifier module — verify it references the shared implementation
  // rather than duplicating the tag list.
  assert.match(mainSource, /_isExplicitAuthRejection\(err\)\s*\{\s*return\s+isExplicitAuthRejection\(err\)/)
  assert.match(mainSource, /import\s*\{[^}]*isExplicitAuthRejection[^}]*\}\s*from\s*'\.\/auth-classification\.js'/)
})

// ── Reachability probe ─────────────────────────────────────────────

test('probe: successful 200 response is REACHABLE', async () => {
  const result = await probeBackendReachability({
    fetchImpl: async () => ({ status: 200 }),
  })
  assert.equal(result, 'reachable')
})

test('probe: 4xx well-formed response is REACHABLE (server answered)', async () => {
  // Any well-formed HTTP status < 500 proves the hop reached Supabase.
  for (const status of [301, 401, 403, 404]) {
    const result = await probeBackendReachability({
      fetchImpl: async () => ({ status }),
    })
    assert.equal(result, 'reachable', `status ${status} must be reachable`)
  }
})

test('probe: 5xx response is UNREACHABLE (server up but broken)', async () => {
  for (const status of [500, 502, 503, 504]) {
    const result = await probeBackendReachability({
      fetchImpl: async () => ({ status }),
    })
    assert.equal(result, 'unreachable', `status ${status} must classify as unreachable`)
  }
})

test('probe: thrown fetch is UNREACHABLE (transport / DNS / TLS)', async () => {
  const result = await probeBackendReachability({
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
  })
  assert.equal(result, 'unreachable')
})

test('probe: abort/timeout is UNREACHABLE', async () => {
  const result = await probeBackendReachability({
    timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
      // never resolves — signal must abort it via the internal timer
    }),
  })
  assert.equal(result, 'unreachable')
})

test('probe: missing fetch or origin is UNREACHABLE (fail closed)', async () => {
  assert.equal(await probeBackendReachability({ fetchImpl: null }), 'unreachable')
  assert.equal(await probeBackendReachability({ origin: '' }), 'unreachable')
})

test('probe: uses `/auth/v1/health` on the configured Supabase origin', async () => {
  const calls = []
  await probeBackendReachability({
    fetchImpl: async url => { calls.push(url); return { status: 200 } },
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/auth\/v1\/health$/)
})

test('probe: GET uses no-store and identifies itself with ONLY the publishable apikey header', async () => {
  const seen = []
  await probeBackendReachability({
    apikey: 'sb_publishable_test_key',
    fetchImpl: async (url, options) => { seen.push(options); return { status: 200 } },
  })
  assert.equal(seen.length, 1)
  const options = seen[0]
  assert.equal(options.method, 'GET')
  assert.equal(options.cache, 'no-store')
  assert.deepEqual(options.headers, { apikey: 'sb_publishable_test_key' })
})

test('probe: NEVER sends the user access token or any Authorization header', async () => {
  const seen = []
  await probeBackendReachability({
    fetchImpl: async (url, options) => { seen.push(options); return { status: 200 } },
  })
  const headers = seen[0]?.headers || {}
  const headerNames = Object.keys(headers).map(h => h.toLowerCase())
  assert.ok(!headerNames.includes('authorization'), 'must not carry an Authorization header')
  assert.deepEqual(headerNames.filter(h => h !== 'apikey'), [], 'apikey is the ONLY header the probe may send')
  // Default apikey comes from the publishable-key export — a public value.
  assert.match(String(headers.apikey || ''), /^sb_publishable_/)
})

test('probe: an empty apikey falls back to a headerless request (fail open on config, closed on auth)', async () => {
  const seen = []
  await probeBackendReachability({
    apikey: '',
    fetchImpl: async (url, options) => { seen.push(options); return { status: 200 } },
  })
  assert.equal(seen[0].headers, undefined)
})
