// Test-support helpers for source-contract assertions.
//
// Several test files pin a behavioural contract by locating a declaration in
// production source with `indexOf(...)` and asserting against a slice of it.
// Done naively that pattern fails in a way that hides its own cause: when the
// declaration is renamed or its signature changes, `indexOf` returns -1,
// `slice(-1, n)` yields '', and every assertion in the block fails against an
// empty string without a word about the anchor. A slice that still lands
// somewhere plausible is worse still — it silently stops covering what it was
// written to cover.
//
// These helpers make the anchor itself an assertion: it is checked before the
// slice is taken, and the failure message names the anchor and the file.
//
// Not a production module. It lives in `src/` beside the colocated
// `*.test.js` files that import it rather than in `test/`, because
// `node --test` auto-discovers every file under a directory named `test/` as a
// test file and a support module there would register as a phantom empty
// suite (as `test/register-css-loader.mjs` already does).

import assert from 'node:assert/strict'

function _anchorFailure(anchor, label) {
  return `stale test anchor: ${JSON.stringify(anchor)} no longer appears in ${label}. `
    + 'The declaration was probably renamed or its signature changed — update the '
    + 'anchor to match the current source, do not weaken the assertions below.'
}

/**
 * Index of `anchor` in `source`, asserting it is present.
 *
 * Use for ordering assertions (`assert.ok(a < b)`), which otherwise pass
 * silently when the earlier anchor is missing: `-1 < 42` is true.
 *
 * @param {string} source     production source text
 * @param {string} anchor     literal that must appear in it
 * @param {string} label      file the source came from, for the message
 * @param {number} [fromIndex] start the search here (must itself be >= 0)
 * @returns {number} the index, always >= 0
 */
export function indexOfAnchor(source, anchor, label, fromIndex = 0) {
  assert.ok(
    fromIndex >= 0,
    `bad anchor search start (${fromIndex}) while looking for ${JSON.stringify(anchor)} `
    + `in ${label} — the preceding anchor was probably not found.`,
  )
  const idx = source.indexOf(anchor, fromIndex)
  assert.ok(idx >= 0, _anchorFailure(anchor, label))
  return idx
}

/**
 * `length` characters of `source` starting at `anchor`, asserting the anchor
 * is present.
 *
 * @param {string} source production source text
 * @param {string} anchor literal the window starts at
 * @param {number} length window size in characters
 * @param {string} label  file the source came from, for the message
 * @returns {string} a non-empty window
 */
export function sliceAfterAnchor(source, anchor, length, label) {
  const idx = indexOfAnchor(source, anchor, label)
  return source.slice(idx, idx + length)
}

/**
 * The region of `source` from `startAnchor` up to the next `endAnchor`,
 * asserting both are present and correctly ordered.
 *
 * `endAnchor` is searched from `startAnchor` onwards, so an end literal that
 * also occurs earlier in the file cannot produce an inverted (empty) window.
 *
 * @param {string} source      production source text
 * @param {string} startAnchor literal the region starts at (inclusive)
 * @param {string} endAnchor   literal the region ends at (exclusive)
 * @param {string} label       file the source came from, for the message
 * @returns {string} a non-empty region
 */
export function sliceBetweenAnchors(source, startAnchor, endAnchor, label) {
  const start = indexOfAnchor(source, startAnchor, label)
  const end = source.indexOf(endAnchor, start + startAnchor.length)
  assert.ok(
    end >= 0,
    `${_anchorFailure(endAnchor, label)} (searched after ${JSON.stringify(startAnchor)}, `
    + 'which was found — the region end anchor is the stale one.)',
  )
  return source.slice(start, end)
}
