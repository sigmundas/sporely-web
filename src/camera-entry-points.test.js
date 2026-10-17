// Every in-app camera entry point must honour the "use system camera" setting:
// a function that opens Sporely Cam (NativeCamera.capturePhotos) has to check
// getUseSystemCamera() and offer openSystemCamera() first. The review screen's
// add-photo button once skipped this and always opened Sporely Cam.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const FILES = [
  'screens/review.js',
  'screens/find_detail.js',
  'screens/import_review.js',
]

function functionBodies(source) {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)]
  return starts.map((match, index) => ({
    name: match[1],
    body: source.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : source.length),
  }))
}

for (const file of FILES) {
  test(`${file}: every Sporely Cam entry point checks the system-camera setting first`, () => {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const openers = functionBodies(source).filter(fn => /capturePhotos\(/.test(fn.body))
    assert.ok(openers.length > 0, `${file} has at least one camera entry point`)
    for (const fn of openers) {
      const capture = fn.body.search(/capturePhotos\(/)
      const check = fn.body.search(/getUseSystemCamera\(\)/)
      const system = fn.body.search(/openSystemCamera\(/)
      assert.ok(check >= 0 && check < capture, `${file} ${fn.name}() checks getUseSystemCamera() before capturePhotos()`)
      assert.ok(system >= 0 && system < capture, `${file} ${fn.name}() opens the system camera when it is chosen`)
    }
  })
}
