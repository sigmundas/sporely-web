import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
)

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [basicSsl()],
  server: {
    host: true,
    https: true,
  },
})
