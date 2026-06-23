import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function readSource(file) {
  return fs.readFileSync(new URL(file, import.meta.url), 'utf8')
}

test('home recent comments loader uses the public comments view for both queries', () => {
  const source = readSource('./home.js')

  assert.ok((source.match(/from\('comments_community_view'\)/g) || []).length >= 2)
  assert.doesNotMatch(source, /from\('comments'\)\.select\('id, body, created_at, user_id, observation_id'\)/)
  assert.doesNotMatch(source, /comment_moderation/)
})

test('detail comments loader uses the public comments view', () => {
  const source = readSource('./find_detail.js')

  assert.match(source, /from\('comments_community_view'\)/)
  assert.doesNotMatch(source, /from\('comments'\)\.select\('id, body, created_at, user_id'\)/)
  assert.doesNotMatch(source, /comment_moderation/)
})
