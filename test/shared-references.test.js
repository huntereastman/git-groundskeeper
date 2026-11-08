import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeNodeProject, applyReclaimReport, scanReclaimRoots } from '../src/reclaim.js';
import { inspectIncomingSymlinks } from '../src/shared-references.js';

const inactive = async () => ({ ok: true, active: false, processes: [], error: null });
const options = { tool: 'node', minAgeMinutes: 0, activeProcessProbe: inactive };

test('a peer outside the cleanup root protects a normal Bridge/node_modules directory', async (t) => {
  const f = fixture(t);
  const link = path.join(f.peer, 'Bridge', 'node_modules');
  fs.symlinkSync(path.relative(path.dirname(link), f.target), link);
  const report = await scanReclaimRoots([f.project], options);
  assert.equal(report.summary.candidateCount, 0);
  assert.equal(report.projects[0].status, 'blocked');
  assert.match(report.projects[0].blockedReasons.join('\n'), /shared symlink target/);
  assert.equal(report.projects[0].targets[0].sharedReferences.references[0].path, link);
  const applied = await applyReclaimReport(report, { ...options, yes: true, explicitRoots: true });
  assert.equal(applied.summary.cleanedCount, 0);
  assert.equal(fs.readFileSync(path.join(link, 'keep.txt'), 'utf8'), 'shared dependency\n');
});

for (const kind of ['absolute', 'descendant', 'parent alias', 'chained', 'dangling descendant']) {
  test(`incoming ${kind} symlink blocks deletion`, async (t) => {
    const f = fixture(t);
    const link = path.join(f.peer, 'consumer');
    if (kind === 'absolute') fs.symlinkSync(f.target, link);
    if (kind === 'descendant') fs.symlinkSync(path.join(f.target, 'keep.txt'), link);
    if (kind === 'parent alias') fs.symlinkSync(path.dirname(f.target), link);
    if (kind === 'chained' || kind === 'dangling descendant') {
      // The intermediate link is outside the registered worktrees. The
      // surviving peer's link must resolve through it, even if its leaf is gone.
      const intermediate = path.join(f.parent, 'intermediate');
      fs.symlinkSync(f.target, intermediate);
      fs.symlinkSync(kind === 'chained' ? intermediate : path.join(intermediate, 'not-created-yet'), link);
    }
    const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
    assert.equal(check.safe, false);
    assert.equal(check.errors.length, 0);
    assert.equal(check.references[0].path, link);
  });
}

test('same-worktree retained output also protects a shared cache', async (t) => {
  const f = fixture(t);
  const link = path.join(f.selected, 'saved-release-dependencies');
  fs.symlinkSync('Bridge/node_modules', link);
  const report = await analyzeNodeProject(f.project, options);
  assert.equal(report.status, 'blocked');
  assert.equal(report.targets[0].sharedReferences.references[0].path, link);
});

test('a chain passing through the cache stays protected even when its final destination is elsewhere', async (t) => {
  const f = fixture(t);
  const source = path.join(f.parent, 'retained-package-source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.js'), 'export {};\n');
  fs.symlinkSync(source, path.join(f.target, 'workspace-package'));
  const link = path.join(f.peer, 'consumer');
  fs.symlinkSync(path.join(f.target, 'workspace-package', 'index.js'), link);
  const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
  assert.equal(check.safe, false);
  assert.equal(check.references[0].path, link);
  assert.equal(check.references[0].destination, path.join(source, 'index.js'));
  assert.equal(check.references[0].throughTarget, true);
});

test('internal package links and unrelated prefix names do not block an exclusive cache', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.target, '.bin'));
  fs.symlinkSync('../keep.txt', path.join(f.target, '.bin', 'command'));
  fs.symlinkSync('cycle', path.join(f.target, 'cycle'));
  fs.mkdirSync(`${f.target}-other`);
  fs.symlinkSync(`${f.target}-other`, path.join(f.peer, 'unrelated'));
  const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
  assert.equal(check.safe, true);
  assert.equal(check.complete, true);
  const report = await scanReclaimRoots([f.project], options);
  const result = await applyReclaimReport(report, { ...options, yes: true, explicitRoots: true });
  assert.equal(result.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(`${f.target}-other`), true);
});

test('an incoming alias added after planning is detected during apply', async (t) => {
  const f = fixture(t);
  const plan = await scanReclaimRoots([f.project], options);
  assert.equal(plan.summary.candidateCount, 1);
  fs.symlinkSync(f.target, path.join(f.peer, 'Bridge', 'node_modules'));
  const result = await applyReclaimReport(plan, { ...options, yes: true, explicitRoots: true });
  assert.equal(result.summary.blockedCount, 1);
  assert.match(result.projects[0].blockedReasons.join('\n'), /apply recheck failed.*|shared symlink target/);
  assert.equal(fs.existsSync(f.target), true);
});

test('apply preserves additional reference scope from the saved plan', async (t) => {
  const f = fixture(t);
  const retained = path.join(f.parent, 'external-retained-output');
  fs.mkdirSync(retained);
  const plan = await scanReclaimRoots([f.project], { ...options, referenceRoots: [retained] });
  assert.equal(plan.summary.candidateCount, 1);
  const link = path.join(retained, 'dependencies');
  fs.symlinkSync(f.target, link);
  // A separately applied receipt must not silently narrow the original scope.
  const result = await applyReclaimReport(JSON.parse(JSON.stringify(plan)), {
    ...options, yes: true, explicitRoots: true,
  });
  assert.equal(result.summary.blockedCount, 1);
  assert.match(result.projects[0].blockedReasons.join('\n'), /external-retained-output/);
  assert.equal(fs.existsSync(path.join(link, 'keep.txt')), true);
});

test('an alias introduced after provider revalidation is blocked before unlink', async (t) => {
  const f = fixture(t);
  const plan = await scanReclaimRoots([f.project], options);
  let inserted = false;
  const result = await applyReclaimReport(plan, {
    ...options, yes: true, explicitRoots: true,
    activeProcessProbe: async () => {
      // Provider activity inspection runs after its target inspection. This
      // exercises the deletion-boundary check, independently of reanalysis.
      fs.symlinkSync(f.target, path.join(f.peer, 'Bridge', 'node_modules'));
      inserted = true;
      return inactive();
    },
    removeTarget: async () => assert.fail('shared target reached the unlink adapter'),
  });
  assert.equal(inserted, true);
  assert.equal(result.projects[0].status, 'blocked');
  assert.equal(result.projects[0].verifiedTargetBytesRemoved, 0);
  assert.equal(fs.existsSync(f.target), true);
});

test('entry and time limits fail closed rather than authorizing deletion', async (t) => {
  const f = fixture(t);
  for (const limit of [{ referenceMaxEntries: 0 }, { referenceTimeoutMs: 0 }]) {
    const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo], ...limit });
    assert.equal(check.safe, false);
    assert.equal(check.complete, false);
    assert.match(check.errors.join('\n'), /limit exceeded/);
  }
});

test('project discovery depth does not truncate incoming-reference inspection', async (t) => {
  const f = fixture(t);
  const retained = path.join(f.peer, ...Array.from({ length: 12 }, (_, i) => `level-${i}`));
  fs.mkdirSync(retained, { recursive: true });
  fs.symlinkSync(f.target, path.join(retained, 'saved-dependencies'));
  const report = await scanReclaimRoots([f.project], { ...options, maxDepth: 0 });
  assert.equal(report.summary.candidateCount, 0);
  assert.match(report.projects[0].blockedReasons.join('\n'), /saved-dependencies/);
});

test('a broken repository in the reference scope blocks deletion', async (t) => {
  const f = fixture(t);
  const broken = path.join(f.peer, 'broken-repository');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: missing-git-metadata\n');
  const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
  assert.equal(check.safe, false);
  assert.match(check.errors.join('\n'), /cannot enumerate registered worktrees/);
});

test('unresolvable external links and unavailable scope fail closed', async (t) => {
  const f = fixture(t);
  const missing = await inspectIncomingSymlinks(f.target, {
    gitRoots: [f.repo], referenceRoots: [path.join(f.parent, 'missing-scope')],
  });
  assert.equal(missing.safe, false);
  assert.match(missing.errors.join('\n'), /cannot inspect reference root/);
  fs.symlinkSync('loop', path.join(f.peer, 'loop'));
  const loop = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
  assert.equal(loop.safe, false);
  assert.equal(loop.complete, false);
  assert.match(loop.errors.join('\n'), /ELOOP|chain/);
});

test('unreadable retained directories block a negative reference claim', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions');
  const f = fixture(t);
  const inaccessible = path.join(f.peer, 'private-output');
  fs.mkdirSync(inaccessible);
  // Restore permission before the fixture's cleanup hook runs.
  try {
    fs.chmodSync(inaccessible, 0);
    const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
    assert.equal(check.safe, false);
    assert.match(check.errors.join('\n'), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(inaccessible, 0o700);
  }
});

test('an explicit broader root expands other repositories and their outside peers', async (t) => {
  const f = fixture(t);
  const other = path.join(f.parent, 'other-repo');
  fs.mkdirSync(other);
  git(other, ['init', '-b', 'main']);
  git(other, ['config', 'user.email', 'fixture@example.com']);
  git(other, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(other, 'README.md'), 'other\n');
  git(other, ['add', 'README.md']);
  git(other, ['commit', '-m', 'other']);
  const outside = path.join(f.parent, 'outside-other');
  git(other, ['worktree', 'add', '-b', 'consumer', outside]);
  const link = path.join(outside, 'shared-sdk');
  fs.symlinkSync(f.target, link);
  const check = await inspectIncomingSymlinks(f.target, {
    gitRoots: [f.repo], referenceRoots: [other],
  });
  assert.equal(check.safe, false);
  assert.equal(check.references[0].path, link);
});

test('NUL-delimited registrations preserve whitespace and Unicode paths', async (t) => {
  const f = fixture(t, { peerName: 'peer space\n日本語' });
  const link = path.join(f.peer, 'Bridge', 'node_modules');
  fs.symlinkSync(f.target, link);
  const check = await inspectIncomingSymlinks(f.target, { gitRoots: [f.repo] });
  assert.equal(check.safe, false);
  assert.equal(check.references[0].path, link);
});

test('the CLI refuses shared cleanup with a nonzero exit and leaves both ends usable', (t) => {
  const f = fixture(t);
  const link = path.join(f.peer, 'Bridge', 'node_modules');
  fs.symlinkSync(f.target, link);
  const result = spawnSync(process.execPath, [
    path.resolve('bin/git-groundskeeper.js'), 'reclaim', f.project,
    '--tool', 'node', '--min-age-minutes', '0', '--apply', '--yes', '--json', '--no-progress',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.cleanedCount, 0);
  assert.equal(report.summary.blockedCount, 1);
  assert.match(report.projects[0].blockedReasons.join('\n'), /shared symlink target/);
  assert.equal(fs.readFileSync(path.join(link, 'keep.txt'), 'utf8'), 'shared dependency\n');
});

function fixture(t, { peerName = 'peer' } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-shared-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(path.join(repo, 'Bridge'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(repo, 'Bridge', 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'Bridge/node_modules/\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  const selected = path.join(parent, 'selected');
  const peer = path.join(parent, 'outside-requested-root', peerName);
  git(repo, ['worktree', 'add', '-b', 'selected', selected]);
  git(repo, ['worktree', 'add', '-b', 'peer', peer]);
  const project = path.join(selected, 'Bridge');
  const target = path.join(project, 'node_modules');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'shared dependency\n');
  return { parent, repo, selected, peer, project, target };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
