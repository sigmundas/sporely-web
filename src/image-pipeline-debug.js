const IMAGE_PIPELINE_DEBUG_KEY = 'sporely-debug-image-pipeline'

export function isImagePipelineDebugEnabled() {
  try {
    return globalThis.localStorage?.getItem(IMAGE_PIPELINE_DEBUG_KEY) === 'true'
      || globalThis.sessionStorage?.getItem(IMAGE_PIPELINE_DEBUG_KEY) === 'true'
  } catch (_) {
    return false
  }
}

export function debugImagePipeline(message, details = {}) {
  if (!isImagePipelineDebugEnabled()) return
  console.debug(`[image-pipeline] ${message}`, details)
}
