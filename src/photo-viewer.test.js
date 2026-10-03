import test from 'node:test'
import assert from 'node:assert/strict'

import { closePhotoViewer, initPhotoViewer, openPhotoViewer } from './photo-viewer.js'

function makeElement() {
  return {
    style: {},
    dataset: {},
    textContent: '',
    src: '',
    addEventListener() {},
    closest() { return null },
  }
}

test('photo viewer shows owner-supplied microscope metadata and clears it for ordinary photos', () => {
  const previousDocument = globalThis.document
  const elements = Object.fromEntries([
    'photo-viewer',
    'photo-viewer-img',
    'photo-viewer-counter',
    'photo-viewer-metadata',
    'photo-viewer-prev',
    'photo-viewer-next',
    'photo-viewer-share',
    'photo-viewer-share-menu',
    'photo-viewer-close',
    'photo-viewer-scale-bar',
  ].map(id => [id, makeElement()]))
  globalThis.document = {
    body: { style: {} },
    getElementById(id) { return elements[id] },
    addEventListener() {},
  }

  try {
    initPhotoViewer()
    openPhotoViewer([{
      src: 'blob:owner-image',
      metadata: '10 Aug 2026 · 21:42',
    }])
    assert.equal(elements['photo-viewer-metadata'].textContent, '10 Aug 2026 · 21:42')
    assert.equal(elements['photo-viewer-metadata'].style.display, 'block')

    openPhotoViewer([{ src: 'blob:ordinary-image' }])
    assert.equal(elements['photo-viewer-metadata'].textContent, '')
    assert.equal(elements['photo-viewer-metadata'].style.display, 'none')
  } finally {
    closePhotoViewer()
    globalThis.document = previousDocument
  }
})

test('photo viewer scale bar uses the calibrated source width and hides for uncalibrated photos', () => {
  const previousDocument = globalThis.document
  const elements = Object.fromEntries([
    'photo-viewer',
    'photo-viewer-img',
    'photo-viewer-counter',
    'photo-viewer-metadata',
    'photo-viewer-prev',
    'photo-viewer-next',
    'photo-viewer-share',
    'photo-viewer-share-menu',
    'photo-viewer-close',
    'photo-viewer-scale-bar',
  ].map(id => [id, makeElement()]))
  const label = { textContent: '' }
  const line = { style: {} }
  elements['photo-viewer-scale-bar'].querySelector = selector => (
    selector === '.scale-bar-label' ? label : line
  )
  // A 1000 px medium variant of a 4000 px source at 0.1 µm/px, fitted to
  // 1000 screen px: 0.4 µm per screen px across 1000 px.
  Object.assign(elements['photo-viewer-img'], { offsetWidth: 1000, naturalWidth: 1000, complete: true })
  elements['photo-viewer'].clientWidth = 1000
  globalThis.document = {
    body: { style: {} },
    getElementById(id) { return elements[id] },
    addEventListener() {},
  }

  try {
    initPhotoViewer()
    openPhotoViewer([{ src: 'blob:micro', scale: { umPerSourcePx: 0.1, sourceWidthPx: 4000 } }])
    assert.equal(elements['photo-viewer-scale-bar'].style.display, '')
    assert.equal(label.textContent, '100 µm')
    assert.equal(line.style.width, '250px')

    openPhotoViewer([{ src: 'blob:field' }])
    assert.equal(elements['photo-viewer-scale-bar'].style.display, 'none')
  } finally {
    closePhotoViewer()
    globalThis.document = previousDocument
  }
})

test('photo viewer shows the thumbnail first and only switches to the resolved full image of the current photo', async () => {
  const previousDocument = globalThis.document
  const elements = Object.fromEntries([
    'photo-viewer', 'photo-viewer-img', 'photo-viewer-counter', 'photo-viewer-metadata',
    'photo-viewer-prev', 'photo-viewer-next', 'photo-viewer-share', 'photo-viewer-share-menu',
    'photo-viewer-close', 'photo-viewer-scale-bar',
  ].map(id => [id, makeElement()]))
  globalThis.document = {
    body: { style: {} },
    getElementById(id) { return elements[id] },
    addEventListener() {},
  }
  let releaseFirst
  const photos = [
    { src: '', previewSrc: 'blob:thumb-a', resolveSrc: () => new Promise(resolve => { releaseFirst = resolve }) },
    { src: '', previewSrc: 'blob:thumb-b', resolveSrc: async () => 'blob:full-b' },
  ]

  try {
    initPhotoViewer()
    openPhotoViewer(photos, 0)
    assert.equal(elements['photo-viewer-img'].src, 'blob:thumb-a')
    openPhotoViewer(photos, 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(elements['photo-viewer-img'].src, 'blob:full-b')
    // A late full image for a photo the user has left must not flip back.
    releaseFirst('blob:full-a')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(elements['photo-viewer-img'].src, 'blob:full-b')
  } finally {
    closePhotoViewer()
    globalThis.document = previousDocument
  }
})
