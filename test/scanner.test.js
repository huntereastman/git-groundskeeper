import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { scanRoots } from '../src/scanner.js';

test('scanRoots reports dirty worktrees and branches without upstream', () => {
  const fixture = createFixture();

  git(fixture.repo, ['checkout', '-b', 'feature/no-upstream']);
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(fixture.repo, ['add', 'feature.txt']);
  git(fixture.repo, ['commit', '-m', 'add feature']);
  fs.writeFileSync(path.join(fixture.repo, 'dirty.txt'), 'dirty\n');

  const report = scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.status, 'commit-needed');
  assert.equal(repo.worktrees.some((worktree) => worktree.dirty), true);
  assert.equal(repo.branches.some((branch) => branch.name === 'feature/no-upstream' && branch.upstreamStatus === 'none'), true);
});

test('scanRoots reports branch ahead of upstream even when worktree is clean', () => {
  const fixture = createFixture();

  fs.writeFileSync(path.join(fixture.repo, 'ahead.txt'), 'ahead\n');
  git(fixture.repo, ['add', 'ahead.txt']);
  git(fixture.repo, ['commit', '-m', 'ahead local']);

  const report = scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const main = repo.branches.find((branch) => branch.name === 'main');

  assert.equal(repo.status, 'push-needed');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
});

test('scanRoots follows linked worktrees from a discovered repo', () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'linked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/linked', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');

  const report = scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));

  assert.ok(repo);
  assert.equal(repo.primaryPath, fixture.repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === linked && worktree.dirty), true);
});

test('scanRoots marks clean gone-upstream worktrees as prune candidates when merged', () => {
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

  const report = scanRoots([linked], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/merged');

  assert.equal(worktree.upstreamStatus, 'gone');
  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedInto, 'origin/main');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
});

test('scanRoots reports nested submodule folders instead of Git storage paths', () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'linked-with-submodule');
  const nestedAdmin = path.join(linked, 'admin');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/submodule', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = scanRoots([linked], { maxDepth: 2 });
  const primaryPaths = report.repos.map((repo) => repo.primaryPath);
  const nestedRepo = report.repos.find((repo) => repo.primaryPath === nestedAdmin);

  assert.equal(primaryPaths.some((primaryPath) => primaryPath.includes(`${path.sep}.git${path.sep}`)), false);
  assert.ok(nestedRepo, primaryPaths.join('\n'));
  assert.equal(nestedRepo.worktrees.some((worktree) => worktree.path === nestedAdmin), true);
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
