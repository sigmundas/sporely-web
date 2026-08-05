import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The edge function runs on Deno; we can't import it directly under Node.
// These tests verify the source-level invariants required for the
// Android/web CORS preflight to succeed.

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('OPTIONS is answered before any auth or body work', () => {
  // The OPTIONS branch must appear inside Deno.serve before authHeader
  // and before any auth.getUser() call.
  const serveIndex = source.indexOf('Deno.serve')
  const optionsIndex = source.indexOf("req.method === 'OPTIONS'", serveIndex)
  const authHeaderIndex = source.indexOf("req.headers.get('Authorization')", serveIndex)
  const getUserIndex = source.indexOf('auth.getUser()', serveIndex)
  assert.ok(serveIndex >= 0)
  assert.ok(optionsIndex > serveIndex)
  assert.ok(optionsIndex < authHeaderIndex)
  assert.ok(optionsIndex < getUserIndex)
})

test('OPTIONS returns 204 with no body', () => {
  assert.match(source, /req\.method === 'OPTIONS'[\s\S]{0,200}?status:\s*204/)
})

test('CORS allows the Capacitor Android and iOS origins', () => {
  assert.match(source, /['"]https:\/\/localhost['"]/)
  assert.match(source, /['"]capacitor:\/\/localhost['"]/)
  assert.match(source, /['"]https:\/\/app\.sporely\.no['"]/)
})

test('Access-Control-Allow-Methods includes POST and OPTIONS', () => {
  assert.match(source, /'Access-Control-Allow-Methods'\s*:\s*['"][^'"]*POST[^'"]*OPTIONS/i)
})

test('Access-Control-Allow-Headers includes required client headers', () => {
  const line = source.match(/'Access-Control-Allow-Headers'\s*:\s*['"][^'"]+['"]/)?.[0] || ''
  assert.match(line, /authorization/i)
  assert.match(line, /apikey/i)
  assert.match(line, /content-type/i)
  assert.match(line, /x-client-info/i)
})

test('Vary: Origin is set (since the allowed origin is echoed per-caller)', () => {
  assert.match(source, /['"]Vary['"]\s*:\s*['"]Origin['"]/)
})

test('every error and success response carries the corsHeaders', () => {
  // json() must attach the corsHeaders in every callsite.
  const jsonCalls = source.match(/json\([^)]*\)/g) || []
  for (const call of jsonCalls) {
    // Definition itself accepts (body, status, corsHeaders); allow zero-arg
    // json() only inside the function body (definition line).
    if (call.startsWith('json(body')) continue
    assert.match(call, /corsHeaders/, `json() call missing corsHeaders: ${call}`)
  }
})

test('CORS does NOT default to Access-Control-Allow-Origin: *', () => {
  assert.equal(/Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/.test(source), false,
    'wildcard Allow-Origin is not allowed; use an allowlist')
})
