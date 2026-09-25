#!/usr/bin/env node
// Production migration deploy helper for the documented migration-order
// exception (docs/deployments/2026-09-25-migration-order-exception.md).
//
// While supabase/deploy-exceptions.json lists deferred migrations, production
// migrations are deployed only from a temporary worktree of a committed ref
// that omits exactly those files. This helper prepares that worktree, checks
// `supabase migration list` and `supabase db push --dry-run` against an
// explicit allowlist, and prints the real push command. It never runs it.
//
//   node scripts/supabase-deploy-tree.mjs prepare --allow 20260926120000 [--ref origin/main]
//   node scripts/supabase-deploy-tree.mjs check --tree <dir>
//   node scripts/supabase-deploy-tree.mjs post-verify --tree <dir>

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const REGISTRY_PATH = 'supabase/deploy-exceptions.json'
export const MIGRATIONS_DIR = 'supabase/migrations'
export const LINK_DIR = 'supabase/.temp'
export const PLAN_PATH = `${LINK_DIR}/sporely-deploy-plan.json`
const VERSION_RE = /^\d{14}$/
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')

export class DeployCheckError extends Error {}

function fail(message) {
  throw new DeployCheckError(message)
}

function sameSet(a, b) {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function describe(versions) {
  return versions.length ? [...versions].sort().join(', ') : '(none)'
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

export function runSupabase(cwd, args) {
  const result = spawnSync('supabase', args, { cwd, encoding: 'utf8' })
  if (result.error) fail(`could not run supabase ${args.join(' ')}: ${result.error.message}`)
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` }
}

// ── Inputs ────────────────────────────────────────────────────────────────

export function loadRegistry(root) {
  const file = path.join(root, REGISTRY_PATH)
  if (!fs.existsSync(file)) fail(`missing ${REGISTRY_PATH}`)
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!/^[a-z0-9]{20}$/.test(String(registry.productionProjectRef || ''))) {
    fail(`${REGISTRY_PATH} has no valid productionProjectRef`)
  }
  if (!Array.isArray(registry.deferredMigrations)) {
    fail(`${REGISTRY_PATH} has no deferredMigrations list`)
  }
  for (const entry of registry.deferredMigrations) {
    const valid = VERSION_RE.test(String(entry?.version))
      && String(entry?.file || '').startsWith(`${entry.version}_`)
      && String(entry.file).endsWith('.sql')
      && /^[0-9a-f]{64}$/.test(String(entry?.sha256))
    if (!valid) fail(`malformed deferred migration entry: ${JSON.stringify(entry)}`)
  }
  return registry
}

/** Map of migration version -> filename. Two files sharing a version fail. */
export function migrationFiles(root) {
  const files = new Map()
  for (const name of fs.readdirSync(path.join(root, MIGRATIONS_DIR)).sort()) {
    const match = name.match(/^(\d{14})_.+\.sql$/)
    if (!match) continue
    if (files.has(match[1])) fail(`two migration files share version ${match[1]}`)
    files.set(match[1], name)
  }
  return files
}

export function parseAllowlist(value) {
  const versions = String(value || '').split(',').map((part) => part.trim()).filter(Boolean)
  if (!versions.length) fail('--allow must name at least one migration version')
  for (const version of versions) {
    if (!VERSION_RE.test(version)) fail(`--allow entry is not a 14-digit migration version: ${version}`)
  }
  if (new Set(versions).size !== versions.length) fail('--allow lists a version twice')
  return versions
}

export function readProjectRef(tree) {
  const file = path.join(tree, LINK_DIR, 'project-ref')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
}

// ── CLI output parsers (fail closed on anything unrecognised) ─────────────

export function parseMigrationList(text) {
  const lines = String(text).split(/\r?\n/)
  const header = lines.findIndex((line) => /^\s*Local\s*\|\s*Remote\s*\|/.test(line))
  if (header < 0) fail('`supabase migration list` output has no Local | Remote table')
  const rows = []
  for (const line of lines.slice(header + 1)) {
    if (/^\s*-+\|/.test(line) || !line.includes('|')) continue
    const [localCell, remoteCell] = line.split('|')
    const local = localCell.trim()
    const remote = remoteCell.trim()
    if (!local && !remote) continue
    if ((local && !VERSION_RE.test(local)) || (remote && !VERSION_RE.test(remote))) {
      fail(`unrecognised migration list row: ${line.trim()}`)
    }
    if (local && remote && local !== remote) fail(`migration list row pairs different versions: ${line.trim()}`)
    rows.push({ local: local || null, remote: remote || null })
  }
  if (!rows.length) fail('`supabase migration list` output has no migration rows')
  return rows
}

export function parseDryRun(text) {
  const output = String(text)
  if (!output.includes('DRY RUN: migrations will *not* be pushed')) {
    fail('this is not `supabase db push --dry-run` output')
  }
  if (output.includes('Found local migration files to be inserted before the last migration on remote database')) {
    fail('the CLI found out-of-order local migrations; a deferred migration is still in the tree')
  }
  if (output.includes('Remote database is up to date.')) return []
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === 'Would push these migrations:')
  if (start < 0) fail('dry run neither lists migrations nor reports the remote up to date (did it fail to connect?)')
  const versions = []
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s*[•*-]\s+(\d{14})_\S+\.sql\s*$/)
    if (!match) break
    versions.push(match[1])
  }
  if (!versions.length) fail('dry run says it would push migrations but none could be parsed')
  return versions
}

// ── Checks ────────────────────────────────────────────────────────────────

/**
 * Everything that must hold before a real push is offered. Returns a list of
 * problems; an empty list is the only passing result.
 */
export function evaluateDeployTree({ registry, plan, projectRef, headSha, gitStatus, treeFiles, listText, dryRunText }) {
  const errors = []
  const expectedRef = registry.productionProjectRef
  const deferred = registry.deferredMigrations
  const deferredVersions = deferred.map((entry) => entry.version)
  const allow = plan.allow

  if (projectRef !== expectedRef) {
    errors.push(`deploy tree is linked to "${projectRef || '(nothing)'}", not the production project ${expectedRef}`)
  }
  if (plan.projectRef !== expectedRef) errors.push('deploy plan was prepared for a different project')
  if (headSha !== plan.sha) errors.push(`deploy tree HEAD ${headSha} is not the prepared commit ${plan.sha}`)

  const expectedStatus = deferred.map((entry) => ` D ${MIGRATIONS_DIR}/${entry.file}`)
  const status = String(gitStatus).split('\n').filter(Boolean)
  if (!sameSet(status, expectedStatus)) {
    errors.push(`deploy tree must differ from its commit only by the deferred deletions; git status shows:\n${status.join('\n') || '(clean)'}`)
  }
  for (const version of deferredVersions) {
    if (treeFiles.has(version)) errors.push(`deferred migration ${version} is present in the deploy tree`)
  }
  for (const version of allow) {
    if (deferredVersions.includes(version)) errors.push(`allowlist contains deferred migration ${version}`)
    if (!treeFiles.has(version)) errors.push(`allowlisted migration ${version} has no file in the deploy tree`)
  }

  try {
    const rows = parseMigrationList(listText)
    const remoteOnly = rows.filter((row) => !row.local).map((row) => row.remote)
    const localOnly = rows.filter((row) => !row.remote).map((row) => row.local)
    if (remoteOnly.length) errors.push(`remote has migrations this tree does not: ${describe(remoteOnly)} — stop and report the mismatch`)
    if (!sameSet(localOnly, allow)) {
      errors.push(`pending migrations ${describe(localOnly)} do not match the allowlist ${describe(allow)}`)
    }
    const seen = rows.flatMap((row) => [row.local, row.remote]).filter(Boolean)
    for (const version of deferredVersions) {
      if (seen.includes(version)) errors.push(`deferred migration ${version} appears in migration list; if it is now on remote, the exception registry is stale`)
    }
  } catch (error) {
    if (!(error instanceof DeployCheckError)) throw error
    errors.push(error.message)
  }

  try {
    const wouldPush = parseDryRun(dryRunText)
    for (const version of deferredVersions) {
      if (wouldPush.includes(version)) errors.push(`dry run would apply deferred migration ${version}`)
    }
    if (!sameSet(wouldPush, allow)) {
      errors.push(`dry run would push ${describe(wouldPush)}, but the allowlist is exactly ${describe(allow)}`)
    }
  } catch (error) {
    if (!(error instanceof DeployCheckError)) throw error
    errors.push(error.message)
  }
  return errors
}

/** After the user's push: local tree and remote must match exactly, gap intact. */
export function evaluatePostDeploy({ registry, plan, listText }) {
  const errors = []
  const rows = parseMigrationList(listText)
  const mismatched = rows.filter((row) => !row.local || !row.remote)
  if (mismatched.length) {
    errors.push(`local and remote differ: ${mismatched.map((row) => `${row.local || '-'}|${row.remote || '-'}`).join(', ')}`)
  }
  const remote = new Set(rows.map((row) => row.remote).filter(Boolean))
  for (const version of plan.allow) {
    if (!remote.has(version)) errors.push(`allowlisted migration ${version} is not on remote`)
  }
  for (const entry of registry.deferredMigrations) {
    if (remote.has(entry.version)) errors.push(`deferred migration ${entry.version} is on remote`)
  }
  return errors
}

// ── Commands ──────────────────────────────────────────────────────────────

export function prepareDeployTree({ repoRoot = DEFAULT_REPO_ROOT, ref = 'HEAD', allow, out, linkFrom } = {}) {
  const allowlist = parseAllowlist(allow)
  const sha = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  const tree = path.resolve(out || path.join(os.tmpdir(), `sporely-web-deploy-${sha.slice(0, 12)}`))
  if (fs.existsSync(tree)) fail(`${tree} already exists; remove it or pass --out`)

  git(repoRoot, ['worktree', 'add', '--detach', tree, sha])
  try {
    const registry = loadRegistry(tree)
    if (!registry.deferredMigrations.length) {
      fail(`${REGISTRY_PATH} lists no deferred migrations at ${sha}; use the ordinary AGENTS.md workflow`)
    }
    const files = migrationFiles(tree)
    for (const entry of registry.deferredMigrations) {
      const file = path.join(tree, MIGRATIONS_DIR, entry.file)
      if (files.get(entry.version) !== entry.file || !fs.existsSync(file)) {
        fail(`deferred migration ${entry.file} is missing or renamed at ${sha}; update ${REGISTRY_PATH} only as a reviewed change`)
      }
      if (sha256(file) !== entry.sha256) {
        fail(`deferred migration ${entry.file} changed since it was deferred; its content needs review before any deploy`)
      }
      fs.rmSync(file)
      files.delete(entry.version)
    }
    for (const version of allowlist) {
      if (registry.deferredMigrations.some((entry) => entry.version === version)) {
        fail(`${version} is a deferred migration; releasing it is a separate reviewed rollout, not an allowlist entry`)
      }
      if (!files.has(version)) fail(`allowlisted migration ${version} has no file at ${sha}`)
    }

    const linkSource = path.join(path.resolve(linkFrom || repoRoot), LINK_DIR)
    if (!fs.existsSync(path.join(linkSource, 'project-ref'))) {
      fail(`${linkSource} has no Supabase link; run \`supabase link --project-ref ${registry.productionProjectRef}\` there first`)
    }
    fs.cpSync(linkSource, path.join(tree, LINK_DIR), { recursive: true })
    for (const leftover of ['sporely-deploy-plan.json', 'sporely-migration-list.txt', 'sporely-dry-run.txt']) {
      fs.rmSync(path.join(tree, LINK_DIR, leftover), { force: true })
    }
    const projectRef = readProjectRef(tree)
    if (projectRef !== registry.productionProjectRef) {
      fail(`Supabase link points at "${projectRef}", not the production project ${registry.productionProjectRef}`)
    }

    const plan = { sha, ref, allow: allowlist, projectRef, deferred: registry.deferredMigrations.map((entry) => entry.version) }
    fs.writeFileSync(path.join(tree, PLAN_PATH), `${JSON.stringify(plan, null, 2)}\n`)
    return { tree, plan }
  } catch (error) {
    git(repoRoot, ['worktree', 'remove', '--force', tree])
    throw error
  }
}

function loadTree(tree) {
  const planFile = path.join(tree, PLAN_PATH)
  if (!fs.existsSync(planFile)) fail(`${tree} was not prepared by this helper (no ${PLAN_PATH})`)
  return {
    registry: loadRegistry(tree),
    plan: JSON.parse(fs.readFileSync(planFile, 'utf8')),
  }
}

export function checkDeployTree({ tree, listText, dryRunText, run = runSupabase }) {
  const { registry, plan } = loadTree(tree)
  const projectRef = readProjectRef(tree)
  if (projectRef !== registry.productionProjectRef) {
    // Refuse before contacting anything through a wrong link.
    return [`deploy tree is linked to "${projectRef || '(nothing)'}", not the production project ${registry.productionProjectRef}`]
  }
  if (listText === undefined) listText = run(tree, ['migration', 'list', '--linked']).output
  if (dryRunText === undefined) dryRunText = run(tree, ['db', 'push', '--linked', '--dry-run']).output
  fs.writeFileSync(path.join(tree, LINK_DIR, 'sporely-migration-list.txt'), listText)
  fs.writeFileSync(path.join(tree, LINK_DIR, 'sporely-dry-run.txt'), dryRunText)
  return evaluateDeployTree({
    registry,
    plan,
    projectRef,
    headSha: git(tree, ['rev-parse', 'HEAD']).trim(),
    gitStatus: git(tree, ['status', '--porcelain']),
    treeFiles: migrationFiles(tree),
    listText,
    dryRunText,
  })
}

export function postVerifyDeployTree({ tree, listText, run = runSupabase }) {
  const { registry, plan } = loadTree(tree)
  if (readProjectRef(tree) !== registry.productionProjectRef) {
    return ['deploy tree is not linked to the production project']
  }
  if (listText === undefined) listText = run(tree, ['migration', 'list', '--linked']).output
  return evaluatePostDeploy({ registry, plan, listText })
}

function printFailures(errors) {
  console.error('REFUSED — do not push. Problems found:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exitCode = 1
}

function main(argv) {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      allow: { type: 'string' },
      ref: { type: 'string', default: 'HEAD' },
      out: { type: 'string' },
      'link-from': { type: 'string' },
      tree: { type: 'string', default: process.cwd() },
      'list-file': { type: 'string' },
      'dry-run-file': { type: 'string' },
    },
  })
  const readOptional = (file) => (file ? fs.readFileSync(file, 'utf8') : undefined)
  const helper = path.relative(process.cwd(), SCRIPT_PATH) || SCRIPT_PATH

  if (command === 'prepare') {
    const { tree, plan } = prepareDeployTree({ ref: values.ref, allow: values.allow, out: values.out, linkFrom: values['link-from'] })
    console.log(`Prepared deploy tree ${tree}`)
    console.log(`  commit ${plan.sha}, project ${plan.projectRef}`)
    console.log(`  omitted deferred: ${describe(plan.deferred)}`)
    console.log(`  allowlist: ${describe(plan.allow)}`)
    console.log('\nNext, from your terminal (read-only; runs migration list and db push --dry-run):')
    console.log(`  node ${path.join(tree, 'scripts', 'supabase-deploy-tree.mjs')} check --tree ${tree}`)
    return
  }
  if (command === 'check') {
    const tree = path.resolve(values.tree)
    const errors = checkDeployTree({ tree, listText: readOptional(values['list-file']), dryRunText: readOptional(values['dry-run-file']) })
    if (errors.length) return printFailures(errors)
    const { plan } = loadTree(tree)
    console.log(`All checks passed. The dry run pushes exactly: ${describe(plan.allow)}`)
    console.log('\nThis helper never pushes. To deploy, run it yourself:')
    console.log(`  cd ${tree}`)
    console.log('  supabase db push --linked')
    console.log('Answer y only if the CLI prompt lists exactly the migrations above. Then:')
    console.log(`  node ${path.join(tree, 'scripts', 'supabase-deploy-tree.mjs')} post-verify --tree ${tree}`)
    return
  }
  if (command === 'post-verify') {
    const tree = path.resolve(values.tree)
    const errors = postVerifyDeployTree({ tree, listText: readOptional(values['list-file']) })
    if (errors.length) return printFailures(errors)
    console.log('Remote matches the deploy tree exactly; deferred migrations are still absent.')
    const commonDir = git(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    console.log('Run the stage\'s read-only verification queries, then remove the tree:')
    console.log(`  git -C ${path.dirname(commonDir)} worktree remove --force ${tree}`)
    return
  }
  console.error(`usage: node ${helper} prepare --allow <version[,version]> [--ref <git-ref>] [--out <dir>] [--link-from <checkout>]`)
  console.error(`       node ${helper} check [--tree <dir>] [--list-file <f> --dry-run-file <f>]`)
  console.error(`       node ${helper} post-verify [--tree <dir>] [--list-file <f>]`)
  process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof DeployCheckError)) throw error
    printFailures([error.message])
  }
}
