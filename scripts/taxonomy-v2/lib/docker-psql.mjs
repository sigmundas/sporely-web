import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)));
  });
}

export async function discoverLocalTarget(projectRoot = process.cwd()) {
  const config = await readFile(`${projectRoot}/supabase/config.toml`, 'utf8');
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) throw new Error('supabase/config.toml has no project_id');
  const context = (await run('docker', ['context', 'show'])).stdout.trim();
  const versions = JSON.parse((await run('docker', ['version', '--format', '{{json .}}'])).stdout);
  const rows = (await run('docker', ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--format', '{{json .}}'])).stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  const candidates = rows.filter(row => row.Names?.startsWith('supabase_db_') && row.State === 'running');
  if (candidates.length !== 1) throw new Error(`expected exactly one running local Supabase database container for ${projectId}, found ${candidates.length}`);
  const container = candidates[0].ID;
  const label = (await run('docker', ['inspect', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}', container])).stdout.trim();
  if (label !== projectId) throw new Error('container project label mismatch');
  const identity = (await run('docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-Atc', "select current_database()||'|'||current_setting('server_version')||'|'||(to_regclass('public.taxonomy_v2_releases') is not null)::text||'|'||(select count(*) from supabase_migrations.schema_migrations where version='20260724130000')::text"])).stdout.trim().split('|');
  if (identity[0] !== 'postgres' || identity[2] !== 'true' || identity[3] !== '1') throw new Error('container database is not the expected W2A local Supabase database');
  const psqlVersion = (await run('docker', ['exec', '-i', container, 'psql', '--version'])).stdout.trim();
  return { projectId, context, engineVersion: versions.Server.Version, container, database: identity[0], postgresVersion: identity[1], psqlVersion };
}

export async function query(target, sql) {
  return (await run('docker', ['exec', '-i', target.container, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target.database, '-Atc', sql])).stdout.trim();
}

// queryStdin: same result as query() but streams SQL over stdin so we never
// hit ARG_MAX. Use this when the SQL text may exceed a few hundred KB (e.g.
// a manifest with hundreds of records embedded as a jsonb literal).
export function queryStdin(target, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', target.container, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target.database, '-Atf', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`psql stdin failed (${code}): ${stderr.trim()}`)));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

export function spawnSession(target) {
  return spawn('docker', ['exec', '-i', target.container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', target.database], { stdio: ['pipe', 'pipe', 'pipe'] });
}
