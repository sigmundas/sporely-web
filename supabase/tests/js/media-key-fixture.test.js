// §K cross-language fixture, JS side for today's Worker (plan 2026-10-20
// media-key retirement, Stage 0a). The SQL side is
// supabase/tests/media_key_family_fixture_test.sh. The full JS root/family
// implementation arrives with the Worker in Stage 0b and must then be checked
// against the same fixture; until then this asserts that every thumb key the
// Worker derives stays inside the fixture's family and root.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveThumbKey } from '../../../cloudflare/r2-upload-worker/src/index.js'

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/media_key_family_fixture.json', import.meta.url), 'utf8'),
)
const byKey = new Map(fixture.cases.filter(c => c.key).map(c => [c.key.trim().replace(/^\/+|\/+$/g, ''), c]))

test('§K fixture: Worker deriveThumbKey stays in the SQL family and root', () => {
  let checked = 0
  for (const c of fixture.cases) {
    if (!c.key || !c.key.trim() || c.root === null || c.valid === false) continue
    if (c.key.split('/').includes('originals')) continue // originals are never thumbed
    const normalized = c.key.trim().replace(/^\/+|\/+$/g, '')
    const thumb = deriveThumbKey(normalized)
    assert.ok(c.family.includes(thumb), `${thumb} (from ${c.key}) missing from its family`)
    const thumbCase = byKey.get(thumb)
    if (thumbCase) assert.equal(thumbCase.root, c.root, `root(${thumb}) differs from root(${c.key})`)
    checked += 1
  }
  assert.ok(checked >= 15)
})

test('§K fixture: covers the plan-required forms', () => {
  const keys = new Set(fixture.cases.map(c => c.key))
  for (const k of ['u/o/small_thumb_f.webp', 'u/o/thumb_small_thumb_f.webp', 'u/o/thumb_thumb_f.webp',
    'u/o/thumb_small_f.webp', 'u/o/thumb_medium_f.webp', 'u/o/small_photo.webp', 'u/originals/12/IMG_1.jpg']) {
    assert.ok(keys.has(k), `fixture lacks ${k}`)
  }
})
