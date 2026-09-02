import { assertEquals } from 'jsr:@std/assert@1.0.19'

import { createReferenceCurationHttpHandler } from './http.ts'

const ALLOWED_ORIGIN = 'https://curation.example.invalid'
const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const ACTOR_SESSION_ID = '11000000-0000-4000-8000-000000000001'

function makeDependencies(overrides: Record<string, unknown> = {}) {
  const calls = {
    authenticate: [] as string[],
    dispatch: [] as Array<{
      actorUserId: string
      actorSessionId: string
      requestBody: Record<string, unknown>
    }>,
  }
  return {
    calls,
    dependencies: {
      allowedOrigins: new Set([ALLOWED_ORIGIN]),
      authenticate: async (accessToken: string) => {
        calls.authenticate.push(accessToken)
        return {
          user: { id: ACTOR_ID },
          claims: { sub: ACTOR_ID, session_id: ACTOR_SESSION_ID },
        }
      },
      dispatch: async (input: {
        actorUserId: string
        actorSessionId: string
        requestBody: Record<string, unknown>
      }) => {
        calls.dispatch.push(input)
        return { status: 200, body: { ok: true, status: 'updated' } }
      },
      logError: (_message: string) => undefined,
      ...overrides,
    },
  }
}

function request(method: string, body?: unknown, options: { origin?: string; authorization?: string } = {}) {
  const headers = new Headers()
  headers.set('Origin', options.origin ?? ALLOWED_ORIGIN)
  if (options.authorization !== undefined) {
    headers.set('Authorization', options.authorization)
  }
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  return new Request('https://project.example.invalid/functions/v1/reference-curation', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

Deno.test('OPTIONS succeeds before authentication and returns explicit CORS headers', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('OPTIONS'))

  assertEquals(response.status, 204)
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
  assertEquals(response.headers.get('Vary'), 'Origin')
  assertEquals(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS')
  assertEquals(fixture.calls.authenticate.length, 0)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('unknown browser origins fail closed without wildcard CORS', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('OPTIONS', undefined, {
    origin: 'https://attacker.example.invalid',
  }))

  assertEquals(response.status, 403)
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), null)
  assertEquals(fixture.calls.authenticate.length, 0)
})

Deno.test('non-POST methods are rejected before authentication', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('GET'))

  assertEquals(response.status, 405)
  assertEquals(fixture.calls.authenticate.length, 0)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('missing or malformed Bearer authorization is rejected before dispatch', async () => {
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer ', 'bearer token']) {
    const fixture = makeDependencies()
    const handler = createReferenceCurationHttpHandler(fixture.dependencies)
    const response = await handler(request('POST', { action: 'claim' }, { authorization }))

    assertEquals(response.status, 401)
    assertEquals(fixture.calls.authenticate.length, 0)
    assertEquals(fixture.calls.dispatch.length, 0)
  }
})

Deno.test('the verified getUser identity is the only actor passed to the action boundary', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)
  const requestBody = {
    action: 'claim',
    actor_user_id: '90000000-0000-4000-8000-000000000009',
    actor_session_id: '91000000-0000-4000-8000-000000000009',
  }

  const response = await handler(request('POST', requestBody, {
    authorization: 'Bearer signed-user-token',
  }))

  assertEquals(response.status, 200)
  assertEquals(fixture.calls.authenticate, ['signed-user-token'])
  assertEquals(fixture.calls.dispatch, [{
    actorUserId: ACTOR_ID,
    actorSessionId: ACTOR_SESSION_ID,
    requestBody,
  }])
})

Deno.test('failed token verification returns 401 and never dispatches', async () => {
  const fixture = makeDependencies({
    authenticate: async () => null,
  })
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('POST', { action: 'claim' }, {
    authorization: 'Bearer expired-token',
  }))

  assertEquals(response.status, 401)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('verified claims without a valid session UUID fail before dispatch', async () => {
  for (const sessionId of [undefined, null, '', 'not-a-uuid']) {
    const fixture = makeDependencies({
      authenticate: async () => ({
        user: { id: ACTOR_ID },
        claims: { sub: ACTOR_ID, session_id: sessionId },
      }),
    })
    const handler = createReferenceCurationHttpHandler(fixture.dependencies)

    const response = await handler(request('POST', { action: 'claim' }, {
      authorization: 'Bearer signed-user-token',
    }))

    assertEquals(response.status, 401)
    assertEquals(fixture.calls.dispatch.length, 0)
  }
})

Deno.test('verified claim subject must equal the getUser identity', async () => {
  const fixture = makeDependencies({
    authenticate: async () => ({
      user: { id: ACTOR_ID },
      claims: {
        sub: '90000000-0000-4000-8000-000000000009',
        session_id: ACTOR_SESSION_ID,
      },
    }),
  })
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('POST', { action: 'claim' }, {
    authorization: 'Bearer signed-user-token',
  }))

  assertEquals(response.status, 401)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('malformed JSON returns a stable 400 without dispatch', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)
  const malformed = new Request('https://project.example.invalid/functions/v1/reference-curation', {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: 'Bearer signed-user-token',
      'Content-Type': 'application/json',
    },
    body: '{',
  })

  const response = await handler(malformed)
  const body = await response.json()

  assertEquals(response.status, 400)
  assertEquals(body.error.code, 'invalid_json')
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('non-object JSON returns invalid_payload without dispatch', async () => {
  for (const body of [null, [], 'claim', 1]) {
    const fixture = makeDependencies()
    const handler = createReferenceCurationHttpHandler(fixture.dependencies)
    const response = await handler(request('POST', body, {
      authorization: 'Bearer signed-user-token',
    }))
    const responseBody = await response.json()

    assertEquals(response.status, 400)
    assertEquals(responseBody.error.code, 'invalid_payload')
    assertEquals(fixture.calls.dispatch.length, 0)
  }
})

Deno.test('declared oversized request bodies are rejected before authentication or dispatch', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)
  const oversized = new Request('https://project.example.invalid/functions/v1/reference-curation', {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: 'Bearer signed-user-token',
      'Content-Type': 'application/json',
      'Content-Length': '73729',
    },
    body: '{}',
  })

  const response = await handler(oversized)
  const body = await response.json()

  assertEquals(response.status, 413)
  assertEquals(body.error.code, 'payload_too_large')
  assertEquals(fixture.calls.authenticate.length, 0)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('streamed oversized request bodies are bounded without Content-Length', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)
  const oversized = new Request('https://project.example.invalid/functions/v1/reference-curation', {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: 'Bearer signed-user-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(73729) }),
  })

  const response = await handler(oversized)
  const body = await response.json()

  assertEquals(response.status, 413)
  assertEquals(body.error.code, 'payload_too_large')
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('request stream failures return a sanitized CORS response without dispatch', async () => {
  const fixture = makeDependencies()
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)
  const failedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('private stream detail'))
    },
  })
  const failedRequest = new Request('https://project.example.invalid/functions/v1/reference-curation', {
    method: 'POST',
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: 'Bearer signed-user-token',
      'Content-Type': 'application/json',
    },
    body: failedStream,
  })

  const response = await handler(failedRequest)
  const text = await response.text()

  assertEquals(response.status, 400)
  assertEquals(JSON.parse(text).error.code, 'invalid_json')
  assertEquals(text.includes('private stream detail'), false)
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
  assertEquals(fixture.calls.dispatch.length, 0)
})

Deno.test('action failures preserve their status and allowed-origin CORS headers', async () => {
  const fixture = makeDependencies({
    dispatch: async () => ({
      status: 409,
      body: { ok: false, error: { code: 'conflict', message: 'Refresh and retry' } },
    }),
  })
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('POST', { action: 'claim' }, {
    authorization: 'Bearer signed-user-token',
  }))
  const body = await response.json()

  assertEquals(response.status, 409)
  assertEquals(body.error.code, 'conflict')
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN)
})

Deno.test('unexpected failures are sanitized and never expose tokens or database details', async () => {
  const secret = 'signed-user-token private.reference_curation_submissions'
  const fixture = makeDependencies({
    dispatch: async () => {
      throw new Error(secret)
    },
  })
  const handler = createReferenceCurationHttpHandler(fixture.dependencies)

  const response = await handler(request('POST', { action: 'claim' }, {
    authorization: 'Bearer signed-user-token',
  }))
  const text = await response.text()

  assertEquals(response.status, 500)
  assertEquals(text.includes(secret), false)
  assertEquals(text.includes('signed-user-token'), false)
  assertEquals(JSON.parse(text).error.code, 'internal_error')
})
