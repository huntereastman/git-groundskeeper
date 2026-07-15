import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScanText } from '../src/format.js';

test('formatScanText defaults to compact actionable cleanup output', () => {
  const text = formatScanText(createReport());

  assert.match(text, /Git Groundskeeper Compact/);
  assert.match(text, /In scope: 3 worktrees, 3 need attention/);
  assert.match(text, /Worktree summaries \(3 needing attention \/ 3 in scope\)/);
  // One row per worktree, not a Field/Value block each: 92 worktrees of
  // vertical tables is about 1,100 lines of scroll.
  assert.match(text, /\| Worktree\s+\| Branch\s+\| Needs\s+\| Remote\s+\|/);
  assert.doesNotMatch(text, /\| Field\s+\| Value\s+\|/);
  assert.match(text, /\| app\s+\| main\s+\| commit, push, review large files\s+\| push \+2\s+\|/);
  assert.match(text, /\| app-admin\s+\| DETACHED\s+\| attach branch\s+\| detached\s+\|/);
  // The Remote cell names how the merge was established, not just that it was:
  // "pr" is GitHub's answer, "squash" and "merged" are local inference.
  assert.match(text, /\| done-worktree\s+\| feature\/done\s+\| prune\s+\| merged \(origin\/main\)\s+\|/);
  assert.match(text, /Repository-level branch cleanup \(2\)/);
  assert.match(text, /feature\/local/);
  assert.match(text, /feature\/old/);
  assert.match(text, /Repository-level state \(1\)/);
  assert.match(text, /stash@\{0\}/);
});

test('formatScanText details output shows full repo details', () => {
  const text = formatScanText(createReport(), { details: true });

  assert.match(text, /Git Groundskeeper/);
  assert.match(text, /! commit-needed \/workspace\/app/);
  assert.match(text, /worktree \/workspace\/app/);
  assert.doesNotMatch(text, /Git Groundskeeper Compact/);
});

test('formatScanText colors key compact metrics when color is forced', () => {
  const text = formatScanText(createReport(), { color: 'always' });

  assert.match(text, /\u001b\[/);
  assert.match(text, /\u001b\[31mcommit, push, review large files\u001b\[0m/);
  assert.match(text, /\u001b\[36mpush \+2\u001b\[0m/);
  assert.match(text, /\u001b\[31mdetached\u001b\[0m/);
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
  assert.match(text, /cashflow-mobile-date-row\s+\|/);
  assert.match(text, /\.\.\./);
  assert.doesNotMatch(text, /Development\/numbus\/B2C\/nu\.\.\./);
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
  assert.match(text, /safe: remove worktree \+ branch \(1, 1\.0GB\)[\s\S]*?\| done-worktree\s+\|/);
  assert.match(text, /safe: remove worktree \(1, 2\.0GB\)[\s\S]*?\| app-admin\s+\|/);
  // Blocked holds 900MB but its heading must not total it: a size beside
  // "removing this loses work" reads as an invitation.
  assert.match(text, /blocked: uncommitted work \(1\) - removing this loses work/);
  // 2GB + 1GB. The blocked 900MB is excluded.
  assert.match(text, /Reclaimable now: 3\.0GB/);
  // The flat list is replaced, not preceded: printing both lists every worktree twice.
  assert.doesNotMatch(text, /Worktree summaries/);
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
            head: 'def5678',
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
            checkedOut: true,
            worktreePath: '/workspace/app',
          },
          {
            name: 'feature/local',
            upstream: null,
            upstreamStatus: 'none',
            ahead: null,
            behind: null,
            checkedOut: false,
            worktreePath: null,
          },
          {
            name: 'feature/old',
            upstream: 'origin/feature/old',
            upstreamStatus: 'gone',
            ahead: null,
            behind: null,
            checkedOut: false,
            worktreePath: null,
          },
          {
            name: 'feature/done',
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
