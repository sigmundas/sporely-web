import test from 'node:test'
import assert from 'node:assert/strict'

import { observationUsesPrivacySlot } from './visibility.js'

test('privacy slot helper ignores drafts and matches published protected observations', () => {
  assert.equal(
    observationUsesPrivacySlot({
      is_draft: true,
      visibility: 'private',
      location_precision: 'fuzzed',
    }),
    false,
  )

  assert.equal(
    observationUsesPrivacySlot({
      is_draft: false,
      visibility: 'private',
      location_precision: 'exact',
    }),
    true,
  )

  assert.equal(
    observationUsesPrivacySlot({
      is_draft: false,
      visibility: 'public',
      location_precision: 'fuzzed',
    }),
    true,
  )

  assert.equal(
    observationUsesPrivacySlot({
      is_draft: false,
      visibility: 'public',
      location_precision: 'exact',
    }),
    false,
  )
})
