import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { supabase } from './supabase.js'
import {
  fetchMySharedReferenceContributions,
  sharedReferenceRowHtml,
  sharedReferencesEmptyHtml,
  sharedReferencesErrorHtml,
  sharedReferencesListHtml,
  sharedReferencesRateLimitedHtml,
  stopSharingWithConfirmation,
  withdrawSharedReferenceContribution,
} from './shared-references.js'
import { t } from './i18n.js'

function withStubbedRpc(behavior, run) {
  const original = supabase.rpc
  supabase.rpc = async (name, args) => behavior(name, args)
  return Promise.resolve().then(run).finally(() => {
    supabase.rpc = original
  })
}

const SHARED_ROW = {
  contribution_id: 'contrib-1',
  status: 'shared',
  sporely_taxon_id: 'taxon-1',
  canonical_scientific_name: 'Amanita muscaria',
  current_revision: 2,
  shared_at: '2026-01-01T00:00:00Z',
  withdrawn_at: null,
}

const WITHDRAWN_ROW = {
  contribution_id: 'contrib-2',
  status: 'withdrawn',
  sporely_taxon_id: 'taxon-2',
  canonical_scientific_name: 'Boletus edulis',
  current_revision: 1,
  shared_at: '2026-01-02T00:00:00Z',
  withdrawn_at: '2026-01-03T00:00:00Z',
}

// ── fetchMySharedReferenceContributions ────────────────────────────────────

test('fetch: ok status returns contributions', async () => {
  await withStubbedRpc(
    () => ({ data: { status: 'ok', contributions: [SHARED_ROW] }, error: null }),
    async () => {
      const result = await fetchMySharedReferenceContributions()
      assert.equal(result.kind, 'ok')
      assert.equal(result.contributions.length, 1)
      assert.equal(result.contributions[0].contribution_id, 'contrib-1')
    },
  )
})

test('fetch: rate_limited status is surfaced with retry_after_seconds', async () => {
  await withStubbedRpc(
    () => ({ data: { status: 'rate_limited', retry_after_seconds: 30 }, error: null }),
    async () => {
      const result = await fetchMySharedReferenceContributions()
      assert.equal(result.kind, 'rate_limited')
      assert.equal(result.retryAfterSeconds, 30)
    },
  )
})

test('fetch: RPC error (e.g. not signed in) surfaces as error', async () => {
  await withStubbedRpc(
    () => ({ data: null, error: { message: 'not signed in' } }),
    async () => {
      const result = await fetchMySharedReferenceContributions()
      assert.equal(result.kind, 'error')
      assert.match(result.message, /not signed in/)
    },
  )
})

test('fetch: thrown rejection is caught and surfaced as error', async () => {
  const original = supabase.rpc
  supabase.rpc = async () => { throw new Error('network down') }
  try {
    const result = await fetchMySharedReferenceContributions()
    assert.equal(result.kind, 'error')
    assert.match(result.message, /network down/)
  } finally {
    supabase.rpc = original
  }
})

// ── withdrawSharedReferenceContribution ────────────────────────────────────

test('withdraw: calls the exact RPC name and args', async () => {
  let seenName, seenArgs
  await withStubbedRpc(
    (name, args) => { seenName = name; seenArgs = args; return { data: { status: 'updated' }, error: null } },
    async () => {
      await withdrawSharedReferenceContribution('contrib-1')
    },
  )
  assert.equal(seenName, 'withdraw_reference_contribution')
  assert.deepEqual(seenArgs, { p_contribution_id: 'contrib-1' })
})

for (const status of ['updated', 'no_change']) {
  test(`withdraw: '${status}' status is treated as success`, async () => {
    await withStubbedRpc(
      () => ({ data: { status }, error: null }),
      async () => {
        const result = await withdrawSharedReferenceContribution('contrib-1')
        assert.equal(result.kind, 'ok')
      },
    )
  })
}

test('withdraw: rate_limited status is surfaced', async () => {
  await withStubbedRpc(
    () => ({ data: { status: 'rate_limited', retry_after_seconds: 15 }, error: null }),
    async () => {
      const result = await withdrawSharedReferenceContribution('contrib-1')
      assert.equal(result.kind, 'rate_limited')
      assert.equal(result.retryAfterSeconds, 15)
    },
  )
})

test('withdraw: forbidden / not_found statuses pass through distinctly', async () => {
  await withStubbedRpc(
    () => ({ data: { status: 'forbidden' }, error: null }),
    async () => {
      const result = await withdrawSharedReferenceContribution('contrib-1')
      assert.equal(result.kind, 'forbidden')
    },
  )
  await withStubbedRpc(
    () => ({ data: { status: 'not_found' }, error: null }),
    async () => {
      const result = await withdrawSharedReferenceContribution('contrib-1')
      assert.equal(result.kind, 'not_found')
    },
  )
})

// ── rendering ───────────────────────────────────────────────────────────────

test('render: empty list shows empty state', () => {
  assert.equal(sharedReferencesListHtml([]), sharedReferencesEmptyHtml())
  assert.match(sharedReferencesEmptyHtml(), /havent|haven|delt noen/i)
})

test('render: shared row shows Stop sharing button', () => {
  const html = sharedReferenceRowHtml(SHARED_ROW)
  assert.match(html, /shared-ref-stop-btn/)
  assert.match(html, /data-contribution-id="contrib-1"/)
  assert.match(html, /<em>Amanita muscaria<\/em>/)
  assert.match(html, /Revision 2|Revisjon 2/)
})

test('render: withdrawn row has no Stop sharing button and shows stopped date', () => {
  const html = sharedReferenceRowHtml(WITHDRAWN_ROW)
  assert.doesNotMatch(html, /shared-ref-stop-btn/)
  assert.match(html, /<em>Boletus edulis<\/em>/)
})

test('render: list renders both shared and withdrawn rows', () => {
  const html = sharedReferencesListHtml([SHARED_ROW, WITHDRAWN_ROW])
  assert.match(html, /contrib-1/)
  assert.match(html, /contrib-2/)
  const withdrawnRowStart = html.indexOf('contrib-2')
  assert.ok(withdrawnRowStart > -1)
})

test('render: server-provided species name is escaped', () => {
  const malicious = { ...SHARED_ROW, canonical_scientific_name: '<img src=x onerror=alert(1)>' }
  const html = sharedReferenceRowHtml(malicious)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('render: error and rate_limited states produce distinct messages', () => {
  const errHtml = sharedReferencesErrorHtml('boom')
  const rateHtml = sharedReferencesRateLimitedHtml(42)
  assert.match(errHtml, /boom/)
  assert.match(rateHtml, /42/)
  assert.notEqual(errHtml, rateHtml)
})

// ── i18n coverage ───────────────────────────────────────────────────────────
// i18n.js is a flat `messages = { en: {...}, nb_NO: {...}, ... }` literal with
// no DOM-free accessor for a specific locale's dictionary, so this checks the
// source text directly: every 'sharedReferences.*' key must appear at least
// twice (once per locale block) with a non-empty string value.

test('i18n: all sharedReferences.* keys exist with values in en and nb_NO', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
  const enIndex = source.indexOf("en: {")
  const nbIndex = source.indexOf("nb_NO: {")
  const svIndex = source.indexOf("sv_SE: {")
  assert.ok(enIndex > -1 && nbIndex > -1 && svIndex > -1, 'expected en/nb_NO/sv_SE blocks in i18n.js')
  const enBlock = source.slice(enIndex, nbIndex)
  const nbBlock = source.slice(nbIndex, svIndex)

  const keyPattern = /'(sharedReferences\.[a-zA-Z]+)':\s*'([^']*(?:\\.[^']*)*)'/g
  const enKeys = new Map([...enBlock.matchAll(keyPattern)].map(m => [m[1], m[2]]))
  assert.ok(enKeys.size >= 12, `expected the sharedReferences.* keys in en, found ${enKeys.size}`)

  const nbMatches = new Map([...nbBlock.matchAll(keyPattern)].map(m => [m[1], m[2]]))
  for (const [key, enValue] of enKeys) {
    assert.ok(enValue.length > 0, `en.${key} is empty`)
    assert.ok(nbMatches.has(key), `nb_NO is missing ${key}`)
    assert.ok(nbMatches.get(key).length > 0, `nb_NO.${key} is empty`)
  }
})

// ── stopSharingWithConfirmation ────────────────────────────────────────────

test('stop sharing: shows the what-cannot-be-undone confirmation before any RPC', async () => {
  const calls = []
  let shownMessage
  const result = await stopSharingWithConfirmation('contrib-1', {
    confirm: message => { shownMessage = message; calls.push('confirm'); return false },
    withdraw: async () => { calls.push('withdraw'); return { kind: 'ok' } },
  })
  assert.equal(result.kind, 'cancelled')
  assert.deepEqual(calls, ['confirm'])
  assert.equal(shownMessage, t('sharedReferences.stopConfirm'))
  assert.match(shownMessage, /copies other users/)
})

test('stop sharing: withdraws only after confirmation and the cloud guard', async () => {
  const calls = []
  const blocked = await stopSharingWithConfirmation('contrib-1', {
    confirm: () => { calls.push('confirm'); return true },
    guard: () => { calls.push('guard'); return false },
    withdraw: async () => { calls.push('withdraw'); return { kind: 'ok' } },
  })
  assert.equal(blocked.kind, 'blocked')
  assert.deepEqual(calls, ['confirm', 'guard'])
  let seenId
  const ok = await stopSharingWithConfirmation('contrib-1', {
    confirm: () => true,
    withdraw: async id => { seenId = id; return { kind: 'ok' } },
  })
  assert.equal(ok.kind, 'ok')
  assert.equal(seenId, 'contrib-1')
})

// ── Hidden, withdrawal reason and source labels ────────────────────────────

test('row: hidden shared row shows "Hidden by moderation" and keeps Stop sharing', () => {
  const html = sharedReferenceRowHtml({ ...SHARED_ROW, hidden_at: '2026-02-01T00:00:00Z' })
  assert.ok(html.includes(t('sharedReferences.hiddenByModeration')))
  assert.match(html, /shared-ref-stop-btn/)
  assert.ok(!sharedReferenceRowHtml(SHARED_ROW).includes(t('sharedReferences.hiddenByModeration')))
})

test('row: withdrawn row shows the withdrawal reason; unknown reasons fall back', () => {
  const html = sharedReferenceRowHtml({ ...WITHDRAWN_ROW, withdrawal_reason: 'consent_text_revoked' })
  assert.ok(html.includes(t('sharedReferences.reason.consent_text_revoked')))
  const unknown = sharedReferenceRowHtml({ ...WITHDRAWN_ROW, withdrawal_reason: 'something_new' })
  assert.ok(unknown.includes(t('sharedReferences.reason.other')))
  assert.ok(!sharedReferenceRowHtml({ ...SHARED_ROW, withdrawal_reason: null })
    .includes(t('sharedReferences.reason.other')))
})

test('row: source labels distinguish sets and are escaped', () => {
  const html = sharedReferenceRowHtml({
    ...SHARED_ROW, source_short_label: 'Smith <1998>', source_raw_text: '8–10 × 5–6 µm',
  })
  assert.ok(html.includes('Smith &lt;1998&gt; · 8–10 × 5–6 µm'))
  assert.ok(!html.includes('<1998>'))
})
