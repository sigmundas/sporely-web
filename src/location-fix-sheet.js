// The single reusable action sheet for location failures on the capture and
// review screens. Opened by tapping the "No location · Tap to fix" pill or by
// saving without a locked location. Resolves with the user's decision:
//   'settings' — open the OS/app location settings
//   'retry'    — perform one short explicit location request
//   'continue' — proceed without location
// or null when dismissed programmatically (navigation, cleanup).

let sheetResolver = null

function _resolve(result) {
  const overlay = globalThis.document?.getElementById('location-fix-overlay')
  if (overlay) overlay.style.display = 'none'
  const resolve = sheetResolver
  sheetResolver = null
  if (typeof resolve === 'function') resolve(result)
}

export function initLocationFixSheet() {
  const overlay = globalThis.document?.getElementById('location-fix-overlay')
  if (!overlay || overlay._wired) return
  overlay._wired = true

  const wire = (id, result) => {
    globalThis.document.getElementById(id)?.addEventListener('click', event => {
      event.preventDefault()
      _resolve(result)
    })
  }
  wire('location-fix-settings', 'settings')
  wire('location-fix-try-again', 'retry')
  wire('location-fix-continue', 'continue')
}

export function showLocationFixSheet() {
  const overlay = globalThis.document?.getElementById('location-fix-overlay')
  if (!overlay) return Promise.resolve('continue')
  _resolve(null) // settle any dangling promise from a previous open
  overlay.style.display = 'flex'
  return new Promise(resolve => {
    sheetResolver = resolve
  })
}

export function hideLocationFixSheet(result = null) {
  _resolve(result)
}
