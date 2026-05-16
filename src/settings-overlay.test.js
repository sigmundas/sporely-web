import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hideSettingsOverlay,
  showSettingsOverlay,
} from './settings-overlay.js'

function makeFocusable(name) {
  return {
    name,
    focusCount: 0,
    blurCount: 0,
    focus() {
      this.focusCount += 1
      globalThis.document.activeElement = this
    },
    blur() {
      this.blurCount += 1
      if (globalThis.document.activeElement === this) {
        globalThis.document.activeElement = null
      }
    },
  }
}

function makeOverlay() {
  const listeners = {}
  return {
    inert: false,
    style: { display: 'block' },
    classList: {
      removed: [],
      remove(name) {
        this.removed.push(name)
      },
    },
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    addEventListener(type, handler) {
      listeners[type] = handler
    },
    contains(node) {
      return node === globalThis.document.activeElement
    },
    listeners,
  }
}

test('hideSettingsOverlay moves focus before hiding the overlay', () => {
  const previousDocument = globalThis.document
  const opener = makeFocusable('settings-btn')
  const closeBtn = makeFocusable('settings-close-btn')
  const overlay = makeOverlay()

  globalThis.document = {
    activeElement: closeBtn,
    contains(node) {
      return node === opener || node === closeBtn
    },
    querySelector() {
      return opener
    },
  }

  try {
    showSettingsOverlay({ overlay })
    const shifted = hideSettingsOverlay({ overlay, settingsOpener: opener })
    assert.equal(shifted, true)
    assert.equal(opener.focusCount, 1)
    assert.equal(closeBtn.blurCount, 0)
    assert.equal(overlay.attributes['aria-hidden'], 'true')
    assert.equal(overlay.inert, true)
    assert.equal(overlay.classList.removed.includes('open'), true)
    assert.equal(overlay.style.display, 'block')
    overlay.listeners.transitionend?.()
    assert.equal(overlay.style.display, 'none')
  } finally {
    globalThis.document = previousDocument
  }
})

test('hideSettingsOverlay falls back to blur when no opener is available', () => {
  const previousDocument = globalThis.document
  const closeBtn = makeFocusable('settings-close-btn')
  const overlay = makeOverlay()

  globalThis.document = {
    activeElement: closeBtn,
    contains() {
      return false
    },
    querySelector() {
      return null
    },
  }

  try {
    const shifted = hideSettingsOverlay({ overlay, settingsOpener: null })
    assert.equal(shifted, true)
    assert.equal(closeBtn.blurCount, 1)
    assert.equal(overlay.attributes['aria-hidden'], 'true')
    assert.equal(overlay.inert, true)
  } finally {
    globalThis.document = previousDocument
  }
})
