import { createPrefixR2Client } from './r2Prefix.ts'

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}
const creds = { R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_S3_ENDPOINT: 'https://r2.example.invalid' }

Deno.test('R2_PRIVATE_BUCKET_NAME unset or empty fails closed (no client)', () => {
  assertEquals(createPrefixR2Client({ ...creds }), undefined)
  assertEquals(createPrefixR2Client({ ...creds, R2_PRIVATE_BUCKET_NAME: '  ' }), undefined)
})

Deno.test('R2_PRIVATE_BUCKET_NAME=none lists only the legacy bucket', () => {
  assertEquals(createPrefixR2Client({ ...creds, R2_PRIVATE_BUCKET_NAME: 'none' })?.buckets, ['sporely-media'])
})

Deno.test('R2_PRIVATE_BUCKET_NAME set lists both buckets', () => {
  assertEquals(createPrefixR2Client({ ...creds, R2_PRIVATE_BUCKET_NAME: 'sporely-media-private' })?.buckets, ['sporely-media', 'sporely-media-private'])
})

Deno.test('missing credentials fail closed', () => {
  assertEquals(createPrefixR2Client({ R2_PRIVATE_BUCKET_NAME: 'none' }), undefined)
})

Deno.test('listObjects refuses a prefix that is not a directory prefix', async () => {
  const client = createPrefixR2Client({ ...creds, R2_PRIVATE_BUCKET_NAME: 'none' })!
  assertEquals((await client.listObjects('')).ok, false)
})
