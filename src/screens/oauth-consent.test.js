import test from 'node:test'
import assert from 'node:assert/strict'
import { initOAuthConsent } from './oauth-consent.js'
import { consumePendingOAuthConsentReturn, isValidOAuthAuthorizationId } from '../oauth-consent-return.js'

// ── DOM / Window helpers ──────────────────────────────────────────────────────

function makeDom() {
  const els = {}
  const listeners = {}

  function el(id) {
    if (!els[id]) {
      els[id] = {
        id,
        style: { display: '' },
        textContent: '',
        disabled: false,
        _listeners: {},
        addEventListener(type, fn) { this._listeners[type] = fn },
        dispatch(type) { return this._listeners[type]?.() },
      }
    }
    return els[id]
  }

  const doc = { getElementById: id => el(id) }
  return { doc, els, el }
}

function makeWin(search = '') {
  const nav = { href: '' }
  const win = {
    location: {
      search,
      origin: 'https://app.sporely.no',
      get href() { return nav.href },
      set href(v) { nav.href = v },
    },
    _navHref: nav,
  }
  return win
}

function makeSupabase({ session = null, sessionError = null, authDetails = null, detailsError = null, approveResult = null, approveError = null, denyResult = null, denyError = null } = {}) {
  return {
    auth: {
      async getSession() {
        return { data: { session }, error: sessionError }
      },
      oauth: {
        async getAuthorizationDetails(_id) {
          return { data: authDetails, error: detailsError }
        },
        async approveAuthorization(_id, _opts) {
          return { data: approveResult, error: approveError }
        },
        async denyAuthorization(_id, _opts) {
          return { data: denyResult, error: denyError }
        },
      },
    },
  }
}

const VALID_AUTHORIZATION_ID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'
const VALID_UUID = VALID_AUTHORIZATION_ID
const DESKTOP_CLIENT_ID = 'b141fed6-e257-4de1-b784-3a28c777dadf'

function makeAuthDetails(overrides = {}) {
  return {
    authorization_id: VALID_AUTHORIZATION_ID,
    redirect_uri: 'http://127.0.0.1:8765/auth/callback',
    client: {
      id: DESKTOP_CLIENT_ID,
      name: 'Sporely Desktop',
      uri: 'https://sporely.no',
      logo_uri: 'https://sporely.no/logo.png',
    },
    user: { id: 'user-123', email: 'test@example.com' },
    scope: 'openid profile',
    ...overrides,
  }
}

function makeSession(overrides = {}) {
  return {
    user: { id: 'user-123', email: 'test@example.com' },
    ...overrides,
  }
}

// ── Missing / invalid authorization_id ────────────────────────────────────────

test('shows error for missing authorization_id', async () => {
  const { doc, els } = makeDom()
  const win = makeWin('')  // no params
  const sb = makeSupabase()

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'invalid_param')
  assert.equal(result.error, 'missing')
  assert.equal(els['consent-error'].style.display, 'block')
  assert.ok(els['consent-error'].textContent.includes('Missing authorization_id'))
  assert.equal(els['consent-ui'].style.display, 'none')
})

test('rejects unsafe, path-like authorization_id', async () => {
  const { doc, els } = makeDom()
  const win = makeWin('?authorization_id=not/a-safe-token')
  const sb = makeSupabase()

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'invalid_param')
  assert.equal(result.error, 'format')
  assert.ok(els['consent-error'].textContent.includes('Invalid authorization_id'))
})

test('shows error for empty authorization_id param', async () => {
  const { doc, els } = makeDom()
  const win = makeWin('?authorization_id=')
  const sb = makeSupabase()

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'invalid_param')
  assert.equal(result.error, 'missing')
})

test('rejects authorization_id with surrounding whitespace', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=%20${VALID_AUTHORIZATION_ID}%20`)

  const result = await initOAuthConsent({ supabase: makeSupabase(), document: doc, window: win })

  assert.equal(result.status, 'invalid_param')
  assert.equal(result.error, 'format')
  assert.ok(els['consent-error'].textContent.includes('Invalid authorization_id'))
})

test('authorization_id validator accepts opaque Supabase token and rejects unsafe values', () => {
  assert.equal(isValidOAuthAuthorizationId(VALID_AUTHORIZATION_ID), true)
  assert.equal(isValidOAuthAuthorizationId(' leading-space'), false)
  assert.equal(isValidOAuthAuthorizationId('unsafe/token'), false)
  assert.equal(isValidOAuthAuthorizationId('unsafe?query'), false)
  assert.equal(isValidOAuthAuthorizationId('unsafe\ncontrol'), false)
  assert.equal(isValidOAuthAuthorizationId('a'.repeat(129)), false)
})

// ── No session → redirect to login ───────────────────────────────────────────

test('redirects unauthenticated user to login and stores pending consent', async () => {
  const { doc } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_AUTHORIZATION_ID}`)
  const sb = makeSupabase({ session: null })

  const previousSessionStorage = globalThis.sessionStorage
  const store = {}
  globalThis.sessionStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: k => { delete store[k] },
  }

  try {
    const result = await initOAuthConsent({ supabase: sb, document: doc, window: win, loginReturnTarget: 'https://app.sporely.no/' })

    assert.equal(result.status, 'redirect_to_login')
    assert.equal(result.authorizationId, VALID_AUTHORIZATION_ID)
    assert.equal(win._navHref.href, 'https://app.sporely.no/')

    const stored = JSON.parse(store['sporely-oauth-consent-pending'])
    assert.equal(stored.id, VALID_AUTHORIZATION_ID)
    assert.ok(typeof stored.ts === 'number')
  } finally {
    globalThis.sessionStorage = previousSessionStorage
  }
})

test('redirects to origin root when no loginReturnTarget specified', async () => {
  const { doc } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_AUTHORIZATION_ID}`)
  const sb = makeSupabase({ session: null })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'redirect_to_login')
  assert.equal(win._navHref.href, 'https://app.sporely.no/')
})

// ── consumePendingOAuthConsentReturn ─────────────────────────────────────────

test('consumePendingOAuthConsentReturn returns null when nothing is stored', () => {
  const prev = globalThis.sessionStorage
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  try {
    assert.equal(consumePendingOAuthConsentReturn(), null)
  } finally {
    globalThis.sessionStorage = prev
  }
})

test('consumePendingOAuthConsentReturn returns consent path and clears store', () => {
  const prev = globalThis.sessionStorage
  const store = { 'sporely-oauth-consent-pending': JSON.stringify({ id: VALID_AUTHORIZATION_ID, ts: Date.now() }) }
  const removed = []
  globalThis.sessionStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: k => { removed.push(k); delete store[k] },
  }
  try {
    const path = consumePendingOAuthConsentReturn()
    assert.ok(path.startsWith('/oauth/consent?authorization_id='))
    assert.ok(path.includes(encodeURIComponent(VALID_AUTHORIZATION_ID)))
    assert.ok(removed.includes('sporely-oauth-consent-pending'))
    // Consumed — second call returns null
    assert.equal(consumePendingOAuthConsentReturn(), null)
  } finally {
    globalThis.sessionStorage = prev
  }
})

test('consumePendingOAuthConsentReturn returns null for unsafe authorization_id in store', () => {
  const prev = globalThis.sessionStorage
  const store = { 'sporely-oauth-consent-pending': JSON.stringify({ id: 'not/a-safe-token', ts: Date.now() }) }
  globalThis.sessionStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: k => { delete store[k] },
  }
  try {
    assert.equal(consumePendingOAuthConsentReturn(), null)
  } finally {
    globalThis.sessionStorage = prev
  }
})

test('consumePendingOAuthConsentReturn rejects stored authorization_id with surrounding whitespace', () => {
  const prev = globalThis.sessionStorage
  const store = {
    'sporely-oauth-consent-pending': JSON.stringify({ id: ` ${VALID_AUTHORIZATION_ID} `, ts: Date.now() }),
  }
  globalThis.sessionStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: k => { delete store[k] },
  }
  try {
    assert.equal(consumePendingOAuthConsentReturn(), null)
  } finally {
    globalThis.sessionStorage = prev
  }
})

test('consumePendingOAuthConsentReturn returns null for expired pending entry', () => {
  const prev = globalThis.sessionStorage
  const expiredTs = Date.now() - 11 * 60 * 1000  // 11 minutes ago
  const store = { 'sporely-oauth-consent-pending': JSON.stringify({ id: VALID_AUTHORIZATION_ID, ts: expiredTs }) }
  globalThis.sessionStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v },
    removeItem: k => { delete store[k] },
  }
  try {
    assert.equal(consumePendingOAuthConsentReturn(), null)
  } finally {
    globalThis.sessionStorage = prev
  }
})

// ── Authenticated user: authorization details errors ──────────────────────────

test('shows expired-authorization message for 404 from getAuthorizationDetails', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    detailsError: { status: 404, message: 'Not found' },
  })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'details_error')
  assert.ok(els['consent-error'].textContent.includes('expired or is invalid'))
  assert.equal(els['consent-ui'].style.display, 'none')
})

test('shows generic error message for non-404 API failure', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    detailsError: { status: 500, message: 'Internal server error' },
  })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'details_error')
  assert.ok(els['consent-error'].textContent.includes('Could not load'))
})

test('shows expired error when authDetails is null', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({ session: makeSession(), authDetails: null })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'not_found')
  assert.ok(els['consent-error'].textContent.includes('expired or is invalid'))
})

test('shows unauthorized error for wrong client.id', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails({ client: { id: '00000000-0000-0000-0000-000000000000', name: 'Other client' } }),
  })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'unauthorized_client')
  assert.ok(els['consent-error'].textContent.includes('Unauthorized'))
})

// ── Authenticated user: consent UI renders ────────────────────────────────────

test('renders consent UI for authenticated user with valid authorization', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
  })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'ready')
  assert.equal(result.userEmail, 'test@example.com')
  assert.equal(result.clientName, 'Sporely Desktop')
  assert.equal(els['consent-ui'].style.display, 'block')
  assert.equal(els['consent-loading'].style.display, 'none')
  assert.equal(els['consent-error'].style.display, 'none')
  assert.equal(els['consent-user-email'].textContent, 'test@example.com')
  assert.equal(els['consent-client-name'].textContent, 'Sporely Desktop')
})

test('renders the server-returned client.name', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails({ client: { id: DESKTOP_CLIENT_ID, name: 'Sporely Desktop Alt' } }),
  })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'ready')
  assert.equal(els['consent-client-name'].textContent, 'Sporely Desktop Alt')
})

test('no auth token or code material in DOM elements on consent render', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const fakeSession = { user: { id: 'uid', email: 'user@test.no' }, access_token: 'ACCESS_TOKEN_SECRET', refresh_token: 'REFRESH_TOKEN_SECRET' }
  const sb = makeSupabase({ session: fakeSession, authDetails: makeAuthDetails() })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  for (const id of ['consent-user-email', 'consent-client-name', 'consent-error', 'consent-loading']) {
    const text = els[id]?.textContent || ''
    assert.ok(!text.includes('ACCESS_TOKEN_SECRET'), `${id} must not contain access_token`)
    assert.ok(!text.includes('REFRESH_TOKEN_SECRET'), `${id} must not contain refresh_token`)
  }
})

// ── Approve ───────────────────────────────────────────────────────────────────

test('approve: calls approveAuthorization and navigates to redirect_url', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const redirectUrl = 'http://127.0.0.1:8765/auth/callback?code=abc&state=xyz'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: { redirect_url: redirectUrl },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  const result = await els['consent-approve'].dispatch('click')
  assert.equal(win._navHref.href, redirectUrl)
})

test('approve: navigates to https redirect_url', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const redirectUrl = 'https://app.sporely.no/auth/callback?code=abc'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: { redirect_url: redirectUrl },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  await els['consent-approve'].dispatch('click')
  assert.equal(win._navHref.href, redirectUrl)
})

test('approve: shows error on Supabase API failure', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveError: { message: 'server error', status: 500 },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-approve'].dispatch('click')

  assert.equal(els['consent-error'].style.display, 'block')
  assert.ok(els['consent-error'].textContent.includes('Authorization failed'))
  assert.equal(win._navHref.href, '')
})

test('approve: shows error when no redirect_url returned', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: {},  // no redirect_url
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-approve'].dispatch('click')

  assert.equal(els['consent-error'].style.display, 'block')
  assert.equal(win._navHref.href, '')
})

test('approve: accepts http: redirect_url to loopback 127.0.0.1', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const redirectUrl = 'http://127.0.0.1:8765/auth/callback?code=abc&state=xyz'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: { redirect_url: redirectUrl },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-approve'].dispatch('click')

  assert.equal(win._navHref.href, redirectUrl)
})

test('approve: rejects http: redirect_url to non-loopback host', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: { redirect_url: 'http://evil.example.com/steal?code=abc' },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-approve'].dispatch('click')

  assert.equal(win._navHref.href, '')
  assert.ok(els['consent-error'].textContent.includes('Invalid redirect'))
})

test('approve: rejects redirect_url with disallowed protocol (javascript:)', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    approveResult: { redirect_url: 'javascript:alert(1)' },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-approve'].dispatch('click')

  assert.equal(win._navHref.href, '')
  assert.ok(els['consent-error'].textContent.includes('Invalid redirect'))
})

// ── Deny ──────────────────────────────────────────────────────────────────────

test('deny: calls denyAuthorization and navigates to redirect_url', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const redirectUrl = 'http://127.0.0.1:8765/auth/callback?error=access_denied&state=xyz'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    denyResult: { redirect_url: redirectUrl },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-deny'].dispatch('click')

  assert.equal(win._navHref.href, redirectUrl)
})

test('deny: shows cancellation message when API fails', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    denyError: { message: 'server error', status: 500 },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-deny'].dispatch('click')

  assert.equal(els['consent-error'].style.display, 'block')
  assert.ok(els['consent-error'].textContent.includes('Could not cancel'))
  assert.equal(win._navHref.href, '')
})

test('deny: shows cancelled message when no redirect_url returned', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    denyResult: {},  // no redirect_url
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-deny'].dispatch('click')

  assert.equal(els['consent-error'].style.display, 'block')
  assert.ok(els['consent-error'].textContent.includes('cancelled'))
  assert.equal(win._navHref.href, '')
})

test('deny: rejects redirect_url with disallowed protocol', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
    denyResult: { redirect_url: 'data:text/html,<h1>xss</h1>' },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })
  await els['consent-deny'].dispatch('click')

  assert.equal(win._navHref.href, '')
  assert.ok(els['consent-error'].textContent.includes('cancelled'))
})

// ── Buttons disabled while in flight ─────────────────────────────────────────

test('buttons are disabled while approve is in flight', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)

  let resolveApprove
  const approvePromise = new Promise(res => { resolveApprove = res })

  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
  })
  sb.auth.oauth.approveAuthorization = async () => {
    await approvePromise
    return { data: { redirect_url: 'https://app.sporely.no/' }, error: null }
  }

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  const clickPromise = els['consent-approve'].dispatch('click')
  // After clicking, both buttons should be disabled before the promise resolves
  await Promise.resolve()  // microtask tick
  assert.equal(els['consent-approve'].disabled, true)
  assert.equal(els['consent-deny'].disabled, true)

  resolveApprove()
  await clickPromise
})

// ── Reload / refresh of consent page ─────────────────────────────────────────

test('re-entering initOAuthConsent with same authorization_id re-fetches details (no pending store)', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: makeAuthDetails(),
  })

  const r1 = await initOAuthConsent({ supabase: sb, document: doc, window: win })
  const r2 = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(r1.status, 'ready')
  assert.equal(r2.status, 'ready')
})

test('already-consented authorization redirects immediately using redirect_url', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_AUTHORIZATION_ID}`)
  const redirectUrl = 'http://127.0.0.1:8765/auth/callback?code=opaque-code&state=opaque-state'
  const sb = makeSupabase({ session: makeSession(), authDetails: { redirect_url: redirectUrl } })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'already_consented')
  assert.equal(win._navHref.href, redirectUrl)
  assert.equal(els['consent-ui'].style.display, 'none')
})

test('already-consented authorization rejects an unsafe redirect_url', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_AUTHORIZATION_ID}`)
  const sb = makeSupabase({ session: makeSession(), authDetails: { redirect_url: 'javascript:alert(1)' } })

  const result = await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.equal(result.status, 'invalid_redirect')
  assert.equal(win._navHref.href, '')
  assert.ok(els['consent-error'].textContent.includes('Invalid redirect'))
})

// ── Security: error text has no HTML/token material ──────────────────────────

test('error text does not contain HTML tags (uses textContent not innerHTML)', async () => {
  const { doc, els } = makeDom()
  const win = makeWin('?authorization_id=not%2Fa-safe-token')
  const sb = makeSupabase()

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  // textContent is set, never innerHTML — so angle brackets would be literal text if present
  const text = els['consent-error'].textContent
  assert.ok(!text.includes('<'), 'error text must not contain < (no innerHTML allowed)')
})

test('getAuthorizationDetails exception does not leak error details to DOM', async () => {
  const { doc, els } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_UUID}`)
  const sensitiveMessage = 'Confidential internal error details'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: null,
    detailsError: { message: sensitiveMessage, status: 500 },
  })

  await initOAuthConsent({ supabase: sb, document: doc, window: win })

  assert.ok(!els['consent-error'].textContent.includes(sensitiveMessage),
    'raw Supabase error details must not appear in DOM')
})

test('authorization errors do not log raw sensitive details', async () => {
  const { doc } = makeDom()
  const win = makeWin(`?authorization_id=${VALID_AUTHORIZATION_ID}`)
  const sensitiveMessage = 'authorization-code=never-log-this'
  const sb = makeSupabase({
    session: makeSession(),
    authDetails: null,
    detailsError: { message: sensitiveMessage, status: 500 },
  })
  const logs = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args) => { logs.push(args.join(' ')) }
  console.warn = (...args) => { logs.push(args.join(' ')) }

  try {
    await initOAuthConsent({ supabase: sb, document: doc, window: win })
    assert.ok(logs.every(entry => !entry.includes(sensitiveMessage)))
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
})
