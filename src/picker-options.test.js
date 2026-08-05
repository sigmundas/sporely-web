import test from 'node:test'
import assert from 'node:assert/strict'

import { PICKER_OPTIONS_AVATAR, PICKER_OPTIONS_IMPORT } from './screens/import-helpers.js'

// The native side's picker-implementation decision depends on all four flags.
// If these presets drift, Profile avatar could accidentally launch the
// EXIF-reading document picker with a persistent-permission grant, and
// Import Photos could accidentally lose EXIF/GPS. Freezing them prevents
// mutation and this test locks the values.

test('PICKER_OPTIONS_IMPORT preserves multi-select + EXIF + media-location + persistent read', () => {
  assert.deepEqual({ ...PICKER_OPTIONS_IMPORT }, {
    multiple: true,
    includeExif: true,
    requestMediaLocation: true,
    persistReadPermission: true,
  })
})

test('PICKER_OPTIONS_AVATAR is single-image, no EXIF, no media-location, no persistent read', () => {
  assert.deepEqual({ ...PICKER_OPTIONS_AVATAR }, {
    multiple: false,
    includeExif: false,
    requestMediaLocation: false,
    persistReadPermission: false,
  })
})

test('presets are frozen so callers cannot mutate them in place', () => {
  assert.equal(Object.isFrozen(PICKER_OPTIONS_IMPORT), true)
  assert.equal(Object.isFrozen(PICKER_OPTIONS_AVATAR), true)
})
