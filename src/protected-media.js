import { getSharedAuthSession } from './auth-session.js'

function _accessToken(session) {
  return String(session?.access_token || '').trim()
}

function _userId(session) {
  return String(session?.user?.id || '').trim()
}

export class ProtectedMediaLoader {
  constructor(options = {}) {
    this._getSession = options.getSession || getSharedAuthSession
    this._fetch = options.fetch || ((...args) => globalThis.fetch(...args))
    this._createObjectURL = options.createObjectURL || (blob => URL.createObjectURL(blob))
    this._revokeObjectURL = options.revokeObjectURL || (url => URL.revokeObjectURL(url))
    this._bindings = new Map()
    this._sessionGeneration = 0
    this._knownUserId = null
  }

  bind(element, mediaUrl, options = {}) {
    const url = String(mediaUrl || '').trim()
    if (!element || !url) return Promise.resolve(null)

    const current = this._bindings.get(element)
    if (current?.url === url && current.objectUrl) return Promise.resolve(current.objectUrl)
    if (current) this.release(element)

    const binding = {
      element,
      url,
      objectUrl: null,
      requestGeneration: 0,
      onLoad: typeof options.onLoad === 'function' ? options.onLoad : null,
    }
    this._bindings.set(element, binding)
    element.removeAttribute?.('src')
    return this._load(binding)
  }

  async _load(binding, suppliedSession = undefined) {
    const requestGeneration = ++binding.requestGeneration
    const sessionGeneration = this._sessionGeneration

    try {
      const session = suppliedSession === undefined
        ? await this._getSession()
        : suppliedSession
      const token = _accessToken(session)
      const userId = _userId(session)
      if (!token || !userId) throw new Error('Protected media requires an authenticated session.')
      if (!this._knownUserId) this._knownUserId = userId

      const response = await this._fetch(binding.url, {
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
      if (!blob || !contentType.startsWith('image/')) {
        throw new Error('Protected media response was not an image.')
      }

      const objectUrl = this._createObjectURL(blob)
      const stillCurrent = this._bindings.get(binding.element) === binding
        && binding.requestGeneration === requestGeneration
        && this._sessionGeneration === sessionGeneration
      if (!stillCurrent) {
        this._revokeObjectURL(objectUrl)
        return null
      }

      if (binding.objectUrl) this._revokeObjectURL(binding.objectUrl)
      binding.objectUrl = objectUrl
      binding.element.src = objectUrl
      binding.element.dataset && (binding.element.dataset.protectedMediaState = 'ready')
      binding.onLoad?.(objectUrl)
      return objectUrl
    } catch (_) {
      if (this._bindings.get(binding.element) === binding && binding.requestGeneration === requestGeneration) {
        binding.element.removeAttribute?.('src')
        binding.element.dataset && (binding.element.dataset.protectedMediaState = 'unavailable')
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
      this._sessionGeneration += 1
      this.dispose()
      this._knownUserId = hasSession ? nextUserId : null
      return
    }

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
        if (this._bindings.get(binding.element) === binding) this._load(binding, session)
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

export function bindProtectedMedia(element, source, options = {}) {
  const url = typeof source === 'string' ? source : source?.protectedUrl
  if (!url) return Promise.resolve(null)
  _observeRemovedMedia()
  return protectedMediaLoader.bind(element, url, options)
}

export function releaseProtectedMediaWithin(root) {
  protectedMediaLoader.releaseWithin(root)
}

export function notifyProtectedMediaSessionChange(session) {
  protectedMediaLoader.handleSessionChange(session)
}
