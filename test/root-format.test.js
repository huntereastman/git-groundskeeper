import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScanText } from '../src/format.js';

test('filesystem-root reports retain absolute paths and disclose scan scope', () => {
  const report = createReport('/', '/Users/hunter/Development/project');
  report.maxDepth = 8;

  const output = formatScanText(report, {
    all: true,
    color: 'never',
    tableWidth: 180,
  });

  assert.match(output, /Scope warning: a filesystem-root scan includes system\/tool-managed repositories/);
  assert.match(output, /descends at most 8 directories/);
  assert.match(output, /\| \/Users\/hunter\/Development\/project\s+\|/);
  assert.doesNotMatch(output, /\| Users\/hunter\/Development\/project\s+\|/);

  report.maxDepth = 1;
  const singularDepth = formatScanText(report, { all: true, color: 'never', tableWidth: 180 });
  assert.match(singularDepth, /descends at most 1 directory from each root/);
  assert.doesNotMatch(singularDepth, /1 directories/);
});

test('workspace-root reports stay relative and do not show the filesystem warning', () => {
  const report = createReport('/Users/hunter/Development', '/Users/hunter/Development/project');

  const output = formatScanText(report, {
    all: true,
    color: 'never',
    tableWidth: 180,
  });

  assert.doesNotMatch(output, /Scope warning:/);
  assert.match(output, /\| project\s+\|/);
});

function createReport(root, worktreePath) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-31T15:12:36.566Z',
    roots: [root],
    summary: {
      repoCount: 1,
      worktreeCount: 1,
      dirtyWorktreeCount: 0,
      draftWorktreeCount: 0,
      aliasedWorktreeCount: 0,
      branchAheadCount: 0,
      noUpstreamBranchCount: 0,
      goneUpstreamBranchCount: 0,
      stashCount: 0,
      nestedRepoCount: 0,
      attentionCount: 0,
    },
    repos: [
      {
        status: 'clean',
        primaryPath: worktreePath,
        worktrees: [
          {
            path: worktreePath,
            branch: 'main',
            detached: false,
            head: 'abc1234',
            lastCommitDate: '2026-08-30T15:12:36.566Z',
            upstream: 'origin/main',
            upstreamStatus: 'tracking',
            ahead: 0,
            behind: 0,
            dirty: false,
            status: { staged: 0, unstaged: 0, untracked: 0, ignored: 0, total: 0 },
            largeFiles: [],
            preciousIgnored: [],
            inspectionErrors: [],
          },
        ],
        branches: [
          {
            name: 'main',
            upstream: 'origin/main',
            upstreamStatus: 'tracking',
            ahead: 0,
            behind: 0,
            lastCommitDate: '2026-08-30T15:12:36.566Z',
            checkedOut: true,
            worktreePath,
          },
        ],
        stashes: [],
        nestedRepos: [],
      },
    ],
  };
}
