// Shared OAuth consent return helpers. authorization_id is opaque server data,
// so validate only the conservative character set needed for a URL query value.

export const CONSENT_PENDING_KEY = 'sporely-oauth-consent-pending'
export const CONSENT_PENDING_TTL_MS = 10 * 60 * 1000

export function isValidOAuthAuthorizationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function storePendingOAuthConsent(authorizationId) {
  if (!isValidOAuthAuthorizationId(authorizationId)) return false
  try {
    globalThis.sessionStorage?.setItem(
      CONSENT_PENDING_KEY,
      JSON.stringify({ id: authorizationId, ts: Date.now() })
    )
    return true
  } catch (_) {
    return false
  }
}

/** Reads, validates, clears, and returns the one-time consent path, or null. */
export function consumePendingOAuthConsentReturn() {
  try {
    const raw = globalThis.sessionStorage?.getItem(CONSENT_PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const id = parsed?.id
    const ts = Number(parsed?.ts || 0)
    globalThis.sessionStorage?.removeItem(CONSENT_PENDING_KEY)
    if (!isValidOAuthAuthorizationId(id)) return null
    if (ts && (Date.now() - ts) > CONSENT_PENDING_TTL_MS) return null
    return `/oauth/consent?authorization_id=${encodeURIComponent(id)}`
  } catch (_) {
    return null
  }
}
