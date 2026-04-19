const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const DEFAULT_FREE_STORAGE_QUOTA_BYTES = 0
const DEFAULT_ALLOWED_METHODS = 'PUT, POST, DELETE, OPTIONS'
const DEFAULT_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Cache-Control',
  'X-Sporely-Upload-Mode',
  'X-Sporely-Cloud-Plan',
  'X-Sporely-Upload-Origin',
].join(', ')
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000

let cachedJwks = null
let cachedJwksAt = 0

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx)
    } catch (error) {
      const status = Number(error?.status || 500)
      const message = status >= 500 ? 'Internal server error' : String(error?.message || 'Request failed')
      return jsonResponse(
        { error: error?.code || 'request_failed', message },
        status,
        request,
        env,
      )
    }
  },
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return handleOptions(request, env)
  }

  if (url.pathname === '/healthz') {
    return jsonResponse({ ok: true, service: 'sporely-r2-upload-worker' }, 200, request, env)
  }

  if (request.method === 'POST' && url.pathname === '/artsorakel') {
    return handleArtsorakel(request, env, ctx)
  }

  if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
    return handleUpload(request, env, ctx, url)
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/upload/')) {
    return handleDelete(request, env, ctx, url)
  }

  throw httpError(404, 'not_found', 'Route not found')
}

function handleOptions(request, env) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env, origin),
  })
}

async function handleUpload(request, env, ctx, url) {
  if (!env.MEDIA_BUCKET) {
    throw httpError(500, 'missing_bucket', 'MEDIA_BUCKET binding is not configured')
  }

  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const key = normalizeObjectKey(url.pathname.slice('/upload/'.length))
  if (!key) {
    throw httpError(400, 'invalid_key', 'Missing upload key')
  }
  if (!claims?.sub || !key.startsWith(`${claims.sub}/`)) {
    throw httpError(403, 'key_not_allowed', 'Upload key must start with the authenticated user id')
  }

  const contentLength = parseIntegerHeader(request.headers.get('Content-Length'))
  const maxUploadBytes = parsePositiveInt(env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES)
  if (contentLength !== null && contentLength > maxUploadBytes) {
    throw httpError(413, 'payload_too_large', `Upload exceeds ${maxUploadBytes} bytes`)
  }
  if (!request.body) {
    throw httpError(400, 'missing_body', 'Request body is required')
  }

  const contentType = String(request.headers.get('Content-Type') || '').trim() || 'application/octet-stream'
  if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
    throw httpError(415, 'unsupported_media_type', 'Only image uploads are supported')
  }

  const bodyBuffer = await request.arrayBuffer()
  const bodyBytes = bodyBuffer.byteLength
  if (bodyBytes > maxUploadBytes) {
    throw httpError(413, 'payload_too_large', `Upload exceeds ${maxUploadBytes} bytes`)
  }

  const existingObject = await env.MEDIA_BUCKET.head(key)
  const existingBytes = mediaObjectSize(existingObject)
  const storageDelta = Math.max(0, bodyBytes - existingBytes)
  const profile = await fetchStorageProfile(env, claims.sub)
  assertStorageQuotaAllowsUpload(profile, storageDelta, env)

  const cacheControl = String(request.headers.get('Cache-Control') || 'public, max-age=31536000, immutable').trim()
  const object = await env.MEDIA_BUCKET.put(key, bodyBuffer, {
    httpMetadata: {
      contentType,
      cacheControl,
    },
    customMetadata: {
      user_id: String(claims.sub),
      uploaded_at: new Date().toISOString(),
      uploaded_by: String(claims.email || ''),
    },
  })
  const imageDelta = isOriginalImageKey(key) && !existingObject ? 1 : 0
  let trackedProfile = null
  try {
    trackedProfile = await applyStorageDelta(env, claims.sub, bodyBytes - existingBytes, imageDelta)
  } catch (error) {
    await env.MEDIA_BUCKET.delete(key).catch(deleteError => {
      console.error('Failed to roll back R2 upload after tally error', deleteError)
    })
    throw error
  }

  return jsonResponse(
    {
      ok: true,
      key,
      etag: object?.etag || null,
      size: bodyBytes,
      storage: trackedProfile,
      url: publicMediaUrl(env, key),
    },
    201,
    request,
    env,
    origin,
  )
}

async function handleDelete(request, env, ctx, url) {
  if (!env.MEDIA_BUCKET) {
    throw httpError(500, 'missing_bucket', 'MEDIA_BUCKET binding is not configured')
  }

  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  const claims = await verifySupabaseJwt(token, env, ctx)

  const key = normalizeObjectKey(url.pathname.slice('/upload/'.length))
  if (!key) {
    throw httpError(400, 'invalid_key', 'Missing upload key')
  }
  if (!claims?.sub || !key.startsWith(`${claims.sub}/`)) {
    throw httpError(403, 'key_not_allowed', 'Delete key must start with the authenticated user id')
  }

  const existingObject = await env.MEDIA_BUCKET.head(key)
  await env.MEDIA_BUCKET.delete(key)
  const existingBytes = mediaObjectSize(existingObject)
  const imageDelta = isOriginalImageKey(key) && existingObject ? -1 : 0
  const trackedProfile = await applyStorageDelta(env, claims.sub, -existingBytes, imageDelta)

  return jsonResponse(
    {
      ok: true,
      key,
      deleted: true,
      storage: trackedProfile,
    },
    200,
    request,
    env,
    origin,
  )
}

async function fetchStorageProfile(env, userId) {
  if (!hasSupabaseServiceRole(env)) return null

  const query = [
    `id=eq.${encodeURIComponent(userId)}`,
    'select=cloud_plan,storage_quota_bytes,total_storage_bytes,storage_used_bytes,image_count',
    'limit=1',
  ].join('&')
  const response = await supabaseRestFetch(env, `/rest/v1/profiles?${query}`, { method: 'GET' })
  if (!response.ok) {
    throw httpError(500, 'profile_fetch_failed', 'Could not fetch storage profile')
  }
  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : null
}

function assertStorageQuotaAllowsUpload(profile, storageDelta, env) {
  if (!profile || storageDelta <= 0) return

  const cloudPlan = String(profile.cloud_plan || '').trim().toLowerCase()
  if (cloudPlan === 'pro') return

  const quota = parseNonNegativeInt(profile.storage_quota_bytes, parseNonNegativeInt(env.FREE_STORAGE_QUOTA_BYTES, DEFAULT_FREE_STORAGE_QUOTA_BYTES))
  if (!quota) return

  const used = parseNonNegativeInt(profile.total_storage_bytes ?? profile.storage_used_bytes, 0)
  if (used + storageDelta > quota) {
    throw httpError(413, 'storage_quota_exceeded', 'This account has reached its storage limit')
  }
}

async function applyStorageDelta(env, userId, storageDelta, imageDelta) {
  if (!hasSupabaseServiceRole(env) || (!storageDelta && !imageDelta)) return null

  const response = await supabaseRestFetch(env, '/rest/v1/rpc/apply_profile_storage_delta', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_storage_delta: Math.trunc(storageDelta),
      p_image_delta: Math.trunc(imageDelta),
    }),
  })
  if (!response.ok) {
    throw httpError(500, 'profile_tally_failed', 'Could not update profile storage tally')
  }
  const rows = await response.json()
  const profile = Array.isArray(rows) ? rows[0] || null : rows
  return profile ? {
    total_storage_bytes: Number(profile.total_storage_bytes || 0),
    storage_used_bytes: Number(profile.storage_used_bytes || 0),
    image_count: Number(profile.image_count || 0),
  } : null
}

function hasSupabaseServiceRole(env) {
  return !!String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
}

function supabaseRestFetch(env, path, options = {}) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!supabaseUrl || !serviceRoleKey) {
    throw httpError(500, 'missing_supabase_admin', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for storage tracking')
  }

  const headers = new Headers(options.headers || {})
  headers.set('apikey', serviceRoleKey)
  headers.set('Authorization', `Bearer ${serviceRoleKey}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json')
  return fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers,
  })
}

function mediaObjectSize(object) {
  const size = Number(object?.size)
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0
}

function isOriginalImageKey(key) {
  const filename = String(key || '').split('/').pop() || ''
  return !!filename && !filename.startsWith('thumb_')
}

async function handleArtsorakel(request, env, ctx) {
  const origin = resolveAllowedOrigin(request, env)
  if (request.headers.get('Origin') && !origin) {
    throw httpError(403, 'origin_not_allowed', 'Origin is not allowed')
  }

  const authHeader = request.headers.get('Authorization')
  const token = parseBearerToken(authHeader)
  await verifySupabaseJwt(token, env, ctx)

  if (!request.body) {
    throw httpError(400, 'missing_body', 'Request body is required')
  }

  const contentType = String(request.headers.get('Content-Type') || '').trim()
  const bodyBuffer = await request.arrayBuffer()
  const upstream = await fetch('https://ai.artsdatabanken.no', {
    method: 'POST',
    headers: contentType ? { 'Content-Type': contentType } : {},
    body: bodyBuffer,
  })

  const upstreamBody = await upstream.arrayBuffer()
  const responseHeaders = corsHeaders(request, env, origin)
  const upstreamContentType = upstream.headers.get('Content-Type')
  if (upstreamContentType) {
    responseHeaders.set('Content-Type', upstreamContentType)
  }
  return new Response(upstreamBody, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

function parseBearerToken(authHeader) {
  const text = String(authHeader || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(text)
  if (!match?.[1]) {
    throw httpError(401, 'missing_token', 'Missing Bearer token')
  }
  return match[1].trim()
}

async function verifySupabaseJwt(token, env, ctx) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) {
    throw httpError(401, 'invalid_token', 'Malformed JWT')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = parseJsonSegment(encodedHeader, 'JWT header')
  const payload = parseJsonSegment(encodedPayload, 'JWT payload')
  const signature = base64UrlToBytes(encodedSignature)
  const signedData = encoder().encode(`${encodedHeader}.${encodedPayload}`)

  await verifyJwtSignature(header, signature, signedData, env, ctx)
  validateJwtClaims(payload, env)
  return payload
}

async function verifyJwtSignature(header, signature, signedData, env, ctx) {
  const alg = String(header?.alg || '').trim()
  if (!alg || alg === 'none') {
    throw httpError(401, 'invalid_token', 'JWT algorithm is not allowed')
  }

  if (alg.startsWith('HS')) {
    const secret = String(env.SUPABASE_JWT_SECRET || '').trim()
    if (!secret) {
      throw httpError(500, 'missing_jwt_secret', 'SUPABASE_JWT_SECRET is required for HS* JWT validation')
    }
    const key = await crypto.subtle.importKey(
      'raw',
      encoder().encode(secret),
      { name: 'HMAC', hash: hashNameForAlg(alg) },
      false,
      ['sign'],
    )
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedData))
    if (!constantTimeEqual(expected, signature)) {
      throw httpError(401, 'invalid_token', 'JWT signature verification failed')
    }
    return
  }

  const jwk = await resolveJwkForHeader(header, env, ctx)
  const cryptoKey = await importJwkForVerify(jwk, alg)
  const verifyAlgorithm = subtleVerifyAlgorithmForAlg(alg)
  const signatureBytes = signature
  const ok = await crypto.subtle.verify(verifyAlgorithm, cryptoKey, signatureBytes, signedData)
  if (!ok) {
    throw httpError(401, 'invalid_token', 'JWT signature verification failed')
  }
}

async function resolveJwkForHeader(header, env, ctx) {
  const keys = await getSupabaseJwks(env, ctx)
  if (!keys.length) {
    throw httpError(500, 'jwks_unavailable', 'No JWKS keys available for JWT validation')
  }

  const kid = String(header?.kid || '').trim()
  let jwk = null
  if (kid) {
    jwk = keys.find(key => String(key?.kid || '').trim() === kid) || null
  } else if (keys.length === 1) {
    jwk = keys[0]
  }

  if (!jwk) {
    throw httpError(401, 'invalid_token', 'No matching signing key found')
  }
  return jwk
}

async function getSupabaseJwks(env, ctx) {
  const now = Date.now()
  if (cachedJwks && now - cachedJwksAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks
  }

  const jwksUrl = resolveJwksUrl(env)
  const response = await fetch(jwksUrl, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 600, cacheEverything: true },
  })
  if (!response.ok) {
    throw httpError(500, 'jwks_fetch_failed', `Could not fetch JWKS from ${jwksUrl}`)
  }
  const body = await response.json()
  const keys = Array.isArray(body?.keys) ? body.keys : []
  cachedJwks = keys
  cachedJwksAt = now
  return keys
}

function resolveJwksUrl(env) {
  const explicit = String(env.SUPABASE_JWKS_URL || '').trim()
  if (explicit) return explicit
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  if (!supabaseUrl) {
    throw httpError(500, 'missing_supabase_url', 'SUPABASE_URL is required')
  }
  return `${supabaseUrl}/auth/v1/.well-known/jwks.json`
}

function validateJwtClaims(payload, env) {
  const now = Math.floor(Date.now() / 1000)
  const clockSkew = parsePositiveInt(env.JWT_CLOCK_SKEW_SECONDS, 60)

  if (!payload || typeof payload !== 'object') {
    throw httpError(401, 'invalid_token', 'JWT payload is invalid')
  }
  if (!String(payload.sub || '').trim()) {
    throw httpError(401, 'invalid_token', 'JWT subject is missing')
  }

  const exp = Number(payload.exp)
  if (Number.isFinite(exp) && exp <= now - clockSkew) {
    throw httpError(401, 'token_expired', 'JWT has expired')
  }
  const nbf = Number(payload.nbf)
  if (Number.isFinite(nbf) && nbf > now + clockSkew) {
    throw httpError(401, 'token_not_yet_valid', 'JWT is not valid yet')
  }
  const iat = Number(payload.iat)
  if (Number.isFinite(iat) && iat > now + clockSkew) {
    throw httpError(401, 'invalid_token', 'JWT issued-at time is in the future')
  }

  const expectedIssuer = String(env.SUPABASE_JWT_ISSUER || defaultIssuer(env)).trim()
  if (expectedIssuer) {
    const actualIssuer = String(payload.iss || '').trim()
    if (actualIssuer !== expectedIssuer) {
      throw httpError(401, 'invalid_token', 'JWT issuer does not match the expected Supabase issuer')
    }
  }

  const expectedAudience = String(env.SUPABASE_JWT_AUDIENCE || 'authenticated').trim()
  if (expectedAudience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || '')]
    if (!audiences.includes(expectedAudience)) {
      throw httpError(401, 'invalid_token', 'JWT audience is not allowed')
    }
  }
}

function defaultIssuer(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
  return supabaseUrl ? `${supabaseUrl}/auth/v1` : ''
}

async function importJwkForVerify(jwk, alg) {
  const normalizedAlg = String(alg || '').trim()
  if (normalizedAlg.startsWith('RS')) {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: hashNameForAlg(normalizedAlg) },
      false,
      ['verify'],
    )
  }
  if (normalizedAlg.startsWith('ES')) {
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: namedCurveForAlg(normalizedAlg) },
      false,
      ['verify'],
    )
  }
  throw httpError(401, 'invalid_token', `Unsupported JWT algorithm: ${normalizedAlg}`)
}

function subtleVerifyAlgorithmForAlg(alg) {
  if (alg.startsWith('RS')) {
    return { name: 'RSASSA-PKCS1-v1_5' }
  }
  if (alg.startsWith('ES')) {
    return { name: 'ECDSA', hash: hashNameForAlg(alg) }
  }
  throw httpError(401, 'invalid_token', `Unsupported JWT algorithm: ${alg}`)
}

function namedCurveForAlg(alg) {
  switch (alg) {
    case 'ES256':
      return 'P-256'
    case 'ES384':
      return 'P-384'
    case 'ES512':
      return 'P-521'
    default:
      throw httpError(401, 'invalid_token', `Unsupported ECDSA algorithm: ${alg}`)
  }
}

function hashNameForAlg(alg) {
  switch (alg) {
    case 'HS256':
    case 'RS256':
    case 'ES256':
      return 'SHA-256'
    case 'HS384':
    case 'RS384':
    case 'ES384':
      return 'SHA-384'
    case 'HS512':
    case 'RS512':
    case 'ES512':
      return 'SHA-512'
    default:
      throw httpError(401, 'invalid_token', `Unsupported hash algorithm: ${alg}`)
  }
}

function parseJsonSegment(value, label) {
  try {
    return JSON.parse(bytesToText(base64UrlToBytes(value)))
  } catch (_) {
    throw httpError(401, 'invalid_token', `${label} is invalid`)
  }
}

function normalizeObjectKey(rawPath) {
  let decoded
  try {
    decoded = decodeURIComponent(String(rawPath || ''))
  } catch (_) {
    throw httpError(400, 'invalid_key', 'Upload key is not valid URL encoding')
  }
  const trimmed = decoded.replace(/^\/+/, '').trim()
  if (!trimmed) return ''
  if (trimmed.includes('\\') || /[\u0000-\u001F]/.test(trimmed)) {
    throw httpError(400, 'invalid_key', 'Upload key contains forbidden characters')
  }
  const parts = trimmed.split('/').filter(Boolean)
  if (!parts.length || parts.some(part => part === '.' || part === '..')) {
    throw httpError(400, 'invalid_key', 'Upload key contains invalid path segments')
  }
  return parts.join('/')
}

function publicMediaUrl(env, key) {
  const base = String(env.MEDIA_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
  return base ? `${base}/${key}` : null
}

const LOCAL_NETWORK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/
const SPORELY_WEB_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*sporely\.no$/i

function resolveAllowedOrigin(request, env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const origin = String(request.headers.get('Origin') || '').trim()

  if (!origin) {
    return '*'
  }
  if (!configured.length) {
    return origin
  }
  if (configured.includes(origin)) {
    return origin
  }
  if (LOCAL_NETWORK_ORIGIN.test(origin)) {
    return origin
  }
  if (SPORELY_WEB_ORIGIN.test(origin)) {
    return origin
  }
  // Installed iOS and Android web apps may emit `Origin: null` for file/blob requests.
  if (origin === 'null') {
    return origin
  }
  return null
}

function corsHeaders(request, env, resolvedOrigin = null) {
  const origin = resolvedOrigin === null ? resolveAllowedOrigin(request, env) : resolvedOrigin
  const headers = new Headers()
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  headers.set('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', DEFAULT_ALLOWED_HEADERS)
  headers.set('Access-Control-Max-Age', '86400')
  return headers
}

function jsonResponse(payload, status, request, env, resolvedOrigin = null) {
  const headers = corsHeaders(request, env, resolvedOrigin)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(payload, null, 2), { status, headers })
}

function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function parseIntegerHeader(value) {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.trunc(parsed)
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.trunc(parsed)
}

function base64UrlToBytes(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes)
}

function encoder() {
  return new TextEncoder()
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i]
  }
  return diff === 0
}

function joseSignatureToDer(signature) {
  if (!(signature instanceof Uint8Array) || signature.length % 2 !== 0) {
    throw httpError(401, 'invalid_token', 'ECDSA signature has invalid length')
  }
  const midpoint = signature.length / 2
  const r = normalizeDerInteger(signature.slice(0, midpoint))
  const s = normalizeDerInteger(signature.slice(midpoint))

  const sequenceBody = concatBytes(
    Uint8Array.of(0x02),
    encodeDerLength(r.length),
    r,
    Uint8Array.of(0x02),
    encodeDerLength(s.length),
    s,
  )
  return concatBytes(
    Uint8Array.of(0x30),
    encodeDerLength(sequenceBody.length),
    sequenceBody,
  )
}

function normalizeDerInteger(value) {
  let index = 0
  while (index < value.length - 1 && value[index] === 0) {
    index += 1
  }
  let normalized = value.slice(index)
  if (normalized[0] & 0x80) {
    normalized = concatBytes(Uint8Array.of(0x00), normalized)
  }
  return normalized
}

function encodeDerLength(length) {
  if (length < 0x80) {
    return Uint8Array.of(length)
  }
  const bytes = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
