import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScanText } from '../src/format.js';

test('formatScanText defaults to compact actionable cleanup output', () => {
  const text = formatScanText(createReport());

  assert.match(text, /Git Groundskeeper Compact/);
  assert.match(text, /In scope: 3 worktrees, 3 need attention/);
  assert.match(text, /Worktree summaries \(3 needing attention \/ 3 in scope\)/);
  assert.match(text, /app\n\+[-+]+\+\n\| Field/);
  assert.match(text, /\| Branch\s+\| main/);
  assert.match(text, /\| Needs\s+\| commit, push, review large files/);
  assert.match(text, /\| Changes\s+\| stg:1 mod:2 new:3/);
  assert.match(text, /\| Remote\s+\| push \+2/);
  assert.match(text, /app-admin\n\+[-+]+\+\n\| Field/);
  assert.match(text, /\| Branch\s+\| DETACHED/);
  assert.match(text, /\| Needs\s+\| attach branch/);
  assert.match(text, /\| Remote\s+\| detached/);
  assert.match(text, /done-worktree/);
  assert.match(text, /\| Needs\s+\| prune/);
  assert.match(text, /\| Remote\s+\| prune \(origin\/main\)/);
  assert.match(text, /12.0MB/);
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
