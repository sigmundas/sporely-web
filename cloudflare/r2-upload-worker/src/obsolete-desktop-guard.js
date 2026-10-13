// Obsolete-desktop media brake. The media half of
// supabase/migrations/20261013200000_obsolete_desktop_sync_brake.sql.
//
// Every shipped Sporely desktop can resolve a sync write to another device's
// cloud observation through the shared desktop_id reverse link. The database
// refuses their row writes; this guard refuses their media writes, so that an
// old desktop deleting an observation cannot remove the media before the
// database refuses the row delete.
//
// Same identification rule as private.sync_brake_guard(): the lower-cased
// User-Agent starts with `python-requests/` (the default every shipped
// desktop sends) and there is no `x-sporely-sync-identity: 2` header. The
// /upload/ routes accept only end-user JWTs (audience `authenticated`), so the
// database's role condition holds here by construction. Web and Android send
// browser User-Agents and are not affected.
//
// This holds back honest old clients. It is NOT an authorization boundary:
// any caller can choose its User-Agent. It is removed only together with the
// database brake, by the sync-key cutover, never as a rollback.

export const UPGRADE_REQUIRED_CODE = 'sporely_upgrade_required'
export const UPGRADE_REQUIRED_MESSAGE =
  'Sporely Desktop must be updated before it can upload to Sporely Cloud. ' +
  'Install the latest version from sporely.no. Nothing was changed in the cloud.'

const SYNC_IDENTITY_HEADER = 'x-sporely-sync-identity'
const SYNC_KEY_PROTOCOL = '2'
const OBSOLETE_DESKTOP_USER_AGENT_PREFIX = 'python-requests/'
// Every route under /upload/ that is not a read creates, replaces, binds or
// deletes a media object (today PUT and DELETE). Refusing any other method
// there too keeps a future mutating route covered by default.
const MEDIA_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isObsoleteDesktopRequest(request) {
  const headers = request?.headers
  if (!headers) return false
  if (String(headers.get(SYNC_IDENTITY_HEADER) ?? '') === SYNC_KEY_PROTOCOL) return false
  const userAgent = String(headers.get('User-Agent') || '').toLowerCase()
  return userAgent.startsWith(OBSOLETE_DESKTOP_USER_AGENT_PREFIX)
}

export function isMediaMutationRequest(request) {
  const method = String(request?.method || '').toUpperCase()
  if (MEDIA_READ_METHODS.has(method)) return false
  let pathname
  try {
    pathname = new URL(request.url).pathname
  } catch (_) {
    return false
  }
  return pathname.startsWith('/upload/')
}

// Returns the 426 refusal for an obsolete desktop's media mutation, or null
// when the request may proceed. `corsHeaders` is the worker's usual CORS
// header set for this request.
export function obsoleteDesktopRefusal(request, corsHeaders) {
  if (!isMediaMutationRequest(request) || !isObsoleteDesktopRequest(request)) {
    return null
  }
  const headers = new Headers(corsHeaders || undefined)
  headers.set('Content-Type', 'application/json')
  headers.set('X-Sporely-Error-Code', UPGRADE_REQUIRED_CODE)
  return new Response(
    JSON.stringify({ error: UPGRADE_REQUIRED_CODE, message: UPGRADE_REQUIRED_MESSAGE }),
    { status: 426, headers },
  )
}

// Self-check for /healthz (`obsoleteDesktopBrake`). Runs a synthetic
// shipped-desktop upload through the guard, so the flag reports what the
// guard actually does rather than a constant that could drift from it. A
// worker built from a tree without this module has no flag at all.
const BRAKE_SELF_CHECK_URL =
  'https://upload.sporely.no/upload/00000000-0000-4000-8000-000000000000/brake-self-check.webp'

export function isObsoleteDesktopBrakeActive() {
  const probe = new Request(BRAKE_SELF_CHECK_URL, {
    method: 'PUT',
    headers: { 'User-Agent': 'python-requests/2.32.3' },
  })
  return obsoleteDesktopRefusal(probe, null)?.status === 426
}
