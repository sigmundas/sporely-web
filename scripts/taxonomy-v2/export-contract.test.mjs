import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflightExport } from './lib/export-contract.mjs';
import { buildFixtureManifest } from './lib/build-fixture-manifest.mjs';

const fixture = path.resolve('scripts/taxonomy-v2/fixtures/complete');
async function copyFixture() { const root=await mkdtemp(path.join(os.tmpdir(),'w2b-fixture-')); await cp(fixture,root,{recursive:true}); return root; }
async function mutateManifest(root, fn) { const p=path.join(root,'taxonomy_export_manifest.json'); const m=JSON.parse(await readFile(p)); fn(m); await writeFile(p,JSON.stringify(m)+'\n'); }

test('valid fixture preflight preserves control escapes and Unicode', async()=>{ const v=await preflightExport(fixture,'tax-2026.07.01-01'); assert.equal(v.files['vernacular.jsonl'].row_count,6); });
test('missing required file fails', async()=>{ const r=await copyFixture(); try{await unlink(path.join(r,'taxon.jsonl')); await assert.rejects(preflightExport(r),/ENOENT/);}finally{await rm(r,{recursive:true});} });
test('wrong file order fails', async()=>{ const r=await copyFixture(); try{await mutateManifest(r,m=>m.files.reverse()); await assert.rejects(preflightExport(r),/dataset order/);}finally{await rm(r,{recursive:true});} });
test('per-file hash mismatch fails', async()=>{ const r=await copyFixture(); try{await writeFile(path.join(r,'taxon.jsonl'),(await readFile(path.join(r,'taxon.jsonl'),'utf8')).replace('COL-1','COL-X')); await assert.rejects(preflightExport(r),/SHA-256 mismatch/);}finally{await rm(r,{recursive:true});} });
test('byte-count mismatch fails', async()=>{ const r=await copyFixture(); try{await mutateManifest(r,m=>m.files[1].bytes++); await assert.rejects(preflightExport(r),/byte count/);}finally{await rm(r,{recursive:true});} });
test('row-count mismatch fails', async()=>{ const r=await copyFixture(); try{await mutateManifest(r,m=>m.files[1].row_count++); await assert.rejects(preflightExport(r),/row count/);}finally{await rm(r,{recursive:true});} });
test('whole-export mismatch fails', async()=>{ const r=await copyFixture(); try{await mutateManifest(r,m=>m.whole_export_sha256='f'.repeat(64)); await assert.rejects(preflightExport(r),/whole-export/);}finally{await rm(r,{recursive:true});} });
test('wrong release and schema fail', async()=>{ const r=await copyFixture(); try{await mutateManifest(r,m=>m.taxonomy_schema_version=3); await assert.rejects(preflightExport(r),/schema versions/);}finally{await rm(r,{recursive:true});} });
test('invalid JSON reports filename and line', async()=>{ const r=await copyFixture(); try{await writeFile(path.join(r,'vernacular.jsonl'),'{bad}\n'); await buildFixtureManifest(r); await assert.rejects(preflightExport(r),/vernacular\.jsonl:1: invalid JSON/);}finally{await rm(r,{recursive:true});} });
test('wrong field type reports field', async()=>{ const r=await copyFixture(); try{const p=path.join(r,'taxon.jsonl'); await writeFile(p,(await readFile(p,'utf8')).replace('"taxon_id":1','"taxon_id":"1"')); await buildFixtureManifest(r); await assert.rejects(preflightExport(r),/invalid positiveInteger field taxon_id/);}finally{await rm(r,{recursive:true});} });
test('blank authoritative namespace fails', async()=>{ const r=await copyFixture(); try{const p=path.join(r,'taxon_external_id.jsonl'); await writeFile(p,(await readFile(p,'utf8')).replace('"namespace":"col_usage_id"','"namespace":""')); await buildFixtureManifest(r); await assert.rejects(preflightExport(r),/nonblankTrimmedString field namespace/);}finally{await rm(r,{recursive:true});} });
