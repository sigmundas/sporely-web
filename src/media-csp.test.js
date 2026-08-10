import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('web CSP allows Worker fetches and Blob rendering while retaining the legacy CDN temporarily', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  const rootPolicy = headers.split('\n\n')[0]

  assert.match(rootPolicy, /img-src[^;]*https:\/\/upload\.sporely\.no/)
  assert.match(rootPolicy, /img-src[^;]*blob:/)
  assert.match(rootPolicy, /connect-src[^;]*https:\/\/upload\.sporely\.no/)
  assert.match(rootPolicy, /img-src[^;]*https:\/\/media\.sporely\.no/)
})
