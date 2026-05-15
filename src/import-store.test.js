import test from 'node:test'
import assert from 'node:assert/strict'

import { loadImportSessions, saveImportSessions } from './import-store.js'

function createIndexedDbStub() {
  const records = []

  class Store {
    clear() {
      records.length = 0
    }

    put(record) {
      records.push(record)
    }

    getAll() {
      const request = {}
      queueMicrotask(() => {
        request.result = records.map(record => structuredClone(record))
        request.onsuccess?.({ target: request })
      })
      return request
    }
  }

  const store = new Store()

  return {
    records,
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: {
            contains() {
              return true
            },
          },
          createObjectStore() {},
          transaction() {
            let completed = false
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore() {
                return {
                  clear() {
                    store.clear()
                    finish()
                  },
                  put(record) {
                    store.put(record)
                    finish()
                  },
                  getAll() {
                    return store.getAll()
                  },
                }
              },
            }
            const finish = () => {
              if (completed) return
              completed = true
              queueMicrotask(() => tx.oncomplete?.())
            }
            return tx
          },
          close() {},
        }
        request.onsuccess?.({ target: request })
      })
      return request
    },
  }
}

test('import sessions preserve blob types when saved and restored', async () => {
  const previousIndexedDb = globalThis.indexedDB
  const previousUrl = globalThis.URL
  const previousQueueMicrotask = globalThis.queueMicrotask
  const savedUrls = []
  const indexedDb = createIndexedDbStub()

  globalThis.indexedDB = {
    open: indexedDb.open,
  }
  globalThis.URL = {
    createObjectURL(blob) {
      const url = `blob:${blob.type}:${blob.size}`
      savedUrls.push(url)
      return url
    },
    revokeObjectURL() {},
  }
  globalThis.queueMicrotask = previousQueueMicrotask || (cb => Promise.resolve().then(cb))

  try {
    const session = {
      id: 's1',
      ts: new Date('2026-05-15T12:00:00Z'),
      files: [new Blob(['png-bytes'], { type: 'image/png' })],
      aiFiles: [new Blob(['webp-bytes'], { type: 'image/webp' })],
      imageMeta: [],
      photoTimes: [],
      photoGps: [],
      photoDebug: [],
    }

    await saveImportSessions([session])
    const restored = await loadImportSessions()

    assert.equal(restored.length, 1)
    assert.equal(restored[0].files[0].type, 'image/png')
    assert.equal(restored[0].aiFiles[0].type, 'image/webp')
    assert.equal(savedUrls.length, 1)
  } finally {
    globalThis.indexedDB = previousIndexedDb
    globalThis.URL = previousUrl
    globalThis.queueMicrotask = previousQueueMicrotask
  }
})
