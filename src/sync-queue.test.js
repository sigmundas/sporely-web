import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_USER_MESSAGE,
  isImageTooLargeForPlanError,
  isPrivacySlotLimitError,
} from './sync-queue.js'

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

test('isImageTooLargeForPlanError matches the plan-size server payload', () => {
  assert.equal(
    isImageTooLargeForPlanError({
      code: 'image_too_large_for_plan',
      message: 'Image too large for plan',
    }),
    true,
  )
  assert.equal(
    isImageTooLargeForPlanError({
      code: '23514',
      message: 'Free Sporely accounts can keep up to 20 privacy slot observations.',
    }),
    false,
  )
  assert.match(IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE, /image is too large for your plan/i)
})
