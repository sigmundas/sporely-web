import { parsePrivateBucketSetting } from './r2Buckets.ts'

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

Deno.test('unset or blank is not configured', () => {
  assertEquals(parsePrivateBucketSetting(undefined), { configured: false, bucket: null })
  assertEquals(parsePrivateBucketSetting('  '), { configured: false, bucket: null })
})

Deno.test("'none' means no private bucket, in any case", () => {
  assertEquals(parsePrivateBucketSetting('none'), { configured: true, bucket: null })
  assertEquals(parsePrivateBucketSetting(' NONE '), { configured: true, bucket: null })
})

Deno.test('a bucket name is kept', () => {
  assertEquals(parsePrivateBucketSetting(' sporely-private '), { configured: true, bucket: 'sporely-private' })
})
