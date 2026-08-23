import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recentFindMediaIdentityForTests, reconcileRecentFindRowsForTests } from './home.js'

function fakeRow(id, mediaIdentity, imageToken) {
  const image = { dataset: { mediaCache: '1', mediaKey: mediaIdentity, mediaPublicUrl: `https://fresh/${imageToken}` }, token: imageToken }
  const thumb = { querySelector: selector => selector === 'img' ? image : null }
  const row = {
    dataset: { id, homeMediaIdentity: mediaIdentity },
    meta: { token: `meta:${id}:${imageToken}` },
    querySelector(selector) {
      if (selector === '.find-thumb-wrap') return thumb
      if (selector === '.find-meta') return this.meta
      return null
    },
  }
  row.meta.replaceWith = next => { row.meta = next }
  return { row, image, thumb }
}

function fakeList(rows) {
  return {
    rows,
    querySelectorAll(selector) {
      assert.equal(selector, '.find-row[data-id]')
      return this.rows
    },
    replaceChildren(...next) { this.rows = next },
  }
}

test('home friend request actions import the toast helper', () => {
  const filename = fileURLToPath(import.meta.url)
  const source = fs.readFileSync(path.join(path.dirname(filename), 'home.js'), 'utf8')

  assert.match(source, /import\s+\{\s*showToast\s*\}\s+from\s+'\.{2}\/toast\.js'/)
  assert.match(source, /showToast\(t\('profile\.friendAccepted'\)\)/)
  assert.match(source, /showToast\(t\('profile\.friendRemoved'\)\)/)
})

test('recent finds reconciliation preserves an already-resolved thumbnail for the same observation and media key', () => {
  const old = fakeRow('obs-1', 'key%3Amedia%2Fone.jpg', 'resolved-blob')
  old.image.src = 'blob:already-resolved'
  old.image.dataset.protectedMediaState = 'ready'
  const fresh = fakeRow('obs-1', 'key%3Amedia%2Fone.jpg', 'fresh-transport')
  const list = fakeList([old.row])

  const needsWiring = reconcileRecentFindRowsForTests(list, [fresh.row])

  assert.equal(list.rows[0], old.row, 'the keyed row should retain object identity')
  assert.equal(old.row.querySelector('.find-thumb-wrap'), old.thumb, 'the live thumbnail wrapper should survive')
  assert.equal(old.image.src, 'blob:already-resolved', 'the resolved image src must not be blanked')
  assert.equal(old.image.dataset.mediaPublicUrl, 'https://fresh/fresh-transport', 'transport metadata may still refresh')
  assert.equal(old.row.meta, fresh.row.meta, 'non-thumbnail metadata should update from the fresh model')
  assert.deepEqual(needsWiring, [], 'a retained thumbnail must not start another cache load')
})

test('recent finds reconciliation rebinds a loading thumbnail when its protected transport changes', () => {
  const old = fakeRow('obs-1', 'protected%7Ckey%3Amedia%2Fone.jpg', 'old')
  delete old.image.dataset.mediaPublicUrl
  old.image.dataset.mediaProtectedUrl = 'https://worker.example/m/one/thumb?v=old'
  old.image.dataset.protectedMediaState = 'loading'
  const fresh = fakeRow('obs-1', 'protected%7Ckey%3Amedia%2Fone.jpg', 'fresh')
  delete fresh.image.dataset.mediaPublicUrl
  fresh.image.dataset.mediaProtectedUrl = 'https://worker.example/m/one/thumb?v=fresh'
  const list = fakeList([old.row])

  const needsWiring = reconcileRecentFindRowsForTests(list, [fresh.row])

  assert.equal(list.rows[0], old.row, 'the row and thumbnail node should remain stable')
  assert.equal(old.image.dataset.mediaProtectedUrl, fresh.image.dataset.mediaProtectedUrl)
  assert.deepEqual(needsWiring, [old.row], 'the in-flight binding must restart with the fresh protected URL')
})

test('recent finds reconciliation replaces and wires rows when the media identity changes', () => {
  const old = fakeRow('obs-1', 'key%3Amedia%2Fold.jpg', 'old')
  const changed = fakeRow('obs-1', 'key%3Amedia%2Fnew.jpg', 'new')
  const added = fakeRow('obs-2', 'key%3Amedia%2Ftwo.jpg', 'two')
  const list = fakeList([old.row])

  const needsWiring = reconcileRecentFindRowsForTests(list, [changed.row, added.row])

  assert.deepEqual(list.rows, [changed.row, added.row])
  assert.deepEqual(needsWiring, [changed.row, added.row])
})

test('recent find media identity distinguishes public and protected loader scopes for the same key', () => {
  const publicIdentity = recentFindMediaIdentityForTests({
    key: 'user/obs/image.jpg',
    primaryUrl: 'https://media.example/image.jpg',
  })
  const protectedIdentity = recentFindMediaIdentityForTests({
    key: 'user/obs/image.jpg',
    protectedUrl: 'https://worker.example/m/image/thumb?v=2',
  })

  assert.notEqual(publicIdentity, protectedIdentity)
  assert.match(publicIdentity, /^public\|key:/)
  assert.match(protectedIdentity, /^protected\|key:/)
})

test('recent finds reconciliation retries a retained thumbnail that was unavailable offline', () => {
  const cached = fakeRow('obs-1', 'key%3Amedia%2Fone.jpg', 'cached')
  cached.image.dataset.protectedMediaState = 'unavailable'
  const fresh = fakeRow('obs-1', 'key%3Amedia%2Fone.jpg', 'fresh')
  const list = fakeList([cached.row])

  const needsWiring = reconcileRecentFindRowsForTests(list, [fresh.row])

  assert.equal(list.rows[0], cached.row, 'the same thumbnail element should still be retained')
  assert.deepEqual(needsWiring, [cached.row], 'the retained offline miss should retry now that a fresh transport exists')
})

test('Home refreshes discard superseded or cross-account network results before rendering', () => {
  const filename = fileURLToPath(import.meta.url)
  const source = fs.readFileSync(path.join(path.dirname(filename), 'home.js'), 'utf8')
  const settledIndex = source.indexOf('const settled = await Promise.allSettled')
  const generationGuardIndex = source.indexOf('generation !== _homeRenderGeneration', settledIndex)
  const renderLoopIndex = source.indexOf('_HOME_SECTIONS.forEach', settledIndex)

  assert.ok(settledIndex > 0 && generationGuardIndex > settledIndex)
  assert.ok(generationGuardIndex < renderLoopIndex, 'stale/account guards must run before any section renderer')
  assert.match(source.slice(generationGuardIndex, renderLoopIndex), /state\.user\?\.id !== uid/)
  assert.match(source.slice(generationGuardIndex, renderLoopIndex), /auth\.userId !== uid/)
})
