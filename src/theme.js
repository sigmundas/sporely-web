// ── Theme management ──────────────────────────────────────────────────────────
// Separated so both main.js and settings panel can import without circular deps.

export function applyTheme(theme) {
  // 'auto' → follow system preference
  const effective = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (theme || 'dark')

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
applyTheme(localStorage.getItem('sporely-theme') || 'dark')

// Keep 'auto' in sync with OS preference changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem('sporely-theme') || 'dark') === 'auto') {
    applyTheme('auto')
  }
})
