import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Vite's defineConfig(fn) simply returns fn, so we can call the default
// export directly with { mode, command } to exercise the validation logic.
const configFn = (await import('./vite.config.js')).default

function withTempCwd({ envLocal, shellKey }) {
  const dir = mkdtempSync(join(tmpdir(), 'sporely-vite-cfg-'))
  const originalCwd = process.cwd()
  const originalShellKey = process.env.VITE_TURNSTILE_SITE_KEY
  if (envLocal !== undefined) {
    writeFileSync(join(dir, '.env.local'), envLocal, 'utf8')
  }
  mkdirSync(join(dir, 'auth'), { recursive: true })
  mkdirSync(join(dir, 'oauth'), { recursive: true })
  process.chdir(dir)
  if (shellKey === undefined) delete process.env.VITE_TURNSTILE_SITE_KEY
  else process.env.VITE_TURNSTILE_SITE_KEY = shellKey
  return {
    dir,
    restore() {
      process.chdir(originalCwd)
      if (originalShellKey === undefined) delete process.env.VITE_TURNSTILE_SITE_KEY
      else process.env.VITE_TURNSTILE_SITE_KEY = originalShellKey
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('production build fails when no site key is available at all', () => {
  const ctx = withTempCwd({ envLocal: undefined, shellKey: undefined })
  try {
    assert.throws(
      () => configFn({ mode: 'production', command: 'build' }),
      /VITE_TURNSTILE_SITE_KEY is required for production builds/,
    )
  } finally {
    ctx.restore()
  }
})

test('production build fails when .env.local key is blank / whitespace', () => {
  const ctx = withTempCwd({ envLocal: 'VITE_TURNSTILE_SITE_KEY=   \n', shellKey: undefined })
  try {
    assert.throws(
      () => configFn({ mode: 'production', command: 'build' }),
      /VITE_TURNSTILE_SITE_KEY is required/,
    )
  } finally {
    ctx.restore()
  }
})

test('production build succeeds when .env.local provides a site key', () => {
  const ctx = withTempCwd({ envLocal: 'VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA\n', shellKey: undefined })
  try {
    const config = configFn({ mode: 'production', command: 'build' })
    assert.equal(typeof config, 'object')
    assert.ok(config.build?.rollupOptions?.input?.turnstileMobile)
  } finally {
    ctx.restore()
  }
})

test('shell env takes precedence over .env.local', () => {
  const ctx = withTempCwd({
    envLocal: 'VITE_TURNSTILE_SITE_KEY=\n',
    shellKey: '1x00000000000000000000AA',
  })
  try {
    // Shell value is non-empty → build must succeed even though .env.local is blank.
    const config = configFn({ mode: 'production', command: 'build' })
    assert.equal(typeof config, 'object')
  } finally {
    ctx.restore()
  }
})

test('non-production modes do not enforce the site key', () => {
  const ctx = withTempCwd({ envLocal: undefined, shellKey: undefined })
  try {
    // Development, http, and other modes must not fail.
    const dev = configFn({ mode: 'development', command: 'serve' })
    assert.equal(typeof dev, 'object')
    const http = configFn({ mode: 'http', command: 'serve' })
    assert.equal(typeof http, 'object')
  } finally {
    ctx.restore()
  }
})

test('multi-page rollup input targets index.html, auth/turnstile-mobile.html, and oauth/consent.html', () => {
  const ctx = withTempCwd({ envLocal: 'VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA\n', shellKey: undefined })
  try {
    const config = configFn({ mode: 'production', command: 'build' })
    const inputs = config.build.rollupOptions.input
    assert.match(inputs.main, /index\.html$/)
    assert.match(inputs.turnstileMobile, /auth\/turnstile-mobile\.html$/)
    assert.match(inputs.oauthConsent, /oauth\/consent\.html$/)
    assert.equal(config.build.outDir, 'dist')
  } finally {
    ctx.restore()
  }
})
