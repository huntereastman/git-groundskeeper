import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { classifyOwnership, defaultRoots, discoverWorktrees, parseRemoteOwner, scanRoots } from '../src/scanner.js';

test('scanRoots reports dirty worktrees and branches without upstream', async () => {
  const fixture = createFixture();

  git(fixture.repo, ['checkout', '-b', 'feature/no-upstream']);
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(fixture.repo, ['add', 'feature.txt']);
  git(fixture.repo, ['commit', '-m', 'add feature']);
  fs.writeFileSync(path.join(fixture.repo, 'dirty.txt'), 'dirty\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.status, 'commit-needed');
  assert.equal(repo.worktrees.some((worktree) => worktree.dirty), true);
  assert.equal(repo.branches.some((branch) => branch.name === 'feature/no-upstream' && branch.upstreamStatus === 'none'), true);
});

test('scanRoots reports branch ahead of upstream even when worktree is clean', async () => {
  const fixture = createFixture();

  fs.writeFileSync(path.join(fixture.repo, 'ahead.txt'), 'ahead\n');
  git(fixture.repo, ['add', 'ahead.txt']);
  git(fixture.repo, ['commit', '-m', 'ahead local']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const main = repo.branches.find((branch) => branch.name === 'main');

  assert.equal(repo.status, 'push-needed');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
});

test('scanRoots follows linked worktrees from a discovered repo', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'linked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/linked', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');

  const report = await scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));

  assert.ok(repo);
  assert.equal(repo.primaryPath, fixture.repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === linked && worktree.dirty), true);
});

test('scanRoots marks clean gone-upstream worktrees as prune candidates when merged', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'merged-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/merged', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'merged.txt'), 'merged\n');
  git(linked, ['add', 'merged.txt']);
  git(linked, ['commit', '-m', 'merged feature']);
  git(fixture.repo, ['merge', '--ff-only', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(linked, ['push', 'origin', 'feature/merged']);
  git(linked, ['branch', '--set-upstream-to=origin/feature/merged', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/merged']);
  git(linked, ['fetch', '--prune', 'origin']);

  const report = await scanRoots([linked], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/merged');

  assert.equal(worktree.upstreamStatus, 'gone');
  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedInto, 'origin/main');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
});

test('scanRoots reports nested submodule folders instead of Git storage paths', async () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'linked-with-submodule');
  const nestedAdmin = path.join(linked, 'admin');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/submodule', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = await scanRoots([linked], { maxDepth: 2 });
  const primaryPaths = report.repos.map((repo) => repo.primaryPath);
  const nestedRepo = report.repos.find((repo) => repo.primaryPath === nestedAdmin);

  assert.equal(primaryPaths.some((primaryPath) => primaryPath.includes(`${path.sep}.git${path.sep}`)), false);
  assert.ok(nestedRepo, primaryPaths.join('\n'));
  assert.equal(nestedRepo.worktrees.some((worktree) => worktree.path === nestedAdmin), true);
});

test('defaultRoots discovers from the home directory so no layout knowledge is needed', async () => {
  assert.deepEqual(defaultRoots(), [os.homedir()]);
});

test('discoverWorktrees prunes home-level noise but keeps real project roots', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-noise-')));
  const cachedRepo = path.join(parent, 'Library', 'Caches', 'vendor');
  const projectRepo = path.join(parent, 'code', 'app');

  fs.mkdirSync(path.dirname(cachedRepo), { recursive: true });
  fs.mkdirSync(path.dirname(projectRepo), { recursive: true });
  createStandaloneRepo(cachedRepo);
  createStandaloneRepo(projectRepo);

  const found = discoverWorktrees([parent], { maxDepth: 6 });

  assert.equal(found.includes(projectRepo), true);
  assert.equal(found.includes(cachedRepo), false);
});

test('scanRoots attributes agent worktrees in hidden home directories to their repo', async () => {
  const fixture = createFixture();
  const agentWorktree = path.join(fixture.parent, '.codex', 'worktrees', '2e34', 'app');

  fs.mkdirSync(path.dirname(agentWorktree), { recursive: true });
  git(fixture.repo, ['worktree', 'add', '-b', 'agent/task', agentWorktree]);

  const report = await scanRoots([fixture.parent], { maxDepth: 6 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === agentWorktree), true);
});

test('large files hidden inside untracked directories are still weighed', async () => {
  const fixture = createFixture();
  const buildDir = path.join(fixture.repo, 'build-output');

  fs.mkdirSync(buildDir);
  fs.writeFileSync(path.join(buildDir, 'artifact.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(buildDir, 'small.txt'), 'small\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === fixture.repo);

  // The default sweep never looks inside untracked directories, so finding this
  // proves the deep second pass ran for a worktree that needed it.
  assert.equal(worktree.largeFiles.some((file) => file.path === 'build-output/artifact.bin'), true);
  // ...and the summary still reports one untracked directory, not its contents.
  assert.equal(worktree.status.untracked, 1);
});

test('parseRemoteOwner handles every remote URL shape', async () => {
  assert.equal(parseRemoteOwner('git@github.com:huntereastman/git-groundskeeper.git'), 'huntereastman');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus.git'), 'numbus-llc');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus'), 'numbus-llc');
  assert.equal(parseRemoteOwner('ssh://git@gitlab.com/group/thing.git'), 'group');
  assert.equal(parseRemoteOwner('https://user@dev.azure.com/org/project'), 'org');
  // Local path remotes have no owner, and must not be mistaken for one.
  assert.equal(parseRemoteOwner('/tmp/fixtures/remote.git'), null);
  assert.equal(parseRemoteOwner('../sibling/remote.git'), null);
});

test('classifyOwnership separates my repos from everything else on the disk', async () => {
  assert.equal(classifyOwnership(['huntereastman'], ['huntereastman', 'numbus-llc']), 'mine');
  // Owner matching is case-insensitive: Git remotes are not consistent here.
  assert.equal(classifyOwnership(['NumBus-LLC'], ['numbus-llc']), 'mine');
  assert.equal(classifyOwnership(['some-vendor'], ['huntereastman']), 'external');
  assert.equal(classifyOwnership([], ['huntereastman']), 'no-remote');
  // With no owners declared the tool must not guess, or it would silently
  // hide repositories it merely failed to recognise.
  assert.equal(classifyOwnership(['huntereastman'], []), 'unknown');
});

test('scanRoots tags repo ownership from its remote', async () => {
  const fixture = createFixture();
  git(fixture.repo, ['remote', 'set-url', 'origin', 'https://github.com/huntereastman/app.git']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, owners: ['huntereastman'] });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.deepEqual(repo.owners, ['huntereastman']);
  assert.equal(repo.ownership, 'mine');
});

function createFixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-')));
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');

  createStandaloneRepo(repo);

  git(parent, ['clone', '--bare', repo, remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);

  return { parent, repo, remote };
}

function createStandaloneRepo(repo) {
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
