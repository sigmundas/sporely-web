import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
)

export default defineConfig(({ mode }) => {
  const useHttps = mode !== 'http'

  return {
    root: '.',
    build: {
      outDir: 'dist',
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
