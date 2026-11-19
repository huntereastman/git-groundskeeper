import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGeneratedArtifactClassifier } from '../src/generated-artifacts.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-artifacts-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  const put = (name, contents, tracked = false) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    if (tracked) git('add', '--', name);
  };
  const fresh = contracts => createGeneratedArtifactClassifier(root, contracts);
  return { root, put, fresh };
}

const digest = (value, type = 'sha256') => createHash(type).update(value).digest('hex');

test('configured Vite cache accepts only optimizer members and maps', t => {
  const {root, put, fresh} = fixture(t);
  put('ui/package.json', JSON.stringify({devDependencies: {vite: '1'}}), true);
  put('ui/vite.custom.config.ts', 'export default {\n  cacheDir: ".cache/optimizer",\n};', true);
  const dirs = 'ui/.cache/optimizer/deps/';
  const metadata = {
    hash: '12345678', configHash: '23456789', lockfileHash: 'aaaabbbb',
    optimized: { pkg: {file: 'pkg.js'} }, chunks: {},
  };
  put(dirs + '_metadata.json', JSON.stringify(metadata));
  put(dirs + 'package.json', '{"type":"module"}');
  put(dirs + 'pkg.js', 'export {};');
  put(dirs + 'pkg.js.map', '{"version":3,"file":"pkg.js"}');
  put(dirs + 'auth.js', 'personal');
  let classify = fresh();
  for (const name of ['pkg.js','pkg.js.map','_metadata.json','package.json']) assert.ok(classify(dirs + name), name);
  assert.equal(classify(dirs + 'auth.js'), false);
  assert.equal(classify('unconfigured/deps/pkg.js'), false);
  put(dirs + 'pkg.js.map', 'unrelated');
  assert.equal(fresh()(dirs + 'pkg.js.map'), false);
  put(dirs + '_metadata.json', '{');
  classify = fresh();
  assert.equal(classify(dirs + 'pkg.js'), false);
  assert.equal(classify(dirs + 'package.json'), false);
  fs.rmSync(path.join(root, 'ui/vite.custom.config.ts'));
  put(dirs + '_metadata.json', JSON.stringify(metadata));
  assert.equal(fresh()(dirs + 'pkg.js'), false);
});

test('Godot cache and receipt require the matching project, original and import bytes', t => {
  const {root, put, fresh} = fixture(t);
  const project = 'game/', uri = 'res://assets/image.png';
  const stem = '.godot/imported/image.png-' + digest(uri, 'md5');
  const target = stem + '.ctex';
  put(project + 'project.godot', 'config_version=5', true);
  put(project + 'assets/image.png', 'original');
  put(project + 'assets/image.png.import', '[remap]\npath="res://' + target + '"\n[deps]\nsource_file="' + uri + '"\n');
  put(project + '.godot/editor/filesystem_cache8', '::res://assets/::123\nimage.png::CompressedTexture2D::123\n');
  put(project + target, 'imported');
  put(project + stem + '.md5', 'source_md5="' + digest('original', 'md5') + '"\ndest_md5="' + digest('imported', 'md5') + '"\n');
  const classify = fresh();
  assert.ok(classify(project + target));
  assert.ok(classify(project + stem + '.md5'));
  assert.equal(classify(project + stem + '.notes'), false);
  put(project + target, 'hand changed');
  assert.equal(fresh()(project + target), false);
  put(project + target, 'imported');
  fs.rmSync(path.join(root, project, 'assets/image.png'));
  assert.equal(fresh()(project + stem + '.md5'), false);
});

test('Astro requires its package dependency, generated filename and content signature', t => {
  const {put, fresh} = fixture(t);
  put('site/package.json', '{"dependencies":{"astro":"1"}}', true);
  put('site/.astro/content-assets.mjs', 'export default new Map();');
  put('site/.astro/types.d.ts', '/// <reference types="astro/client" />');
  put('site/.astro/content.d.ts', 'export type HumanAuthored = string;');
  put('site/.astro/notes.mjs', 'export default new Map();');
  const classify = fresh();
  assert.ok(classify('site/.astro/types.d.ts'));
  assert.ok(classify('site/.astro/content-assets.mjs'));
  assert.equal(classify('site/.astro/content.d.ts'), false);
  assert.equal(classify('site/.astro/notes.mjs'), false);
  put('site/package.json', '{}');
  assert.equal(fresh()('site/.astro/types.d.ts'), false);
});

test('staged JavaScript needs a tracked build recipe and identical tracked source', t => {
  const {root, put, fresh} = fixture(t);
  put('pkg/package.json', '{"scripts":{"stage":"node scripts/build.cjs"}}', true);
  put('pkg/scripts/build.cjs', "const root = path.resolve(__dirname, '..');\nfs.copyFileSync(path.join(root, '../src/data.js'), path.join(root, 'lib/data.js'));", true);
  put('src/data.js', 'data', true);
  put('pkg/lib/data.js', 'data');
  put('pkg/lib/other.js', 'data');
  assert.ok(fresh()('pkg/lib/data.js'));
  assert.equal(fresh()('pkg/lib/other.js'), false);
  put('pkg/lib/data.js', 'extra');
  assert.equal(fresh()('pkg/lib/data.js'), false);
  fs.rmSync(path.join(root, 'src/data.js'));
  put('pkg/lib/data.js', 'data');
  assert.equal(fresh()('pkg/lib/data.js'), false);
});

test('build-shipped contract keeps changed, missing, symlinked and untracked inputs visible', t => {
  const {root, put, fresh} = fixture(t);
  const name = 'assets/rendered.bin';
  const contract = [{inputs: {'tools/render': digest('script'), 'src/input': digest('source')}, outputs: {[name]: digest('result')}}];
  put('tools/render', 'script', true);
  put('src/input', 'source', true);
  put(name, 'result');
  let classify = fresh(contract);
  assert.ok(classify(name));
  assert.equal(classify('assets/other.bin'), false);
  put(name, 'changed');
  assert.equal(fresh(contract)(name), false);
  put(name, 'result');
  put('src/input', 'updated');
  assert.equal(fresh(contract)(name), false);
  fs.rmSync(path.join(root, 'src/input'));
  assert.equal(fresh(contract)(name), false);
  put('src/alternate', 'source');
  fs.symlinkSync('alternate', path.join(root, 'src/input'));
  assert.equal(fresh(contract)(name), false);
  const untracked = [{inputs: {'src/alternate': digest('source')}, outputs: {[name]: digest('result')}}];
  assert.equal(fresh(untracked)(name), false);
  classify = createGeneratedArtifactClassifier(path.join(root, 'missing'), contract);
  assert.equal(classify(name), false);
  assert.equal(classify('../assets/rendered.bin'), false);
});
