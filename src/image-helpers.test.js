import test from 'node:test'
import assert from 'node:assert/strict'

import { imageHtml } from './image-helpers.js'

test('public authorized media remains a direct image URL', () => {
  const html = imageHtml({
    primaryUrl: 'https://upload.sporely.no/m/4960/thumb?v=1',
    fallbackUrl: null,
  }, 'photo', 'placeholder')

  assert.match(html, /src="https:\/\/upload\.sporely\.no\/m\/4960\/thumb\?v=1"/)
  assert.doesNotMatch(html, /data-protected-media-url/)
})

test('protected media exposes only its Worker URL for authenticated hydration', () => {
  const html = imageHtml({
    primaryUrl: null,
    fallbackUrl: null,
    protectedUrl: 'https://upload.sporely.no/m/4962/thumb?v=7',
  }, 'photo', 'placeholder')

  assert.match(html, /data-protected-media-url="https:\/\/upload\.sporely\.no\/m\/4962\/thumb\?v=7"/)
  assert.doesNotMatch(html, /media\.sporely\.no/)
  assert.doesNotMatch(html, /Bearer|secret-token/)
})
