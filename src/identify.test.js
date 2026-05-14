import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatIdentifyScore,
  runInaturalistForBlobs,
} from './identify.js'
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
