import {
  DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR,
  hideSlidingOverlay,
  showSlidingOverlay,
} from './slide-overlay.js'

export const DEFAULT_PROFILE_FOCUS_FALLBACK_SELECTOR = DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR

export function hideProfileOverlay({
  overlay,
  profileOpener = null,
  fallbackSelector = DEFAULT_PROFILE_FOCUS_FALLBACK_SELECTOR,
} = {}) {
  return hideSlidingOverlay({
    overlay,
    opener: profileOpener,
    fallbackSelector,
    openClass: 'open',
  })
}

export function showProfileOverlay({ overlay } = {}) {
  showSlidingOverlay({ overlay })
}
