import { register } from 'node:module'

let registered = false

/**
 * Install the `.css` stub loader for the current process.
 *
 * Vite resolves `import 'leaflet/dist/leaflet.css'` at build time; Node's ESM
 * loader cannot, so importing a production module that pulls in CSS under
 * `node --test` fails with ERR_UNKNOWN_FILE_EXTENSION. `module.register()` is
 * the documented (non-deprecated) replacement for `--experimental-loader`, and
 * because it needs no CLI flag it works identically for a focused
 * `node --test <file>` run and for the whole `npm test` run.
 *
 * Call this before dynamically importing the module under test; static imports
 * of that module are resolved before any test-file code runs, so the hook must
 * be registered first and the module imported with `await import(...)`.
 */
export function registerCssLoader() {
  if (registered) return
  registered = true
  register('./css-loader.mjs', import.meta.url)
}
