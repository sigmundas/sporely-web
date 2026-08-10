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
