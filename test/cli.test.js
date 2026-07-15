import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';

const binPath = path.resolve('bin/git-groundskeeper.js');

test('scan exits 0 when attention is found by default', () => {
  const repo = createDirtyRepo();
  const result = runCli(['scan', repo]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
  assert.match(result.stdout, /Worktree summaries \(1 needing attention \/ 1 in scope\)/);
  assert.match(result.stdout, /\| Field\s+\| Value/);
});

test('scan exits 1 for attention when fail-on-attention is requested', () => {
  const repo = createDirtyRepo();
  const result = runCli(['scan', repo, '--fail-on-attention']);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Worktree summaries \(1 needing attention \/ 1 in scope\)/);
});

function createDirtyRepo() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-cli-')));
  const repo = path.join(parent, 'repo');

  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');

  return repo;
}

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
