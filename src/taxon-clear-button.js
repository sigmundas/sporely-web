// Clear (×) button for a species input inside `.taxon-field-wrap`.
//
// Clicking it empties the input and dispatches a real `input` event, so the
// screen's own empty-value handler does the clearing (taxon, AI selection,
// persistence). There is deliberately no separate clearing logic here.

import { t } from './i18n.js'

const BUTTON_SELECTOR = '.taxon-clear-btn'

export function renderTaxonClearButton(value = '') {
  const hidden = String(value ?? '').length ? '' : ' hidden'
  return `<button type="button" class="taxon-clear-btn" aria-label="${t('detail.clearSpecies')}"${hidden}>`
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>'
    + '</button>'
}

function _findButton(input) {
  return input?.closest?.('.taxon-field-wrap')?.querySelector?.(BUTTON_SELECTOR) || null
}

export function syncTaxonClearButton(input, button = _findButton(input)) {
  if (!input || !button) return
  button.hidden = !String(input.value ?? '').length
}

export function wireTaxonClearButton(input, button = _findButton(input)) {
  if (!input || !button || button._wired) return
  button._wired = true
  // Keep focus on the input so its blur handler does not start the delayed
  // dropdown hide; the dropdown items use the same guard.
  const keepFocus = event => { event.preventDefault() }
  button.addEventListener('pointerdown', keepFocus)
  button.addEventListener('mousedown', keepFocus)
  button.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    if (input.disabled) return
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const dropdown = input.closest?.('.taxon-field-wrap')?.querySelector?.('.taxon-dropdown')
    if (dropdown) {
      dropdown.style.display = 'none'
      dropdown.innerHTML = ''
    }
    syncTaxonClearButton(input, button)
    input.focus?.()
  })
  input.addEventListener('input', () => syncTaxonClearButton(input, button))
  syncTaxonClearButton(input, button)
}
