import { lookupCoordinateKey, lookupReverseLocation } from './location-lookup.js'

let suggestions = []
let lastApplied = ''
let lastLookupKey = ''
let lastLookupResult = null
let debounceTimer = null
let lookupSeq = 0

export function resetLocationState() {
  lookupSeq += 1
  suggestions = []
  lastApplied = ''
  lastLookupKey = ''
  lastLookupResult = null
  clearTimeout(debounceTimer)
  const input = document.getElementById('location-name-input')
  if (input) input.value = ''
  _renderDropdown(false)
  _updateApplyBtn()
}

export function getLocationLookup() {
  return lastLookupResult
}

export function getLocationName() {
  return document.getElementById('location-name-input')?.value.trim() || ''
}

export function openLocationSuggestions() {
  const input = document.getElementById('location-name-input')
  if (!input) return

  try {
    input.focus({ preventScroll: true })
  } catch {
    input.focus()
  }

  _renderDropdown(true)
}

// Call once in initReview() — wires manual input plus lookup suggestions.
export function initLocationField() {
  const input = document.getElementById('location-name-input')
  _wireReviewLocationTrigger()
  if (!input) return
  if (input._locationWired) {
    _updateApplyBtn()
    return
  }

  input._locationWired = true
  input.readOnly = false

  input.addEventListener('focus', () => _renderDropdown(true))
  input.addEventListener('click', () => _renderDropdown(true))
  input.addEventListener('input', () => {
    _updateApplyBtn()
    _renderDropdown(document.activeElement === input)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => _renderDropdown(false), 250)
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
  lastLookupResult = result || null
  suggestions = result?.suggestions || []
  const first = suggestions[0] || ''
  const input = document.getElementById('location-name-input')
  if (!input) return

  if (first && (!input.value.trim() || input.value.trim() === lastApplied)) {
    input.value = first
    lastApplied = first
  }

  const reviewLocation = document.getElementById('review-location')
  if (reviewLocation && first) {
    reviewLocation.textContent = first
    reviewLocation.title = first
  }

  _updateApplyBtn()
  _renderDropdown(document.activeElement === input)
}

function _renderDropdown(show) {
  const input = document.getElementById('location-name-input')
  const dropdown = document.getElementById('location-suggestion-dropdown')
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
    const handleSelect = event => {
      event.preventDefault()
      event.stopPropagation()
      const name = suggestions[index] || ''
      input.value = name
      lastApplied = name
      dropdown.style.display = 'none'
      _updateApplyBtn()
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    item.addEventListener('mousedown', handleSelect)
    item.addEventListener('touchstart', handleSelect, { passive: false })
  })
}

function _updateApplyBtn() {
  const btn = document.getElementById('location-apply-btn')
  if (!btn) return
  btn.style.display = 'none'
  btn.disabled = true
}

function _wireReviewLocationTrigger() {
  const triggers = [
    document.getElementById('review-location'),
    document.getElementById('review-coords-text'),
  ].filter(Boolean)

  for (const el of triggers) {
    if (el._locationTriggerWired) continue
    el._locationTriggerWired = true

    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')

    const open = event => {
      event.preventDefault()
      event.stopPropagation()
      openLocationSuggestions()
    }

    el.addEventListener('click', open)
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') open(event)
    })
  }
}

function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
