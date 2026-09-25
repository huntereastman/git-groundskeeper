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
  assert.equal(report.ignoredContent.inspectionStatus, 'complete');
  assert.deepEqual(report.ignoredContent.reviewRequired, []);
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(fixture.linked), true);
  assert.match(formatRetireText(report), /Ignored-content inspection: complete/);
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

test('dirty retirement receipt inspects and names unique ignored exports', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, '.gitignore'), 'exportedData/\n');
  git(fixture.linked, ['add', '.gitignore']);
  git(fixture.linked, ['commit', '-m', 'ignore local exports']);
  git(fixture.linked, ['push']);
  fs.writeFileSync(path.join(fixture.linked, 'README.md'), '# dirty fixture\n');
  const exportPath = path.join(fixture.linked, 'exportedData', 'auth_export', 'accounts.json');
  fs.mkdirSync(path.dirname(exportPath), { recursive: true });
  fs.writeFileSync(exportPath, '{}\n');

  const inventory = await scanRoots([fixture.linked], { buckets: true });
  const inventoryWorktree = inventory.repos
    .flatMap((repo) => repo.worktrees)
    .find((worktree) => worktree.path === fixture.linked);
  assert.equal(inventoryWorktree.ignoredInspection, 'skipped-dirty');

  const report = await retireWorktree(fixture.linked, { inspectProcesses: noProcesses });
  assert.equal(report.status, 'blocked');
  assert.equal(report.ignoredContent.inspectionStatus, 'complete');
  assert.deepEqual(report.ignoredContent.reviewRequired, ['exportedData/auth_export/accounts.json']);
  assert.match(report.blockedReasons.join('\n'), /review-required ignored content exists/);
  assert.match(formatRetireText(report), /KEEP IGNORED: exportedData\/auth_export\/accounts\.json/);
  const withPolicy = {
    ...report,
    ignoredContent: {
      ...report.ignoredContent,
      policyClassified: [{ path: 'cache/', rule: 'cache/', reason: 'regenerable' }],
    },
  };
  assert.match(formatRetireText(withPolicy), /Policy-classified ignored content: 1 item/);
  assert.equal(fs.existsSync(exportPath), true);
});

test('ignored inspection failure is explicit in a dirty retirement receipt', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, 'README.md'), '# dirty fixture\n');

  const report = await retireWorktree(fixture.linked, {
    inspectProcesses: noProcesses,
    inspectPreciousIgnored: async () => ({
      precious: [],
      policyIgnored: [],
      errors: ['injected ignored-file failure'],
    }),
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.ignoredContent.inspectionStatus, 'failed');
  assert.deepEqual(report.ignoredContent.reviewRequired, []);
  assert.match(report.blockedReasons.join('\n'), /safety inspections failed/);
  assert.match(formatRetireText(report), /Ignored-content inspection: failed/);
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

test('an unpushed branch needs an exact local-only HEAD acknowledgement', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, 'archive.md'), 'local archival evidence\n');
  git(fixture.linked, ['add', 'archive.md']);
  git(fixture.linked, ['commit', '-m', 'archive local evidence']);
  const head = git(fixture.linked, ['rev-parse', 'HEAD']);

  const defaultPlan = await retireWorktree(fixture.linked, {
    retainBranch: true,
    inspectProcesses: noProcesses,
  });
  assert.equal(defaultPlan.tier, 'push-first');
  assert.equal(defaultPlan.status, 'blocked');
  assert.equal(defaultPlan.localOnlyBranch.accepted, false);
  assert.match(defaultPlan.blockedReasons.join('\n'), /accept-local-only-head/);

  const stalePlan = await retireWorktree(fixture.linked, {
    retainBranch: true,
    acceptLocalOnlyHead: fixture.head,
    inspectProcesses: noProcesses,
  });
  assert.equal(stalePlan.status, 'blocked');
  assert.equal(stalePlan.localOnlyBranch.accepted, false);
  assert.match(stalePlan.blockedReasons.join('\n'), /does not match the current full HEAD/);

  const acceptedPlan = await retireWorktree(fixture.linked, {
    retainBranch: true,
    acceptLocalOnlyHead: head,
    inspectProcesses: noProcesses,
  });
  assert.equal(acceptedPlan.status, 'planned');
  assert.equal(acceptedPlan.eligible, true);
  assert.equal(acceptedPlan.localOnlyBranch.remoteBackupVerified, false);
  assert.equal(acceptedPlan.localOnlyBranch.accepted, true);
  assert.match(formatRetireText(acceptedPlan), /losing the local repository can lose this commit/);
  assert.equal(fs.existsSync(fixture.linked), true);
});

test('local-only acknowledgement does not bypass review-required ignored content', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, '.gitignore'), 'ignored-notes.txt\n');
  fs.writeFileSync(path.join(fixture.linked, 'archive.md'), 'local archival evidence\n');
  git(fixture.linked, ['add', '.gitignore', 'archive.md']);
  git(fixture.linked, ['commit', '-m', 'archive local evidence']);
  const head = git(fixture.linked, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(fixture.linked, 'ignored-notes.txt'), 'separate work to review\n');

  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    acceptLocalOnlyHead: head,
    inspectProcesses: noProcesses,
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.ignoredContent.reviewRequired.length > 0, true);
  assert.equal(fs.existsSync(fixture.linked), true);
  assert.equal(fs.existsSync(path.join(fixture.linked, 'ignored-notes.txt')), true);
});

test('local-only opt-in retires only a clean checkout and retains the exact commit', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, 'archive.md'), 'local archival evidence\n');
  git(fixture.linked, ['add', 'archive.md']);
  git(fixture.linked, ['commit', '-m', 'archive local evidence']);
  const head = git(fixture.linked, ['rev-parse', 'HEAD']);

  const dirtyPath = path.join(fixture.linked, 'not-archived.md');
  fs.writeFileSync(dirtyPath, 'do not lose this\n');
  const blocked = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    acceptLocalOnlyHead: head,
    inspectProcesses: noProcesses,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(fs.existsSync(dirtyPath), true);

  fs.unlinkSync(dirtyPath);
  const removed = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    acceptLocalOnlyHead: head,
    inspectProcesses: noProcesses,
  });
  assert.equal(removed.status, 'removed');
  assert.equal(removed.localOnlyBranch.accepted, true);
  assert.equal(removed.verification.retainedRefExists, true);
  assert.equal(fs.existsSync(fixture.linked), false);
  assert.equal(git(fixture.repo, ['rev-parse', `refs/heads/${fixture.branch}`]), head);
  assert.equal(git(fixture.repo, ['show', `${head}:archive.md`]), 'local archival evidence');
});

test('local-only opt-in blocks if HEAD changes between plan and apply', async (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, 'archive.md'), 'local archival evidence\n');
  git(fixture.linked, ['add', 'archive.md']);
  git(fixture.linked, ['commit', '-m', 'archive local evidence']);
  const head = git(fixture.linked, ['rev-parse', 'HEAD']);
  let scans = 0;
  const changingScan = async (roots, options) => {
    const report = await scanRoots(roots, options);
    scans += 1;
    if (scans === 1) {
      fs.writeFileSync(path.join(fixture.linked, 'later.md'), 'later work\n');
      git(fixture.linked, ['add', 'later.md']);
      git(fixture.linked, ['commit', '-m', 'later work']);
    }
    return report;
  };

  const report = await retireWorktree(fixture.linked, {
    apply: true,
    yes: true,
    retainBranch: true,
    acceptLocalOnlyHead: head,
    inspectProcesses: noProcesses,
    scanRoots: changingScan,
  });
  assert.equal(report.status, 'blocked');
  assert.equal(fs.existsSync(fixture.linked), true);
  assert.equal(scans, 2);
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

test('local-only CLI flag requires a full HEAD and explicit branch retention', (t) => {
  const fixture = createFixture(t);
  const shortHead = spawnSync(process.execPath, [binPath, 'retire', fixture.linked, '--retain-branch', '--accept-local-only-head', fixture.head.slice(0, 12)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missingRetention = spawnSync(process.execPath, [binPath, 'retire', fixture.linked, '--accept-local-only-head', fixture.head], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wrongCommand = spawnSync(process.execPath, [binPath, 'scan', fixture.repo, '--accept-local-only-head', fixture.head], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.notEqual(shortHead.status, 0);
  assert.match(shortHead.stderr, /full 40- or 64-character HEAD/);
  assert.notEqual(missingRetention.status, 0);
  assert.match(missingRetention.stderr, /requires --retain-branch/);
  assert.notEqual(wrongCommand.status, 0);
  assert.match(wrongCommand.stderr, /only valid with retire/);
  assert.equal(fs.existsSync(fixture.linked), true);
});

test('local-only CLI apply retains the exact committed report on its branch', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.linked, 'report.md'), 'reviewed local report\n');
  git(fixture.linked, ['add', 'report.md']);
  git(fixture.linked, ['commit', '-m', 'archive report']);
  const head = git(fixture.linked, ['rev-parse', 'HEAD']);

  const result = spawnSync(process.execPath, [
    binPath,
    'retire',
    fixture.linked,
    '--retain-branch',
    `--accept-local-only-head=${head}`,
    '--apply',
    '--yes',
    '--json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'removed');
  assert.equal(report.localOnlyBranch.accepted, true);
  assert.equal(fs.existsSync(fixture.linked), false);
  assert.equal(git(fixture.repo, ['rev-parse', `refs/heads/${fixture.branch}`]), head);
  assert.equal(git(fixture.repo, ['show', `${head}:report.md`]), 'reviewed local report');
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
