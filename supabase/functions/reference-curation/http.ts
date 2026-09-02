type AuthenticatedIdentity = {
  user: { id: string }
  claims: {
    sub?: unknown
    session_id?: unknown
  }
}

type HttpDependencies = {
  allowedOrigins: Set<string>
  authenticate: (accessToken: string) => Promise<AuthenticatedIdentity | null>
  dispatch: (input: {
    actorUserId: string
    actorSessionId: string
    requestBody: Record<string, unknown>
  }) => Promise<{ status: number; body: Record<string, unknown> }>
  logError: (message: string) => void
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REQUEST_BYTES = 72 * 1024

export function createReferenceCurationHttpHandler(dependencies: HttpDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin')
    const originAllowed = origin === null || dependencies.allowedOrigins.has(origin)
    const corsHeaders = buildCorsHeaders(origin, originAllowed)

    if (!originAllowed) {
      return jsonResponse(
        { ok: false, error: { code: 'origin_denied', message: 'Origin denied' } },
        403,
        corsHeaders,
      )
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }
    if (request.method !== 'POST') {
      return jsonResponse(
        { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed' } },
        405,
        corsHeaders,
      )
    }
    const declaredLength = request.headers.get('Content-Length')
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BYTES) {
      return jsonResponse(
        { ok: false, error: { code: 'payload_too_large', message: 'Request payload is too large' } },
        413,
        corsHeaders,
      )
    }

    const authorization = request.headers.get('Authorization') ?? ''
    const bearer = /^Bearer ([^\s]+)$/.exec(authorization)
    if (!bearer) {
      return jsonResponse(
        { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } },
        401,
        corsHeaders,
      )
    }

    let identity: AuthenticatedIdentity | null
    try {
      identity = await dependencies.authenticate(bearer[1])
    } catch {
      identity = null
    }
    const userId = identity?.user?.id
    const subject = identity?.claims?.sub
    const sessionId = identity?.claims?.session_id
    if (!isUuid(userId) || subject !== userId || !isUuid(sessionId)) {
      return jsonResponse(
        { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } },
        401,
        corsHeaders,
      )
    }

    const bodyResult = await readBoundedJson(request, MAX_REQUEST_BYTES)
    if (bodyResult.kind === 'too_large') {
      return jsonResponse(
        { ok: false, error: { code: 'payload_too_large', message: 'Request payload is too large' } },
        413,
        corsHeaders,
      )
    }
    if (bodyResult.kind === 'invalid') {
      return jsonResponse(
        { ok: false, error: { code: 'invalid_json', message: 'Invalid JSON body' } },
        400,
        corsHeaders,
      )
    }
    const requestBody = bodyResult.value
    if (!isRecord(requestBody)) {
      return jsonResponse(
        { ok: false, error: { code: 'invalid_payload', message: 'Invalid request payload' } },
        400,
        corsHeaders,
      )
    }

    try {
      const result = await dependencies.dispatch({
        actorUserId: userId,
        actorSessionId: sessionId,
        requestBody,
      })
      return jsonResponse(result.body, result.status, corsHeaders)
    } catch {
      dependencies.logError('reference-curation request failed')
      return jsonResponse(
        { ok: false, error: { code: 'internal_error', message: 'Unexpected error' } },
        500,
        corsHeaders,
      )
    }
  }
}

function buildCorsHeaders(origin: string | null, allowed: boolean): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  })
  if (origin !== null && allowed) headers.set('Access-Control-Allow-Origin', origin)
  return headers
}

function jsonResponse(body: Record<string, unknown>, status: number, headers: Headers): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<{ kind: 'ok'; value: unknown } | { kind: 'too_large' } | { kind: 'invalid' }> {
  if (!request.body) return { kind: 'invalid' }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    const reader = request.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel()
        } catch {
          // The size decision is already final; cancellation is best-effort.
        }
        return { kind: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { kind: 'invalid' }
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { kind: 'ok', value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { kind: 'invalid' }
  }
}
