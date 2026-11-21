// S3-compatible R2 client for the delete-account prefix stages (plan.js:
// delete_r2_prefix, delete_r2_prefix_second_pass, verify_r2_prefix_empty).
//
// Same credentials and bucket settings as admin-ops (createR2Client in
// ../admin-ops/adminActions.ts); Supabase edge-function secrets are shared
// by every function of the project:
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT   (required)
//   R2_BUCKET_NAME          legacy public bucket (default 'sporely-media')
//   R2_PRIVATE_BUCKET_NAME  REQUIRED: the private bucket name, or the literal
//                           'none' when the Worker has no PRIVATE_MEDIA_BUCKET
//                           bound. Unset or empty fails closed, so a missing
//                           setting can never silently skip private objects.
// The token needs List, Read and Delete on both buckets. Without the
// required values this returns undefined and the plan fails closed at
// delete_r2_prefix (the account is not deleted).
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from 'npm:@aws-sdk/client-s3@3.1091.0'
import { parsePrivateBucketSetting } from '../_shared/r2Buckets.ts'

type R2Object = { bucket: string; key: string }

export function createPrefixR2Client(env: Record<string, string | undefined>) {
  const accessKeyId = String(env.R2_ACCESS_KEY_ID ?? '').trim()
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY ?? '').trim()
  const endpoint = String(env.R2_S3_ENDPOINT ?? '').trim().replace(/\/+$/, '')
  if (!accessKeyId || !secretAccessKey || !endpoint) return undefined
  const legacy = String(env.R2_BUCKET_NAME ?? '').trim() || 'sporely-media'
  const privateSetting = parsePrivateBucketSetting(env.R2_PRIVATE_BUCKET_NAME)
  if (!privateSetting.configured) return undefined
  const buckets = [...new Set([legacy, privateSetting.bucket].filter((b): b is string => Boolean(b)))]
  const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } })

  return {
    buckets,
    async listObjects(prefix: string) {
      if (!prefix || !prefix.endsWith('/')) return { ok: false, error: 'invalid prefix' }
      const objects: R2Object[] = []
      try {
        for (const bucket of buckets) {
          let token: string | undefined
          do {
            const page = await client.send(new ListObjectsV2Command({
              Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
            }))
            for (const item of page.Contents ?? []) if (item.Key) objects.push({ bucket, key: item.Key })
            token = page.IsTruncated ? page.NextContinuationToken : undefined
          } while (token)
        }
        return { ok: true, objects }
      } catch (error) {
        return { ok: false, error: (error as Error)?.name || 'list failed' }
      }
    },
    async deleteObjects(objects: R2Object[]) {
      try {
        for (const bucket of buckets) {
          const keys = objects.filter(o => o.bucket === bucket).map(o => o.key)
          for (let i = 0; i < keys.length; i += 1000) {
            const result = await client.send(new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
            }))
            if (result.Errors?.length) return { ok: false, error: `${result.Errors.length} delete error(s) in ${bucket}` }
          }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error)?.name || 'delete failed' }
      }
    },
    // Delete permission check without side effects: deleting a key that does
    // not exist succeeds in S3/R2 when the token may delete, and fails with
    // AccessDenied for a list-only token.
    async probeDelete(prefix: string) {
      if (!prefix || !prefix.endsWith('/')) return { ok: false, error: 'invalid prefix' }
      try {
        for (const bucket of buckets) {
          const result = await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: [{ Key: `${prefix}.sporely-delete-probe` }], Quiet: true },
          }))
          if (result.Errors?.length) return { ok: false, error: `delete not permitted in ${bucket}` }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error)?.name || 'delete check failed' }
      }
    },
  }
}
