// Location name lookup via Artsdatabanken place-name service.
// Current location is only applied when the user explicitly asks for it.

let resolvedName = ''
let lastApplied  = ''
let debounceTimer = null

export function resetLocationState() {
  resolvedName = ''
  lastApplied  = ''
  clearTimeout(debounceTimer)
  const input = document.getElementById('location-name-input')
  if (input) input.value = ''
  _updateApplyBtn()
}

export function getLocationName() {
  return document.getElementById('location-name-input')?.value.trim() || ''
}

// Call once in initReview() — wires the manual input + "Use lookup" button.
export function initLocationField() {
  const input = document.getElementById('location-name-input')
  const btn   = document.getElementById('location-apply-btn')
  if (!input || !btn) return

  btn.addEventListener('click', () => {
    if (!resolvedName) return
    const current = input.value.trim()
    if (current && current !== resolvedName.trim()) {
      const confirmed = window.confirm('The place-name lookup will overwrite the existing location. Continue?')
      if (!confirmed) return
    }
    input.value = resolvedName
    lastApplied = resolvedName
    _updateApplyBtn()
  })

  _updateApplyBtn()
}

// Call in buildReviewGrid() after GPS coords are known.
export function startLocationLookup(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return

  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    try {
      const url  = `https://stedsnavn.artsdatabanken.no/v1/punkt?lat=${lat}&lng=${lon}&zoom=55`
      const resp = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!resp.ok) return

      const data = await resp.json()
      const name = typeof data?.navn === 'string' ? data.navn.trim() : ''
      if (!name) return

      resolvedName = name

      const input = document.getElementById('location-name-input')
      if (!input) return

      if (!input.value.trim()) {
        input.value = resolvedName
        lastApplied = resolvedName
      }

      _updateApplyBtn()
    } catch { /* silent — location name is optional */ }
  }, 500)
}

function _updateApplyBtn() {
  const input = document.getElementById('location-name-input')
  const btn   = document.getElementById('location-apply-btn')
  if (!input || !btn) return
  const matchesResolved = !!resolvedName && input.value.trim() === resolvedName.trim()
  btn.textContent = resolvedName || 'Use lookup result'
  btn.style.display = resolvedName && !matchesResolved ? 'inline-block' : 'none'
  btn.disabled = !resolvedName
}
