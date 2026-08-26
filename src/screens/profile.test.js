import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedUserRowHtmlForTests } from './profile.js'

test('blocked-user fallback avatar escapes a display-name-derived initial', () => {
  const html = blockedUserRowHtmlForTests({
    blocked_id: 'blocked-user-id',
    username: null,
    display_name: '<script>alert(1)</script>',
    avatar_url: null,
  })

  assert.match(html, /<div class="friend-avatar">&lt;<\/div>/)
  assert.doesNotMatch(html, /<div class="friend-avatar"><script>/)
  assert.match(html, /<div class="friend-email">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/)
})
