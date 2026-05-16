export const DEFAULT_SETTINGS_FOCUS_FALLBACK_SELECTOR = '[data-settings-open], #profile-btn, #home-screen button, main button'

function _isFocusWithinOverlay(overlay, activeElement) {
  return !!overlay && !!activeElement && typeof overlay.contains === 'function' && overlay.contains(activeElement)
}

function _focusTarget(target) {
  if (target && typeof target.focus === 'function') {
    target.focus()
    return true
  }
  return false
}

export function hideSettingsOverlay({
  overlay,
  settingsOpener = null,
  fallbackSelector = DEFAULT_SETTINGS_FOCUS_FALLBACK_SELECTOR,
} = {}) {
  if (!overlay) return false

  const active = globalThis.document?.activeElement || null
  const needsFocusShift = _isFocusWithinOverlay(overlay, active)

  if (needsFocusShift) {
    const opener = settingsOpener && globalThis.document?.contains?.(settingsOpener)
      ? settingsOpener
      : null
    const fallback = opener || globalThis.document?.querySelector?.(fallbackSelector) || null

    if (!_focusTarget(fallback) && active && typeof active.blur === 'function') {
      active.blur()
    }
  }

  if ('inert' in overlay) overlay.inert = true
  overlay.setAttribute('aria-hidden', 'true')
  overlay.classList?.remove?.('open')
  overlay.addEventListener('transitionend', () => {
    overlay.style.display = 'none'
  }, { once: true })
  return needsFocusShift
}

export function showSettingsOverlay({ overlay } = {}) {
  if (!overlay) return
  if ('inert' in overlay) overlay.inert = false
  overlay.style.display = 'block'
  overlay.setAttribute('aria-hidden', 'false')
}
