import fs from 'node:fs';
import os from 'node:os';
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
  // Home-level noise, pruned so a bare `scan` can default to the home
  // directory and still finish in seconds. Package manager caches are listed
  // because their registry checkouts are real Git repositories.
  'Applications',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  '.Trash',
  '.bun',
  '.cache',
  '.cargo',
  '.gem',
  '.npm',
  '.nvm',
  '.pub-cache',
  '.pyenv',
  '.rbenv',
  '.rustup',
  // Scratch space. Agent tools stage and back up plugin marketplaces here as
  // real repositories, which is noise rather than work. Codex alone leaves
  // ~87 of them under ~/.codex/.tmp while keeping only 3 real worktrees.
  '.staging',
  '.tmp',
]);

// Agent tools check out real linked worktrees under hidden home directories,
// for example ~/.codex/worktrees/<hash>/<repo>. Those are the worktrees most
// easily forgotten, so no hidden directory is pruned by pattern. Anything
// skipped must be named in SKIP_DIRS deliberately.
export function defaultRoots() {
  return [os.homedir()];
}

export function resolveConcurrency(options = {}) {
  if (Number.isInteger(options.concurrency) && options.concurrency > 0) {
    return options.concurrency;
  }
  const available = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, available);
}

// Runs mapper over items with at most `limit` in flight, preserving order.
// Callers must never pool from inside a pooled task: the outer workers would
// hold every slot while waiting on inner work that can never be scheduled.
// scanRoots is therefore structured as flat phases rather than nested maps.
export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

export async function scanRoots(roots, options = {}) {
  const startedAt = new Date().toISOString();
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const concurrency = resolveConcurrency(options);

  // Phase 1: filesystem discovery. Stays synchronous; it is fs-bound and cheap
  // relative to the Git work that follows.
  const discoveredWorktrees = discoverWorktrees(normalizedRoots, options);

  // Phase 2: resolve each hit to its repository identity and ask Git for the
  // worktrees it owns. Only leaf Git calls run here, so pooling is safe.
  const identified = await mapWithConcurrency(discoveredWorktrees, concurrency, async (worktreePath) => ({
    worktreePath,
    commonDir: await getCommonGitDir(worktreePath),
    linkedWorktreePaths: await listLinkedWorktreePaths(worktreePath),
  }));

  // Phase 3: group by common Git directory. Pure bookkeeping.
  const reposByCommonDir = new Map();

  for (const { worktreePath, commonDir, linkedWorktreePaths } of identified) {
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

    for (const linkedWorktree of linkedWorktreePaths) {
      repo.worktreePaths.add(linkedWorktree);
    }

    repo.worktreePaths.add(worktreePath);
  }

  const repoRecords = [...reposByCommonDir.values()];

  for (const repo of repoRecords) {
    const worktreePathsInGitOrder = [...repo.worktreePaths];
    repo.worktreePathsSorted = [...worktreePathsInGitOrder].sort((a, b) => a.localeCompare(b));
    repo.primaryPath = pickPrimaryPath(repo.discoveryRoots, worktreePathsInGitOrder, repo.worktreePathsSorted);
  }

  // Phase 3.5: ownership, resolved before anything expensive runs. Filtering
  // after the scan would still pay for repositories you do not own, and those
  // are reliably the slowest things on a disk: a vendored dependency with a
  // huge working tree can hold a whole scan open by itself while `git status`
  // walks it. One config read per repository buys the right to skip all of it.
  const ownersByRepo = await mapWithConcurrency(repoRecords, concurrency, (repo) =>
    listRemoteOwners(repo.primaryPath),
  );

  for (const [index, repo] of repoRecords.entries()) {
    repo.owners = ownersByRepo[index];
    repo.ownership = classifyOwnership(repo.owners, options.owners ?? []);
  }

  const selectedRepos = options.onlyMine
    ? repoRecords.filter((repo) => repo.ownership === 'mine')
    : repoRecords;

  // Phase 4: scan every selected worktree as one flat pool. Flattening matters:
  // a single repository with 71 worktrees would otherwise straggle while the
  // rest of the pool sat idle.
  const worktreeJobs = selectedRepos.flatMap((repo) =>
    repo.worktreePathsSorted.map((worktreePath) => ({ repo, worktreePath })),
  );

  const scannedWorktrees = await mapWithConcurrency(worktreeJobs, concurrency, ({ worktreePath }) =>
    scanWorktree(worktreePath, options),
  );

  const worktreesByRepo = new Map(selectedRepos.map((repo) => [repo, []]));
  for (const [index, job] of worktreeJobs.entries()) {
    worktreesByRepo.get(job.repo).push(scannedWorktrees[index]);
  }

  // Phase 5: repository-level work, using the worktrees already scanned.
  const repos = (
    await mapWithConcurrency(selectedRepos, concurrency, (repo) =>
      finishRepo(repo, worktreesByRepo.get(repo), options),
    )
  ).sort((a, b) => a.primaryPath.localeCompare(b.primaryPath));

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

async function finishRepo(repo, worktrees, options) {
  const primaryPath = repo.primaryPath;
  const branchMap = new Map();

  for (const branch of await listBranches(primaryPath, worktrees)) {
    branchMap.set(branch.name, branch);
  }

  applyBranchStateToWorktrees(worktrees, branchMap);
  await annotatePruneCandidates(primaryPath, worktrees, branchMap);

  const stashes = await listStashes(primaryPath);

  return {
    primaryPath,
    commonDir: repo.commonDir,
    nestedRepos: [],
    owners: repo.owners,
    ownership: repo.ownership,
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

async function scanWorktree(worktreePath, options) {
  const branch = await getCurrentBranch(worktreePath);
  const head = (await git(worktreePath, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  const statusEntries = await listStatusEntries(worktreePath, options);
  const largeFileEntries = await resolveLargeFileEntries(worktreePath, statusEntries, options);
  const largeFiles = findLargeDirtyFiles(worktreePath, largeFileEntries, options.largeFileBytes ?? 10 * 1024 * 1024);

  // A worktree on a branch gets its upstream and ahead/behind overwritten by
  // applyBranchStateToWorktrees from the branch map, which derives them from a
  // single for-each-ref per repository. Computing them here too would spawn two
  // more Git processes per worktree only to discard the answers. Detached HEADs
  // have no branch row, so they are the only case that still needs the lookup.
  const upstream = branch ? { name: null, status: 'none', error: null } : await getUpstream(worktreePath);
  const aheadBehind = !branch && upstream.name
    ? await getAheadBehind(worktreePath, 'HEAD', upstream.name)
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

async function listBranches(cwd, worktrees) {
  const checkedOutByBranch = new Map();
  for (const worktree of worktrees) {
    if (worktree.branch) {
      checkedOutByBranch.set(worktree.branch, worktree.path);
    }
  }

  // %(upstream:track) makes Git report ahead/behind inside this same call. The
  // previous shape spawned one rev-list per branch, so a repository with two
  // hundred branches paid two hundred process spawns to learn what for-each-ref
  // already knew.
  const output = await mustGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)%09%(upstream:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(upstream:track,nobracket)',
    'refs/heads',
  ]);

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, head, lastCommitDate, track] = line.split('\t');
      const upstreamName = upstream || null;
      const tracking = parseUpstreamTrack(track, upstreamName);

      return {
        name,
        upstream: upstreamName,
        upstreamStatus: tracking.status,
        cleanupStatus: null,
        ahead: tracking.ahead,
        behind: tracking.behind,
        head,
        lastCommitDate,
        checkedOut: checkedOutByBranch.has(name),
        worktreePath: checkedOutByBranch.get(name) ?? null,
      };
    });
}

// `%(upstream:track,nobracket)` yields "", "gone", "ahead 3", "behind 2", or
// "ahead 3, behind 2". An empty value is ambiguous on its own because it means
// both "no upstream" and "in sync", so the upstream name is what decides.
function parseUpstreamTrack(track, upstreamName) {
  if (!upstreamName) {
    return { status: 'none', ahead: null, behind: null };
  }

  const value = (track ?? '').trim();
  if (value === 'gone') {
    return { status: 'gone', ahead: null, behind: null };
  }

  const ahead = /ahead (\d+)/.exec(value);
  const behind = /behind (\d+)/.exec(value);

  return {
    status: 'tracking',
    ahead: ahead ? Number.parseInt(ahead[1], 10) : 0,
    behind: behind ? Number.parseInt(behind[1], 10) : 0,
  };
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

async function annotatePruneCandidates(cwd, worktrees, branchMap) {
  // Resolving base refs costs roughly eight Git calls. Most repositories have
  // no candidate at all, so doing it first spent that on every repository on
  // the machine to answer a question with no askers.
  const candidates = worktrees.filter(
    (worktree) => worktree.branch && !worktree.dirty && worktree.upstreamStatus === 'gone',
  );
  if (candidates.length === 0) return;

  const baseRefs = await listPruneBaseRefs(cwd);

  for (const worktree of candidates) {
    const branch = branchMap.get(worktree.branch);
    if (!branch) continue;

    let mergedInto = null;
    for (const baseRef of baseRefs) {
      if (await isAncestor(cwd, worktree.branch, baseRef)) {
        mergedInto = baseRef;
        break;
      }
    }

    if (!mergedInto) continue;

    worktree.cleanupStatus = 'prune-candidate';
    worktree.mergedInto = mergedInto;
    branch.cleanupStatus = 'prune-candidate';
    branch.mergedInto = mergedInto;
  }
}

async function listPruneBaseRefs(cwd) {
  const candidates = [
    'origin/dev',
    'origin/main',
    'origin/master',
    await getDefaultRemoteHead(cwd),
    'dev',
    'main',
    'master',
  ].filter(Boolean);

  const baseRefs = [];
  for (const ref of new Set(candidates)) {
    if (await refExists(cwd, ref)) {
      baseRefs.push(ref);
    }
  }

  return baseRefs;
}

async function getDefaultRemoteHead(cwd) {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function refExists(cwd, ref) {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

async function isAncestor(cwd, maybeAncestor, descendant) {
  return (await git(cwd, ['merge-base', '--is-ancestor', maybeAncestor, descendant])).ok;
}

async function listLinkedWorktreePaths(cwd) {
  const result = await git(cwd, ['worktree', 'list', '--porcelain']);
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

async function listStashes(cwd) {
  const result = await git(cwd, ['stash', 'list']);
  if (!result.ok || !result.stdout.trim()) return [];

  return result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [ref, ...rest] = line.split(': ');
      return { ref, message: rest.join(': ') };
    });
}

// Untracked mode is the dominant cost of a wide scan. `all` lists every file
// inside an untracked directory, so a single build output folder can produce
// thousands of records, each of which is then stat'd for large-file checks.
// `normal` collapses those to one entry per directory, which is enough to
// answer "is there untracked work here". Pass `all` to see inside them.
async function listStatusEntries(cwd, options = {}) {
  const untrackedFiles = options.untrackedFiles === 'all' ? 'all' : 'normal';
  const result = await git(cwd, ['status', '--porcelain=v1', '-z', `--untracked-files=${untrackedFiles}`], {
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

// The cheap sweep collapses an untracked directory to a single opaque entry,
// which statSync reports as a directory, so a 2 GB file inside an untracked
// build/ would never be weighed. Large *dirty* files only exist where there is
// dirt, though, so only the worktrees actually hiding an untracked directory
// need the deep listing. Everything clean is free, and the reported summary
// still counts the directory once rather than every file beneath it.
async function resolveLargeFileEntries(cwd, entries, options) {
  if (options.untrackedFiles === 'all') return entries;

  const hidesUntrackedDirectory = entries.some((entry) => entry.untracked && entry.path.endsWith('/'));
  if (!hidesUntrackedDirectory) return entries;

  return listStatusEntries(cwd, { ...options, untrackedFiles: 'all' });
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

// Most repositories on a developer's disk are not theirs: vendored
// dependencies, cloned references, plugin marketplaces, agent scratch. Flagging
// those as "needing attention" is noise, and noise is what makes a scanner
// useless at machine scale. A remote pointing at an account you control is the
// cheapest honest signal of ownership.
async function listRemoteOwners(cwd) {
  const result = await git(cwd, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  if (!result.ok) return [];

  const urls = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(' ') + 1).trim());

  return [...new Set(urls.map(parseRemoteOwner).filter(Boolean))];
}

// Handles scp-style (git@host:owner/repo.git), ssh:// and https:// URLs.
// Returns null for local path remotes, which have no owner to speak of.
export function parseRemoteOwner(url) {
  const scpStyle = /^[^/@]+@([^:/]+):(.+)$/.exec(url);
  let repoPath;

  if (scpStyle) {
    repoPath = scpStyle[2];
  } else {
    try {
      repoPath = new URL(url).pathname;
    } catch {
      return null;
    }
  }

  const segments = repoPath
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);

  return segments.length >= 2 ? segments[segments.length - 2] : null;
}

export function classifyOwnership(repoOwners, myOwners) {
  if (myOwners.length === 0) return 'unknown';
  if (repoOwners.length === 0) return 'no-remote';

  const normalized = myOwners.map((owner) => owner.toLowerCase());
  const mine = repoOwners.some((owner) => normalized.includes(owner.toLowerCase()));

  return mine ? 'mine' : 'external';
}

async function getCurrentBranch(cwd) {
  const branch = (await git(cwd, ['branch', '--show-current'])).stdout.trim();
  return branch || null;
}

async function getUpstream(cwd) {
  const result = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!result.ok) {
    return { name: null, status: 'none', error: result.stderr.trim() };
  }
  return { name: result.stdout.trim(), status: 'tracking', error: null };
}

async function getAheadBehind(cwd, left, right) {
  const result = await git(cwd, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  if (!result.ok) {
    return { ahead: null, behind: null, error: result.stderr.trim() };
  }

  const [ahead, behind] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
  return { ahead, behind, error: null };
}

async function getCommonGitDir(cwd) {
  const result = await git(cwd, ['rev-parse', '--git-common-dir']);
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
