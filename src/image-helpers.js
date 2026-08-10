import { bindProtectedMedia } from './protected-media.js'

// Shared helpers for rendering image placeholders and wiring fallback URLs.
// Replaces duplicated _imageHtml + _wireImageFallback from home.js and find_s.js.

function _attr(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Render an <img> from a media source, or a mushroom placeholder if missing. */
export function imageHtml(source, className, placeholderClassOrHtml) {
  if (source?.protectedUrl) {
    return `<img class="${_attr(className)}" data-protected-media-url="${_attr(source.protectedUrl)}" loading="lazy" decoding="async" alt="">`
  }
  if (!source?.primaryUrl) {
    if (placeholderClassOrHtml && placeholderClassOrHtml.trim().startsWith('<')) {
      return placeholderClassOrHtml
    }
    const cls = placeholderClassOrHtml || className
    return `<div class="${cls}">🍄</div>`
  }
  const fallbackAttr = source.fallbackUrl && source.fallbackUrl !== source.primaryUrl
     ? ` data-fallback-src="${source.fallbackUrl}"`
     : ''
  return `<img class="${className}" src="${source.primaryUrl}"${fallbackAttr} loading="lazy" decoding="async" alt="">`
}

/** Wire image error handlers so failed images fall back to a backup URL. */
export function wireImageFallback(root) {
  root.querySelectorAll('img[data-protected-media-url]').forEach(img => {
    bindProtectedMedia(img, img.dataset.protectedMediaUrl)
  })
  root.querySelectorAll('img[data-fallback-src]').forEach(img => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallbackSrc
      if (!fallback || img.dataset.fallbackApplied === 'true') return
      img.dataset.fallbackApplied = 'true'
      img.src = fallback
     }, { once: true })
   })
}
