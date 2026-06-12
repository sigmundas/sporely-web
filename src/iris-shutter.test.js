import test from 'node:test'
import assert from 'node:assert/strict'

import { IRIS_BLADE_PATH_D, clearIrisShutter, playIrisShutter } from './iris-shutter.js'

function makeClassList() {
  const values = new Set()
  return {
    add(...names) {
      names.filter(Boolean).forEach(name => values.add(name))
    },
    remove(...names) {
      names.filter(Boolean).forEach(name => values.delete(name))
    },
    toggle(name, force) {
      if (force === true) {
        values.add(name)
        return true
      }
      if (force === false) {
        values.delete(name)
        return false
      }
      if (values.has(name)) {
        values.delete(name)
        return false
      }
      values.add(name)
      return true
    },
    contains(name) {
      return values.has(name)
    },
    has(name) {
      return values.has(name)
    },
  }
}

function withCaptureDocument() {
  const previousDocument = globalThis.document
  const viewfinder = {
    classList: makeClassList(),
    dataset: {},
    style: {
      setProperty() {},
    },
    getBoundingClientRect() {
      return { width: 100, height: 100 }
    },
  }

  globalThis.document = {
    querySelector(selector) {
      return selector === '.capture-viewfinder' ? viewfinder : null
    },
    getElementById() {
      return null
    },
  }

  return {
    viewfinder,
    restore() {
      clearIrisShutter()
      globalThis.document = previousDocument
    },
  }
}

test('iris blade path uses the fixed inkscape path', () => {
  assert.equal(
    IRIS_BLADE_PATH_D,
    'M -79.050967,-36.693239 C -197.91366,56.591496 -94.056754,137.06665 22.020885,98.809356 31.337039,95.73891 25.736889,79.983604 28.329989,67.293163 33.531408,41.837808 40.507132,10.973915 72.390971,-11.010864 95.098917,-26.909528 111.66924,-38.688794 135.20597,-48.762471 126.17785,-63.049848 99.181976,-102.1146 23.072759,-82.989494 c -35.033969,8.803513 -67.409698,20.355718 -102.123726,46.296255 z',
  )
})

test('pending iris shutter waits for the minimum hold before opening', async () => {
  const captureDom = withCaptureDocument()

  try {
    const controller = playIrisShutter({
      mode: 'pending',
      closeMs: 5,
      minHoldMs: 30,
      openMs: 5,
    })

    assert.equal(typeof controller.release, 'function')
    assert.equal(typeof controller.cancel, 'function')

    await new Promise(resolve => setTimeout(resolve, 8))
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-pending'), true)

    const releasePromise = controller.release({
      captureAfterMs: 8,
      captureResolvedAt: performance.now(),
    })

    let settled = false
    releasePromise.then(() => {
      settled = true
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(settled, false)
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-opening'), false)

    await releasePromise
    assert.equal(settled, true)
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-pending'), false)
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-opening'), false)
  } finally {
    captureDom.restore()
  }
})

test('pending iris shutter opens immediately after a long capture resolves', async () => {
  const captureDom = withCaptureDocument()

  try {
    const controller = playIrisShutter({
      mode: 'pending',
      closeMs: 5,
      minHoldMs: 20,
      openMs: 5,
    })

    await new Promise(resolve => setTimeout(resolve, 25))
    const releasePromise = controller.release({
      captureAfterMs: 25,
      captureResolvedAt: performance.now(),
    })

    await releasePromise
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-pending'), false)
    assert.equal(captureDom.viewfinder.classList.contains('is-iris-opening'), false)
  } finally {
    captureDom.restore()
  }
})
