import test from 'node:test'
import assert from 'node:assert/strict'

import { isPrivacySlotLimitError, PRIVACY_SLOT_LIMIT_USER_MESSAGE } from './sync-queue.js'

test('isPrivacySlotLimitError matches the privacy-cap server payload', () => {
  assert.equal(
    isPrivacySlotLimitError({
      code: '23514',
      message: 'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.',
    }),
    true,
  )
  assert.equal(
    isPrivacySlotLimitError({
      error: {
        code: '23514',
        message: 'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.',
      },
    }),
    true,
  )
})

test('isPrivacySlotLimitError handles nested Supabase response text', () => {
  assert.equal(
    isPrivacySlotLimitError(
      'POST observations: {"code":"23514","message":"Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue."}',
    ),
    true,
  )
})

test('isPrivacySlotLimitError ignores unrelated check violations', () => {
  assert.equal(
    isPrivacySlotLimitError({
      code: '23514',
      message: 'Some other check constraint failed.',
    }),
    false,
  )
})

test('privacy slot blocked message is user-facing', () => {
  assert.match(PRIVACY_SLOT_LIMIT_USER_MESSAGE, /Free accounts can have up to 20 private or fuzzed-location cloud observations/)
  assert.doesNotMatch(PRIVACY_SLOT_LIMIT_USER_MESSAGE, /privacy slot observations/i)
})
