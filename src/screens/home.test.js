import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('home friend request actions import the toast helper', () => {
  const filename = fileURLToPath(import.meta.url)
  const source = fs.readFileSync(path.join(path.dirname(filename), 'home.js'), 'utf8')

  assert.match(source, /import\s+\{\s*showToast\s*\}\s+from\s+'\.{2}\/toast\.js'/)
  assert.match(source, /showToast\(t\('profile\.friendAccepted'\)\)/)
  assert.match(source, /showToast\(t\('profile\.friendRemoved'\)\)/)
})
