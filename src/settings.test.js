import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  PHOTO_ID_MODE_AUTO,
  PHOTO_ID_MODE_BOTH,
  PHOTO_ID_MODE_INATURALIST,
  resolvePhotoIdServices,
} from './settings.js'

test('resolvePhotoIdServices respects inaturalist-only mode with and without login', () => {
  const loggedIn = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_INATURALIST,
    inaturalistAvailable: true,
  })
  assert.equal(loggedIn.primary, ID_SERVICE_INATURALIST)
  assert.deepEqual(loggedIn.run, [ID_SERVICE_INATURALIST])

  const loggedOut = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_INATURALIST,
    inaturalistAvailable: false,
  })
  assert.equal(loggedOut.primary, ID_SERVICE_INATURALIST)
  assert.deepEqual(loggedOut.run, [])
  assert.equal(loggedOut.disabledReason[ID_SERVICE_INATURALIST], 'login_required')
})

test('resolvePhotoIdServices runs both services only when both are available', () => {
  const loggedIn = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_BOTH,
    inaturalistAvailable: true,
  })
  assert.equal(loggedIn.run.length, 2)
  assert.match(loggedIn.run.join(','), /artsorakel/)
  assert.match(loggedIn.run.join(','), /inat/)

  const loggedOut = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_BOTH,
    inaturalistAvailable: false,
  })
  assert.deepEqual(loggedOut.run, [ID_SERVICE_ARTSORAKEL])
})

test('resolvePhotoIdServices picks Artsorakel for Nordic auto and iNaturalist elsewhere when logged in', () => {
  const nordic = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryCode: 'no',
    inaturalistAvailable: true,
  })
  assert.equal(nordic.primary, ID_SERVICE_ARTSORAKEL)
  assert.deepEqual(nordic.run, [ID_SERVICE_ARTSORAKEL])

  const elsewhere = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryCode: 'de',
    inaturalistAvailable: true,
  })
  assert.equal(elsewhere.primary, ID_SERVICE_INATURALIST)
  assert.deepEqual(elsewhere.run, [ID_SERVICE_INATURALIST])
})
