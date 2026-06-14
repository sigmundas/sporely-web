export const DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR = 'main button, [data-settings-open], [data-profile-open], #home-screen button'

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

export function hideSlidingOverlay({
  overlay,
  opener = null,
  fallbackSelector = DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR,
  openClass = 'open',
} = {}) {
  if (!overlay) return false

  const active = globalThis.document?.activeElement || null
  const needsFocusShift = _isFocusWithinOverlay(overlay, active)

  if (needsFocusShift) {
    const resolvedOpener = opener && globalThis.document?.contains?.(opener)
      ? opener
      : null
    const fallback = resolvedOpener || globalThis.document?.querySelector?.(fallbackSelector) || null

    if (!_focusTarget(fallback) && active && typeof active.blur === 'function') {
      active.blur()
    }
  }

  if ('inert' in overlay) overlay.inert = true
  overlay.setAttribute('aria-hidden', 'true')
  overlay.classList?.remove?.(openClass)
  overlay.addEventListener('transitionend', () => {
    overlay.style.display = 'none'
  }, { once: true })
  return needsFocusShift
}

export function showSlidingOverlay({ overlay } = {}) {
  if (!overlay) return
  if ('inert' in overlay) overlay.inert = false
  overlay.style.display = 'block'
  overlay.setAttribute('aria-hidden', 'false')
}
