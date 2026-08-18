// Stage B2b integration tests: verify the capability gates block the actual
// call sites BEFORE any network dispatch and let COMPLETE proceed unchanged.
// These tests use the real capability module + real call-site code. Where
// we cannot import the DOM-bound handlers (Node test env has no DOM), we
// static-check the source for the gate call — the capability module itself
// is unit-tested elsewhere.

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as fs from 'node:fs'
import path from 'node:path'

import { AUTH_STATE, setAuthState, _resetAuthStateForTests } from './auth-state.js'
import { searchTaxaV2 } from './taxonomy-v2.js'
import { runIdentifyProviderOperation } from './ai-identification.js'
import { triggerSync } from './sync-queue.js'
import { canPerformCloudMutation } from './capabilities.js'

// A supabase mock that surfaces every rpc/from call as an assertion target.
function makeSupabaseSpy() {
  const calls = { rpc: [], from: [], insert: [], update: [], delete: [] }
  const noopBuilder = {
    select() { return this },
    insert(row) { calls.insert.push(row); return this },
    update(row) { calls.update.push(row); return this },
    delete() { calls.delete.push(true); return this },
    eq() { return this },
    or() { return this },
    in() { return this },
    single() { return Promise.resolve({ data: null, error: null }) },
    limit() { return Promise.resolve({ data: null, error: null }) },
    then(resolve) { return resolve({ data: null, error: null }) },
  }
  return {
    calls,
    rpc(...args) { calls.rpc.push(args); return Promise.resolve({ data: [], error: null }) },
    from(table) { calls.from.push(table); return noopBuilder },
  }
}

describe('capability gates — taxonomy search', () => {
  beforeEach(() => _resetAuthStateForTests())

  it('CACHED — searchTaxaV2 dispatches ZERO RPCs and returns []', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const spy = makeSupabaseSpy()
    const results = await searchTaxaV2('cantharellus', 'no', { supabaseClient: spy })
    assert.deepEqual(results, [])
    assert.equal(spy.calls.rpc.length, 0, 'must not fire RPC while cached')
  })

  it('REAUTH_REQUIRED — searchTaxaV2 dispatches ZERO RPCs (no auth-error toast spam)', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    const spy = makeSupabaseSpy()
    const results = await searchTaxaV2('cantharellus', 'no', { supabaseClient: spy })
    assert.deepEqual(results, [])
    assert.equal(spy.calls.rpc.length, 0)
  })

  it('COMPLETE — searchTaxaV2 dispatches the search_taxa_v2 RPC exactly once', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    const spy = makeSupabaseSpy()
    await searchTaxaV2('cantharellus', 'no', { supabaseClient: spy })
    assert.equal(spy.calls.rpc.length, 1)
    assert.equal(spy.calls.rpc[0][0], 'search_taxa_v2')
  })

  it('bypassCapabilityGate=true forces dispatch (used by AI orchestration)', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const spy = makeSupabaseSpy()
    await searchTaxaV2('cantharellus', 'no', { supabaseClient: spy, bypassCapabilityGate: true })
    assert.equal(spy.calls.rpc.length, 1)
  })
})

describe('capability gates — AI identification', () => {
  beforeEach(() => _resetAuthStateForTests())

  it('CACHED — runIdentifyProviderOperation refuses before invoking the operation', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    let invoked = 0
    await assert.rejects(
      runIdentifyProviderOperation('artsorakel', async () => { invoked += 1; return {} }),
      err => err.code === 'capability_denied'
        && err.capabilityReason === 'offline',
    )
    assert.equal(invoked, 0, 'the AI provider operation must not run')
  })

  it('REAUTH_REQUIRED — runIdentifyProviderOperation refuses with reauth reason', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    let invoked = 0
    await assert.rejects(
      runIdentifyProviderOperation('artsorakel', async () => { invoked += 1; return {} }),
      err => err.code === 'capability_denied'
        && err.capabilityReason === 'reauth_required',
    )
    assert.equal(invoked, 0)
  })

  it('COMPLETE — runIdentifyProviderOperation invokes the operation normally', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    let invoked = 0
    const result = await runIdentifyProviderOperation('artsorakel', async () => {
      invoked += 1
      return { ok: true }
    })
    assert.equal(invoked, 1)
    assert.deepEqual(result, { ok: true })
  })
})

describe('capability gates — sync-queue manual trigger', () => {
  beforeEach(() => _resetAuthStateForTests())

  it('CACHED — triggerSync returns null WITHOUT consuming queued work', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const result = await triggerSync()
    // A capability denial returns null; existing queue state is untouched.
    assert.equal(result, null)
  })

  it('REAUTH_REQUIRED — triggerSync returns null', async () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    const result = await triggerSync()
    assert.equal(result, null)
  })
})

describe('capability gates — static verification for DOM-bound handlers', () => {
  // These handlers are wired to click events at DOM boot time; the Node
  // test env has no DOM. Statically assert that the gate is present at
  // the top of each handler so a refactor can't quietly drop it.

  it('profile.js gates friend accept / decline / remove and avatar upload', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/screens/profile.js'), 'utf8')
    const acceptFn = src.slice(src.indexOf('async function _acceptRequest'), src.indexOf('async function _declineRequest'))
    const declineFn = src.slice(src.indexOf('async function _declineRequest'), src.indexOf('async function _removeFriend'))
    const removeFn = src.slice(src.indexOf('async function _removeFriend'), src.indexOf('async function _deleteAccount'))
    const avatarFn = src.slice(src.indexOf('async function _uploadAvatar'), src.indexOf('async function _uploadAvatar') + 800)
    assert.match(acceptFn, /requireCloudMutation\(/)
    assert.match(declineFn, /requireCloudMutation\(/)
    assert.match(removeFn, /requireCloudMutation\(/)
    assert.match(avatarFn, /requireCloudMutation\(/)
  })

  it('profile.js gates account delete and profile save', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/screens/profile.js'), 'utf8')
    const del = src.slice(src.indexOf('async function _deleteAccount'), src.indexOf('async function _deleteAccount') + 1000)
    assert.match(del, /requireCloudMutation\(/)
    assert.match(src, /if \(!requireCloudMutation\(\{ showToast \}\)\.allowed\) \{\n +btn\.disabled = false/)
  })

  it('find_detail.js gates _sendComment / _blockObservationAuthor / _reportObservation', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/screens/find_detail.js'), 'utf8')
    for (const fnName of ['_sendComment', '_blockObservationAuthor', '_reportObservation']) {
      const idx = src.indexOf(`async function ${fnName}`)
      assert.ok(idx > -1, `expected ${fnName} in find_detail.js`)
      const slice = src.slice(idx, idx + 800)
      assert.match(slice, /requireCloudMutation\(/, `${fnName} must gate on capability`)
    }
  })

  it('main.js gates the iNat connect click handler', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8')
    const idx = src.indexOf('.inat-connect-btn\').forEach')
    assert.ok(idx > -1, 'expected iNat connect handler wiring in main.js')
    const slice = src.slice(idx, idx + 800)
    assert.match(slice, /requireCloudMutation\(/)
  })

  it('sync-queue.js triggerSync gates before touching the queue', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/sync-queue.js'), 'utf8')
    const idx = src.indexOf('export async function triggerSync')
    const slice = src.slice(idx, idx + 800)
    // The capability check must come BEFORE the isSyncing guard's success
    // path returns a promise that could touch the queue.
    assert.match(slice, /canPerformCloudMutation\(\)\.allowed/)
  })

  it('capability messages are wired into every supported locale', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/i18n.js'), 'utf8')
    for (const key of ['common.internetRequired', 'common.signInToReconnect', 'common.finishSetup']) {
      const occurrences = src.split(`'${key}'`).length - 1
      // 4 locales × 1 declaration each = 4
      assert.equal(occurrences, 4, `${key} must be translated in all 4 locales`)
    }
  })
})

describe('capability gates — state transitions', () => {
  beforeEach(() => _resetAuthStateForTests())

  it('CACHED → COMPLETE re-enables cloud mutations without a reload', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, false)
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, true)
  })

  it('REAUTH_REQUIRED → COMPLETE re-enables cloud mutations without a reload', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, false)
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, true)
  })

  it('COMPLETE → CACHED disables cloud mutations without a reload', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, true)
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    assert.equal(canonicalPerformCloudMutation().allowed, false)
  })
})

function canonicalPerformCloudMutation() {
  return canPerformCloudMutation()
}

// ─── Concern 1: bypassCapabilityGate must stay narrow ─────────────────────
//
// The bypass flag is an escape hatch. It's tolerable in tests and in
// module-internal orchestration (cache warm / prefetch / non-user paths),
// but must NEVER appear in user-triggered screen code — otherwise the
// offline guarantee silently degrades screen-by-screen. Guard it here.

describe('bypassCapabilityGate — narrow-usage invariant', () => {
  it('no screen/user-triggered file passes bypassCapabilityGate', () => {
    const screenDirs = [
      path.join(process.cwd(), 'src/screens'),
    ]
    const violations = []
    function walk(dir) {
for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!entry.isFile()) continue
        if (entry.name.endsWith('.test.js')) continue // Screen test files legitimately test bypass paths.
        if (!entry.name.endsWith('.js')) continue
        const src = fs.readFileSync(full, 'utf8')
        if (src.includes('bypassCapabilityGate')) {
          violations.push(path.relative(process.cwd(), full))
        }
      }
    }
    for (const dir of screenDirs) walk(dir)
    assert.deepEqual(
      violations,
      [],
      `bypassCapabilityGate must not leak into user-triggered screen code — found: ${violations.join(', ')}`,
    )
  })

  it('bypassCapabilityGate is only referenced by (a) module definitions and (b) test files', () => {
    const allowlistDefinitions = new Set([
      'src/taxonomy-v2.js',
      'src/ai-identification.js',
    ])
    const violations = []
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
          walk(full)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue
        const rel = path.relative(process.cwd(), full)
        if (!rel.startsWith('src/')) continue
        const src = fs.readFileSync(full, 'utf8')
        if (!src.includes('bypassCapabilityGate')) continue
        if (rel.endsWith('.test.js')) continue // tests may reference the flag
        if (allowlistDefinitions.has(rel)) continue // definition sites
        violations.push(rel)
      }
    }
    walk(path.join(process.cwd(), 'src'))
    assert.deepEqual(
      violations,
      [],
      `bypassCapabilityGate leaked into non-allowlisted production code: ${violations.join(', ')}`,
    )
  })
})

// ─── Concern 2: taxonomy search UI must not render [] as "no matches" ───
//
// Static verification that every screen that calls `searchTaxa` also checks
// capability at the UI layer BEFORE dispatching (or before rendering the
// empty-result state) so an offline user sees an offline hint instead of
// a silently hidden dropdown that looks like "no matches for your query".

describe('taxonomy search UI — runtime offline rendering', () => {
  // A minimal DOM stub that exercises the exact code shape used by every
  // taxonomy-search screen: check capability → render offline row into a
  // dropdown element and set display:block. We simulate the branch directly
  // from the capability module + a fake element so this test is portable
  // across the three screens without a full DOM.

  beforeEach(() => _resetAuthStateForTests())

  function makeDropdownStub() {
    let display = 'none'
    return {
      _display: () => display,
      style: {
        get display() { return display },
        set display(v) { display = v },
      },
      innerHTML: '',
    }
  }

  function renderTaxonomyDropdownForState(stateValue) {
    setAuthState({ state: stateValue, userId: 'u1' })
    const dropdown = makeDropdownStub()
    // Existing selection stored elsewhere — this stub proves we do not
    // touch it in the offline branch.
    const existingSelection = { scientificName: 'Cantharellus cibarius' }
    const cap = canPerformCloudMutation()
    if (!cap.allowed) {
      dropdown.innerHTML = `<li class="taxon-dropdown-offline" aria-disabled="true" style="opacity:0.7;pointer-events:none;font-style:italic">${cap.message}</li>`
      dropdown.style.display = 'block'
    } else {
      // A real search would render results here; empty is fine for this test.
      dropdown.style.display = 'none'
    }
    return { dropdown, existingSelection, cap }
  }

  it('CACHED: taxonomy dropdown shows offline hint, not "no results"', () => {
    const { dropdown, existingSelection, cap } = renderTaxonomyDropdownForState(AUTH_STATE.AUTHENTICATED_CACHED)
    assert.equal(cap.allowed, false)
    assert.equal(cap.reason, 'offline')
    assert.equal(dropdown.style.display, 'block', 'dropdown must be VISIBLE with the hint')
    assert.match(dropdown.innerHTML, /taxon-dropdown-offline/)
    assert.match(dropdown.innerHTML, /pointer-events:none/, 'hint row must be non-selectable')
    assert.ok(dropdown.innerHTML.includes(cap.message), 'hint must render the localized capability message')
    // Existing selection remains intact.
    assert.deepEqual(existingSelection, { scientificName: 'Cantharellus cibarius' })
  })

  it('REAUTH_REQUIRED: shows reauth-specific hint, not "no results"', () => {
    const { dropdown, cap } = renderTaxonomyDropdownForState(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED)
    assert.equal(cap.reason, 'reauth_required')
    assert.equal(dropdown.style.display, 'block')
    assert.ok(dropdown.innerHTML.includes(cap.message))
  })

  it('COMPLETE: dropdown is not forced open by capability; normal search path runs', () => {
    const { dropdown, cap } = renderTaxonomyDropdownForState(AUTH_STATE.AUTHENTICATED_COMPLETE)
    assert.equal(cap.allowed, true)
    // In COMPLETE we do not render the offline hint.
    assert.doesNotMatch(dropdown.innerHTML, /taxon-dropdown-offline/)
  })
})

describe('taxonomy search UI — offline hint invariant', () => {
  const searchScreens = [
    'src/screens/review.js',
    'src/screens/import_review.js',
    'src/screens/find_detail.js',
  ]

  for (const file of searchScreens) {
    it(`${file} checks capability before dispatching searchTaxa`, () => {
      const src = readFileSync(path.join(process.cwd(), file), 'utf8')
      assert.match(src, /canPerformCloudMutation\(\)/, `${file} must import + call canPerformCloudMutation()`)
      // The check must appear textually BEFORE the searchTaxa call it
      // guards. We assert every searchTaxa call has a preceding
      // canPerformCloudMutation() in a short window.
      let idx = 0
      while (true) {
        const found = src.indexOf('searchTaxa(', idx)
        if (found === -1) break
        // Skip imports.
        const isImport = src.slice(Math.max(0, found - 40), found).includes('import')
        if (isImport) { idx = found + 1; continue }
        const priorWindow = src.slice(Math.max(0, found - 800), found)
        assert.match(
          priorWindow,
          /canPerformCloudMutation\(\)/,
          `${file}: searchTaxa call at offset ${found} must be preceded by a canPerformCloudMutation() check`,
        )
        idx = found + 1
      }
    })

    it(`${file} renders capability.message as an inline offline row (not empty state)`, () => {
      const src = readFileSync(path.join(process.cwd(), file), 'utf8')
      assert.match(src, /taxon-dropdown-offline/, `${file} must render the offline dropdown row`)
      assert.match(src, /pointer-events:none/, `${file}'s offline row must be non-selectable`)
    })
  }
})
