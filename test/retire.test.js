import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatRetireText, retireWorktree } from '../src/retire.js';
import { scanRoots } from '../src/scanner.js';

const binPath = path.resolve('bin/git-groundskeeper.js');
const noProcesses = async () => ({ ok: true, active: false, processes: [], error: null });

test('retire is read-only by default and emits a stable evidence receipt', async (t) => {
  const fixture = createFixture(t);
  const report = await retireWorktree(fixture.linked, { inspectProcesses: noProcesses });

  assert.equal(report.status, 'planned');
  assert.equal(report.eligible, true);
  assert.equal(report.apply, false);
  assert.equal(report.branchPolicy, 'retain');
  assert.equal(report.preservation.required, false);
  assert.equal(report.preservation.itemCount, 0);
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(fixture.linked), true);
  assert.match(formatRetireText(report), /no dirty tracked or untracked work detected/);
  assert.match(formatRetireText(report), /No changes made/);
});

test('dirty retirement inventories work and requires a verified archival commit without discarding files', async (t) => {
  const fixture = createFixture(t);
  const trackedPath = path.join(fixture.linked, 'README.md');
  const untrackedPath = path.join(fixture.linked, 'notes', 'recovered.md');
  fs.writeFileSync(trackedPath, '# changed fixture\n');
  fs.mkdirSync(path.dirname(untrackedPath));
  fs.writeFileSync(untrackedPath, 'keep this work\n');

  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    inspectProcesses: noProcesses,
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.preservation.required, true);
  assert.equal(report.preservation.inspectionComplete, true);
  assert.deepEqual(
    report.preservation.items.map((item) => item.path).sort(),
    ['README.md', 'notes/recovered.md'],
  );
  assert.match(report.blockedReasons.join('\n'), /verified archival commit/);
  const text = formatRetireText(report);
  assert.match(text, /Preservation: REQUIRED \(2 dirty items\)/);
  assert.match(text, /DIRTY:  M README\.md/);
  assert.match(text, /DIRTY: \?\? notes\/recovered\.md/);
  assert.match(text, /PROHIBITED: do not use restore, checkout --, clean, reset, force removal/);
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), '# changed fixture\n');
  assert.equal(fs.readFileSync(untrackedPath, 'utf8'), 'keep this work\n');
  assert.equal(fs.existsSync(fixture.linked), true);
});

test('retire apply revalidates, removes one checkout, and preserves its branch', async (t) => {
  const fixture = createFixture(t);
  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    inspectProcesses: noProcesses,
  });

  assert.equal(report.status, 'removed');
  assert.equal(report.verification.targetRemoved, true);
  assert.equal(report.verification.retainedRefExists, true);
  assert.equal(fs.existsSync(fixture.linked), false);
  assert.equal(git(fixture.repo, ['rev-parse', '--verify', `refs/heads/${fixture.branch}`]), fixture.head);
});

test('changed evidence between retire plan and apply leaves the checkout untouched', async (t) => {
  const fixture = createFixture(t);
  let scans = 0;
  const changingScan = async (roots, options) => {
    const report = await scanRoots(roots, options);
    scans += 1;
    if (scans === 1) fs.writeFileSync(path.join(fixture.linked, 'appeared-after-plan.txt'), 'keep\n');
    return report;
  };

  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    inspectProcesses: noProcesses,
    scanRoots: changingScan,
  });

  assert.equal(report.status, 'blocked');
  assert.match(report.blockedReasons.join('\n'), /evidence changed|dirty/);
  assert.equal(fs.existsSync(fixture.linked), true);
  assert.equal(git(fixture.linked, ['rev-parse', 'HEAD']), fixture.head);
});

test('active processes block retirement before any checkout change', async (t) => {
  const fixture = createFixture(t);
  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    inspectProcesses: async () => ({
      ok: true,
      active: true,
      processes: ['123 node test.js'],
      error: null,
    }),
  });

  assert.equal(report.status, 'blocked');
  assert.match(report.blockedReasons.join('\n'), /active processes/);
  assert.equal(fs.existsSync(fixture.linked), true);
});

test('retire CLI requires an exact target and explicit branch-retention apply policy', (t) => {
  const fixture = createFixture(t);
  const dryRun = spawnSync(process.execPath, [binPath, 'retire', fixture.linked, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missingPolicy = spawnSync(
    process.execPath,
    [binPath, 'retire', fixture.linked, '--apply', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  assert.equal(dryRun.status, 0);
  assert.equal(JSON.parse(dryRun.stdout).kind, 'worktree-retirement-receipt');
  assert.notEqual(missingPolicy.status, 0);
  assert.match(missingPolicy.stderr, /requires the explicit --retain-branch policy/);
  assert.equal(fs.existsSync(fixture.linked), true);
});

function createFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-retire-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');
  const linked = path.join(parent, 'linked');
  const branch = 'feature/retire-me';

  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  git(parent, ['clone', '--bare', repo, remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['worktree', 'add', '-b', branch, linked, 'main']);
  git(linked, ['push', '-u', 'origin', branch]);
  const head = git(linked, ['rev-parse', 'HEAD']);

  return { parent, repo, remote, linked, branch, head };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
