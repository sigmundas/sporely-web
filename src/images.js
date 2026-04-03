import { supabase } from './supabase.js'

/**
 * Given an array of observation IDs, returns a map of { obsId -> signedUrl }
 * for the first image (lowest sort_order) of each observation.
 */
export async function fetchFirstImages(obsIds) {
  if (!obsIds.length) return {}

  const { data, error } = await supabase
    .from('observation_images')
    .select('observation_id, storage_path')
    .in('observation_id', obsIds)
    .order('sort_order', { ascending: true })

  if (error || !data?.length) return {}

  // Keep only the first image per observation; build reverse lookup path→obsId
  const firstPaths = {}   // obsId → path
  const pathToObsId = {} // path → obsId
  for (const img of data) {
    if (!firstPaths[img.observation_id]) {
      firstPaths[img.observation_id] = img.storage_path
      pathToObsId[img.storage_path]  = img.observation_id
    }
  }

  const { data: signed } = await supabase.storage
    .from('observation-images')
    .createSignedUrls(Object.values(firstPaths), 3600)

  if (!signed) return {}

  // Use item.path (not positional index) to match back to obsId
  const urls = {}
  for (const item of signed) {
    if (item.signedUrl && item.path) {
      const obsId = pathToObsId[item.path]
      if (obsId) urls[obsId] = item.signedUrl
    }
  }

  return urls
}
