import fs from 'node:fs';
import path from 'node:path';
import { git, mustGit } from './git.js';

const SKIP_DIRS = new Set([
  '.git',
  '.dart_tool',
  '.gradle',
  '.next',
  '.turbo',
  '.vercel',
  'Pods',
  'build',
  'coverage',
  'DerivedData',
  'dist',
  'node_modules',
  'target',
]);

export function scanRoots(roots, options = {}) {
  const startedAt = new Date().toISOString();
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const discoveredWorktrees = discoverWorktrees(normalizedRoots, options);
  const reposByCommonDir = new Map();

  for (const worktreePath of discoveredWorktrees) {
    const commonDir = getCommonGitDir(worktreePath);
    if (!commonDir) continue;

    if (!reposByCommonDir.has(commonDir)) {
      reposByCommonDir.set(commonDir, {
        commonDir,
        discoveryRoots: [],
        worktreePaths: new Set(),
      });
    }

    const repo = reposByCommonDir.get(commonDir);
    repo.discoveryRoots.push(worktreePath);

    for (const linkedWorktree of listLinkedWorktreePaths(worktreePath)) {
      repo.worktreePaths.add(linkedWorktree);
    }

    repo.worktreePaths.add(worktreePath);
  }

  const repos = [...reposByCommonDir.values()]
    .map((repo) => scanRepo(repo, options))
    .sort((a, b) => a.primaryPath.localeCompare(b.primaryPath));

  attachNestedRepoInfo(repos);

  return {
    schemaVersion: 1,
    generatedAt: startedAt,
    roots: normalizedRoots,
    summary: buildSummary(repos),
    repos,
  };
}

export function discoverWorktrees(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const found = new Set();
  const seenDirs = new Set();

  for (const root of roots) {
    walk(root, 0);
  }

  return [...found].sort((a, b) => a.localeCompare(b));

  function walk(dir, depth) {
    const resolved = safeRealpath(dir);
    if (!resolved || seenDirs.has(resolved) || depth > maxDepth) return;
    seenDirs.add(resolved);

    const basename = path.basename(resolved);
    if (depth > 0 && SKIP_DIRS.has(basename)) return;

    if (hasGitMetadata(resolved)) {
      found.add(resolved);
    }

    let entries;
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(resolved, entry.name), depth + 1);
    }
  }
}

function scanRepo(repo, options) {
  const worktreePathsInGitOrder = [...repo.worktreePaths];
  const worktreePaths = [...worktreePathsInGitOrder].sort((a, b) => a.localeCompare(b));
  const primaryPath = pickPrimaryPath(repo.discoveryRoots, worktreePathsInGitOrder, worktreePaths);
  const worktrees = worktreePaths.map((worktreePath) => scanWorktree(worktreePath, options));
  const branchMap = new Map();

  for (const branch of listBranches(primaryPath, worktrees)) {
    branchMap.set(branch.name, branch);
  }

  applyBranchStateToWorktrees(worktrees, branchMap);
  annotatePruneCandidates(primaryPath, worktrees, branchMap);

  const stashes = listStashes(primaryPath);

  return {
    primaryPath,
    commonDir: repo.commonDir,
    nestedRepos: [],
    worktrees,
    branches: [...branchMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stashes,
    status: classifyRepo(worktrees, [...branchMap.values()], stashes),
  };
}

function pickPrimaryPath(discoveryRoots, worktreePathsInGitOrder, sortedWorktreePaths) {
  const usableWorktreePathsInGitOrder = worktreePathsInGitOrder.filter((worktreePath) => !isGitStoragePath(worktreePath));

  if (usableWorktreePathsInGitOrder.length > 0) {
    return usableWorktreePathsInGitOrder[0];
  }

  return sortedWorktreePaths.find((worktreePath) => !isGitStoragePath(worktreePath)) ?? discoveryRoots[0];
}

function scanWorktree(worktreePath, options) {
  const branch = getCurrentBranch(worktreePath);
  const head = git(worktreePath, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  const statusEntries = listStatusEntries(worktreePath);
  const largeFiles = findLargeDirtyFiles(worktreePath, statusEntries, options.largeFileBytes ?? 10 * 1024 * 1024);
  const upstream = getUpstream(worktreePath);
  const aheadBehind = upstream.name
    ? getAheadBehind(worktreePath, 'HEAD', upstream.name)
    : { ahead: null, behind: null, error: upstream.error ?? null };

  return {
    path: worktreePath,
    branch: branch ?? null,
    detached: branch === null,
    head,
    upstream: upstream.name,
    upstreamStatus: upstream.status,
    cleanupStatus: null,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirty: statusEntries.length > 0,
    status: summarizeStatus(statusEntries),
    largeFiles,
    entries: statusEntries,
  };
}

function listBranches(cwd, worktrees) {
  const checkedOutByBranch = new Map();
  for (const worktree of worktrees) {
    if (worktree.branch) {
      checkedOutByBranch.set(worktree.branch, worktree.path);
    }
  }

  const output = mustGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:iso8601)',
    'refs/heads',
  ]);

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, head, lastCommitDate] = line.split('\t');
      const upstreamName = upstream || null;
      const aheadBehind = upstreamName
        ? getAheadBehind(cwd, name, upstreamName)
        : { ahead: null, behind: null, error: null };

      return {
        name,
        upstream: upstreamName,
        upstreamStatus: upstreamName ? (aheadBehind.error ? 'gone' : 'tracking') : 'none',
        cleanupStatus: null,
        ahead: aheadBehind.ahead,
        behind: aheadBehind.behind,
        head,
        lastCommitDate,
        checkedOut: checkedOutByBranch.has(name),
        worktreePath: checkedOutByBranch.get(name) ?? null,
      };
    });
}

function applyBranchStateToWorktrees(worktrees, branchMap) {
  for (const worktree of worktrees) {
    if (!worktree.branch) continue;

    const branch = branchMap.get(worktree.branch);
    if (!branch) continue;

    worktree.upstream = branch.upstream;
    worktree.upstreamStatus = branch.upstreamStatus;
    worktree.cleanupStatus = branch.cleanupStatus;
    worktree.ahead = branch.ahead;
    worktree.behind = branch.behind;
  }
}

function annotatePruneCandidates(cwd, worktrees, branchMap) {
  const baseRefs = listPruneBaseRefs(cwd);

  for (const worktree of worktrees) {
    if (!worktree.branch || worktree.dirty || worktree.upstreamStatus !== 'gone') continue;

    const branch = branchMap.get(worktree.branch);
    if (!branch) continue;

    const mergedInto = baseRefs.find((baseRef) => isAncestor(cwd, worktree.branch, baseRef));
    if (!mergedInto) continue;

    worktree.cleanupStatus = 'prune-candidate';
    worktree.mergedInto = mergedInto;
    branch.cleanupStatus = 'prune-candidate';
    branch.mergedInto = mergedInto;
  }
}

function listPruneBaseRefs(cwd) {
  const candidates = [
    'origin/dev',
    'origin/main',
    'origin/master',
    getDefaultRemoteHead(cwd),
    'dev',
    'main',
    'master',
  ].filter(Boolean);

  return [...new Set(candidates)].filter((ref) => refExists(cwd, ref));
}

function getDefaultRemoteHead(cwd) {
  const result = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

function refExists(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref]).ok;
}

function isAncestor(cwd, maybeAncestor, descendant) {
  return git(cwd, ['merge-base', '--is-ancestor', maybeAncestor, descendant]).ok;
}

function listLinkedWorktreePaths(cwd) {
  const result = git(cwd, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return [cwd];

  const paths = [];
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const worktreePath = path.resolve(line.slice('worktree '.length));
      const realWorktreePath = safeRealpath(worktreePath) ?? worktreePath;
      if (!isGitStoragePath(realWorktreePath)) {
        paths.push(realWorktreePath);
      }
    }
  }

  return paths.length > 0 ? paths : [cwd];
}

function listStashes(cwd) {
  const result = git(cwd, ['stash', 'list']);
  if (!result.ok || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [ref, ...rest] = line.split(': ');
      return { ref, message: rest.join(': ') };
    });
}

function listStatusEntries(cwd) {
  const result = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    encoding: 'buffer',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!result.ok || result.stdout.length === 0) return [];

  const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
  const entries = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    const hasOriginalPath = code.includes('R') || code.includes('C');

    entries.push({
      code,
      path: filePath,
      originalPath: hasOriginalPath ? records[++index] ?? null : null,
      staged: code[0] !== ' ' && code[0] !== '?' && code[0] !== '!',
      unstaged: code[1] !== ' ' && code[1] !== '?' && code[1] !== '!',
      untracked: code === '??',
      ignored: code === '!!',
    });
  }

  return entries;
}

function summarizeStatus(entries) {
  return entries.reduce(
    (summary, entry) => {
      summary.total += 1;
      if (entry.staged) summary.staged += 1;
      if (entry.unstaged) summary.unstaged += 1;
      if (entry.untracked) summary.untracked += 1;
      if (entry.ignored) summary.ignored += 1;
      return summary;
    },
    { total: 0, staged: 0, unstaged: 0, untracked: 0, ignored: 0 },
  );
}

function findLargeDirtyFiles(cwd, entries, thresholdBytes) {
  const largeFiles = [];

  for (const entry of entries) {
    const absolutePath = path.join(cwd, entry.path);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }

    if (stat.isFile() && stat.size >= thresholdBytes) {
      largeFiles.push({
        path: entry.path,
        bytes: stat.size,
      });
    }
  }

  return largeFiles.sort((a, b) => b.bytes - a.bytes);
}

function getCurrentBranch(cwd) {
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim();
  return branch || null;
}

function getUpstream(cwd) {
  const result = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!result.ok) {
    return { name: null, status: 'none', error: result.stderr.trim() };
  }
  return { name: result.stdout.trim(), status: 'tracking', error: null };
}

function getAheadBehind(cwd, left, right) {
  const result = git(cwd, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  if (!result.ok) {
    return { ahead: null, behind: null, error: result.stderr.trim() };
  }

  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return { ahead, behind, error: null };
}

function getCommonGitDir(cwd) {
  const result = git(cwd, ['rev-parse', '--git-common-dir']);
  if (!result.ok) return null;

  const rawPath = result.stdout.trim();
  if (!rawPath) return null;

  return path.resolve(cwd, rawPath);
}

function attachNestedRepoInfo(repos) {
  const sorted = [...repos].sort((a, b) => a.primaryPath.length - b.primaryPath.length);

  for (const repo of sorted) {
    for (const maybeChild of sorted) {
      if (repo === maybeChild) continue;
      if (isInsideAnyWorktree(maybeChild.primaryPath, repo.worktrees.map((worktree) => worktree.path))) {
        repo.nestedRepos.push({
          path: maybeChild.primaryPath,
          dirty: maybeChild.worktrees.some((worktree) => worktree.dirty),
          status: maybeChild.status,
        });
      }
    }
  }
}

function isInsideAnyWorktree(candidate, worktreePaths) {
  return worktreePaths.some((worktreePath) => {
    const relative = path.relative(worktreePath, candidate);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function classifyRepo(worktrees, branches, stashes) {
  const dirtyWorktrees = worktrees.filter((worktree) => worktree.dirty).length;
  const branchesAhead = branches.filter((branch) => Number.isInteger(branch.ahead) && branch.ahead > 0).length;
  const noUpstream = branches.filter((branch) => branch.upstreamStatus === 'none').length;
  const goneUpstream = branches.filter((branch) => branch.upstreamStatus === 'gone').length;
  const detachedWorktrees = worktrees.filter((worktree) => worktree.detached).length;
  const largeFileWorktrees = worktrees.filter((worktree) => worktree.largeFiles.length > 0).length;

  if (dirtyWorktrees > 0) return 'commit-needed';
  if (branchesAhead > 0) return 'push-needed';
  if (goneUpstream > 0) return 'upstream-gone';
  if (noUpstream > 0) return 'no-upstream';
  if (stashes.length > 0) return 'stash-present';
  if (detachedWorktrees > 0) return 'detached';
  if (largeFileWorktrees > 0) return 'large-file-review';
  return 'clean';
}

function buildSummary(repos) {
  const summary = {
    repoCount: repos.length,
    worktreeCount: 0,
    dirtyWorktreeCount: 0,
    branchAheadCount: 0,
    noUpstreamBranchCount: 0,
    goneUpstreamBranchCount: 0,
    stashCount: 0,
    nestedRepoCount: 0,
    attentionCount: 0,
  };

  for (const repo of repos) {
    summary.worktreeCount += repo.worktrees.length;
    summary.dirtyWorktreeCount += repo.worktrees.filter((worktree) => worktree.dirty).length;
    summary.branchAheadCount += repo.branches.filter((branch) => Number.isInteger(branch.ahead) && branch.ahead > 0).length;
    summary.noUpstreamBranchCount += repo.branches.filter((branch) => branch.upstreamStatus === 'none').length;
    summary.goneUpstreamBranchCount += repo.branches.filter((branch) => branch.upstreamStatus === 'gone').length;
    summary.stashCount += repo.stashes.length;
    summary.nestedRepoCount += repo.nestedRepos.length;

    if (repo.status !== 'clean') {
      summary.attentionCount += 1;
    }
  }

  return summary;
}

function hasGitMetadata(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function isGitStoragePath(candidatePath) {
  return path.normalize(candidatePath).split(path.sep).includes('.git');
}

function safeRealpath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}
