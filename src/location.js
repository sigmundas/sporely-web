import { lookupCoordinateKey, lookupReverseLocation } from './location-lookup.js'

let suggestions = []
let lastApplied = ''
let lastLookupKey = ''
let debounceTimer = null
let lookupSeq = 0

export function resetLocationState() {
  lookupSeq += 1
  suggestions = []
  lastApplied = ''
  lastLookupKey = ''
  clearTimeout(debounceTimer)
  const input = document.getElementById('location-name-input')
  if (input) input.value = ''
  _renderDropdown(false)
  _updateApplyBtn()
}

export function getLocationName() {
  return document.getElementById('location-name-input')?.value.trim() || ''
}

// Call once in initReview() — wires manual input plus lookup suggestions.
export function initLocationField() {
  const input = document.getElementById('location-name-input')
  if (!input || input._locationWired) return

  input._locationWired = true
  input.readOnly = false

  input.addEventListener('focus', () => _renderDropdown(true))
  input.addEventListener('click', () => _renderDropdown(true))
  input.addEventListener('input', () => {
    _updateApplyBtn()
    _renderDropdown(document.activeElement === input)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => _renderDropdown(false), 160)
  })

  _updateApplyBtn()
}

// Call in buildReviewGrid() after GPS coords are known.
export function startLocationLookup(lat, lon) {
  const key = lookupCoordinateKey(Number(lat), Number(lon))
  if (!key || key === lastLookupKey) return

  const seq = ++lookupSeq
  lastLookupKey = key
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    try {
      const result = await lookupReverseLocation(lat, lon, {
        onUpdate: updated => _applyLookupResult(updated, key),
      })
      if (seq !== lookupSeq || key !== lastLookupKey) return
      _applyLookupResult(result, key)
    } catch { /* silent — location name is optional */ }
  }, 500)
}

function _applyLookupResult(result, key) {
  if (key && key !== lastLookupKey) return
  suggestions = result?.suggestions || []
  const first = suggestions[0] || ''
  const input = document.getElementById('location-name-input')
  if (!input) return

  if (first && (!input.value.trim() || input.value.trim() === lastApplied)) {
    input.value = first
    lastApplied = first
  }

  _updateApplyBtn()
  _renderDropdown(document.activeElement === input)
}

function _ensureDropdown() {
  const input = document.getElementById('location-name-input')
  const wrap = input?.closest('.location-field-val')
  if (!input || !wrap) return null
  let dropdown = wrap.querySelector('.location-suggestion-dropdown')
  if (!dropdown) {
    dropdown = document.createElement('ul')
    dropdown.className = 'location-suggestion-dropdown'
    dropdown.style.display = 'none'
    wrap.appendChild(dropdown)
  }
  return dropdown
}

function _renderDropdown(show) {
  const input = document.getElementById('location-name-input')
  const dropdown = _ensureDropdown()
  if (!input || !dropdown) return

  if (!show || !suggestions.length) {
    dropdown.style.display = 'none'
    dropdown.innerHTML = ''
    return
  }

  dropdown.innerHTML = suggestions
    .map((name, index) => `<li data-index="${index}">${_esc(name)}</li>`)
    .join('')
  dropdown.style.display = 'block'
  dropdown.querySelectorAll('li').forEach((item, index) => {
    item.addEventListener('mousedown', event => {
      event.preventDefault()
      const name = suggestions[index] || ''
      input.value = name
      lastApplied = name
      dropdown.style.display = 'none'
      _updateApplyBtn()
    })
  })
}

function _updateApplyBtn() {
  const btn = document.getElementById('location-apply-btn')
  if (!btn) return
  btn.style.display = 'none'
  btn.disabled = true
}

function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
