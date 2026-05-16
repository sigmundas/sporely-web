import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatIdentifyScore,
  runInaturalistForBlobs,
} from './identify.js'
import { prepareImageBlobForUpload } from './image_crop.js'
import {
  getDefaultIdService,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  PHOTO_ID_MODE_AUTO,
  PHOTO_ID_MODE_ARTSORAKEL,
  PHOTO_ID_MODE_INATURALIST,
  PHOTO_ID_MODE_BOTH,
  getPhotoIdMode,
  normalizeIdentifyService,
  normalizePhotoIdMode,
  resolvePhotoIdServices,
  setPhotoIdMode,
} from './settings.js'

function createLocalStorageStub() {
  const values = new Map()
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

test('normalizes and migrates AI Photo ID mode settings', () => {
  const original = globalThis.localStorage
  globalThis.localStorage = createLocalStorageStub()

  try {
    assert.equal(normalizePhotoIdMode('auto'), PHOTO_ID_MODE_AUTO)
    assert.equal(normalizePhotoIdMode('artsorakel'), PHOTO_ID_MODE_ARTSORAKEL)
    assert.equal(normalizePhotoIdMode('inat'), PHOTO_ID_MODE_INATURALIST)
    assert.equal(normalizePhotoIdMode('both'), PHOTO_ID_MODE_BOTH)
    assert.equal(normalizePhotoIdMode('Artsorakel'), PHOTO_ID_MODE_ARTSORAKEL)
    assert.equal(normalizeIdentifyService('inat'), ID_SERVICE_INATURALIST)
    assert.equal(normalizeIdentifyService('Artsorakel'), ID_SERVICE_ARTSORAKEL)

    localStorage.setItem('sporely-default-id-service', 'inat')
    assert.equal(getPhotoIdMode(), PHOTO_ID_MODE_INATURALIST)
    assert.equal(localStorage.getItem('sporely-photo-id-mode'), PHOTO_ID_MODE_INATURALIST)
    assert.equal(getDefaultIdService(), ID_SERVICE_INATURALIST)

    setPhotoIdMode('artsorakel')
    assert.equal(getPhotoIdMode(), PHOTO_ID_MODE_ARTSORAKEL)
    assert.equal(getDefaultIdService(), ID_SERVICE_ARTSORAKEL)
  } finally {
    globalThis.localStorage = original
  }
})

test('resolves photo ID services by mode, country, and iNaturalist availability', () => {
  const autoNorway = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryCode: 'no',
    inaturalistAvailable: true,
  })
  assert.equal(autoNorway.primary, ID_SERVICE_ARTSORAKEL)
  assert.deepEqual(autoNorway.run, [ID_SERVICE_ARTSORAKEL])

  const autoCountryName = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryName: 'Norge',
    inaturalistAvailable: true,
  })
  assert.equal(autoCountryName.primary, ID_SERVICE_ARTSORAKEL)

  for (const countryCode of ['se', 'dk', 'fi']) {
    const result = resolvePhotoIdServices({
      mode: PHOTO_ID_MODE_AUTO,
      countryCode,
      inaturalistAvailable: true,
    })
    assert.equal(result.primary, ID_SERVICE_ARTSORAKEL, countryCode)
    assert.deepEqual(result.run, [ID_SERVICE_ARTSORAKEL], countryCode)
  }

  const autoOutsideNordics = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryCode: 'us',
    inaturalistAvailable: true,
  })
  assert.equal(autoOutsideNordics.primary, ID_SERVICE_INATURALIST)
  assert.deepEqual(autoOutsideNordics.run, [ID_SERVICE_INATURALIST])

  const autoOutsideNordicsNoLogin = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    countryCode: 'us',
    inaturalistAvailable: false,
  })
  assert.equal(autoOutsideNordicsNoLogin.primary, ID_SERVICE_ARTSORAKEL)
  assert.deepEqual(autoOutsideNordicsNoLogin.run, [ID_SERVICE_ARTSORAKEL])
  assert.equal(autoOutsideNordicsNoLogin.available.inat, false)
  assert.equal(autoOutsideNordicsNoLogin.disabledReason.inat, 'login_required')

  const autoLocaleHint = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_AUTO,
    locale: 'nb_NO',
    inaturalistAvailable: true,
  })
  assert.equal(autoLocaleHint.primary, ID_SERVICE_ARTSORAKEL)
  assert.deepEqual(autoLocaleHint.run, [ID_SERVICE_ARTSORAKEL])

  const bothLoggedIn = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_BOTH,
    countryCode: 'us',
    inaturalistAvailable: true,
  })
  assert.deepEqual(bothLoggedIn.run, [ID_SERVICE_INATURALIST, ID_SERVICE_ARTSORAKEL])

  const bothNoLogin = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_BOTH,
    countryCode: 'us',
    inaturalistAvailable: false,
  })
  assert.deepEqual(bothNoLogin.run, [ID_SERVICE_ARTSORAKEL])
  assert.equal(bothNoLogin.available.inat, false)

  const inatNoLogin = resolvePhotoIdServices({
    mode: PHOTO_ID_MODE_INATURALIST,
    countryCode: 'us',
    inaturalistAvailable: false,
  })
  assert.equal(inatNoLogin.primary, ID_SERVICE_INATURALIST)
  assert.deepEqual(inatNoLogin.run, [])
  assert.equal(inatNoLogin.disabledReason.inat, 'login_required')
})

test('formats identification scores per service', () => {
  assert.equal(formatIdentifyScore(ID_SERVICE_INATURALIST, 0.8734), '87%')
  assert.equal(formatIdentifyScore(ID_SERVICE_INATURALIST, 87.34), '87%')
  assert.equal(formatIdentifyScore(ID_SERVICE_ARTSORAKEL, 0.8734), '0.87')
})

test('builds an iNaturalist suggestion request and normalizes the response', async () => {
  const storage = {
    values: new Map([
      ['sporely.inat.oauth.api_token', 'test-jwt'],
    ]),
    async getItem(key) {
      return this.values.has(key) ? this.values.get(key) : null
    },
    async setItem(key, value) {
      this.values.set(key, String(value))
    },
    async removeItem(key) {
      this.values.delete(key)
    },
  }

  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      async json() {
        return {
          results: [
            {
              combined_score: 82,
              taxon: {
                id: 12345,
                name: 'Amanita muscaria',
                preferred_common_name: 'Fly agaric',
              },
            },
          ],
        }
      },
    }
  }

  const predictions = await runInaturalistForBlobs([new Blob(['x'], { type: 'image/jpeg' })], 'en', {
    storage,
    fetchImpl,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.inaturalist.org/v2/taxa/suggest')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-jwt')
  assert.equal(calls[0].options.body.get('source'), 'visual')
  assert.equal(calls[0].options.body.get('locale'), 'en')
  assert.equal(calls[0].options.body.get('image') instanceof Blob, true)
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].displayName, 'Fly agaric (Amanita muscaria)')
  assert.equal(predictions[0].probability, 0.82)
})

test('sorts single-image iNaturalist predictions from high to low probability', async () => {
  const storage = {
    values: new Map([
      ['sporely.inat.oauth.api_token', 'test-jwt'],
    ]),
    async getItem(key) {
      return this.values.has(key) ? this.values.get(key) : null
    },
    async setItem(key, value) {
      this.values.set(key, String(value))
    },
    async removeItem(key) {
      this.values.delete(key)
    },
  }

  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        results: [
          {
            combined_score: 12,
            taxon: {
              id: 3,
              name: 'Taxon three',
              preferred_common_name: 'Third',
            },
          },
          {
            combined_score: 93,
            taxon: {
              id: 1,
              name: 'Taxon one',
              preferred_common_name: 'First',
            },
          },
          {
            combined_score: 71,
            taxon: {
              id: 2,
              name: 'Taxon two',
              preferred_common_name: 'Second',
            },
          },
        ],
      }
    },
  })

  const predictions = await runInaturalistForBlobs([new Blob(['x'], { type: 'image/jpeg' })], 'en', {
    storage,
    fetchImpl,
  })

  assert.deepEqual(predictions.map(prediction => prediction.probability), [0.93, 0.71, 0.12])
  assert.deepEqual(predictions.map(prediction => prediction.displayName), [
    'First (Taxon one)',
    'Second (Taxon two)',
    'Third (Taxon three)',
  ])
})

test('converts non-JPEG image uploads to JPEG for AI inference', async () => {
  const originalImage = globalThis.Image
  const originalDocument = globalThis.document
  const originalURL = globalThis.URL

  class FakeImage {
    constructor() {
      this.naturalWidth = 1600
      this.naturalHeight = 1200
      this.width = 1600
      this.height = 1200
    }

    set src(_value) {
      queueMicrotask(() => this.onload?.())
    }
  }

  globalThis.Image = FakeImage
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return null
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {},
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high',
          }
        },
        toBlob(callback) {
          callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
        },
      }
    },
  }
  globalThis.URL = {
    createObjectURL() {
      return 'blob:fake'
    },
    revokeObjectURL() {},
  }

  try {
    const prepared = await prepareImageBlobForUpload(new Blob(['x'], { type: 'image/png' }), {
      forceJpeg: true,
      maxEdge: 1920,
    })

    assert.equal(prepared.blob.type, 'image/jpeg')
    assert.equal(prepared.outputType, 'image/jpeg')
    assert.equal(prepared.prepared, true)
  } finally {
    globalThis.Image = originalImage
    globalThis.document = originalDocument
    globalThis.URL = originalURL
  }
})
