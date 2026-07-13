import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  PHOTO_ID_MODE_AUTO,
  PHOTO_ID_MODE_BOTH,
  PHOTO_ID_MODE_INATURALIST,
  getLocationPreference,
  resolvePhotoIdServices,
  setLocationPreference,
} from './settings.js'

function createLocalStorageStub() {
  const store = new Map()
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
    removeItem(key) {
      store.delete(String(key))
    },
    clear() {
      store.clear()
    },
  }
}

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

test('location preference is persisted independently of geolocation permission', () => {
  const originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = createLocalStorageStub()

  try {
    assert.equal(getLocationPreference(), 'ask')
    assert.equal(setLocationPreference('enabled'), 'enabled')
    assert.equal(globalThis.localStorage.getItem('sporely-location-preference'), 'enabled')
    assert.equal(getLocationPreference(), 'enabled')
    assert.equal(setLocationPreference('disabled'), 'disabled')
    assert.equal(globalThis.localStorage.getItem('sporely-location-preference'), 'disabled')
    assert.equal(setLocationPreference('something-else'), 'ask')
    assert.equal(getLocationPreference(), 'ask')
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})
