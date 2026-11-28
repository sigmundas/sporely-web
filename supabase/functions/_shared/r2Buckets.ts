// One reading of R2_PRIVATE_BUCKET_NAME for every Edge Function (secrets are
// project-wide). The value is the Worker's PRIVATE_MEDIA_BUCKET name, or the
// literal 'none' when the Worker binds no private bucket.
//   unset or empty -> configured: false (callers decide: delete-account fails
//                     closed, admin-ops keeps the legacy bucket only)
//   'none'          -> configured: true, bucket: null
//   a name          -> configured: true, bucket: the name
export function parsePrivateBucketSetting(value: string | undefined | null): { configured: boolean; bucket: string | null } {
  const text = String(value ?? '').trim()
  if (!text) return { configured: false, bucket: null }
  if (text.toLowerCase() === 'none') return { configured: true, bucket: null }
  return { configured: true, bucket: text }
}
