import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(import.meta.dirname, '..')
const packageJsonPath = path.join(rootDir, 'package.json')
const androidGradlePath = path.join(rootDir, 'android', 'app', 'build.gradle')

const args = new Set(process.argv.slice(2))
const bumpCode = args.has('--bump-code')

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const packageVersion = String(pkg.version || '').trim()
if (!packageVersion) {
  throw new Error('package.json is missing a version')
}

const gradleBefore = fs.readFileSync(androidGradlePath, 'utf8')

const versionNameMatch = gradleBefore.match(/versionName\s+"([^"]+)"/)
const versionCodeMatch = gradleBefore.match(/versionCode\s+(\d+)/)

if (!versionNameMatch || !versionCodeMatch) {
  throw new Error('Could not find versionName/versionCode in android/app/build.gradle')
}

const currentVersionName = versionNameMatch[1]
const currentVersionCode = Number(versionCodeMatch[1])
if (!Number.isInteger(currentVersionCode)) {
  throw new Error('Invalid versionCode in android/app/build.gradle')
}

let nextGradle = gradleBefore.replace(
  /versionName\s+"([^"]+)"/,
  `versionName "${packageVersion}"`,
)

let nextVersionCode = currentVersionCode
if (bumpCode) {
  nextVersionCode += 1
  nextGradle = nextGradle.replace(
    /versionCode\s+\d+/,
    `versionCode ${nextVersionCode}`,
  )
}

if (nextGradle !== gradleBefore) {
  fs.writeFileSync(androidGradlePath, nextGradle)
}

const statusParts = [
  `package.json version ${packageVersion}`,
  `android versionName ${currentVersionName} -> ${packageVersion}`,
]
if (bumpCode) {
  statusParts.push(`android versionCode ${currentVersionCode} -> ${nextVersionCode}`)
} else {
  statusParts.push(`android versionCode unchanged at ${currentVersionCode}`)
}

console.log(statusParts.join('\n'))
