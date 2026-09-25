import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  checkDeployTree,
  DeployCheckError,
  loadRegistry,
  migrationFiles,
  parseDryRun,
  parseMigrationList,
  postVerifyDeployTree,
  prepareDeployTree,
} from './supabase-deploy-tree.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PROD_REF = 'abcdefghijklmnopqrst'
const DEFERRED = '20260914090000_extend_reference_snapshots_to_version_2.sql'
const NEW = '20260926120000_new_rls.sql'

// Output shapes captured from Supabase CLI 2.98.2 against a throwaway Postgres
// whose history had every migration except the deferred one.
const listRow = (local, remote) => `   ${local.padEnd(14)} | ${remote.padEnd(14)} | 2026-09-01 00:00:00 `
const migrationList = (rows) => [
  'Connecting to remote database...',
  '',
  '  ',
  '   Local          | Remote         | Time (UTC)          ',
  '  ----------------|----------------|---------------------',
  ...rows.map(([local, remote]) => listRow(local, remote)),
  '',
].join('\n')
const APPLIED = ['20260901000000', '20260922120000', '20260925120000']
const LIST_TREE_ONE_NEW = migrationList([...APPLIED.map((v) => [v, v]), ['20260926120000', '']])
const LIST_MAIN = migrationList([
  ['20260901000000', '20260901000000'],
  ['20260914090000', ''],
  ['20260922120000', '20260922120000'],
  ['20260925120000', '20260925120000'],
  ['20260926120000', ''],
])
const LIST_AFTER_PUSH = migrationList([...APPLIED.map((v) => [v, v]), ['20260926120000', '20260926120000']])
const dryRun = (files) => [
  'DRY RUN: migrations will *not* be pushed to the database.',
  'Connecting to remote database...',
  'Would push these migrations:',
  ...files.map((file) => ` • ${file}`),
  'Finished supabase db push.',
  '',
].join('\n')
const DRY_RUN_PLAIN_FROM_MAIN = [
  'DRY RUN: migrations will *not* be pushed to the database.',
  'Connecting to remote database...',
  'Found local migration files to be inserted before the last migration on remote database.',
  '',
  'Rerun the command with --include-all flag to apply these migrations:',
  `supabase/migrations/${DEFERRED}`,
  '',
].join('\n')
const DRY_RUN_UP_TO_DATE = 'DRY RUN: migrations will *not* be pushed to the database.\nConnecting to remote database...\nRemote database is up to date.\n'

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** A throwaway repo shaped like production: deferred file on main, later files applied, one new. */
function makeRepo(t, { linkedRef = PROD_REF, extraMigration } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-tree-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const migrations = path.join(repo, 'supabase', 'migrations')
  fs.mkdirSync(migrations, { recursive: true })
  for (const name of ['20260901000000_base.sql', DEFERRED, '20260922120000_later.sql', '20260925120000_latest.sql', NEW, extraMigration].filter(Boolean)) {
    fs.writeFileSync(path.join(migrations, name), `-- ${name}\nselect 1;\n`)
  }
  const deferredHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(migrations, DEFERRED))).digest('hex')
  fs.writeFileSync(path.join(repo, 'supabase', 'deploy-exceptions.json'), JSON.stringify({
    productionProjectRef: PROD_REF,
    deferredMigrations: [{ version: '20260914090000', file: DEFERRED, sha256: deferredHash, reason: 'test', doc: 'x.md' }],
  }))
  fs.writeFileSync(path.join(repo, '.gitignore'), 'supabase/.temp/\n')
  git(repo, 'init', '-q')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture')
  fs.mkdirSync(path.join(repo, 'supabase', '.temp'), { recursive: true })
  if (linkedRef) fs.writeFileSync(path.join(repo, 'supabase', '.temp', 'project-ref'), linkedRef)
  return { repo, out: path.join(root, 'deploy-tree') }
}

function prepared(t, options = {}) {
  const fixture = makeRepo(t, options)
  const { tree, plan } = prepareDeployTree({ repoRoot: fixture.repo, allow: options.allow || '20260926120000', out: fixture.out })
  return { ...fixture, tree, plan }
}

test('the repository registry pins the deferred migration exactly as committed', () => {
  const registry = loadRegistry(REPO_ROOT)
  const files = migrationFiles(REPO_ROOT)
  assert.ok(registry.deferredMigrations.length > 0)
  for (const entry of registry.deferredMigrations) {
    assert.equal(files.get(entry.version), entry.file, 'filename and timestamp must stay unchanged')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', entry.file))).digest('hex')
    assert.equal(hash, entry.sha256)
  }
})

test('prepare omits exactly the deferred migration and keeps every other file', (t) => {
  const { repo, tree, plan } = prepared(t)
  const source = [...migrationFiles(repo).values()]
  const deployed = [...migrationFiles(tree).values()]
  assert.deepEqual(deployed, source.filter((name) => name !== DEFERRED))
  assert.equal(git(tree, 'status', '--porcelain'), `D supabase/migrations/${DEFERRED}`)
  assert.deepEqual(plan.allow, ['20260926120000'])
  assert.equal(plan.projectRef, PROD_REF)
})

test('check accepts exactly the one allowlisted migration', (t) => {
  const { tree } = prepared(t)
  const calls = []
  const run = (_cwd, args) => {
    calls.push(args.join(' '))
    return { status: 0, output: args[0] === 'migration' ? LIST_TREE_ONE_NEW : dryRun([NEW]) }
  }
  assert.deepEqual(checkDeployTree({ tree, run }), [])
  assert.deepEqual(calls, ['migration list --linked', 'db push --linked --dry-run'], 'only read-only commands are run')
})

test('an unexpected second pending migration refuses the deploy', (t) => {
  const { tree } = prepared(t, { extraMigration: '20260927120000_unreviewed.sql' })
  const listText = migrationList([...APPLIED.map((v) => [v, v]), ['20260926120000', ''], ['20260927120000', '']])
  const errors = checkDeployTree({ tree, listText, dryRunText: dryRun([NEW, '20260927120000_unreviewed.sql']) })
  assert.ok(errors.some((e) => e.includes('do not match the allowlist')), errors.join('\n'))
  assert.ok(errors.some((e) => e.includes('dry run would push')), errors.join('\n'))
})

test('a dry run that would include the deferred migration refuses the deploy', (t) => {
  const { tree } = prepared(t)
  const errors = checkDeployTree({ tree, listText: LIST_TREE_ONE_NEW, dryRunText: dryRun([DEFERRED, NEW]) })
  assert.ok(errors.some((e) => e.includes('would apply deferred migration 20260914090000')), errors.join('\n'))
})

test('output taken from main instead of the deploy tree refuses the deploy', (t) => {
  const { tree } = prepared(t)
  const errors = checkDeployTree({ tree, listText: LIST_MAIN, dryRunText: DRY_RUN_PLAIN_FROM_MAIN })
  assert.ok(errors.some((e) => e.includes('deferred migration 20260914090000 appears in migration list')), errors.join('\n'))
  assert.ok(errors.some((e) => e.includes('out-of-order')), errors.join('\n'))
})

test('the deferred file restored into the tree refuses the deploy', (t) => {
  const { repo, tree } = prepared(t)
  fs.copyFileSync(path.join(repo, 'supabase', 'migrations', DEFERRED), path.join(tree, 'supabase', 'migrations', DEFERRED))
  const errors = checkDeployTree({ tree, listText: LIST_TREE_ONE_NEW, dryRunText: dryRun([NEW]) })
  assert.ok(errors.some((e) => e.includes('present in the deploy tree')), errors.join('\n'))
})

test('a remote-only migration refuses the deploy', (t) => {
  const { tree } = prepared(t)
  const listText = migrationList([...APPLIED.map((v) => [v, v]), ['', '20260926000000'], ['20260926120000', '']])
  const errors = checkDeployTree({ tree, listText, dryRunText: dryRun([NEW]) })
  assert.ok(errors.some((e) => e.includes('remote has migrations this tree does not')), errors.join('\n'))
})

test('an up-to-date or unreadable dry run refuses the deploy', (t) => {
  const { tree } = prepared(t)
  assert.ok(checkDeployTree({ tree, listText: LIST_TREE_ONE_NEW, dryRunText: DRY_RUN_UP_TO_DATE }).length > 0)
  const unreachable = 'DRY RUN: migrations will *not* be pushed to the database.\nConnecting to remote database...\nfailed to connect to postgres\n'
  assert.ok(checkDeployTree({ tree, listText: LIST_TREE_ONE_NEW, dryRunText: unreachable }).some((e) => e.includes('neither lists')))
  assert.ok(checkDeployTree({ tree, listText: 'failed to connect', dryRunText: dryRun([NEW]) }).some((e) => e.includes('no Local | Remote table')))
})

test('a wrong project link refuses before any Supabase command runs', (t) => {
  const { tree } = prepared(t)
  fs.writeFileSync(path.join(tree, 'supabase', '.temp', 'project-ref'), 'zzzzzzzzzzzzzzzzzzzz')
  const run = () => assert.fail('must not contact a wrongly linked project')
  const errors = checkDeployTree({ tree, run })
  assert.ok(errors[0].includes('not the production project'), errors.join('\n'))
  assert.ok(postVerifyDeployTree({ tree, run }).length > 0)
})

test('prepare refuses a wrong or missing link and leaves no tree behind', (t) => {
  for (const linkedRef of ['zzzzzzzzzzzzzzzzzzzz', null]) {
    const { repo, out } = makeRepo(t, { linkedRef })
    assert.throws(() => prepareDeployTree({ repoRoot: repo, allow: '20260926120000', out }), DeployCheckError)
    assert.equal(fs.existsSync(out), false)
    assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1)
  }
})

test('prepare refuses to allowlist the deferred migration or a version with no file', (t) => {
  for (const allow of ['20260914090000', '20260926120000,20260914090000', '20261001000000', '2026']) {
    const { repo, out } = makeRepo(t)
    assert.throws(() => prepareDeployTree({ repoRoot: repo, allow, out }), DeployCheckError, allow)
    assert.equal(fs.existsSync(out), false)
  }
})

test('prepare refuses when the deferred migration changed, was renamed, or was removed', (t) => {
  const mutations = [
    (dir) => fs.appendFileSync(path.join(dir, DEFERRED), '-- edited\n'),
    (dir) => fs.renameSync(path.join(dir, DEFERRED), path.join(dir, '20260930000000_extend_reference_snapshots_to_version_2.sql')),
    (dir) => fs.rmSync(path.join(dir, DEFERRED)),
  ]
  for (const mutate of mutations) {
    const { repo, out } = makeRepo(t)
    mutate(path.join(repo, 'supabase', 'migrations'))
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'mutate')
    assert.throws(() => prepareDeployTree({ repoRoot: repo, allow: '20260926120000', out }), DeployCheckError)
    assert.equal(fs.existsSync(out), false)
  }
})

test('post-verify requires an exact match with the deferred migration still absent', (t) => {
  const { tree } = prepared(t)
  assert.deepEqual(postVerifyDeployTree({ tree, listText: LIST_AFTER_PUSH }), [])
  assert.ok(postVerifyDeployTree({ tree, listText: LIST_TREE_ONE_NEW }).some((e) => e.includes('not on remote')))
  const deferredLanded = migrationList([...APPLIED.map((v) => [v, v]), ['', '20260914090000'], ['20260926120000', '20260926120000']])
  assert.ok(postVerifyDeployTree({ tree, listText: deferredLanded }).some((e) => e.includes('deferred migration 20260914090000 is on remote')))
})

test('parsers accept the captured CLI shapes', () => {
  assert.deepEqual(parseDryRun(dryRun([NEW])), ['20260926120000'])
  assert.deepEqual(parseDryRun(DRY_RUN_UP_TO_DATE), [])
  assert.throws(() => parseDryRun(DRY_RUN_PLAIN_FROM_MAIN), DeployCheckError)
  assert.throws(() => parseDryRun('Would push these migrations:\n • 20260926120000_x.sql\n'), /not `supabase db push --dry-run`/)
  const rows = parseMigrationList(LIST_MAIN)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[1], { local: '20260914090000', remote: null })
})
