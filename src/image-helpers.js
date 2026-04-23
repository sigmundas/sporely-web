// Shared helpers for rendering image placeholders and wiring fallback URLs.
// Replaces duplicated _imageHtml + _wireImageFallback from home.js and find_s.js.

/** Render an <img> from a media source, or a mushroom placeholder if missing. */
export function imageHtml(source, className) {
  if (!source?.primaryUrl) return `<div class="${className}"></div>`
  const fallbackAttr = source.fallbackUrl && source.fallbackUrl !== source.primaryUrl
     ? ` data-fallback-src="${source.fallbackUrl}"`
     : ''
  return `<img class="${className}" src="${source.primaryUrl}"${fallbackAttr} loading="lazy" decoding="async" alt="">`
}

/** Wire image error handlers so failed images fall back to a backup URL. */
export function wireImageFallback(root) {
  root.querySelectorAll('img[data-fallback-src]').forEach(img => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallbackSrc
      if (!fallback || img.dataset.fallbackApplied === 'true') return
      img.dataset.fallbackApplied = 'true'
      img.src = fallback
     }, { once: true })
   })
}
