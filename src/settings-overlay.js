import {
  DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR,
  hideSlidingOverlay,
  showSlidingOverlay,
} from './slide-overlay.js'

export const DEFAULT_SETTINGS_FOCUS_FALLBACK_SELECTOR = DEFAULT_SLIDE_OVERLAY_FOCUS_FALLBACK_SELECTOR

export function hideSettingsOverlay({
  overlay,
  settingsOpener = null,
  fallbackSelector = DEFAULT_SETTINGS_FOCUS_FALLBACK_SELECTOR,
} = {}) {
  return hideSlidingOverlay({
    overlay,
    opener: settingsOpener,
    fallbackSelector,
    openClass: 'open',
  })
}

export function showSettingsOverlay({ overlay } = {}) {
  showSlidingOverlay({ overlay })
}
