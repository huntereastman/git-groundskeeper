import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverWorktrees,
  discoverWorktreesAsync,
  scanRoots,
} from '../src/scanner.js';

test('filesystem-root discovery prefers the public path for a physical subtree alias', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-firmlink-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const publicUsers = path.join(root, 'Users');
  const aliasedUsers = path.join(root, 'System', 'Volumes', 'Data', 'Users');
  const publicRepo = path.join(publicUsers, 'hunter', 'project');
  const aliasedRepo = path.join(aliasedUsers, 'hunter', 'project');
  createRepository(publicRepo);
  createRepository(aliasedRepo);

  const directoryIdentity = (candidatePath) => {
    if (candidatePath === publicUsers || candidatePath === aliasedUsers) return 'same-users-directory';
    return `path:${candidatePath}`;
  };

  const synchronous = discoverWorktrees([root], { maxDepth: 8, directoryIdentity });
  const cooperative = await discoverWorktreesAsync([root], {
    maxDepth: 8,
    directoryIdentity,
    discoveryYieldEvery: 1,
  });

  for (const found of [synchronous, cooperative]) {
    assert.deepEqual(found, [publicRepo]);
  }
});

test('registered Git paths win when a linked checkout has a second physical spelling', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-linked-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repository = path.join(root, 'repository');
  const physicalAlias = path.join(root, 'System', 'Volumes', 'Data', 'repository');
  createRepository(repository, { commit: true });
  fs.mkdirSync(physicalAlias, { recursive: true });

  const directoryIdentity = (candidatePath) => {
    if (candidatePath === repository || candidatePath === physicalAlias) return 'same-checkout';
    return `path:${candidatePath}`;
  };

  const report = await scanRoots([repository], {
    maxDepth: 1,
    directoryIdentity,
    listLinkedWorktreePaths: async () => [repository, physicalAlias],
    prCheck: false,
    liveRemoteCheck: false,
    squashDetect: false,
  });

  assert.equal(report.repos.length, 1);
  assert.equal(report.repos[0].primaryPath, repository);
  assert.deepEqual(report.repos[0].worktrees.map((worktree) => worktree.path), [repository]);
});

test('discovery prunes SourcePackages under custom-named build roots', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-source-packages-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const project = path.join(root, 'Development', 'project');
  const dependency = path.join(
    root,
    'private',
    'tmp',
    'agent-maxer-release-derived',
    'SourcePackages',
    'checkouts',
    'dependency',
  );
  createRepository(project);
  createRepository(dependency);

  const synchronous = discoverWorktrees([root], { maxDepth: 8 });
  const cooperative = await discoverWorktreesAsync([root], {
    maxDepth: 8,
    discoveryYieldEvery: 1,
  });

  for (const found of [synchronous, cooperative]) {
    assert.equal(found.includes(project), true);
    assert.equal(found.includes(dependency), false);
  }
});

test('discovery prunes Gemini history snapshots without hiding other Gemini repositories', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-gemini-history-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const history = path.join(root, '.gemini', 'history', 'snapshot');
  const project = path.join(root, '.gemini', 'projects', 'active');
  createRepository(history);
  createRepository(project);

  const synchronous = discoverWorktrees([root], { maxDepth: 6 });
  const cooperative = await discoverWorktreesAsync([root], {
    maxDepth: 6,
    discoveryYieldEvery: 1,
  });

  for (const found of [synchronous, cooperative]) {
    assert.equal(found.includes(history), false);
    assert.equal(found.includes(project), true);
  }
});

function createRepository(repository, options = {}) {
  fs.mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  if (!options.commit) return;

  fs.writeFileSync(path.join(repository, 'README.md'), 'fixture\n');
  execFileSync('git', ['-C', repository, 'add', 'README.md']);
  execFileSync('git', [
    '-C', repository,
    '-c', 'user.name=Groundskeeper Tests',
    '-c', 'user.email=tests@example.com',
    'commit', '-q', '-m', 'initial',
  ]);
}
