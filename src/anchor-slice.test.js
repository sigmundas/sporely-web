import test from 'node:test'
import assert from 'node:assert/strict'

import { indexOfAnchor, sliceAfterAnchor, sliceBetweenAnchors } from './anchor-slice.js'

// The point of these helpers is the failure message, so the failure paths are
// what matter most here: a stale anchor must throw and must name itself.

const SRC = 'alpha\nfunction target(a, b) { body }\nomega\n'

test('sliceAfterAnchor returns the window when the anchor matches', () => {
  assert.equal(sliceAfterAnchor(SRC, 'function target(', 18, 'fake.js'), 'function target(a,')
})

test('sliceAfterAnchor finds an anchor at offset 0', () => {
  // A naive `idx > 0` guard rejects this; the helper must accept it.
  assert.equal(sliceAfterAnchor(SRC, 'alpha', 5, 'fake.js'), 'alpha')
})

test('sliceAfterAnchor throws and names a stale anchor instead of yielding an empty window', () => {
  assert.throws(
    () => sliceAfterAnchor(SRC, 'function renamed(', 100, 'fake.js'),
    err => {
      assert.match(err.message, /stale test anchor/)
      assert.match(err.message, /"function renamed\("/, 'the message must quote the missing anchor')
      assert.match(err.message, /fake\.js/, 'the message must name the file')
      return true
    },
  )
})

test('sliceBetweenAnchors returns the region between two anchors', () => {
  assert.equal(sliceBetweenAnchors(SRC, 'function', 'omega', 'fake.js'), 'function target(a, b) { body }\n')
})

test('sliceBetweenAnchors searches the end anchor after the start, not globally', () => {
  // 'x' occurs before the start anchor; a global indexOf would invert the
  // window and silently return ''. The region must be the later one.
  const src = 'x-early START middle x-late END'
  assert.equal(sliceBetweenAnchors(src, 'START', 'x-late', 'fake.js'), 'START middle ')
})

test('sliceBetweenAnchors blames the end anchor when only the end is stale', () => {
  assert.throws(
    () => sliceBetweenAnchors(SRC, 'function target(', 'function gone(', 'fake.js'),
    err => {
      assert.match(err.message, /"function gone\("/)
      assert.match(err.message, /end anchor is the stale one/)
      return true
    },
  )
})

test('sliceBetweenAnchors blames the start anchor when the start is stale', () => {
  assert.throws(
    () => sliceBetweenAnchors(SRC, 'function gone(', 'omega', 'fake.js'),
    err => {
      assert.match(err.message, /"function gone\("/)
      assert.equal(/end anchor is the stale one/.test(err.message), false)
      return true
    },
  )
})

test('indexOfAnchor returns the index and honours fromIndex', () => {
  assert.equal(indexOfAnchor('a-b-a', 'a', 'fake.js'), 0)
  assert.equal(indexOfAnchor('a-b-a', 'a', 'fake.js', 1), 4)
})

test('indexOfAnchor throws on a missing anchor rather than returning -1', () => {
  // -1 is what makes ordering assertions pass silently: -1 < anything.
  assert.throws(() => indexOfAnchor(SRC, 'nope', 'fake.js'), /stale test anchor/)
})

test('indexOfAnchor rejects a negative fromIndex instead of searching the whole string', () => {
  assert.throws(
    () => indexOfAnchor(SRC, 'alpha', 'fake.js', -1),
    /bad anchor search start \(-1\)/,
  )
})
