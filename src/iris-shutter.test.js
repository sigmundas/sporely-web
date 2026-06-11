import test from 'node:test'
import assert from 'node:assert/strict'

import { buildIrisBladePathData } from './iris-shutter.js'

test('iris blade path samples a curved inner edge', () => {
  const path = buildIrisBladePathData({
    bladeSamples: 20,
    bladeCurveExponent: 2.4,
    bladeCurveStrength: 20,
  })

  assert.ok(path.startsWith('M '))
  assert.ok(path.includes('Q '))
  assert.ok((path.match(/L /g) || []).length >= 20)
})
