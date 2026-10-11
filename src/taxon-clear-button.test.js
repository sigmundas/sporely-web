import test from 'node:test'
import assert from 'node:assert/strict'

import { t } from './i18n.js'
import { renderTaxonClearButton, syncTaxonClearButton, wireTaxonClearButton } from './taxon-clear-button.js'

function makeField(value = '') {
  const makeNode = extra => {
    const listeners = {}
    return {
      style: { display: '' },
      innerHTML: '',
      hidden: false,
      disabled: false,
      listenerCount(type) { return (listeners[type] || []).length },
      addEventListener(type, handler) {
        (listeners[type] ||= []).push(handler)
      },
      dispatchEvent(event) {
        for (const handler of listeners[event.type] || []) handler(event)
        return true
      },
      ...extra,
    }
  }
  const field = { focusCount: 0, inputEvents: [] }
  const dropdown = makeNode()
  const button = makeNode()
  const wrap = makeNode({
    querySelector(selector) {
      if (selector === '.taxon-clear-btn') return button
      if (selector === '.taxon-dropdown') return dropdown
      return null
    },
  })
  const input = makeNode({
    value,
    closest(selector) {
      return selector === '.taxon-field-wrap' ? wrap : null
    },
    focus() { field.focusCount++ },
  })
  // Stands in for the screen's own input handler, registered first as on
  // the real screens.
  input.addEventListener('input', event => field.inputEvents.push({ type: event.type, value: input.value }))
  return Object.assign(field, { input, button, dropdown, wrap })
}

function click(button) {
  button.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} })
}

test('clear button markup is a labelled type=button, hidden only for an empty value', () => {
  const empty = renderTaxonClearButton('')
  assert.match(empty, /^<button type="button" class="taxon-clear-btn"/)
  assert.match(empty, new RegExp(`aria-label="${t('detail.clearSpecies')}"`))
  assert.match(empty, /\shidden>/)
  assert.doesNotMatch(renderTaxonClearButton('Amanita muscaria'), /\shidden>/)
  assert.doesNotMatch(renderTaxonClearButton('Amanita muscaria'), /undefined/)
})

test('clear button visibility follows typing and programmatic fills', () => {
  const field = makeField('')
  wireTaxonClearButton(field.input)
  assert.equal(field.button.hidden, true)

  field.input.value = 'A'
  field.input.dispatchEvent({ type: 'input' })
  assert.equal(field.button.hidden, false)

  field.input.value = ''
  field.input.dispatchEvent({ type: 'input' })
  assert.equal(field.button.hidden, true)

  field.input.value = 'Fly agaric (Amanita muscaria)'
  syncTaxonClearButton(field.input)
  assert.equal(field.button.hidden, false)
})

test('clicking clear goes through the input event path, hides the dropdown and refocuses', () => {
  const field = makeField('Fly agaric (Amanita muscaria)')
  wireTaxonClearButton(field.input)
  field.dropdown.style.display = 'block'
  field.dropdown.innerHTML = '<li>stale</li>'

  for (const type of ['pointerdown', 'mousedown']) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    field.button.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true, `${type} keeps focus on the input`)
  }
  click(field.button)

  assert.equal(field.input.value, '')
  assert.deepEqual(field.inputEvents, [{ type: 'input', value: '' }])
  assert.equal(field.dropdown.style.display, 'none')
  assert.equal(field.dropdown.innerHTML, '')
  assert.equal(field.button.hidden, true)
  assert.equal(field.focusCount, 1)
})

test('clear does nothing while the input is disabled, and wiring twice adds no listeners', () => {
  const field = makeField('Amanita')
  wireTaxonClearButton(field.input)
  wireTaxonClearButton(field.input)
  assert.equal(field.button.listenerCount('click'), 1)

  field.input.disabled = true
  click(field.button)
  assert.equal(field.input.value, 'Amanita')
  assert.deepEqual(field.inputEvents, [])
  assert.equal(field.focusCount, 0)
})
