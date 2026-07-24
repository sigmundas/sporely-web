// ── Theme management ──────────────────────────────────────────────────────────
// Separated so both main.js and settings panel can import without circular deps.

export function applyTheme(theme) {
  // 'auto' (or unset) → follow system preference
  const resolved = theme || 'auto'
  const effective = resolved === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : resolved

  const html = document.documentElement
  const meta = document.querySelector('meta[name=theme-color]')

  if (effective === 'light') {
    html.classList.add('light')
    if (meta) meta.content = '#f2f5f1'
  } else {
    html.classList.remove('light')
    if (meta) meta.content = '#0d1109'
  }
}

// Apply immediately on module load so there's no flash
applyTheme(localStorage.getItem('sporely-theme') || 'auto')

// Keep 'auto' in sync with OS preference changes
function refreshIfAuto() {
  if ((localStorage.getItem('sporely-theme') || 'auto') === 'auto') {
    applyTheme('auto')
  }
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshIfAuto)
// Android WebView (Capacitor) may not fire the media-query change while backgrounded,
// so re-check whenever the app returns to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfAuto()
})
window.addEventListener('focus', refreshIfAuto)
