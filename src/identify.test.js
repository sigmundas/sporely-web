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
  normalizeIdentifyService,
  setDefaultIdService,
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

test('normalizes and persists the default identification service', () => {
  const original = globalThis.localStorage
  globalThis.localStorage = createLocalStorageStub()

  try {
    assert.equal(normalizeIdentifyService('inat'), ID_SERVICE_INATURALIST)
    assert.equal(normalizeIdentifyService('Artsorakel'), ID_SERVICE_ARTSORAKEL)
    assert.equal(getDefaultIdService(), ID_SERVICE_ARTSORAKEL)

    setDefaultIdService('inat')
    assert.equal(getDefaultIdService(), ID_SERVICE_INATURALIST)

    setDefaultIdService('anything-else')
    assert.equal(getDefaultIdService(), ID_SERVICE_ARTSORAKEL)
  } finally {
    globalThis.localStorage = original
  }
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
