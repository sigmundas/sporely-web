import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
)

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  const useHttps = mode !== 'http'

  // loadEnv reads .env, .env.local, .env.<mode>, .env.<mode>.local from the
  // project root and merges them with process.env (process.env wins, matching
  // Vite's runtime rules). This is required because the raw process.env is
  // not populated with .env files until AFTER config evaluation.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const turnstileSiteKey = (env.VITE_TURNSTILE_SITE_KEY || '').trim()

  if (mode === 'production' && !turnstileSiteKey) {
    throw new Error(
      'VITE_TURNSTILE_SITE_KEY is required for production builds. ' +
      'Refusing to ship without a Cloudflare Turnstile site key.'
    )
  }

  return {
    root: '.',
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main: resolve(projectRoot, 'index.html'),
          turnstileMobile: resolve(projectRoot, 'auth/turnstile-mobile.html'),
        },
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: useHttps ? [basicSsl()] : [],
    server: {
      host: true,
      https: useHttps,
    },
  }
})
