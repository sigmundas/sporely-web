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

test('security.txt is published with the fields RFC 9116 requires', () => {
  const text = readFileSync(new URL('../public/.well-known/security.txt', import.meta.url), 'utf8')
  const field = name => text.split('\n').find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)

  assert.match(field('Contact'), /^mailto:[^@\s]+@sporely\.no$/)
  assert.ok(Number.isFinite(Date.parse(field('Expires'))), 'Expires must be an ISO 8601 date')
  assert.equal(field('Canonical'), 'https://app.sporely.no/.well-known/security.txt')

  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  assert.match(headers, /^\/\.well-known\/security\.txt\n  Content-Type: text\/plain; charset=utf-8$/m)
})

test('every app response carries a one-year HSTS policy', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  const rootBlock = headers.split('\n\n')[0]

  assert.match(rootBlock, /^\/\*$/m)
  assert.match(rootBlock, /^  Strict-Transport-Security: max-age=31536000$/m)
})
