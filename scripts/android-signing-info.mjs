#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) {
    console.error(`[android-signing-info] Unable to run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  process.exitCode = result.status || 0
}

const apkArgument = process.argv[2]
if (apkArgument) {
  const apkPath = resolve(apkArgument)
  if (!existsSync(apkPath)) {
    console.error(`[android-signing-info] APK not found: ${apkPath}`)
    process.exit(1)
  }
  console.log(`[android-signing-info] Certificate embedded in ${apkPath}`)
  const sdkCandidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
  ].filter(Boolean)
  let apkSigner = null
  for (const sdkPath of sdkCandidates) {
    const buildToolsPath = join(sdkPath, 'build-tools')
    if (!existsSync(buildToolsPath)) continue
    const versions = readdirSync(buildToolsPath).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    const candidate = join(buildToolsPath, versions.at(-1) || '', 'apksigner')
    if (existsSync(candidate)) apkSigner = candidate
  }
  if (apkSigner) {
    run(apkSigner, ['verify', '--print-certs', apkPath])
  } else {
    console.warn('[android-signing-info] Android apksigner was not found; keytool only recognizes legacy JAR signatures')
    run('keytool', ['-printcert', '-jarfile', apkPath])
  }
} else {
  console.log('[android-signing-info] Gradle signing configurations (debug and configured local release)')
  run('./gradlew', [':app:signingReport'], { cwd: resolve('android') })
}
