import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { supabase } from './supabase.js'
import {
  fetchMyReferenceSharing,
  shareAgainGuarded,
  shareReferenceSetAgain,
  sharedReferenceSetRowHtml,
  sharedReferencesEmptyHtml,
  sharedReferencesErrorHtml,
  sharedReferencesListHtml,
  sharedReferencesRateLimitedHtml,
  stopSharingReferenceSet,
  stopSharingWithConfirmation,
  stoppedSetIds,
} from './shared-references.js'
import { setLocale, t } from './i18n.js'

setLocale('en')

function withStubbedRpc(behavior, run) {
  const original = supabase.rpc
  const calls = []
  supabase.rpc = async (name, args) => { calls.push([name, args]); return behavior(name, args) }
  return Promise.resolve().then(() => run(calls)).finally(() => { supabase.rpc = original })
}

const LISTING = {
  contribution_id: 'c-1', sporely_taxon_id: 't-1', canonical_scientific_name: 'Amanita muscaria',
  current_revision: 2, shared_at: '2026-01-01T00:00:00Z', hidden_at: null,
}
const SHARED = {
  source_measurement_set_id: 'set-1', status: 'shared', stopped_at: null, hidden_by_moderation: false,
  public_observation_count: 3, species_page_contributions: [LISTING],
  source_short_label: 'Funga Nordica', source_raw_text: 'Spores 8-10 x 6-7',
}
const STOPPED = {
  ...SHARED, source_measurement_set_id: 'set-2', status: 'stopped', stopped_at: '2026-02-01T00:00:00Z',
  public_observation_count: 1, species_page_contributions: [],
}
const HIDDEN = {
  ...SHARED, source_measurement_set_id: 'set-3', status: 'hidden', hidden_by_moderation: true,
  species_page_contributions: [{ ...LISTING, hidden_at: '2026-03-01T00:00:00Z' }],
}

// ── Data ──

test('fetch: calls list_my_reference_sharing and returns sets', async () => {
  await withStubbedRpc(() => ({ data: { status: 'ok', sets: [SHARED] }, error: null }), async calls => {
    const result = await fetchMyReferenceSharing()
    assert.equal(calls[0][0], 'list_my_reference_sharing')
    assert.equal(result.kind, 'ok')
    assert.equal(result.sets[0].source_measurement_set_id, 'set-1')
  })
})

test('fetch: rate_limited, RPC error, thrown and unexpected responses', async () => {
  await withStubbedRpc(() => ({ data: { status: 'rate_limited', retry_after_seconds: 30 }, error: null }), async () => {
    assert.deepEqual(await fetchMyReferenceSharing(), { kind: 'rate_limited', retryAfterSeconds: 30 })
  })
  await withStubbedRpc(() => ({ data: null, error: { message: 'not signed in' } }), async () => {
    assert.deepEqual(await fetchMyReferenceSharing(), { kind: 'error', message: 'not signed in' })
  })
  await withStubbedRpc(() => { throw new Error('offline') }, async () => {
    assert.deepEqual(await fetchMyReferenceSharing(), { kind: 'error', message: 'offline' })
  })
  await withStubbedRpc(() => ({ data: { status: 'weird' }, error: null }), async () => {
    assert.equal((await fetchMyReferenceSharing()).kind, 'error')
  })
})

test('stop / share again: exact RPC names and set-keyed args; status mapping', async () => {
  for (const [fn, name] of [[stopSharingReferenceSet, 'stop_sharing_reference_set'], [shareReferenceSetAgain, 'share_reference_set_again']]) {
    for (const [status, kind] of [['updated', 'ok'], ['no_change', 'ok'], ['not_found', 'not_found'], ['rate_limited', 'rate_limited'], ['bogus', 'error']]) {
      await withStubbedRpc(() => ({ data: { status, row: null, retry_after_seconds: 5 }, error: null }), async calls => {
        const result = await fn('set-9')
        assert.deepEqual(calls, [[name, { p_source_measurement_set_id: 'set-9' }]])
        assert.equal(result.kind, kind)
        if (kind === 'rate_limited') assert.equal(result.retryAfterSeconds, 5)
      })
    }
    await withStubbedRpc(() => ({ data: null, error: { message: 'boom' } }), async () => {
      assert.deepEqual(await fn('set-9'), { kind: 'error', message: 'boom' })
    })
  }
})

test('stop sharing: confirmation first, then guard, then RPC', async () => {
  const calls = []
  let shown
  const cancelled = await stopSharingWithConfirmation('set-1', {
    confirm: m => { shown = m; calls.push('confirm'); return false },
    stop: async () => { calls.push('stop'); return { kind: 'ok' } },
  })
  assert.equal(cancelled.kind, 'cancelled')
  assert.deepEqual(calls, ['confirm'])
  assert.equal(shown, t('sharedReferences.stopConfirm'))
  assert.match(shown, /everywhere/)
  assert.match(shown, /species-page listing/)
  assert.match(shown, /Share again/)
  assert.match(shown, /cannot be recalled/)

  const blocked = await stopSharingWithConfirmation('set-1', {
    confirm: () => true, guard: () => false, stop: async () => { calls.push('stop2') },
  })
  assert.equal(blocked.kind, 'blocked')
  const ok = await stopSharingWithConfirmation('set-1', { confirm: () => true, stop: async id => ({ kind: 'ok', id }) })
  assert.deepEqual(ok, { kind: 'ok', id: 'set-1' })
  assert.ok(!calls.includes('stop2'))
})

test('share again: no confirmation, respects the guard', async () => {
  const blocked = await shareAgainGuarded('set-2', { guard: () => false, shareAgain: async () => assert.fail('called') })
  assert.equal(blocked.kind, 'blocked')
  assert.deepEqual(await shareAgainGuarded('set-2', { shareAgain: async id => ({ kind: 'ok', id }) }), { kind: 'ok', id: 'set-2' })
})

test('stoppedSetIds: stopped and hidden-but-stopped sets', () => {
  const ids = stoppedSetIds([SHARED, STOPPED, { ...HIDDEN, stopped_at: '2026-01-01T00:00:00Z' }, { ...HIDDEN, source_measurement_set_id: 'set-4' }])
  assert.deepEqual([...ids].sort(), ['set-2', 'set-3'])
})

// ── Rendering ──

test('render: shared set shows status, source, public count, species listing and Stop sharing', () => {
  const html = sharedReferenceSetRowHtml(SHARED)
  assert.match(html, /data-set-id="set-1"/)
  assert.match(html, />Shared</)
  assert.match(html, /Funga Nordica · Spores 8-10 x 6-7/)
  assert.match(html, /Public observations using it: 3/)
  assert.match(html, /Species-page listing:/)
  assert.match(html, /<em>Amanita muscaria<\/em>/)
  assert.match(html, /shared-ref-stop-btn/)
  assert.doesNotMatch(html, /shared-ref-share-again-btn/)
})

test('render: stopped set shows Stopped, date, no listing and Share again', () => {
  const html = sharedReferenceSetRowHtml(STOPPED)
  assert.match(html, />Stopped</)
  assert.match(html, /Stopped \S/)
  assert.match(html, /Not listed on a species page/)
  assert.match(html, /shared-ref-share-again-btn/)
  assert.doesNotMatch(html, /shared-ref-stop-btn/)
})

test('render: hidden set shows Hidden by moderation and keeps Stop sharing unless stopped', () => {
  const html = sharedReferenceSetRowHtml(HIDDEN)
  assert.match(html, /shared-ref-status-hidden">Hidden by moderation</)
  assert.match(html, /shared-ref-stop-btn/)
  const hiddenStopped = sharedReferenceSetRowHtml({ ...HIDDEN, stopped_at: '2026-02-01T00:00:00Z' })
  assert.match(hiddenStopped, /shared-ref-share-again-btn/)
})

test('render: escapes server text; unnamed fallback; list and empty/error/rate-limited states', () => {
  const html = sharedReferenceSetRowHtml({
    ...SHARED, source_short_label: '<b>x</b>', source_raw_text: null,
    species_page_contributions: [{ ...LISTING, canonical_scientific_name: '<script>' }],
  })
  assert.doesNotMatch(html, /<b>x<\/b>|<script>/)
  assert.match(sharedReferenceSetRowHtml({ ...SHARED, source_short_label: ' ', source_raw_text: null }), /Unnamed reference/)
  const list = sharedReferencesListHtml([SHARED, STOPPED, HIDDEN])
  assert.equal((list.match(/class="friend-row shared-ref-row"/g) || []).length, 3)
  assert.equal(sharedReferencesListHtml([]), sharedReferencesEmptyHtml())
  assert.match(sharedReferencesErrorHtml('boom'), /boom/)
  assert.match(sharedReferencesRateLimitedHtml(12), /12s/)
})

test('i18n: every sharedReferences.* en key exists in nb_NO, sv_SE and de_DE; reasons removed', () => {
  const source = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')
  const order = ['en', 'nb_NO', 'sv_SE', 'de_DE']
  const idx = order.map(l => source.indexOf(`\n  ${l}: {`)).concat(source.length)
  const blocks = order.map((_, i) => source.slice(idx[i], idx[i + 1]))
  const keys = [...blocks[0].matchAll(/'(sharedReferences\.[a-zA-Z.]+)':\s*'/g)].map(m => m[1])
  assert.ok(keys.includes('sharedReferences.shareAgain') && keys.includes('sharedReferences.statusStopped'))
  for (const block of blocks.slice(1)) for (const key of keys) assert.ok(block.includes(`'${key}':`), key)
  assert.doesNotMatch(source, /sharedReferences\.reason\./)
  const de = blocks[3].split('\n').filter(l => l.includes("'sharedReferences.")).join('\n')
  assert.doesNotMatch(de, /\b(Sie|Ihr|Ihre|Ihnen)\b/)
})
