import { bindCacheableMedia, bindProtectedMedia, MEDIA_KIND, MEDIA_PRIVACY_SCOPE } from './protected-media.js'
import { normalizeMediaVariant } from './media-cache.js'
import { canUseAuthenticatedNetwork } from './capabilities.js'
import { state } from './state.js'

// Shared helpers for rendering image placeholders and wiring fallback URLs.
//
// Stage B: `imageHtml()` no longer emits a raw remote `src=` for public
// observation thumbnails. Instead every keyed observation image (public OR
// protected) is rendered with data-* attributes that describe the cache
// identity; `wireImageFallback()` then routes the element through the
// cache-first loader (`bindCacheableMedia`) so:
//
//   * The loader consults the persisted user-scoped blob cache first.
//   * A miss consults the capability gate before any remote fetch, so
//     CACHED / REAUTH_REQUIRED never triggers a doomed HTTP round-trip.
//   * A COMPLETE miss fetches once, validates, size-guards, persists.
//
// Legacy sources without a `key` (e.g. blob:/data: previews, local pending
// syncs) still render with a direct `src=` because there is no durable cache
// identity to resolve.

function _attr(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function _isLocalTransportUrl(url) {
  const text = String(url || '')
  return text.startsWith('blob:') || text.startsWith('data:')
}

function _hasCacheableIdentity(source) {
  const key = String(source?.key || '').trim()
  return !!key
}

/**
 * Render an <img> from a media source, or a mushroom placeholder if missing.
 *
 * A "cacheable" identity (any source with a stable `key`) is emitted as an
 * <img> without a remote `src`; the loader wires it up in
 * `wireImageFallback()`. Sources without a key (or blob:/data: transports)
 * are rendered directly so they still work for local previews.
 */
export function imageHtml(source, className, placeholderClassOrHtml) {
  if (!source) {
    return _placeholder(className, placeholderClassOrHtml)
  }
  const key = String(source.key || '').trim()
  const protectedUrl = String(source.protectedUrl || '').trim()
  const primaryUrl = String(source.primaryUrl || '').trim()
  const fallbackUrl = String(source.fallbackUrl || '').trim()

  // Cacheable route: durable key + one or more transport URLs. The loader
  // picks up the identity from data-* attributes on the element. We include
  // an explicit variant so the loader normalizes it (thumb/small/medium →
  // canonical thumb).
  if (_hasCacheableIdentity(source) && (primaryUrl || protectedUrl)) {
    const variant = normalizeMediaVariant(source.variant, MEDIA_KIND.OBSERVATION_THUMB)
    const scope = protectedUrl ? MEDIA_PRIVACY_SCOPE.PROTECTED : MEDIA_PRIVACY_SCOPE.PUBLIC
    const attrs = [
      `class="${_attr(className)}"`,
      `data-media-cache="1"`,
      `data-media-kind="${_attr(MEDIA_KIND.OBSERVATION_THUMB)}"`,
      `data-media-scope="${_attr(scope)}"`,
      `data-media-key="${_attr(key)}"`,
      `data-media-variant="${_attr(variant)}"`,
    ]
    if (protectedUrl) attrs.push(`data-media-protected-url="${_attr(protectedUrl)}"`)
    if (primaryUrl && !_isLocalTransportUrl(primaryUrl)) attrs.push(`data-media-public-url="${_attr(primaryUrl)}"`)
    if (fallbackUrl && fallbackUrl !== primaryUrl && !_isLocalTransportUrl(fallbackUrl)) {
      attrs.push(`data-media-fallback-url="${_attr(fallbackUrl)}"`)
    }
    return `<img ${attrs.join(' ')} loading="lazy" decoding="async" alt="">`
  }

  // Legacy protected-URL-only path (no durable key). Same behavior as before
  // Stage B: the loader binds by URL, no persistent cache.
  if (protectedUrl) {
    return `<img class="${_attr(className)}" data-protected-media-url="${_attr(protectedUrl)}" loading="lazy" decoding="async" alt="">`
  }

  // No identifiable image. Blob:/data: previews render inline (they are
  // ephemeral local transports; there is nothing to cache).
  if (primaryUrl) {
    const fallbackAttr = fallbackUrl && fallbackUrl !== primaryUrl
      ? ` data-fallback-src="${_attr(fallbackUrl)}"`
      : ''
    return `<img class="${_attr(className)}" src="${_attr(primaryUrl)}"${fallbackAttr} loading="lazy" decoding="async" alt="">`
  }

  return _placeholder(className, placeholderClassOrHtml)
}

function _placeholder(className, placeholderClassOrHtml) {
  if (placeholderClassOrHtml && placeholderClassOrHtml.trim().startsWith('<')) {
    return placeholderClassOrHtml
  }
  const cls = placeholderClassOrHtml || className
  return `<div class="${cls}">🍄</div>`
}

function _readIdentityFromElement(img) {
  const kind = img.dataset.mediaKind || ''
  const scope = img.dataset.mediaScope || ''
  const key = img.dataset.mediaKey || ''
  const variant = img.dataset.mediaVariant || ''
  if (!kind || !scope || !key) return null
  const uid = _currentUserId()
  if (!uid) return null
  return { userId: uid, mediaKind: kind, privacyScope: scope, mediaKey: key, variant }
}

function _currentUserId() {
  // Direct read from the shared state module. state.js is a small module
  // whose transitive deps (observation-defaults, settings, visibility) do
  // NOT import image-helpers.js, so no cycle exists.
  try { return String(state?.user?.id || '').trim() }
  catch (_) { return '' }
}

/** Wire image handlers so keyed images route through the cache-first loader,
 *  and legacy fallback-src images pick up the fallback on error. */
export function wireImageFallback(root) {
  // New keyed media path (Stage B).
  root.querySelectorAll('img[data-media-cache="1"]').forEach(img => {
    const identity = _readIdentityFromElement(img)
    if (!identity) {
      // Without a resolvable user id we cannot key the cache. Fall back to
      // a direct-src render ONLY when the capability gate allows an
      // authenticated network op (i.e. AUTHENTICATED_COMPLETE) so we do
      // not fire a browser-level GET while CACHED / REAUTH_REQUIRED. In
      // the denied case we leave the element as a placeholder (no `src`,
      // no fetch); a later re-render after the state transitions to
      // COMPLETE will bind it properly.
      const publicUrl = img.dataset.mediaPublicUrl || ''
      if (!publicUrl || img.dataset.mediaProtectedUrl) return
      if (!canUseAuthenticatedNetwork()?.allowed) return
      img.src = publicUrl
      return
    }
    bindCacheableMedia(img, identity, {
      publicUrl: img.dataset.mediaPublicUrl || '',
      protectedUrl: img.dataset.mediaProtectedUrl || '',
    })
  })
  // Legacy protected-URL-only path.
  root.querySelectorAll('img[data-protected-media-url]').forEach(img => {
    bindProtectedMedia(img, img.dataset.protectedMediaUrl)
  })
  // Legacy fallback-src path (no cache identity).
  root.querySelectorAll('img[data-fallback-src]').forEach(img => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallbackSrc
      if (!fallback || img.dataset.fallbackApplied === 'true') return
      img.dataset.fallbackApplied = 'true'
      img.src = fallback
    }, { once: true })
  })
}
