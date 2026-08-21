import { supabase } from './supabase.js'

const SESSION_CACHE_KEY = '__sporelyAuthSessionCache__'
const SESSION_PROMISE_KEY = '__sporelyAuthSessionPromise__'
const SESSION_CACHE_TTL_MS = 1000

function _globalAuthState() {
  const scope = globalThis
  if (!scope[SESSION_CACHE_KEY]) scope[SESSION_CACHE_KEY] = { session: null, at: 0 }
  return scope[SESSION_CACHE_KEY]
}

function _getSessionPromiseState() {
  const scope = globalThis
  return scope[SESSION_PROMISE_KEY] || null
}

function _setSessionPromiseState(promise) {
  globalThis[SESSION_PROMISE_KEY] = promise
}

export function clearSharedAuthSessionCache() {
  const state = _globalAuthState()
  state.session = null
  state.at = 0
  _setSessionPromiseState(null)
}

export function seedSharedAuthSession(session) {
  const state = _globalAuthState()
  state.session = session || null
  state.at = Date.now()
}

export async function getSharedAuthSession(options = {}) {
  const forceRefresh = options?.refresh === true
  const state = _globalAuthState()
  const now = Date.now()

  if (!forceRefresh && state.session && (now - state.at) < SESSION_CACHE_TTL_MS) {
    return state.session
  }

  const existingPromise = _getSessionPromiseState()
  if (existingPromise) {
    return existingPromise
  }

  const sessionPromise = supabase.auth.getSession()
    .then(({ data, error }) => {
      const session = data?.session || null
      // supabase-js reports refresh failures via the `error` channel WITHOUT
      // throwing (auth-js __loadSession returns { session: null, error }).
      // Swallowing it here made every downstream `_isExplicitAuthRejection`
      // gate dead code: a server-confirmed revocation was indistinguishable
      // from "no session stored". Surface it as a throw so callers can
      // classify auth-reject vs transport. A session alongside an error is
      // still a usable session — never discard it.
      if (error && !session) {
        state.session = null
        state.at = 0
        throw error
      }
      state.session = session
      state.at = Date.now()
      return session
    })
    .catch(error => {
      state.session = null
      state.at = 0
      throw error
    })
    .finally(() => {
      if (_getSessionPromiseState() === sessionPromise) {
        _setSessionPromiseState(null)
      }
    })

  _setSessionPromiseState(sessionPromise)
  return sessionPromise
}

export async function getSharedAuthUser(options = {}) {
  const session = await getSharedAuthSession(options)
  return session?.user || null
}
