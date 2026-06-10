import test from 'node:test'
import assert from 'node:assert/strict'

import { isTinyCameraCaptureDimensions } from './capture.js'

test('tiny camera capture dimensions reject degraded iOS fallback frames', () => {
  assert.equal(isTinyCameraCaptureDimensions(144, 192), true)
  assert.equal(isTinyCameraCaptureDimensions(3024, 4032), false)
  assert.equal(isTinyCameraCaptureDimensions(800, 999), true)
  assert.equal(isTinyCameraCaptureDimensions(1000, 800), false)
})
