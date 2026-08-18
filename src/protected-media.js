// Stage B — cache-first media binder.
//
// Historical name: this module used to only handle "protected" (authorized
// worker) media. Stage B expands it to also own PUBLIC observation
// thumbnails and the header AVATAR, because those all live in the same
// user-scoped persistent blob store and share the same rules:
//
//   * On every bind:
//       1. If a cache identity is known, do a LOCAL cache read (no capability
//          gate — reads are local ops).
//       2. On hit, render the blob object URL and stop.
//       3. On miss, only attempt the authoritative remote fetch when the
//          capability gate allows authenticated network use. In CACHED or
//          REAUTH_REQUIRED that never runs; the element degrades to the
//          placeholder.
//   * On a live COMPLETE session, remote fetch validates the response is
//     actually an image, enforces the per-entry size guard, persists the
//     blob to the media cache, and paints an object URL.
//   * PUBLIC media fails OPEN for display while COMPLETE: when the cache
//     warming fetch fails for a non-authoritative reason (CORS block —
//     e.g. the Capacitor Android WebView origin `https://localhost` fetching
//     `media.sporely.no` — transport error, non-OK status, non-image body),
//     the loader falls back to a direct `img.src = publicUrl` assignment so
//     the browser renders the image exactly as it did before Stage B.
//     The persistent cache is an optimization; it must never break an image
//     that was previously displayable online. The fallback re-checks the
//     capability gate at assignment time and NEVER applies to protected
//     media or in CACHED / REAUTH_REQUIRED.
//   * 401/403/404 for a protected fetch evicts the cache entry so we do
//     not keep serving stale bytes for a resource we no longer own.
//     Protected media stays fail-closed in every failure mode — it never
//     falls back to any public URL.
//   * Session change / account switch revokes every current object URL and
//     forgets bindings so A's URL cannot be reused for B.
//
// The loader still exposes `bindProtectedMedia(element, source, options)` for
// backwards compatibility, but the new preferred entry point is
// `bindCacheableMedia(element, identity)` where `identity` is the durable
// cache identity produced by the model layer.

import { getSharedAuthSession } from './auth-session.js'
import { canUseAuthenticatedNetwork } from './capabilities.js'
import {
  MEDIA_CACHE_MAX_ENTRY_BYTES,
  MEDIA_KIND,
  MEDIA_PRIVACY_SCOPE,
  buildMediaCacheKey,
  deleteCachedMedia,
  readCachedMedia,
  writeCachedMedia,
} from './media-cache.js'

// ── Artsorakel invariant regression ─────────────────────────────────────────
// Retained as a compile-time constant so any future refactor that reuses
// this module for Artsorakel identify will fail the invariant test in
// `capability-gates.test.js` / `artsorakel.test.js`. The identify secret is
// owned by the Sporely Worker; the client only ever holds Supabase tokens.
export const ARTSORAKEL_IDENTIFY_ROUTED_THROUGH_MEDIA_LOADER = false

function _accessToken(session) { return String(session?.access_token || '').trim() }
function _userId(session) { return String(session?.user?.id || '').trim() }

// Deduplication map: multiple DOM elements binding the same identity share a
// single fetch. Keyed by the cache-key string; entries live only while an
// operation is in flight.
class _InFlightRegistry {
  constructor() { this._map = new Map() }
  get(cacheKey) { return this._map.get(cacheKey) || null }
  set(cacheKey, promise) {
    this._map.set(cacheKey, promise)
    const cleanup = () => { if (this._map.get(cacheKey) === promise) this._map.delete(cacheKey) }
    promise.then(cleanup, cleanup)
    return promise
  }
}

export class ProtectedMediaLoader {
  constructor(options = {}) {
    this._getSession = options.getSession || getSharedAuthSession
    this._fetch = options.fetch || ((...args) => globalThis.fetch(...args))
    this._createObjectURL = options.createObjectURL || (blob => URL.createObjectURL(blob))
    this._revokeObjectURL = options.revokeObjectURL || (url => URL.revokeObjectURL(url))
    this._capabilityCheck = options.capabilityCheck || canUseAuthenticatedNetwork
    this._cacheRead = options.cacheRead || readCachedMedia
    this._cacheWrite = options.cacheWrite || writeCachedMedia
    this._cacheDelete = options.cacheDelete || deleteCachedMedia
    this._maxEntryBytes = Number(options.maxEntryBytes || MEDIA_CACHE_MAX_ENTRY_BYTES)
    this._bindings = new Map()
    this._sessionGeneration = 0
    this._knownUserId = null
    this._inFlight = new _InFlightRegistry()
  }

  // Legacy shape: bind a protected-worker URL. Retained so existing callers
  // that only have `source.protectedUrl` still work; the new preferred path
  // is `bindCacheableMedia`.
  bind(element, mediaUrl, options = {}) {
    const url = String(mediaUrl || '').trim()
    if (!element || !url) return Promise.resolve(null)

    const current = this._bindings.get(element)
    if (current?.legacyUrl === url && current.objectUrl) return Promise.resolve(current.objectUrl)
    if (current) this.release(element)

    const binding = {
      element,
      legacyUrl: url,
      identity: null,
      publicUrl: '',
      objectUrl: null,
      requestGeneration: 0,
      onLoad: typeof options.onLoad === 'function' ? options.onLoad : null,
      mode: 'legacy-protected',
    }
    this._bindings.set(element, binding)
    element.removeAttribute?.('src')
    element.dataset && (element.dataset.protectedMediaState = 'loading')
    return this._loadLegacyProtected(binding)
  }

  // New: bind an element to a durable cache identity plus optional remote
  // hints (a public URL for the online-remote fetch path). Handles public,
  // protected, and avatar media through the single cache-first pipeline.
  bindCacheable(element, identity, options = {}) {
    if (!element || !identity) return Promise.resolve(null)
    const cacheKey = buildMediaCacheKey(identity)
    if (!cacheKey) return Promise.resolve(null)

    const current = this._bindings.get(element)
    if (current?.cacheKey === cacheKey && current.objectUrl) return Promise.resolve(current.objectUrl)
    if (current) this.release(element)

    const binding = {
      element,
      identity,
      cacheKey,
      publicUrl: String(options.publicUrl || '').trim(),
      protectedUrl: String(options.protectedUrl || '').trim(),
      objectUrl: null,
      requestGeneration: 0,
      onLoad: typeof options.onLoad === 'function' ? options.onLoad : null,
      mode: identity.privacyScope === MEDIA_PRIVACY_SCOPE.PROTECTED ? 'protected' : 'public',
      onMiss: typeof options.onMiss === 'function' ? options.onMiss : null,
    }
    this._bindings.set(element, binding)
    element.removeAttribute?.('src')
    element.dataset && (element.dataset.protectedMediaState = 'loading')
    return this._loadCacheable(binding)
  }

  async _loadCacheable(binding) {
    const requestGeneration = ++binding.requestGeneration
    const sessionGeneration = this._sessionGeneration
    const identity = binding.identity

    // 1. Local cache read. Always safe, no capability gate needed.
    let cached
    try { cached = await this._cacheRead(identity) }
    catch (_) { cached = null }
    if (!this._stillCurrent(binding, requestGeneration, sessionGeneration)) return null
    if (cached?.blob) {
      return this._paintFromBlob(binding, cached.blob)
    }

    // 2. Miss. Capability gate decides whether a remote attempt is even
    //    allowed. In CACHED / REAUTH_REQUIRED this ALWAYS denies; the
    //    element degrades to placeholder without touching the network.
    const capability = this._capabilityCheck()
    if (!capability?.allowed) {
      binding.onMiss?.('capability-denied')
      this._markUnavailable(binding)
      return null
    }

    // 3. Deduplicate concurrent remote fetches by cacheKey. Multiple DOM
    //    elements bound to the same identity share one round trip.
    const existing = this._inFlight.get(binding.cacheKey)
    const workPromise = existing || this._inFlight.set(binding.cacheKey, this._fetchAndCache(binding))
    let outcome
    try { outcome = await workPromise }
    catch (_) { outcome = null }
    if (!this._stillCurrent(binding, requestGeneration, sessionGeneration)) return null
    if (outcome?.blob) return this._paintFromBlob(binding, outcome.blob)

    // 3b. PUBLIC-ONLY fail-open (B3 regression fix): cache warming failed for
    //     a non-authoritative reason (CORS / transport / non-OK / non-image).
    //     Fall back to a plain `img.src = publicUrl` so the browser renders
    //     the image itself, exactly as it did pre-Stage-B. Never applied to
    //     protected media, and re-gated on the capability check because the
    //     state may have flipped to CACHED / REAUTH while the fetch was in
    //     flight (an http(s) src assignment is a browser-level GET).
    if (outcome?.publicSrcFallbackEligible && this._canFallBackToDirectPublicSrc(binding)) {
      return this._paintDirectPublicUrl(binding)
    }

    binding.onMiss?.('remote-failed')
    this._markUnavailable(binding)
    return null
  }

  // Remote acquisition. Returns an outcome object:
  //   { blob, publicSrcFallbackEligible }
  //   * `blob` — validated image bytes to paint (and maybe persist), or null.
  //   * `publicSrcFallbackEligible` — true ONLY when a PUBLIC acquisition
  //     failed for a NON-authoritative reason (CORS block, transport error,
  //     non-OK status, non-image body — anything that is not a definitive
  //     "this image is gone" ruling; the public CDN never issues one that we
  //     trust over the browser's own <img> resolution). Account-isolation
  //     refusals and EVERY protected-path failure keep this false so
  //     protected media stays fail-closed.
  async _fetchAndCache(binding) {
    // Chooses a byte-fetch strategy: protected identities require the
    // authenticated worker URL (Bearer header); public identities try the
    // public URL first. Never persists the transport URL — only the blob.
    const identity = binding.identity
    let session
    // A session-read failure must not break PUBLIC display (pre-Stage-B the
    // public <img> path never consulted the session at all). Protected media
    // still fails closed below because it requires token + userId.
    try { session = await this._getSession() } catch (_) { session = null }
    const token = _accessToken(session)
    const userId = _userId(session)
    if (identity?.userId && userId && identity.userId !== userId) {
      // The signed-in user does not match the identity we were asked to
      // load. Refuse — this prevents A's session from fetching a resource
      // keyed under B (or vice versa) when a race with account-switch
      // exists. Isolation refusals never fall back to a direct public src.
      return { blob: null, publicSrcFallbackEligible: false }
    }
    if (this._knownUserId && userId && this._knownUserId !== userId) {
      return { blob: null, publicSrcFallbackEligible: false }
    }
    if (userId) this._knownUserId = userId

    if (identity?.privacyScope === MEDIA_PRIVACY_SCOPE.PROTECTED) {
      if (!token || !userId) return { blob: null, publicSrcFallbackEligible: false }
      const url = binding.protectedUrl
      if (!url) return { blob: null, publicSrcFallbackEligible: false }
      const blob = await this._doAuthorizedFetch(binding, url, token, identity)
      return { blob, publicSrcFallbackEligible: false }
    }

    // Public / avatar path: try the public URL first if any.
    const url = binding.publicUrl
    if (!url) return { blob: null, publicSrcFallbackEligible: false }
    try {
      const response = await this._fetch(url, { cache: 'no-store' })
      if (!response?.ok) return { blob: null, publicSrcFallbackEligible: true }
      const blob = await this._extractImageBlob(response, binding)
      if (!blob) return { blob: null, publicSrcFallbackEligible: true }
      return { blob, publicSrcFallbackEligible: false }
    } catch (_) {
      // CORS rejections surface as a TypeError from fetch — the exact
      // Capacitor Android regression (origin https://localhost fetching
      // media.sporely.no without an Access-Control-Allow-Origin header).
      return { blob: null, publicSrcFallbackEligible: true }
    }
  }

  async _doAuthorizedFetch(binding, url, token, identity) {
    let response
    try {
      response = await this._fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
    } catch (_) { return null }
    if (!response) return null
    const status = Number(response.status || 0)
    if (status === 401 || status === 403 || status === 404) {
      // Authoritative "no". Evict any stale cache entry so a subsequent
      // load cannot re-render the doomed blob.
      try { await this._cacheDelete(identity) } catch { /* ignore */ }
      return null
    }
    if (!response.ok) return null
    return await this._extractImageBlob(response, binding)
  }

  async _extractImageBlob(response, binding) {
    let blob
    try { blob = await response.blob() }
    catch (_) { return null }
    if (!blob) return null
    const contentType = String(blob.type || response.headers?.get?.('content-type') || '').toLowerCase()
    // Non-image responses (JSON error, HTML 200-with-body, etc.) must NEVER
    // be blob-rendered and must NEVER be persisted. Protected elements
    // degrade to the placeholder; PUBLIC elements fall back to the direct
    // `img.src = publicUrl` render in `_loadCacheable` (a non-image body
    // from the public CDN is not an authoritative tombstone).
    if (!contentType.startsWith('image/')) return null
    const size = Number(blob.size || 0)
    if (!Number.isFinite(size) || size <= 0) return null

    // Oversized VALID image response: paint the object URL for this render
    // (online display fallback is preserved) but do NOT persist to the
    // per-entry-capped media cache. On the next cold boot, the element
    // will miss the cache and either refetch (if COMPLETE) or degrade to
    // a placeholder (if CACHED / REAUTH). This is the correct separation:
    // "too big to cache" is a caching decision, not a rendering decision.
    if (size > this._maxEntryBytes) return blob

    // Persist as a background best-effort. A failure to persist must NEVER
    // block the paint — the element still gets its object URL for this
    // paint even if we cannot save it for next launch.
    if (binding.identity) {
      try {
        // Some blobs may carry no type; recreate with an explicit type so
        // the media-cache content-type guard passes.
        const persistable = blob.type ? blob : (typeof Blob !== 'undefined' ? new Blob([await blob.arrayBuffer()], { type: contentType }) : blob)
        this._cacheWrite(binding.identity, persistable).catch(() => {})
      } catch (_) { /* ignore */ }
    }
    return blob
  }

  _paintFromBlob(binding, blob) {
    const objectUrl = this._createObjectURL(blob)
    if (!this._bindings.get(binding.element) || this._bindings.get(binding.element) !== binding) {
      this._revokeObjectURL(objectUrl)
      return null
    }
    if (binding.objectUrl) this._revokeObjectURL(binding.objectUrl)
    binding.objectUrl = objectUrl
    binding.element.src = objectUrl
    binding.element.dataset && (binding.element.dataset.protectedMediaState = 'ready')
    binding.onLoad?.(objectUrl)
    return objectUrl
  }

  // Fail-open direct-src fallback eligibility. Restricted to:
  //   * privacyScope PUBLIC only (never protected, never the self avatar);
  //   * a non-empty public URL hint;
  //   * `canUseAuthenticatedNetwork().allowed === true` AT ASSIGNMENT TIME —
  //     the gate may have flipped to CACHED / REAUTH_REQUIRED while the
  //     warming fetch was in flight (e.g. the network dropped, which is a
  //     likely cause of the fetch failure in the first place). Assigning an
  //     http(s) `src` triggers a browser-level GET, which must never happen
  //     in those states.
  _canFallBackToDirectPublicSrc(binding) {
    if (binding.identity?.privacyScope !== MEDIA_PRIVACY_SCOPE.PUBLIC) return false
    if (!binding.publicUrl) return false
    return this._capabilityCheck()?.allowed === true
  }

  _paintDirectPublicUrl(binding) {
    if (this._bindings.get(binding.element) !== binding) return null
    if (binding.objectUrl) {
      this._revokeObjectURL(binding.objectUrl)
      binding.objectUrl = null
    }
    binding.element.src = binding.publicUrl
    binding.element.dataset && (binding.element.dataset.protectedMediaState = 'direct')
    binding.onLoad?.(binding.publicUrl)
    return binding.publicUrl
  }

  _markUnavailable(binding) {
    if (this._bindings.get(binding.element) !== binding) return
    binding.element.removeAttribute?.('src')
    binding.element.dataset && (binding.element.dataset.protectedMediaState = 'unavailable')
  }

  _stillCurrent(binding, requestGeneration, sessionGeneration) {
    return this._bindings.get(binding.element) === binding
      && binding.requestGeneration === requestGeneration
      && this._sessionGeneration === sessionGeneration
  }

  // Legacy path: authorized worker URL with no cache identity. Kept for
  // call sites that only carry `protectedUrl` (no durable key). No caching
  // occurs; behavior is the pre-Stage-B fetch-and-paint.
  async _loadLegacyProtected(binding, suppliedSession = undefined) {
    const requestGeneration = ++binding.requestGeneration
    const sessionGeneration = this._sessionGeneration

    // Only attempt the remote fetch when the capability gate allows it. In
    // CACHED / REAUTH the previous behavior would fire a doomed 401; that
    // is now silently a placeholder.
    const capability = this._capabilityCheck()
    if (!capability?.allowed) {
      this._markUnavailable(binding)
      return null
    }

    try {
      const session = suppliedSession === undefined ? await this._getSession() : suppliedSession
      const token = _accessToken(session)
      const userId = _userId(session)
      if (!token || !userId) throw new Error('Protected media requires an authenticated session.')
      if (!this._knownUserId) this._knownUserId = userId

      const response = await this._fetch(binding.legacyUrl, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      if (!response?.ok) {
        const error = new Error('Protected media is unavailable.')
        error.status = Number(response?.status || 0)
        throw error
      }
      const blob = await response.blob()
      const contentType = String(blob?.type || response.headers?.get?.('content-type') || '').toLowerCase()
      if (!blob || !contentType.startsWith('image/')) throw new Error('Protected media response was not an image.')

      if (!this._stillCurrent(binding, requestGeneration, sessionGeneration)) return null
      return this._paintFromBlob(binding, blob)
    } catch (_) {
      if (this._bindings.get(binding.element) === binding && binding.requestGeneration === requestGeneration) {
        this._markUnavailable(binding)
      }
      return null
    }
  }

  release(element) {
    const binding = this._bindings.get(element)
    if (!binding) return
    binding.requestGeneration += 1
    if (binding.objectUrl) {
      this._revokeObjectURL(binding.objectUrl)
      binding.objectUrl = null
    }
    binding.element.removeAttribute?.('src')
    this._bindings.delete(element)
  }

  releaseWithin(root) {
    for (const element of this._bindings.keys()) {
      if (element === root || root?.contains?.(element)) this.release(element)
    }
  }

  handleSessionChange(session) {
    const nextUserId = _userId(session)
    const hasSession = !!_accessToken(session) && !!nextUserId

    if (!hasSession || (this._knownUserId && this._knownUserId !== nextUserId)) {
      // Sign-out or account switch. Every current binding must be revoked;
      // A's object URLs must never be reused for B.
      this._sessionGeneration += 1
      this.dispose()
      this._knownUserId = hasSession ? nextUserId : null
      return
    }

    // Same-user token refresh. Bump generation to invalidate in-flight
    // operations, revoke and requeue.
    this._sessionGeneration += 1
    this._knownUserId = nextUserId
    const bindings = [...this._bindings.values()]
    for (const binding of bindings) {
      binding.requestGeneration += 1
      if (binding.objectUrl) {
        this._revokeObjectURL(binding.objectUrl)
        binding.objectUrl = null
      }
      binding.element.removeAttribute?.('src')
    }
    queueMicrotask(() => {
      for (const binding of bindings) {
        if (this._bindings.get(binding.element) !== binding) continue
        if (binding.mode === 'legacy-protected') this._loadLegacyProtected(binding, session)
        else this._loadCacheable(binding)
      }
    })
  }

  dispose() {
    for (const element of [...this._bindings.keys()]) this.release(element)
  }
}

const protectedMediaLoader = new ProtectedMediaLoader()
let removalObserver = null
let pagehideBound = false

function _observeRemovedMedia() {
  if (removalObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.documentElement) return
  removalObserver = new MutationObserver(records => {
    const removed = records.flatMap(record => [...record.removedNodes])
    if (!removed.length) return
    queueMicrotask(() => {
      for (const node of removed) {
        if (!node?.isConnected) protectedMediaLoader.releaseWithin(node)
      }
    })
  })
  removalObserver.observe(document.documentElement, { childList: true, subtree: true })
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true
    window.addEventListener('pagehide', () => protectedMediaLoader.dispose(), { once: true })
  }
}

// Legacy default entry: given a raw protectedUrl string or a source object.
export function bindProtectedMedia(element, source, options = {}) {
  const url = typeof source === 'string' ? source : source?.protectedUrl
  if (!url) return Promise.resolve(null)
  _observeRemovedMedia()
  return protectedMediaLoader.bind(element, url, options)
}

// New: bind a cache identity + optional public/protected URL hints. The
// loader consults the media cache first, then applies the capability gate
// before any remote fetch. Passing `privacyScope=protected` implies the
// fetch will use the authorized worker URL and evict on 401/403/404.
export function bindCacheableMedia(element, identity, options = {}) {
  _observeRemovedMedia()
  return protectedMediaLoader.bindCacheable(element, identity, options)
}

export function releaseProtectedMediaWithin(root) {
  protectedMediaLoader.releaseWithin(root)
}

export function notifyProtectedMediaSessionChange(session) {
  protectedMediaLoader.handleSessionChange(session)
}

// Test-only accessor to the default loader singleton so orchestration tests
// can dispose it between runs.
export function _defaultLoaderForTests() { return protectedMediaLoader }

// Handy re-exports so screens can build identities from one place.
export { MEDIA_KIND, MEDIA_PRIVACY_SCOPE }
