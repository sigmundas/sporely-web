// Location name lookup via Artsdatabanken place-name service.
// Auto-fills the location field when GPS coords are available,
// preserving any manual edits the user has made.

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

  input.addEventListener('input', _updateApplyBtn)

  btn.addEventListener('click', () => {
    if (!resolvedName) return
    input.value = resolvedName
    lastApplied = resolvedName
    _updateApplyBtn()
  })
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

      // Auto-apply only when field is empty or still shows the last auto-applied value
      const current = input.value.trim()
      const shouldApply = !current || current === lastApplied.trim()
      if (shouldApply) {
        input.value = name
        lastApplied = name
      }
      _updateApplyBtn()
    } catch { /* silent — location name is optional */ }
  }, 500)
}

function _updateApplyBtn() {
  const input = document.getElementById('location-name-input')
  const btn   = document.getElementById('location-apply-btn')
  if (!input || !btn) return
  const canApply = !!resolvedName && input.value.trim() !== resolvedName.trim()
  btn.style.display = canApply ? 'inline-block' : 'none'
}
