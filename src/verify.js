import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { inspectLivePrimaryBranch, inspectDefaultBranchContainment } from './default-branch.js';
import { mapWithConcurrency, parseRemoteRepository, resolveConcurrency } from './scanner.js';

// A targeted, read-only report for clients that already have an inventory.
// No discovery, GitHub CLI, status/ignored scan, fetch, or disk-size traversal.
export async function verifyRepository(root, options = {}) {
  const runGit = options.runGit ?? git;
  const cwd = fs.realpathSync(path.resolve(root));
  const commandOptions = {
    timeoutMs: 10_000,
    env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  };
  const listed = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'], commandOptions);
  if (!listed.ok) throw new Error('Could not read this repository’s registered worktrees. Check repository access.');
  const worktrees = parseRegisteredWorktrees(listed.stdout);
  if (worktrees.length === 0) throw new Error('No registered checkouts were found in this repository.');

  const primaryPath = canonicalPath(worktrees[0].path);
  const remote = await runGit(cwd, ['config', '--get', 'remote.origin.url'], commandOptions);
  const repository = remote.ok ? parseRemoteRepository(remote.stdout.trim()) : null;
  const inspect = options.inspectPrimaryBranch ?? inspectLivePrimaryBranch;
  const evidence = await inspect(cwd, 'origin', { runGit });
  const fields = {
    defaultBranch: evidence.branch,
    defaultBranchRef: evidence.ref,
    defaultBranchHead: evidence.head,
    defaultBranchStatus: evidence.status,
    defaultBranchCheckedAt: evidence.checkedAt,
    defaultBranchError: evidence.error ?? null,
  };
  const comparisons = new Map();
  const inspectContainment = options.inspectContainment ?? inspectDefaultBranchContainment;
  await mapWithConcurrency(worktrees, Math.min(4, resolveConcurrency(options)), async (worktree) => {
    if (!comparisons.has(worktree.headFull)) {
      comparisons.set(worktree.headFull, inspectContainment(
        cwd, worktree.headFull, evidence, { runGit },
      ));
    }
    const comparison = await comparisons.get(worktree.headFull);
    Object.assign(worktree, fields, {
      path: canonicalPath(worktree.path),
      defaultBranchContainment: comparison.containment,
      defaultBranchComparisonError: comparison.error ?? null,
    });
  });

  return {
    schemaVersion: 1,
    kind: 'default-branch-verification',
    generatedAt: new Date().toISOString(),
    roots: [cwd],
    // Keep the scan envelope so consumers can share a decoder; this report
    // intentionally contains no cleanup tiers or permission to remove files.
    repos: [{ primaryPath, repository, ...fields, worktrees }],
  };
}

export function formatVerificationText(report) {
  const repo = report.repos[0];
  const lines = [
    'Git Groundskeeper default-branch verification (read-only)',
    `Repository: ${repo.repository ?? repo.primaryPath}`,
    `Default branch: ${repo.defaultBranchRef ?? 'unavailable'}`,
    `Live commit: ${repo.defaultBranchHead ?? 'unavailable'}`,
    `Checked: ${repo.defaultBranchCheckedAt ?? 'not verified'}`,
  ];
  if (repo.defaultBranchError) lines.push(`Verification: ${repo.defaultBranchError.message}`);
  for (const worktree of repo.worktrees) {
    const reason = worktree.defaultBranchComparisonError?.message;
    lines.push(`${worktree.defaultBranchContainment}: ${worktree.path}${reason ? ` — ${reason}` : ''}`);
  }
  lines.push('This report verifies commit history only; cleanup still requires fresh ownership and content checks.');
  return lines.join('\n');
}

function canonicalPath(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function parseRegisteredWorktrees(output) {
  const result = [];
  let current = null;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      if (current) result.push(current);
      current = { path: field.slice(9), headFull: null, branch: null, detached: false };
    } else if (current && field.startsWith('HEAD ')) {
      current.headFull = field.slice(5);
    } else if (current && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    } else if (current && field === 'detached') {
      current.detached = true;
    }
  }
  if (current) result.push(current);
  return result;
}
