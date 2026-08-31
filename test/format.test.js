import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatScanText, terminalCellWidth } from '../src/format.js';

test('formatScanText defaults to compact actionable cleanup output', () => {
  const text = formatScanText(createReport());

  assert.match(text, /Git Groundskeeper Compact/);
  assert.match(text, /In scope: 3 worktrees, 3 need attention/);
  assert.match(text, /Worktree summaries \(3 needing attention \/ 3 in scope\)/);
  // One row per worktree, not a Field/Value block each: 92 worktrees of
  // vertical tables is about 1,100 lines of scroll.
  assert.match(text, /\| Worktree\s+\| Branch\s+\| Needs\s+\| Remote\s+\| Push\s+\| Unmerged\s+\| Age\s+\|/);
  assert.doesNotMatch(text, /\| Field\s+\| Value\s+\|/);
  assert.match(text, /\| app\s+\| main\s+\| commit, push, review large files\s+\| push \+2\s+\| 2\s+\| 2\s+\| 2h\s+\|/);
  assert.match(text, /\| app-admin\s+\| DETACHED\s+\| clean\s+\| .*main; local\)\s+\| -\s+\|/);
  // The Remote cell names how the merge was established, not just that it was:
  // "pr" is GitHub's answer, "squash" and "merged" are local inference.
  assert.match(text, /\| done-worktree\s+\| feature\/done\s+\| prune\s+\| .*origin\/main\)\s+\| 0\s+\| 0\s+\|/);
  assert.match(text, /Repository-level branch cleanup \(2\)/);
  assert.match(text, /feature\/local/);
  assert.match(text, /feature\/old/);
  assert.match(text, /Repository-level state \(1\)/);
  assert.match(text, /stash@\{0\}/);
});

test('formatScanText details output shows full repo details', () => {
  const report = createReport();
  report.repos[0].worktrees[0].policyIgnored = [
    { path: 'build/', rule: 'build/', reason: 'fixture build output' },
    { path: 'debug.log', rule: 'debug.log', reason: 'fixture debug log' },
  ];
  const text = formatScanText(report, { details: true });

  assert.match(text, /Git Groundskeeper/);
  assert.match(text, /! commit-needed \/workspace\/app/);
  assert.match(text, /worktree \/workspace\/app/);
  assert.match(text, /policy-ignored 2 items: build\//);
  assert.doesNotMatch(text, /Git Groundskeeper Compact/);
});

test('formatScanText colors key compact metrics when color is forced', () => {
  const text = formatScanText(createReport(), { color: 'always', tableWidth: 180 });

  assert.match(text, /\u001b\[/);
  assert.match(text, /\u001b\[31mcommit, push, review large files\u001b\[0m/);
  assert.match(text, /\u001b\[36mpush \+2\u001b\[0m/);
  assert.match(text, /\u001b\[32mkept \(main; local\)\u001b\[0m/);
});

test('long worktree and branch names keep the end, which is the part that differs', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;
  const prefix = '/workspace/Development/numbus/B2C/numbus-worktrees';

  worktrees[0].path = `${prefix}/cashflow-date-range-bar`;
  worktrees[0].branch = 'codex/cashflow-date-range-bar';
  worktrees[1].path = `${prefix}/cashflow-mobile-date-row`;
  worktrees[1].branch = 'codex/cashflow-mobile-date-row';

  const text = formatScanText(report, { all: true });

  // Clipping the end would render both rows as "Development/numbus/B2C/nu..."
  // and "codex/cashflow-da...", making them indistinguishable, which defeats
  // the point of listing them at all. The tail must survive in both columns.
  assert.match(text, /cashflow-date-range-bar\s+\|/);
  assert.match(text, /ashflow-mobile-date-row\s+\|/);
  assert.match(text, /\.\.\./);
  assert.doesNotMatch(text, /Development\/numbus\/B2C\/nu\.\.\./);
});

test('fetch staleness measures only the repos actually claiming merged', () => {
  const report = createReport();
  const [repo] = report.repos;
  const stale = new Date(Date.now() - 1475 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();

  repo.lastFetchAt = fresh;
  repo.worktrees[2].tier = 'worktree-and-branch';
  // A repo cloned once years ago and never fetched, with nothing to claim.
  report.repos.push({ ...repo, primaryPath: '/workspace/ancient', lastFetchAt: stale, worktrees: [], branches: [], stashes: [], nestedRepos: [] });

  const text = formatScanText(report, { buckets: true, all: true });

  // The ancient repo makes no remote claim, so it must not drag the warning.
  // Two days is not worth a line at all: a stamp on every run is the tool
  // narrating its own provenance at a reader who did not ask.
  assert.doesNotMatch(text, /1475/);
  assert.doesNotMatch(text, /local comparison data is/i);

  repo.lastFetchAt = stale;
  const staleText = formatScanText(report, { buckets: true, all: true });
  assert.match(staleText, /Oldest local comparison data is 1475 days old/);
  assert.match(staleText, /Candidate branch existence was checked live/);
});

test('bucket output separates default-branch containment from integration base', () => {
  const report = createReport();
  const [repo] = report.repos;
  const candidate = repo.worktrees[2];
  const branch = repo.branches.find((entry) => entry.name === candidate.branch);

  repo.repository = 'numbus-llc/numbus-flutter';
  repo.defaultBranch = 'master';
  repo.defaultBranchHead = '0123456789abcdef0123456789abcdef01234567';
  repo.defaultBranchStatus = 'checked';
  candidate.unmergedBase = 'origin/dev';
  candidate.unmergedBaseHead = 'abcdef0123456789abcdef0123456789abcdef0123';
  candidate.defaultBranchContainment = 'not-contained';
  branch.unmergedBase = candidate.unmergedBase;
  branch.unmergedBaseHead = candidate.unmergedBaseHead;
  branch.defaultBranchContainment = candidate.defaultBranchContainment;

  const text = formatScanText(report, { buckets: true, all: true, color: 'never', tableWidth: 180 });

  assert.match(text, /Repository integration evidence/);
  assert.match(text, /numbus-llc\/numbus-flutter/);
  assert.match(text, /origin\/dev/);
  assert.match(text, /abcdef012345/);
  assert.match(text, /master/);
  assert.match(text, /0123456789ab/);
  assert.match(text, /yes 0, no 1, \? 0/);
});

test('a wide terminal is spent on the columns that are still clipping', () => {
  const report = createReport();
  const long = '/workspace/Development/numbus/B2C/numbus-worktrees/a-very-long-worktree-name-here';
  report.repos[0].worktrees[0].path = long;

  const narrow = formatScanText(report, { tableWidth: 100, all: true });
  const wide = formatScanText(report, { tableWidth: 220, all: true });

  // Narrow has to clip. Wide has room to spare, so leaving the name cut short
  // with empty space beside it would be a choice, and the wrong one.
  assert.match(narrow, /\.\.\./);
  assert.match(wide, /Development\/numbus\/B2C\/numbus-worktrees\/a-very-long-worktree-name-here/);

  // The table must still respect the terminal it was given.
  const widestLine = Math.max(...wide.split('\n').map((line) => line.length));
  assert.ok(widestLine <= 220, `table overflowed: ${widestLine} > 220`);
});

test('bucket output fits narrow terminals without autowrap', () => {
  const report = createReport();
  const [repo] = report.repos;
  const [primary, detached, done] = repo.worktrees;
  const doneBranch = repo.branches.find((branch) => branch.name === done.branch);

  primary.tier = 'blocked';
  detached.tier = 'worktree-only';
  detached.bytes = 2_000_000_000;
  done.tier = 'worktree-and-branch';
  done.bytes = 1_000_000_000;
  done.path = '/workspace/账本/🌲-Cafe\u0301-worktree';
  done.branch = 'codex/修复-🌲-width';
  doneBranch.name = done.branch;
  doneBranch.worktreePath = done.path;
  repo.stashes[0].message = `On main: ${'1️⃣'.repeat(50)}`;

  assert.equal(terminalCellWidth('A界🌲e\u0301'), 6);
  assert.equal(terminalCellWidth('\u001b[32mA界🌲e\u0301\u001b[0m'), 6);
  assert.equal(terminalCellWidth('1️⃣#️⃣*️⃣'), 6);

  for (const color of ['never', 'always']) {
    for (const terminalColumns of [80, 100, 120, 200]) {
      const safeWidth = terminalColumns - 1;
      const text = formatScanText(report, {
        buckets: true,
        all: true,
        color,
        tableWidth: safeWidth,
      });
      const plainText = text.replace(/\u001b\[[0-9;]*m/g, '');

      for (const line of text.split('\n')) {
        const width = terminalCellWidth(line);
        assert.ok(
          width <= safeWidth,
          `${color} ${terminalColumns} columns overflowed (${width} > ${safeWidth}): ${line}`,
        );
      }

      if (terminalColumns <= 120) {
        assert.match(plainText, new RegExp(`^\\+-{${safeWidth - 2}}\\+$`, 'm'));
        assert.match(plainText, /\| Worktree\s+/);
        assert.match(plainText, /\| Unmerged\s+/);
        assert.match(plainText, /\| Keeps\s+/);
      }
    }
  }

  const tiny = formatScanText(report, {
    buckets: true,
    all: true,
    color: 'never',
    tableWidth: 11,
  });
  for (const line of tiny.split('\n')) {
    assert.ok(terminalCellWidth(line) <= 11, `11-column output overflowed: ${line}`);
  }
  assert.match(tiny, /^Worktree:$/m);
  assert.match(tiny, /^Branch:$/m);
  assert.match(tiny, /^Unmerged:(?: .*)?$/m);
  assert.match(tiny, /^Keeps:(?: .*)?$/m);
});

test('sizes are base 10, matching the free space macOS reports', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  worktrees[0].tier = 'worktree-only';
  worktrees[0].bytes = 1_000_000_000;

  const text = formatScanText(report, { buckets: true, all: true });

  // Dividing by 1024 and printing "GB" would render this 0.9GB: a GiB wearing
  // the wrong label, understating the reclaim against the only number a reader
  // will check it against.
  assert.match(text, /1\.0GB/);
  assert.doesNotMatch(text, /0\.9GB/);
});

test('a squash-merged branch that outlived its worktree is retained for review', () => {
  const report = createReport();

  report.repos[0].branches.push({
    name: 'codex/left-behind',
    upstream: 'origin/codex/left-behind',
    upstreamStatus: 'gone',
    ahead: null,
    behind: null,
    cleanupStatus: 'prune-candidate',
    mergedInto: 'origin/dev',
    mergedVia: 'pr',
    pullRequest: { number: 198, base: 'dev', mergedAt: '2026-06-25' },
    ancestryVisible: false,
    checkedOut: false,
    worktreePath: null,
  });

  const text = formatScanText(report, { buckets: true, commands: true, all: true });

  // Buckets are built from worktrees, so detecting this branch and then never
  // showing it is the same as not detecting it. A cleanup pass creates these.
  assert.match(text, /review: retain merged source branch \(1\)/);
  assert.match(text, /\| codex\/left-behind\s+\|/);

  const commands = text.split('\n').filter((line) => line.startsWith('git '));

  // The PR proves the content landed, but the local branch is still the only
  // named reference to the original commits. No forced deletion is emitted.
  assert.equal(commands.some((line) => line.includes("branch -D 'codex/left-behind'")), false);
  assert.equal(commands.some((line) => line.includes("branch -d 'codex/left-behind'")), false);
  assert.match(text, /retained/);
});

test('a merged PR with commits outside the base is not in the safe branch-deletion bucket', () => {
  const report = createReport();
  const [repo] = report.repos;
  const worktree = repo.worktrees.find((candidate) => candidate.branch === 'feature/done');
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/done');

  worktree.tier = 'worktree-and-branch';
  worktree.unmergedCommits = 2;
  worktree.githubMergeStatus = 'merged';
  worktree.pullRequest = { number: 878, base: 'main', mergedAt: '2026-07-16' };
  worktree.mergedVia = 'pr';
  worktree.ancestryVisible = false;
  Object.assign(branch, {
    unmergedCommits: 2,
    githubMergeStatus: 'merged',
    pullRequest: worktree.pullRequest,
    mergedVia: 'pr',
    ancestryVisible: false,
  });

  const text = formatScanText(report, { buckets: true, commands: true, all: true });
  const commands = text.split('\n').filter((line) => line.startsWith('git '));

  assert.doesNotMatch(text, /ready if unused: remove checkout \+ branch/);
  assert.match(text, /review: remove checkout, retain local branch history \(1\)/);
  assert.ok(commands.some((line) => line.includes("worktree remove '/workspace/done-worktree'")));
  assert.equal(commands.some((line) => line.includes("branch -D 'feature/done'")), false);
  assert.equal(commands.some((line) => line.includes("branch -d 'feature/done'")), false);
});

test('a worktree holding unique files is not swept along by the safe bucket', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  worktrees[0].tier = 'blocked';
  worktrees[1].tier = 'worktree-only';
  worktrees[2].tier = 'check-first';
  worktrees[2].preciousIgnored = ['assets/.env'];

  const text = formatScanText(report, { buckets: true, commands: true, all: true });
  const commands = text.split('\n').filter((line) => line.includes('worktree remove'));

  // The Keeps warning lived only in the table, so piping the safe bucket's
  // commands deleted the file it warned about. A bucket is an action group:
  // needing a look first makes this a different action, not a footnote.
  assert.match(text, /check first: ignored content here \(1\)/);
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/done-worktree'")), false);
  assert.ok(commands.some((line) => line.includes("worktree remove '/workspace/app-admin'")));
});

test('ignored content is named as review work and counted as items', () => {
  const report = createReport();
  const worktree = report.repos[0].worktrees[2];

  worktree.tier = 'check-first';
  worktree.preciousIgnored = ['.dart_tool/', 'assets/.env'];

  const compact = formatScanText(report, { all: true, tableWidth: 220 });
  const buckets = formatScanText(report, { buckets: true, all: true, tableWidth: 220 });

  assert.match(compact, /review ignored content, prune/);
  assert.doesNotMatch(compact, /done-worktree\s+\| feature\/done\s+\| clean\s+\|/);
  assert.match(buckets, /2 items: \.dart_tool/);
  assert.doesNotMatch(buckets, /2 files: \.dart_tool/);
});

test('ignored-content buckets group Keeps and offer opt-in exact path samples', () => {
  const report = createReport();
  const [repo] = report.repos;
  const worktree = repo.worktrees[2];

  worktree.tier = 'check-first';
  worktree.preciousIgnored = [
    '.idea/inspectionProfiles/Project_Default.xml',
    'assets/.env',
    'build/',
    'functions/test-results/junit.xml',
  ];

  const summary = formatScanText(report, { buckets: true, all: true, tableWidth: 220 });
  assert.match(summary, /Keeps review \(4 entries\)/);
  assert.match(summary, /\.idea\/\*\*/);
  assert.match(summary, /inspect settings; exact rule candidate/);
  assert.match(summary, /build\//);
  assert.match(summary, /inspect tree; no blanket rule/);
  assert.match(summary, /\*\*\/junit\.xml/);
  assert.match(summary, /generated evidence; opt in only/);
  assert.match(summary, /Use --keeps-details for exact path samples/);
  assert.doesNotMatch(summary, /\[keep\] assets\/\.env/);

  const detailed = formatScanText(report, {
    buckets: true,
    keepsDetails: true,
    all: true,
    tableWidth: 220,
  });
  assert.match(detailed, /Exact Keeps samples by checkout/);
  assert.match(detailed, /\[editor\] \.idea\/inspectionProfiles\/Project_Default\.xml/);
  assert.match(detailed, /\[keep\] assets\/\.env/);
  assert.match(detailed, /never auto-suggest a suppression rule/);
  assert.match(detailed, /\[tree\] build\//);
  assert.match(detailed, /contents were not inspected/);
});

test('Keeps details append to compact and detailed reports without changing layout', () => {
  const report = createReport();
  const worktree = report.repos[0].worktrees[2];

  worktree.tier = 'check-first';
  worktree.preciousIgnored = [
    'assets/.env',
    'functions/test-results/junit.xml',
  ];

  const compact = formatScanText(report, {
    all: true,
    keepsDetails: true,
    tableWidth: 220,
  });
  assert.match(compact, /^Git Groundskeeper Compact\n/);
  assert.match(compact, /Worktree summaries/);
  assert.match(compact, /Keeps review \(2 entries\)/);
  assert.match(compact, /Exact Keeps samples by checkout/);
  assert.match(compact, /\[keep\] assets\/\.env/);
  assert.doesNotMatch(compact, /check first: ignored content here/);

  const detailed = formatScanText(report, {
    all: true,
    details: true,
    keepsDetails: true,
    tableWidth: 220,
  });
  assert.match(detailed, /^Git Groundskeeper\n/);
  assert.match(detailed, /worktree \/workspace\/done-worktree/);
  assert.match(detailed, /Keeps review \(2 entries\)/);
  assert.match(detailed, /Exact Keeps samples by checkout/);
  assert.match(detailed, /\[output\] functions\/test-results\/junit\.xml/);
  assert.doesNotMatch(detailed, /Git Groundskeeper Compact/);
  assert.doesNotMatch(detailed, /check first: ignored content here/);
});

test('aliased worktree paths are blocked and receive no cleanup commands', () => {
  const report = createReport();
  const [repo] = report.repos;
  const original = repo.worktrees[1];
  const copied = {
    ...original,
    path: '/workspace/app-admin-copy',
    aliasedWorktreePaths: [original.path],
    tier: 'aliased',
  };

  original.aliasedWorktreePaths = [copied.path];
  original.tier = 'aliased';
  repo.worktrees.push(copied);

  const text = formatScanText(report, { buckets: true, commands: true, all: true });
  const commands = text.split('\n').filter((line) => line.startsWith('git '));

  assert.match(text, /blocked: aliased worktree metadata \(2\)/);
  assert.match(text, /multiple paths share one Git worktree/);
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/app-admin'")), false);
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/app-admin-copy'")), false);
});

test('command scopes follow the emitted action, not the scanner tier', () => {
  const report = createReport();
  const [repo] = report.repos;
  const worktrees = repo.worktrees;

  worktrees[0].tier = 'blocked';
  worktrees[1].tier = 'worktree-only';
  worktrees[2].tier = 'worktree-and-branch';

  // The scanner still calls this worktree-and-branch because the remote branch
  // is gone, but nonzero Unmerged means the command intentionally retains the
  // local branch. Its actual cleanup action is therefore worktree-only.
  const retainedSourceBranch = {
    ...worktrees[2],
    path: '/workspace/retained-source-branch',
    branch: 'feature/retained-source-branch',
    unmergedCommits: 3,
    githubMergeStatus: 'merged',
  };
  worktrees.push(retainedSourceBranch);
  repo.branches.push({
    ...repo.branches.find((branch) => branch.name === 'feature/done'),
    name: retainedSourceBranch.branch,
    worktreePath: retainedSourceBranch.path,
    unmergedCommits: retainedSourceBranch.unmergedCommits,
    githubMergeStatus: retainedSourceBranch.githubMergeStatus,
  });

  const scoped = formatScanText(report, { commands: true, commandsTier: 'worktree-and-branch', buckets: true, all: true });
  const commands = scoped.split('\n').filter((line) => line.startsWith('git '));

  assert.ok(commands.some((line) => line.includes("worktree remove '/workspace/done-worktree'")));
  assert.ok(commands.some((line) => line.includes("merge-base --is-ancestor 'refs/heads/feature/done' 'origin/main'")));
  assert.ok(commands.some((line) => line.includes("update-ref -d 'refs/heads/feature/done' '987fedc987fedc987fedc987fedc987fedc987f0'")));
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/app-admin'")), false);
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/retained-source-branch'")), false);

  const checkoutOnly = formatScanText(report, { commands: true, commandsTier: 'worktree-only', buckets: true, all: true });
  const checkoutCommands = checkoutOnly.split('\n').filter((line) => line.startsWith('git '));

  assert.ok(checkoutCommands.some((line) => line.includes("worktree remove '/workspace/retained-source-branch'")));
  assert.equal(checkoutCommands.some((line) => line.includes("update-ref -d 'refs/heads/feature/retained-source-branch'")), false);
  assert.equal(checkoutCommands.some((line) => line.includes("worktree remove '/workspace/done-worktree'")), false);
});

test('branch removal rechecks an explicit base and refuses a moved branch OID', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  // A path with a space, as in "4 Pillars".
  report.repos[0].primaryPath = '/workspace/4 Pillars/app';
  worktrees[0].tier = 'blocked';
  worktrees[1].tier = 'worktree-only';
  worktrees[2].tier = 'worktree-and-branch';

  // Merged the ordinary way, so the explicit base can confirm it.
  const done = report.repos[0].branches.find((branch) => branch.name === 'feature/done');
  done.ancestryVisible = true;

  const text = formatScanText(report, { commands: true, buckets: true, all: true });

  const commands = text.split('\n').filter((line) => line.startsWith('git '));

  assert.ok(commands.some((line) => line.includes("worktree remove '/workspace/done-worktree'")));
  // Paths with spaces must survive being pasted into a shell.
  assert.ok(commands.every((line) => line.startsWith("git -C '/workspace/4 Pillars/app'")));
  // The configured upstream is deliberately not trusted as the deletion
  // guard. The command checks the named integration base, then update-ref binds
  // deletion to the full OID observed by the scan so a moved branch is refused.
  const branchCommand = commands.find((line) => line.includes("update-ref -d 'refs/heads/feature/done'"));
  assert.ok(branchCommand);
  assert.match(branchCommand, /worktree remove '\/workspace\/done-worktree' && git -C/);
  assert.match(branchCommand, /merge-base --is-ancestor 'refs\/heads\/feature\/done' 'origin\/main'/);
  assert.match(branchCommand, /update-ref -d 'refs\/heads\/feature\/done' '987fedc987fedc987fedc987fedc987fedc987f0'/);
  assert.doesNotMatch(branchCommand, /branch -[dD]/);
  // worktree remove never forces: a refusal there means real uncommitted work.
  assert.equal(commands.some((line) => line.includes('worktree remove') && line.includes('--force')), false);
  // Nothing is proposed for the bucket that would lose work.
  assert.equal(commands.some((line) => line.includes("worktree remove '/workspace/app'")), false);

  // A legacy/incomplete report cannot supply update-ref's expected-old guard.
  // The checkout can still be removed, but branch retirement must be withheld.
  done.head = '987fedc';
  const incomplete = formatScanText(report, { commands: true, buckets: true, all: true });
  assert.match(incomplete, /retained branch feature\/done: explicit base or scanned full branch OID unavailable/);
  assert.doesNotMatch(incomplete, /update-ref -d 'refs\/heads\/feature\/done'/);
});

test('generated branch retirement command refuses stale-upstream and moved-tip races', (t) => {
  const upstreamFixture = createCommandFixture(t);
  const upstreamBranch = 'feature/upstream-only';
  gitCommand(upstreamFixture.repo, ['worktree', 'add', '-b', upstreamBranch, upstreamFixture.linked, 'main']);
  fs.writeFileSync(path.join(upstreamFixture.linked, 'feature.txt'), 'not merged to main\n');
  gitCommand(upstreamFixture.linked, ['add', 'feature.txt']);
  gitCommand(upstreamFixture.linked, ['commit', '-m', 'upstream-only feature']);
  gitCommand(upstreamFixture.linked, ['push', '-u', 'origin', upstreamBranch]);
  const upstreamHead = gitCommand(upstreamFixture.linked, ['rev-parse', 'HEAD']);
  const upstreamReport = createGuardedBranchReport(upstreamFixture, upstreamBranch, upstreamHead);
  const upstreamCommand = extractBranchRetirementCommand(upstreamReport, upstreamBranch);

  const refusedByBase = spawnSync('/bin/sh', ['-c', upstreamCommand], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(refusedByBase.status, 0);
  assert.equal(fs.existsSync(upstreamFixture.linked), false, 'clean checkout removal should have completed');
  assert.equal(gitCommand(upstreamFixture.repo, ['rev-parse', `refs/heads/${upstreamBranch}`]), upstreamHead);

  // This is the dangerous git branch -d behaviour the generated command must
  // not inherit: the configured upstream contains the tip, so Git deletes it
  // even though main does not.
  const plainDelete = spawnSync('git', ['branch', '-d', upstreamBranch], {
    cwd: upstreamFixture.repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(plainDelete.status, 0);

  const movedFixture = createCommandFixture(t);
  const movedBranch = 'feature/moved-after-scan';
  gitCommand(movedFixture.repo, ['worktree', 'add', '-b', movedBranch, movedFixture.linked, 'main']);
  fs.writeFileSync(path.join(movedFixture.linked, 'landed.txt'), 'landed\n');
  gitCommand(movedFixture.linked, ['add', 'landed.txt']);
  gitCommand(movedFixture.linked, ['commit', '-m', 'land feature']);
  gitCommand(movedFixture.repo, ['merge', '--ff-only', movedBranch]);
  const scannedHead = gitCommand(movedFixture.linked, ['rev-parse', 'HEAD']);
  const movedReport = createGuardedBranchReport(movedFixture, movedBranch, scannedHead);

  fs.writeFileSync(path.join(movedFixture.repo, 'later.txt'), 'base advanced\n');
  gitCommand(movedFixture.repo, ['add', 'later.txt']);
  gitCommand(movedFixture.repo, ['commit', '-m', 'advance base after scan']);
  gitCommand(movedFixture.linked, ['reset', '--hard', 'main']);
  const movedHead = gitCommand(movedFixture.linked, ['rev-parse', 'HEAD']);
  assert.notEqual(movedHead, scannedHead);

  const movedCommand = extractBranchRetirementCommand(movedReport, movedBranch);
  const refusedByExpectedOld = spawnSync('/bin/sh', ['-c', movedCommand], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(refusedByExpectedOld.status, 0);
  assert.equal(fs.existsSync(movedFixture.linked), false, 'clean checkout removal should have completed');
  assert.equal(gitCommand(movedFixture.repo, ['rev-parse', `refs/heads/${movedBranch}`]), movedHead);
});

test('detached cleanup commands recheck exact HEAD and current local retention', () => {
  const report = createReport();
  const [repo] = report.repos;
  repo.worktrees[0].tier = 'blocked';
  repo.worktrees[1].tier = 'worktree-only';
  repo.worktrees[2].tier = 'blocked';

  const output = formatScanText(report, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-only',
    tableWidth: 200,
  });
  const command = output
    .split('\n')
    .find((line) => line.startsWith('test ') && line.includes("worktree remove '/workspace/app-admin'"));
  assert.ok(command);
  assert.match(command, /rev-parse --verify HEAD\)" = 'dddddddddddddddddddddddddddddddddddddddd'/);
  assert.match(command, /merge-base --is-ancestor 'dddddddddddddddddddddddddddddddddddddddd' 'refs\/heads\/main'/);
  assert.match(
    command,
    /update-ref 'refs\/heads\/git-groundskeeper\/retained-detached\/dddddddddddddddddddddddddddddddddddddddd' 'dddddddddddddddddddddddddddddddddddddddd' '0000000000000000000000000000000000000000'/,
  );
  assert.match(output, /creates safety branch git-groundskeeper\/retained-detached\/dddddddddddddddddddddddddddddddddddddddd/);
  assert.ok(command.indexOf('merge-base --is-ancestor') < command.indexOf('worktree remove'));
  assert.ok(command.indexOf('update-ref') < command.lastIndexOf('rev-parse --verify HEAD'));

  repo.worktrees[1].retentionSource = 'local-tag';
  repo.worktrees[1].containedIn = 'saved-detached';
  const tagOutput = formatScanText(report, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-only',
  });
  assert.match(tagOutput, /merge-base --is-ancestor 'dddddddddddddddddddddddddddddddddddddddd' 'refs\/tags\/saved-detached\^\{\}'/);

  repo.worktrees[1].headFull = null;
  const incomplete = formatScanText(report, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-only',
  });
  assert.match(incomplete, /retained detached checkout \/workspace\/app-admin: exact HEAD or current retention guard unavailable/);
  assert.doesNotMatch(incomplete, /worktree remove '\/workspace\/app-admin'/);
});

test('buckets list the worktrees in each tier, not just a count', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  // Base 10 throughout, matching how macOS reports free space and therefore
  // how these totals get checked.
  worktrees[0].tier = 'blocked';
  worktrees[0].bytes = 900_000_000;
  worktrees[1].tier = 'worktree-only';
  worktrees[1].bytes = 2_000_000_000;
  worktrees[2].tier = 'worktree-and-branch';
  worktrees[2].bytes = 1_000_000_000;

  const text = formatScanText(report, { buckets: true, all: true });

  // A bucket you cannot see into is a number, not a decision. Each tier heading
  // must be followed by the worktrees actually in it.
  assert.match(text, /ready if unused: remove checkout \+ branch \(1, 1\.0GB\)[\s\S]*?\| done-worktree\s+\|/);
  assert.match(text, /ready if unused: remove detached checkout, commit retained \(1, 2\.0GB\)[\s\S]*?\| app-admin\s+\|/);
  // Blocked rows keep their inventory measurement, but the heading labels it
  // as on-disk usage so it is not confused with reclaimable space.
  assert.match(text, /blocked: uncommitted work \(1, 900\.0MB on disk\) - removing this loses work/);
  const blockedSection = /blocked: uncommitted work[\s\S]*?(?=\n\n|$)/.exec(text)?.[0] ?? '';
  assert.match(blockedSection, /\| Size\s+\|/);
  assert.match(blockedSection, /900\.0MB/);
  // 2GB + 1GB. The blocked 900MB is excluded.
  assert.match(text, /Reclaimable after review: 3\.0GB/);
  // The flat list is replaced, not preceded: printing both lists every worktree twice.
  assert.doesNotMatch(text, /Worktree summaries/);
});

test('bucket totals exclude nested worktree sizes without hiding their rows', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;
  const parent = worktrees[2];

  worktrees[0].tier = 'blocked';
  worktrees[0].bytes = 900_000_000;
  worktrees[1].tier = 'worktree-only';
  worktrees[1].bytes = 2_000_000_000;
  parent.tier = 'worktree-and-branch';
  parent.bytes = 1_000_000_000;
  report.repos[0].worktrees.push({
    ...parent,
    path: `${parent.path}/admin`,
    bytes: 600_000_000,
  });

  const text = formatScanText(report, { buckets: true, all: true });

  assert.match(text, /ready if unused: remove checkout \+ branch \(2, 1\.0GB; 1 nested excluded\)/);
  assert.match(text, /600\.0MB/);
  assert.match(text, /Reclaimable after review: 3\.0GB; 1 nested row excluded to prevent double-counting/);
  assert.doesNotMatch(text, /Reclaimable after review: 3\.6GB/);
});

test('flat size reports total the visible measurements and disclose partial coverage', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  worktrees[0].bytes = 1_000_000_000;
  worktrees[1].bytes = 2_000_000_000;
  worktrees[2].bytes = null;

  const partial = formatScanText(report, { all: true });

  assert.match(partial, /Measured size shown: 3\.0GB across 2 of 3 worktrees; 1 unmeasured\./);
  assert.doesNotMatch(partial, /Total size shown:/);

  worktrees[2].bytes = 500_000_000;
  const complete = formatScanText(report, { all: true });

  assert.match(complete, /Total size shown: 3\.5GB across 3 worktrees\./);
  assert.doesNotMatch(complete, /Measured size shown:/);
});

test('flat size totals count nested worktree paths only once', () => {
  const report = createReport();
  const worktrees = report.repos[0].worktrees;

  worktrees[0].path = '/workspace/parent';
  worktrees[0].bytes = 2_000_000_000;
  worktrees[1].path = '/workspace/parent/admin';
  worktrees[1].bytes = 1_500_000_000;
  worktrees[2].path = '/workspace/sibling';
  worktrees[2].bytes = 500_000_000;

  const text = formatScanText(report, { all: true });

  assert.match(text, /2\.0GB/);
  assert.match(text, /1\.5GB/);
  assert.match(text, /Total unique size shown: 2\.5GB across 2 top-level worktrees; 1 nested row excluded to prevent double-counting\./);
  assert.doesNotMatch(text, /Total size shown: 4\.0GB/);
});

test('checkout review separates integration state and differently named upstreams without duplicate commands', () => {
  const report = createReport();
  const [repo] = report.repos;
  const integrated = repo.worktrees[1];
  integrated.tier = 'worktree-only';
  integrated.unmergedCommits = 0;

  const integratedRetained = {
    ...integrated,
    path: '/workspace/integrated-retained',
    branch: 'feature/integrated-retained',
    detached: false,
    containedIn: null,
    upstream: 'origin/feature/integrated-retained',
    upstreamBranch: 'feature/integrated-retained',
    upstreamStatus: 'tracking',
    ahead: 0,
    behind: 0,
    githubMergeStatus: 'not-found',
  };
  const integratedMerged = {
    ...integratedRetained,
    path: '/workspace/integrated-merged',
    branch: 'feature/integrated-merged',
    upstream: 'origin/feature/integrated-merged',
    upstreamBranch: 'feature/integrated-merged',
    // Squash merges do not make the original commits ancestors of the base.
    // Exact live PR evidence must still put this in the merged branch bucket.
    unmergedCommits: 3,
    githubMergeStatus: 'merged',
    pullRequest: {
      base: 'main',
      number: 412,
      mergedAt: '2026-06-12',
    },
  };
  const integratedDifferentUpstream = {
    ...integrated,
    path: '/workspace/integrated-base-tracker',
    branch: 'feature/integrated-base-tracker',
    detached: false,
    containedIn: null,
    upstream: 'origin/main',
    upstreamBranch: 'main',
    upstreamStatus: 'tracking',
    liveUpstreamStatus: 'present',
    liveUpstreamMatchesHead: false,
    ahead: 7,
    behind: 97,
  };
  const unmerged = {
    ...integrated,
    path: '/workspace/unmerged-checkout',
    branch: 'feature/unmerged',
    detached: false,
    containedIn: null,
    upstream: 'origin/feature/unmerged',
    upstreamBranch: 'feature/unmerged',
    upstreamStatus: 'tracking',
    ahead: 0,
    behind: 0,
    unmergedCommits: 4,
  };
  const unmergedDifferentUpstream = {
    ...unmerged,
    path: '/workspace/unmerged-release-tracker',
    branch: 'feature/unmerged-release-tracker',
    upstream: 'origin/release',
    upstreamBranch: 'release',
  };
  const unknown = {
    ...integrated,
    path: '/workspace/unknown-checkout',
    branch: 'feature/unknown',
    detached: false,
    containedIn: null,
    upstream: 'origin/feature/unknown',
    upstreamBranch: 'feature/unknown',
    unmergedCommits: null,
    unmergedBase: null,
  };
  const unknownDifferentUpstream = {
    ...unknown,
    path: '/workspace/unknown-dev-tracker',
    branch: 'feature/unknown-dev-tracker',
    upstream: 'origin/dev',
    upstreamBranch: 'dev',
  };
  repo.worktrees.push(
    integratedRetained,
    integratedMerged,
    integratedDifferentUpstream,
    unmerged,
    unmergedDifferentUpstream,
    unknown,
    unknownDifferentUpstream,
  );
  for (const worktree of [
    integratedRetained,
    integratedMerged,
    integratedDifferentUpstream,
    unmerged,
    unmergedDifferentUpstream,
    unknown,
    unknownDifferentUpstream,
  ]) {
    repo.branches.push({
      name: worktree.branch,
      upstream: worktree.upstream,
      upstreamBranch: worktree.upstreamBranch,
      upstreamStatus: worktree.upstreamStatus,
      liveUpstreamStatus: worktree.liveUpstreamStatus,
      liveUpstreamMatchesHead: worktree.liveUpstreamMatchesHead,
      cleanupStatus: null,
      ahead: worktree.ahead,
      behind: worktree.behind,
      lastCommitDate: worktree.lastCommitDate,
      unmergedCommits: worktree.unmergedCommits,
      unmergedBase: worktree.unmergedBase,
      githubMergeStatus: worktree.githubMergeStatus,
      pullRequest: worktree.pullRequest ?? null,
      checkedOut: true,
      worktreePath: worktree.path,
    });
  }

  const text = formatScanText(report, {
    buckets: true,
    commands: true,
    all: true,
    tableWidth: 180,
  });

  assert.match(text, /review: remove checkout, retain merged source branch \(1\)/);
  assert.match(text, /ready if unused: remove checkout, retain branch \(1\)/);
  assert.match(text, /ready if unused: remove detached checkout, commit retained \(1\)/);
  assert.match(text, /review: remove checkout, branch integrated, upstream name differs \(1\)/);
  assert.match(text, /review: remove checkout, keep unmerged branch \(1\)/);
  assert.match(text, /review: remove checkout, keep unmerged branch, upstream name differs \(1\)/);
  assert.match(text, /review: remove checkout, integration unknown \(1\)/);
  assert.match(text, /review: remove checkout, integration unknown, upstream name differs \(1\)/);
  assert.match(text, /\| Worktree\s+\| Branch\s+\| Upstream\s+\| GitHub\s+\| State\s+\| Remote\s+\|/);
  assert.match(text, /\| integrated-merged\s+\| feature\/integrated-merged\s+\| origin\/feature\/integrated-merged\s+\| PR #412 -> main\s+\|/);
  assert.match(text, /no exact-name merged PR match/);
  assert.doesNotMatch(text, /no merged PR found/);
  assert.match(text, /\| integrated-merged[\s\S]*?\| 3\s+\|/);
  assert.match(text, /\| integrated-base-tracker\s+\| feature\/integrated-base-tracker\s+\| origin\/main\s+\| -\s+\| clean\s+\| push \+7, behind 97\s+\| 7\s+\|/);
  assert.match(text, /\| unmerged-checkout\s+\| feature\/unmerged[\s\S]*?\| 4\s+\|/);

  const removals = text.split('\n').filter((line) => line.includes('worktree remove'));
  assert.equal(removals.length, 8);
  assert.equal(new Set(removals).size, 8);
});

test('bucket rows and cleanup commands never target linked worktrees outside the requested roots', () => {
  const report = createReport();
  const [repo] = report.repos;
  const done = repo.worktrees[2];
  const doneBranch = repo.branches.find((branch) => branch.name === 'feature/done');

  repo.worktrees[0].tier = 'primary';
  repo.worktrees[1].tier = 'worktree-only';
  done.tier = 'worktree-and-branch';

  const outsideWorktree = {
    ...done,
    path: '/outside/escape-worktree',
    branch: 'feature/outside-escape',
    upstream: 'origin/feature/outside-escape',
    upstreamBranch: 'feature/outside-escape',
  };
  repo.worktrees.push(outsideWorktree);
  repo.branches.push({
    ...doneBranch,
    name: outsideWorktree.branch,
    head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    upstream: outsideWorktree.upstream,
    upstreamBranch: outsideWorktree.upstreamBranch,
    checkedOut: true,
    worktreePath: outsideWorktree.path,
  });

  const outsideRepo = structuredClone(repo);
  outsideRepo.primaryPath = '/outside/other-repo';
  outsideRepo.worktrees = [{
    ...outsideRepo.worktrees[0],
    path: outsideRepo.primaryPath,
    tier: 'primary',
  }];
  outsideRepo.branches = [{
    ...doneBranch,
    name: 'feature/outside-orphan',
    head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    checkedOut: false,
    worktreePath: null,
  }];
  outsideRepo.stashes = [{ ref: 'stash@{0}', message: 'outside stash must stay outside' }];
  report.repos.push(outsideRepo);

  const text = formatScanText(report, { buckets: true, commands: true, tableWidth: 220 });

  assert.match(text, /Linked worktrees outside roots hidden:/);
  assert.doesNotMatch(text, /escape-worktree|feature\/outside-escape|outside-orphan|outside stash/);
  assert.doesNotMatch(text, /git -C '\/outside|worktree remove '\/outside/);
  assert.match(text, /worktree remove '\/workspace\/done-worktree'/);
});

test('bucket mode renders a clean removal candidate instead of the ordinary empty state', () => {
  const report = createCleanCandidateReport();

  const text = formatScanText(report, { buckets: true, commands: true });

  assert.match(text, /In scope: 1 worktree, 0 need attention/);
  assert.match(text, /ready if unused: remove checkout, retain branch \(1\)/);
  assert.match(text, /worktree remove '\/workspace\/clean-candidate'/);
  assert.doesNotMatch(text, /No outstanding Git state found/);
  assert.doesNotMatch(text, /Clean worktrees hidden/);
});

test('branch-only retirement keeps the safe label because no checkout path is removed', () => {
  const report = createReport();
  const [repo] = report.repos;
  repo.worktrees[0].tier = 'primary';
  repo.worktrees[1].tier = 'worktree-only';
  repo.worktrees[2].tier = 'worktree-and-branch';
  repo.branches.push({
    name: 'feature/orphaned-and-integrated',
    head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    upstream: 'origin/feature/orphaned-and-integrated',
    upstreamBranch: 'feature/orphaned-and-integrated',
    upstreamStatus: 'gone',
    cleanupStatus: 'prune-candidate',
    mergedInto: 'origin/main',
    ancestryVisible: true,
    checkedOut: false,
    worktreePath: null,
  });

  const text = formatScanText(report, { buckets: true, commands: true });

  assert.match(text, /safe: remove branch \(1\) - command rechecks the named integration base; no worktree left/);
  assert.match(text, /# safe: remove branch \(1\)/);
  assert.match(text, /update-ref -d 'refs\/heads\/feature\/orphaned-and-integrated'/);
});

test('bucket output exposes dirty primary and aliased state plus repository branches and stashes', () => {
  const report = createReport();
  const [repo] = report.repos;
  const [primary, aliased, done] = repo.worktrees;

  primary.tier = 'primary';
  aliased.tier = 'aliased';
  aliased.aliasedWorktreePaths = ['/workspace/app-admin-copy'];
  aliased.dirty = true;
  aliased.status = { staged: 0, unstaged: 0, untracked: 1, ignored: 0, total: 1 };
  done.tier = 'worktree-and-branch';

  const text = formatScanText(report, { buckets: true, all: true, tableWidth: 220 });

  assert.match(text, /In scope: 3 worktrees, 3 need attention, \(2 dirty,/);
  assert.match(text, /primary checkout \(1\)[\s\S]*?\| app\s+\| main[\s\S]*?\| stg:1 mod:2 new:3\s+\|/);
  assert.match(text, /blocked: aliased worktree metadata \(1\)[\s\S]*?\| app-admin\s+\| DETACHED[\s\S]*?\| stg:0 mod:0 new:1\s+\|/);
  assert.match(text, /Repository-level branch attention \(2\)/);
  assert.match(text, /feature\/local/);
  assert.match(text, /feature\/old/);
  assert.match(text, /Repository-level state \(1\)/);
  assert.match(text, /stash@\{0\}/);
});

test('a differently named upstream cannot remain in the safe worktree-and-branch bucket', () => {
  const report = createReport();
  const [repo] = report.repos;
  const done = repo.worktrees[2];
  const doneBranch = repo.branches.find((branch) => branch.name === done.branch);

  repo.worktrees[0].tier = 'primary';
  repo.worktrees[1].tier = 'worktree-only';
  done.tier = 'worktree-and-branch';
  done.upstream = 'origin/main';
  done.upstreamBranch = 'main';
  doneBranch.upstream = done.upstream;
  doneBranch.upstreamBranch = done.upstreamBranch;

  const text = formatScanText(report, { buckets: true, commands: true, all: true });

  assert.match(text, /review: remove checkout, retain branch; upstream name differs \(1\)/);
  assert.doesNotMatch(text, /ready if unused: remove checkout \+ branch/);
  assert.match(text, /worktree remove '\/workspace\/done-worktree'/);
  assert.doesNotMatch(text, /update-ref -d 'refs\/heads\/feature\/done'/);
});

test('attention headline reconciles inspection failures and non-dirty blocker buckets', () => {
  const report = createReport();
  const [repo] = report.repos;
  const primary = { ...repo.worktrees[0], tier: 'primary' };
  const seed = {
    ...repo.worktrees[2],
    cleanupStatus: null,
    mergedInto: null,
    dirty: false,
    status: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, total: 0 },
    locked: false,
    inProgress: null,
    detached: false,
    unreachableCommits: 0,
    containedIn: null,
    retentionVerified: null,
    retentionSource: null,
    submodules: [],
    preciousIgnored: [],
    inspectionErrors: [],
    upstreamStatus: 'tracking',
    ahead: 0,
    behind: 0,
  };

  repo.worktrees = [
    primary,
    {
      ...seed,
      path: '/workspace/inspection-failed',
      branch: 'feature/inspection-failed',
      tier: 'inspection-error',
      inspectionErrors: [{ probe: 'status', message: 'git status failed: synthetic' }],
    },
    {
      ...seed,
      path: '/workspace/locked',
      branch: 'feature/locked',
      tier: 'blocked',
      locked: true,
    },
    {
      ...seed,
      path: '/workspace/rebase',
      branch: 'feature/rebase',
      tier: 'blocked',
      inProgress: 'rebase',
    },
    {
      ...seed,
      path: '/workspace/detached-unique',
      branch: null,
      tier: 'blocked',
      detached: true,
      unreachableCommits: 2,
      retentionVerified: false,
    },
    {
      ...seed,
      path: '/workspace/check-files',
      branch: 'feature/check-files',
      tier: 'check-first',
      preciousIgnored: ['.idea/dataSources.local.xml'],
    },
    {
      ...seed,
      path: '/workspace/push-first',
      branch: 'feature/push-first',
      tier: 'push-first',
      upstream: null,
      upstreamStatus: 'none',
      ahead: null,
      behind: null,
    },
  ];
  repo.branches = [];
  repo.stashes = [];

  const text = formatScanText(report, { buckets: true, tableWidth: 220 });

  assert.match(text, /In scope: 7 worktrees, 7 need attention/);
  assert.match(text, /blocked: inspection failed \(1\)/);
  assert.match(text, /status: git status failed/);
  assert.match(text, /blocked: worktree is locked \(1\)/);
  assert.match(text, /blocked: Git operation in progress \(1\)/);
  assert.match(text, /blocked: detached commits have no verified ref \(1\)/);
  assert.match(text, /content differs from the primary checkout or lives in a directory that is not assumed disposable/);
  assert.match(text, /push first: branch is not safely retained upstream/);
  assert.doesNotMatch(text, /on no other disk|only copy is here/);
});

test('root scoping compares filesystem identity so symlinked roots stay in scope', (t) => {
  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-format-'));
  t.after(() => fs.rmSync(temporaryParent, { recursive: true, force: true }));

  const realRoot = path.join(temporaryParent, 'real-root');
  const aliasRoot = path.join(temporaryParent, 'alias-root');
  const candidatePath = path.join(realRoot, 'clean-candidate');
  const siblingPath = path.join(temporaryParent, 'real-root-sibling', 'outside-candidate');
  fs.mkdirSync(candidatePath, { recursive: true });
  fs.mkdirSync(siblingPath, { recursive: true });
  fs.symlinkSync(realRoot, aliasRoot, 'dir');

  const report = createCleanCandidateReport(aliasRoot, candidatePath);
  const [repo] = report.repos;
  const outside = {
    ...repo.worktrees[0],
    path: siblingPath,
    branch: 'feature/outside-symlink-root',
    upstream: 'origin/feature/outside-symlink-root',
    upstreamBranch: 'feature/outside-symlink-root',
  };
  repo.worktrees.push(outside);
  repo.branches.push({
    ...repo.branches[0],
    name: outside.branch,
    upstream: outside.upstream,
    upstreamBranch: outside.upstreamBranch,
    worktreePath: outside.path,
  });
  const text = formatScanText(report, { buckets: true, commands: true });

  assert.match(text, /In scope: 1 worktree/);
  assert.match(text, /\| clean-candidate\s+\|/);
  assert.doesNotMatch(text, /outside-candidate/);
  assert.match(text, new RegExp(`worktree remove '${escapeRegExp(candidatePath)}'`));
  assert.doesNotMatch(text, new RegExp(`worktree remove '${escapeRegExp(siblingPath)}'`));
});

function createReport() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-13T17:15:00.000Z',
    roots: ['/workspace'],
    summary: {
      repoCount: 1,
      worktreeCount: 2,
      dirtyWorktreeCount: 1,
      branchAheadCount: 1,
      noUpstreamBranchCount: 1,
      goneUpstreamBranchCount: 1,
      stashCount: 1,
      nestedRepoCount: 0,
      attentionCount: 1,
    },
    repos: [
      {
        status: 'commit-needed',
        primaryPath: '/workspace/app',
        worktrees: [
          {
            path: '/workspace/app',
            branch: 'main',
            detached: false,
            head: 'abc1234',
            lastCommitDate: '2026-06-13T15:15:00.000Z',
            unmergedCommits: 2,
            unmergedBase: 'origin/main',
            upstream: 'origin/main',
            upstreamStatus: 'tracking',
            ahead: 2,
            behind: 0,
            dirty: true,
            status: {
              staged: 1,
              unstaged: 2,
              untracked: 3,
              ignored: 0,
              total: 6,
            },
            largeFiles: [{ path: 'movie.mp4', bytes: 12 * 1024 * 1024 }],
          },
          {
            path: '/workspace/app-admin',
            branch: null,
            detached: true,
            containedIn: 'main',
            retentionVerified: true,
            retentionSource: 'local-branch',
            head: 'def5678',
            headFull: 'dddddddddddddddddddddddddddddddddddddddd',
            retentionRefHead: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            lastCommitDate: '2026-05-14T17:15:00.000Z',
            unmergedCommits: 0,
            unmergedBase: 'origin/main',
            upstream: null,
            upstreamStatus: 'none',
            ahead: null,
            behind: null,
            dirty: false,
            status: {
              staged: 0,
              unstaged: 0,
              untracked: 0,
              ignored: 0,
              total: 0,
            },
            largeFiles: [],
          },
          {
            path: '/workspace/done-worktree',
            branch: 'feature/done',
            detached: false,
            head: '987fedc',
            lastCommitDate: '2025-06-13T17:15:00.000Z',
            unmergedCommits: 0,
            unmergedBase: 'origin/main',
            upstream: 'origin/feature/done',
            upstreamStatus: 'gone',
            cleanupStatus: 'prune-candidate',
            mergedInto: 'origin/main',
            ahead: null,
            behind: null,
            dirty: false,
            status: {
              staged: 0,
              unstaged: 0,
              untracked: 0,
              ignored: 0,
              total: 0,
            },
            largeFiles: [],
          },
        ],
        branches: [
          {
            name: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'tracking',
            ahead: 2,
            behind: 0,
            lastCommitDate: '2026-06-13T15:15:00.000Z',
            unmergedCommits: 2,
            unmergedBase: 'origin/main',
            checkedOut: true,
            worktreePath: '/workspace/app',
          },
          {
            name: 'feature/local',
            upstream: null,
            upstreamStatus: 'none',
            ahead: null,
            behind: null,
            lastCommitDate: '2026-05-14T17:15:00.000Z',
            checkedOut: false,
            worktreePath: null,
          },
          {
            name: 'feature/old',
            upstream: 'origin/feature/old',
            upstreamStatus: 'gone',
            ahead: null,
            behind: null,
            lastCommitDate: '2025-06-13T17:15:00.000Z',
            checkedOut: false,
            worktreePath: null,
          },
          {
            name: 'feature/done',
            head: '987fedc987fedc987fedc987fedc987fedc987f0',
            upstream: 'origin/feature/done',
            upstreamStatus: 'gone',
            cleanupStatus: 'prune-candidate',
            mergedInto: 'origin/main',
            ahead: null,
            behind: null,
            checkedOut: true,
            worktreePath: '/workspace/done-worktree',
          },
        ],
        stashes: [{ ref: 'stash@{0}', message: 'On main: example' }],
        nestedRepos: [],
      },
    ],
  };
}

function createCleanCandidateReport(root = '/workspace', candidatePath = '/workspace/clean-candidate') {
  const report = createReport();
  const [repo] = report.repos;
  const candidate = {
    ...repo.worktrees[2],
    path: candidatePath,
    branch: 'feature/clean-candidate',
    tier: 'worktree-only',
    cleanupStatus: null,
    mergedInto: null,
    mergedVia: null,
    ancestryVisible: null,
    upstream: 'origin/feature/clean-candidate',
    upstreamBranch: 'feature/clean-candidate',
    upstreamStatus: 'tracking',
    liveUpstreamStatus: 'present',
    liveUpstreamMatchesHead: true,
    ahead: 0,
    behind: 0,
    dirty: false,
    status: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, total: 0 },
    preciousIgnored: [],
    inspectionErrors: [],
    submodules: [],
    locked: false,
    inProgress: null,
    unmergedCommits: 0,
    githubMergeStatus: 'not-found',
  };

  report.roots = [root];
  repo.primaryPath = path.join(root, 'repository');
  repo.worktrees = [candidate];
  repo.branches = [{
    name: candidate.branch,
    head: 'cccccccccccccccccccccccccccccccccccccccc',
    upstream: candidate.upstream,
    upstreamBranch: candidate.upstreamBranch,
    upstreamStatus: candidate.upstreamStatus,
    liveUpstreamStatus: candidate.liveUpstreamStatus,
    liveUpstreamMatchesHead: candidate.liveUpstreamMatchesHead,
    ahead: 0,
    behind: 0,
    lastCommitDate: candidate.lastCommitDate,
    unmergedCommits: 0,
    githubMergeStatus: 'not-found',
    checkedOut: true,
    worktreePath: candidate.path,
  }];
  repo.stashes = [];
  repo.status = 'clean';
  return report;
}

function createCommandFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-command-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');
  const linked = path.join(parent, 'linked');

  fs.mkdirSync(repo);
  gitCommand(repo, ['init', '-b', 'main']);
  gitCommand(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  gitCommand(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  gitCommand(repo, ['add', 'README.md']);
  gitCommand(repo, ['commit', '-m', 'initial']);
  gitCommand(parent, ['init', '--bare', remote]);
  gitCommand(repo, ['remote', 'add', 'origin', remote]);
  gitCommand(repo, ['push', '-u', 'origin', 'main']);

  return { parent, repo, remote, linked };
}

function createGuardedBranchReport(fixture, branchName, head) {
  const report = createCleanCandidateReport(fixture.parent, fixture.linked);
  const [repo] = report.repos;
  const [worktree] = repo.worktrees;
  const [branch] = repo.branches;

  repo.primaryPath = fixture.repo;
  Object.assign(worktree, {
    branch: branchName,
    detached: false,
    head: head.slice(0, 7),
    headFull: head,
    tier: 'worktree-and-branch',
    cleanupStatus: 'prune-candidate',
    mergedInto: 'refs/heads/main',
    upstream: `origin/${branchName}`,
    upstreamBranch: branchName,
    upstreamStatus: 'gone',
    unmergedCommits: 0,
  });
  Object.assign(branch, {
    name: branchName,
    head,
    cleanupStatus: 'prune-candidate',
    mergedInto: 'refs/heads/main',
    ancestryVisible: true,
    upstream: `origin/${branchName}`,
    upstreamBranch: branchName,
    upstreamStatus: 'gone',
    checkedOut: true,
    worktreePath: fixture.linked,
    unmergedCommits: 0,
  });

  return report;
}

function extractBranchRetirementCommand(report, branchName) {
  const output = formatScanText(report, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-and-branch',
    tableWidth: 200,
  });
  const command = output
    .split('\n')
    .find((line) => line.startsWith('git ') && line.includes(`refs/heads/${branchName}`));
  assert.ok(command, `no guarded retirement command for ${branchName}`);
  return command;
}

function gitCommand(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
