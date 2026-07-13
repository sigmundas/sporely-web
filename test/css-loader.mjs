export async function load(url, context, defaultLoad) {
  if (url.endsWith('.css')) {
    return {
      format: 'module',
      source: 'export default {};',
      shortCircuit: true,
    }
  }

  return defaultLoad(url, context, defaultLoad)
}
