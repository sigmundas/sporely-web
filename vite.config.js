import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [basicSsl()],
  server: {
    host: true,
    https: true,
  },
})
