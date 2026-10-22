import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { verifyRepository } from '../src/verify.js';

const bin = path.resolve('bin/git-groundskeeper.js');

test('verify compares registered exact tips to live default without changing repository state', async (t) => {
  const { repo, remote, root } = fixture(t);
  const integrated = path.join(root, 'integrated with spaces');
  const unfinished = path.join(root, 'unfinished');
  git(repo, ['worktree', 'add', '--detach', integrated, 'HEAD']);
  git(repo, ['worktree', 'add', '-b', 'unfinished', unfinished, 'HEAD']);
  fs.writeFileSync(path.join(unfinished, 'feature.txt'), 'keep this work\n');
  git(unfinished, ['add', 'feature.txt']);
  git(unfinished, ['commit', '-m', 'unfinished feature']);
  fs.writeFileSync(path.join(integrated, 'local-only.txt'), 'keep this file\n');
  const before = snapshot(repo);
  const remoteBefore = snapshot(remote, true);

  const report = await verifyRepository(unfinished);
  const result = report.repos[0];
  assert.equal(report.kind, 'default-branch-verification');
  assert.equal(result.primaryPath, repo);
  assert.equal(result.defaultBranchRef, 'origin/trunk');
  assert.equal(result.defaultBranchHead, git(remote, ['rev-parse', 'HEAD']).trim());
  assert.equal(result.defaultBranchStatus, 'checked');
  assert.ok(Number.isFinite(Date.parse(result.defaultBranchCheckedAt)));
  assert.equal(result.worktrees.find((w) => w.path === integrated).defaultBranchContainment, 'contained');
  assert.equal(result.worktrees.find((w) => w.path === unfinished).defaultBranchContainment, 'not-contained');
  assert.ok(result.worktrees.every((w) => !('tier' in w) && !('dirty' in w)));
  assert.deepEqual(snapshot(repo), before);
  assert.deepEqual(snapshot(remote, true), remoteBefore);
  assert.equal(fs.readFileSync(path.join(integrated, 'local-only.txt'), 'utf8'), 'keep this file\n');
});

test('verify CLI emits usable JSON for unavailable live evidence without owner detection', (t) => {
  const { repo } = fixture(t);
  git(repo, ['remote', 'remove', 'origin']);
  const result = cli(['verify', repo, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repos[0].defaultBranchStatus, 'unavailable');
  assert.equal(report.repos[0].defaultBranchError.code, 'missing-origin');
  assert.equal(report.repos[0].worktrees[0].defaultBranchContainment, 'unknown');
  assert.equal(report.provenance.name, 'git-groundskeeper');
  assert.equal(result.stderr, '');
});

test('verify requires one explicit repository and rejects mutations or disabled live checks', (t) => {
  const { repo } = fixture(t);
  for (const args of [
    ['verify'], ['verify', repo, repo], ['verify', repo, '--apply', '--yes'],
    ['verify', repo, '--retain-branch'], ['verify', repo, '--no-live-remote-check'],
  ]) {
    const result = cli(args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
  }
  const help = cli(['verify', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /without fetching, changing refs/);
});

test('verify bounds concurrent comparisons, preserves row order and caches duplicate exact heads', async (t) => {
  const { repo, root } = fixture(t);
  const heads = [1, 2, 1, 3, 4, 5, 3, 6].map((value) => value.toString(16).repeat(40));
  const paths = heads.map((_, index) => path.join(root, `synthetic-${index}`));
  let active = 0;
  let maximum = 0;
  const calls = new Map();
  const report = await verifyRepository(repo, {
    concurrency: 2,
    runGit: async (_cwd, args) => ({
      ok: true, stderr: '',
      stdout: args[0] === 'worktree'
        ? heads.map((head, index) => `worktree ${paths[index]}\0HEAD ${head}\0detached\0\0`).join('')
        : 'https://example.invalid/owner/repo.git\n',
    }),
    inspectPrimaryBranch: async () => ({ status: 'checked', branch: 'main', ref: 'origin/main', head: heads[0] }),
    inspectContainment: async (_cwd, head) => {
      calls.set(head, (calls.get(head) ?? 0) + 1);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { containment: 'contained', error: null };
    },
  });
  assert.equal(maximum, 2, 'the configured lower concurrency must be honored');
  assert.equal(calls.size, new Set(heads).size);
  assert.ok([...calls.values()].every((count) => count === 1));
  assert.deepEqual(report.repos[0].worktrees.map((worktree) => worktree.path), paths);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-verify-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(root, ['init', '--bare', '--initial-branch=trunk', remote]);
  git(repo, ['init', '--initial-branch=trunk']);
  git(repo, ['config', 'user.name', 'Verification fixture']);
  git(repo, ['config', 'user.email', 'verification@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'trunk']);
  return { root, repo, remote };
}

function snapshot(repo, bare = false) {
  const gitDir = bare ? repo : path.join(repo, '.git');
  return {
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    files: Object.fromEntries(['HEAD', 'config', 'index', 'FETCH_HEAD', 'shallow'].map((name) => {
      const file = path.join(gitDir, name);
      return [name, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null];
    })),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cli(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}
