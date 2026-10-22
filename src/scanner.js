import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { git, mustGit } from './git.js';
import { inspectLivePrimaryBranch, inspectDefaultBranchContainment } from './default-branch.js';
import {
  listMergedPullRequestBranches,
  listOpenDraftPullRequestBranches,
} from './owners.js';

const execFileAsync = promisify(execFile);
const LIVE_REMOTE_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE = 'origin';
const REPOSITORY_POLICY_FILE = 'groundskeeper-policy.json';
const REPOSITORY_POLICY_SCHEMA_VERSION = 1;
const MAX_REPOSITORY_POLICY_BYTES = 256 * 1024;

const SKIP_DIRS = new Set([
  '.git',
  '.dart_tool',
  '.gradle',
  '.next',
  '.terraform',
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
  'SourcePackages',
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

// Xcode and SwiftPM commonly suffix or hide their checkout roots (for example
// `.derivedData-3i/SourcePackages/checkouts/`). Those directories contain real
// Git repositories, but they are dependency caches rather than user
// worktrees. Exact-name pruning alone lets them leak into scans and can make a
// broken cache abort an otherwise healthy forest walk.
function shouldSkipDirectory(name, parentPath = null) {
  return SKIP_DIRS.has(name)
    || name === '.build'
    || /^\.?deriveddata(?:$|[-_.])/i.test(name)
    // Gemini stores internal snapshot repositories here. They are tool
    // history, not checkouts a user should push, prune, or size as project
    // work. Keep other hidden Gemini directories discoverable by default.
    || (name === 'history' && path.basename(parentPath ?? '') === '.gemini');
}

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

function createDefaultBranchComparisonLimiter(limit) {
  // This pool is independent of the repository workers. Sharing it across
  // repositories bounds Git processes without nesting the repository pool.
  const running = new Set();
  return async (compare) => {
    while (running.size >= limit) await Promise.race(running).catch(() => {});
    const result = Promise.resolve().then(compare);
    running.add(result);
    try { return await result; } finally { running.delete(result); }
  };
}

export async function scanRoots(roots, options = {}) {
  const startedAt = new Date().toISOString();
  // macOS exposes /tmp as a symlink to /private/tmp. Keep one canonical path
  // vocabulary throughout the report so later root scoping cannot mistake the
  // same directory for an out-of-root worktree.
  const normalizedRoots = roots.map(canonicalPath);
  const concurrency = resolveConcurrency(options);
  const limitDefaultBranchComparison = createDefaultBranchComparisonLimiter(Math.min(4, concurrency));
  const directoryIdentity = options.directoryIdentity ?? filesystemIdentity;

  // Phase 1: filesystem discovery. The walk yields cooperatively so progress,
  // signals, and other event-loop work stay responsive across large forests.
  notifyProgress(options, {
    phase: 'discovery',
    label: 'Discovering repositories',
    completed: 0,
    total: null,
    visitedDirectories: 0,
    discoveredRepositories: 0,
  });
  const discoveredWorktrees = await discoverWorktreesAsync(normalizedRoots, options);

  // Phase 2: resolve each hit to its repository identity and ask Git for the
  // worktrees it owns. Only leaf Git calls run here, so pooling is safe.
  let identifiedCount = 0;
  notifyProgress(options, progressEvent('resolve', 'Resolving repositories', identifiedCount, discoveredWorktrees.length));
  const identified = await mapWithConcurrency(discoveredWorktrees, concurrency, async (worktreePath) => {
    const result = {
      worktreePath,
      commonDir: await getCommonGitDir(worktreePath),
    };
    identifiedCount += 1;
    notifyProgress(
      options,
      progressEvent('resolve', 'Resolving repositories', identifiedCount, discoveredWorktrees.length),
    );
    return result;
  });

  // Phase 3: group by common Git directory. Pure bookkeeping.
  const reposByCommonDir = new Map();

  for (const { worktreePath, commonDir } of identified) {
    if (!commonDir) continue;
    const commonDirIdentity = resolveDirectoryIdentity(commonDir, directoryIdentity);

    if (!reposByCommonDir.has(commonDirIdentity)) {
      reposByCommonDir.set(commonDirIdentity, {
        commonDir,
        discoveryRoots: [],
        worktreePaths: new Set(),
      });
    }

    const repo = reposByCommonDir.get(commonDirIdentity);
    repo.discoveryRoots.push(worktreePath);

    repo.worktreePaths.add(worktreePath);
  }

  const repoRecords = [...reposByCommonDir.values()];

  // Discovery often finds several linked worktrees from the same repository.
  // `git worktree list` is repository-wide, so ask once per common git dir
  // instead of once per discovered checkout.
  const queryLinkedWorktreePaths = options.listLinkedWorktreePaths ?? listLinkedWorktreePaths;
  const linkedPathsByRepo = await mapWithConcurrency(repoRecords, concurrency, (repo) =>
    queryLinkedWorktreePaths(repo.discoveryRoots[0]),
  );

  for (const [index, repo] of repoRecords.entries()) {
    // Git's registry is authoritative when the same checkout is reachable by
    // two filesystem spellings. In particular, APFS firmlinks expose
    // /Users/... again below /System/Volumes/Data/Users/.... Keeping both
    // strings would turn the alias into a non-primary cleanup candidate.
    repo.worktreePathsInGitOrder = uniquePathsByIdentity(
      linkedPathsByRepo[index],
      directoryIdentity,
    );
    repo.worktreePaths = new Set(uniquePathsByIdentity(
      [...repo.worktreePathsInGitOrder, ...repo.worktreePaths],
      directoryIdentity,
    ));
  }

  for (const repo of repoRecords) {
    const worktreePathsInGitOrder = repo.worktreePathsInGitOrder;
    // Preserve copied/aliased worktrees found by the filesystem even though
    // Git's registry quite correctly does not list those duplicate paths.
    repo.worktreePathsSorted = [...repo.worktreePaths].sort((a, b) => a.localeCompare(b));
    repo.primaryPath = pickPrimaryPath(repo.discoveryRoots, worktreePathsInGitOrder, repo.worktreePathsSorted);
    repo.ignoredContentPolicy = loadRepositoryIgnoredContentPolicy(repo.commonDir);
  }

  // Phase 3.5: ownership, resolved before anything expensive runs. Filtering
  // after the scan would still pay for repositories you do not own, and those
  // are reliably the slowest things on a disk: a vendored dependency with a
  // huge working tree can hold a whole scan open by itself while `git status`
  // walks it. One config read per repository buys the right to skip all of it.
  let ownershipCount = 0;
  notifyProgress(options, progressEvent('ownership', 'Reading repository ownership', ownershipCount, repoRecords.length));
  const ownersByRepo = await mapWithConcurrency(repoRecords, concurrency, async (repo) => {
    const owners = await listRemoteOwners(repo.primaryPath);
    ownershipCount += 1;
    notifyProgress(
      options,
      progressEvent('ownership', 'Reading repository ownership', ownershipCount, repoRecords.length),
    );
    return owners;
  });

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
    repo.worktreePathsSorted.map((worktreePath) => ({
      repo,
      worktreePath,
      measureSize: !options.scopeStrict || isInsideAnyScanRoot(worktreePath, normalizedRoots),
    })),
  );

  let scannedWorktreeCount = 0;
  notifyProgress(options, progressEvent('worktrees', 'Scanning worktrees', scannedWorktreeCount, worktreeJobs.length));
  const scannedWorktrees = await mapWithConcurrency(
    worktreeJobs,
    concurrency,
    async ({ repo, worktreePath, measureSize }) => {
      const worktree = await scanWorktree(
        worktreePath,
        { ...options, sizes: options.sizes && measureSize },
        repo.primaryPath,
        repo.ignoredContentPolicy,
      );
      scannedWorktreeCount += 1;
      notifyProgress(
        options,
        progressEvent('worktrees', 'Scanning worktrees', scannedWorktreeCount, worktreeJobs.length),
      );
      return worktree;
    },
  );

  const worktreesByRepo = new Map(selectedRepos.map((repo) => [repo, []]));
  for (const [index, job] of worktreeJobs.entries()) {
    worktreesByRepo.get(job.repo).push(scannedWorktrees[index]);
  }

  // Phase 5: repository-level work, using the worktrees already scanned.
  let finishedRepoCount = 0;
  notifyProgress(options, progressEvent('analysis', 'Analyzing repositories', finishedRepoCount, selectedRepos.length));
  const repos = (
    await mapWithConcurrency(selectedRepos, concurrency, async (repo) => {
      const finished = await finishRepo(repo, worktreesByRepo.get(repo), { ...options, limitDefaultBranchComparison });
      finishedRepoCount += 1;
      notifyProgress(
        options,
        progressEvent('analysis', 'Analyzing repositories', finishedRepoCount, selectedRepos.length),
      );
      return finished;
    })
  ).sort((a, b) => a.primaryPath.localeCompare(b.primaryPath));

  attachNestedRepoInfo(repos);
  notifyProgress(options, {
    phase: 'complete',
    label: 'Scan complete',
    completed: repos.length,
    total: repos.length,
  });

  return {
    schemaVersion: 1,
    generatedAt: startedAt,
    roots: normalizedRoots,
    maxDepth: options.maxDepth ?? 8,
    summary: buildSummary(repos),
    repos,
  };
}

function progressEvent(phase, label, completed, total) {
  return {
    phase,
    label,
    completed,
    total,
  };
}

function notifyProgress(options, event) {
  if (typeof options.onProgress !== 'function') return;
  try {
    options.onProgress(event);
  } catch {
    // Presentation must never turn a successful scan into a failed scan.
  }
}

export function discoverWorktrees(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const found = new Set();
  const seenDirs = new Set();
  const directoryIdentity = options.directoryIdentity ?? filesystemIdentity;
  const preferredPaths = preferredScanRootChildren(roots, directoryIdentity);

  for (const root of roots) {
    walk(root, 0);
  }

  return [...found].sort((a, b) => a.localeCompare(b));

  function walk(dir, depth) {
    const resolved = safeRealpath(dir);
    if (!resolved || depth > maxDepth) return;
    const identity = resolveDirectoryIdentity(resolved, directoryIdentity);
    const preferredPath = preferredPaths.get(identity);
    if (preferredPath && preferredPath !== resolved) return;
    if (seenDirs.has(identity)) return;
    seenDirs.add(identity);

    const basename = path.basename(resolved);
    if (depth > 0 && shouldSkipDirectory(basename, path.dirname(resolved))) return;

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
      if (shouldSkipDirectory(entry.name, resolved)) continue;
      walk(path.join(resolved, entry.name), depth + 1);
    }
  }
}

// The home-directory walk has historically been the longest scan phase. Keep
// the synchronous export above for callers that need it, but let scanRoots use
// a cooperative traversal so animation, Ctrl-C, and other event-loop work stay
// responsive while thousands of directories are inspected.
export async function discoverWorktreesAsync(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const yieldEvery = Math.max(1, options.discoveryYieldEvery ?? 96);
  const yieldDiscovery = options.discoveryYield ?? yieldToEventLoop;
  const found = new Set();
  const seenDirs = new Set();
  const directoryIdentity = options.directoryIdentity ?? filesystemIdentity;
  const preferredPaths = preferredScanRootChildren(roots, directoryIdentity);
  const pending = roots.map((root) => ({ dir: root, depth: 0 })).reverse();
  let visitedDirectories = 0;
  let processedCandidates = 0;

  while (pending.length > 0) {
    const { dir, depth } = pending.pop();
    processedCandidates += 1;

    if (depth <= maxDepth) {
      const resolved = safeRealpath(dir);
      const identity = resolved
        ? resolveDirectoryIdentity(resolved, directoryIdentity)
        : null;
      const preferredPath = identity ? preferredPaths.get(identity) : null;
      if (resolved && (!preferredPath || preferredPath === resolved) && !seenDirs.has(identity)) {
        seenDirs.add(identity);

        const basename = path.basename(resolved);
        if (depth === 0 || !shouldSkipDirectory(basename, path.dirname(resolved))) {
          visitedDirectories += 1;

          if (hasGitMetadata(resolved)) {
            found.add(resolved);
          }

          let entries;
          try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
          } catch {
            entries = [];
          }

          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (!entry.isDirectory() || shouldSkipDirectory(entry.name, resolved)) continue;
            pending.push({ dir: path.join(resolved, entry.name), depth: depth + 1 });
          }
        }
      }
    }

    if (processedCandidates % yieldEvery === 0) {
      notifyDiscoveryProgress(options, visitedDirectories, found.size);
      await yieldDiscovery();
    }
  }

  notifyDiscoveryProgress(options, visitedDirectories, found.size);
  return [...found].sort((a, b) => a.localeCompare(b));
}

function notifyDiscoveryProgress(options, visitedDirectories, discoveredRepositories) {
  notifyProgress(options, {
    phase: 'discovery',
    label: 'Discovering repositories',
    completed: visitedDirectories,
    total: null,
    visitedDirectories,
    discoveredRepositories,
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function finishRepo(repo, worktrees, options) {
  const primaryPath = repo.primaryPath;
  const branchMap = new Map();

  annotateAliasedWorktreeGitDirs(worktrees);

  for (const branch of await listBranches(primaryPath, worktrees)) {
    branchMap.set(branch.name, branch);
  }

  applyBranchStateToWorktrees(worktrees, branchMap);
  await annotateLiveUpstreamState(primaryPath, worktrees, branchMap, options);
  applyBranchStateToWorktrees(worktrees, branchMap);
  const pruneCandidates = collectPruneCandidates(worktrees, branchMap);
  const bucketPullRequestCandidate = options.buckets && worktrees.some(
    (worktree) => worktree.branch
      && worktree.upstreamBranch === worktree.branch
      && classifyTier(worktree, primaryPath) === 'worktree-only',
  );
  const draftPullRequestCandidate = worktrees.some(
    (worktree) => worktree.branch
      && worktree.path !== primaryPath
      && classifyTier(worktree, primaryPath) === 'worktree-only',
  );
  const needsMergedPullRequestCheck = pruneCandidates.length > 0 || bucketPullRequestCandidate;
  const needsDraftPullRequestCheck = draftPullRequestCandidate;
  let pullRequestCheck = 'not-requested';
  let draftPullRequestCheck = 'not-requested';
  let mergedPullRequests = null;
  let draftPullRequests = null;

  if (options.prCheck === false) {
    if (needsMergedPullRequestCheck) pullRequestCheck = 'skipped';
    if (needsDraftPullRequestCheck) draftPullRequestCheck = 'skipped';
  } else {
    const queryMergedPullRequests = options.listMergedPullRequests ?? listMergedPullRequestBranches;
    const queryDraftPullRequests = options.listDraftPullRequests ?? listOpenDraftPullRequestBranches;
    [mergedPullRequests, draftPullRequests] = await Promise.all([
      needsMergedPullRequestCheck
        ? queryPullRequestMap(queryMergedPullRequests, primaryPath)
        : Promise.resolve(null),
      needsDraftPullRequestCheck
        ? queryPullRequestMap(queryDraftPullRequests, primaryPath)
        : Promise.resolve(null),
    ]);
    if (needsMergedPullRequestCheck) {
      pullRequestCheck = mergedPullRequests ? 'checked' : 'unavailable';
    }
    if (needsDraftPullRequestCheck) {
      draftPullRequestCheck = draftPullRequests ? 'checked' : 'unavailable';
    }
  }

  annotatePullRequestEvidence(
    worktrees,
    branchMap,
    mergedPullRequests,
    pullRequestCheck,
    draftPullRequests,
    draftPullRequestCheck,
  );
  await annotatePruneCandidates(primaryPath, worktrees, branchMap, pruneCandidates, options);

  // Tier depends on cleanupStatus, so it can only be decided once prune
  // candidates have been resolved.
  for (const worktree of worktrees) {
    worktree.tier = classifyTier(worktree, primaryPath);
  }

  // Unmerged history is decision context specifically for checkout removal.
  // Keep it off ordinary scans: machine-wide subprocess count is already the
  // dominant cost, and non-bucket output is asking about outstanding state,
  // not whether a checkout should be reclaimed.
  if (options.buckets) {
    await annotateRemovalCandidateHistory(primaryPath, worktrees, branchMap);
  }

  // The configured integration base can intentionally be dev while the
  // repository's default branch is master. Keep those separate: cleanup still
  // uses the integration base, while the report names whether the exact tip is
  // also contained in the remote default branch.
  const needsPrimaryBranchEvidence = options.buckets && worktrees.some(
    (worktree) => worktree.path !== primaryPath
      && ['worktree-only', 'worktree-and-branch', 'push-first'].includes(worktree.tier),
  );
  const primaryBranch = needsPrimaryBranchEvidence
    ? await inspectPrimaryBranch(primaryPath, options)
    : emptyPrimaryBranchEvidence();
  if (needsPrimaryBranchEvidence) {
    await annotatePrimaryBranchContainment(primaryPath, worktrees, branchMap, primaryBranch, options);
  }

  const stashes = await listStashes(primaryPath);

  return {
    primaryPath,
    commonDir: repo.commonDir,
    repository: primaryBranch.repository,
    defaultBranch: primaryBranch.branch,
    defaultBranchRef: primaryBranch.ref,
    defaultBranchHead: primaryBranch.head,
    defaultBranchStatus: primaryBranch.status,
    defaultBranchCheckedAt: primaryBranch.checkedAt,
    defaultBranchError: primaryBranch.error ?? null,
    ignoredContentPolicy: {
      source: repo.ignoredContentPolicy.source,
      ruleCount: repo.ignoredContentPolicy.rules.length,
      errors: repo.ignoredContentPolicy.errors,
    },
    nestedRepos: [],
    owners: repo.owners,
    ownership: repo.ownership,
    // Nothing here fetches. FETCH_HEAD age still describes local comparison
    // refs used for ahead/behind and integration history. Candidate branch
    // existence is checked separately with a targeted, read-only ls-remote.
    lastFetchAt: getLastFetchAt(repo.commonDir),
    worktrees,
    branches: [...branchMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    stashes,
    status: classifyRepo(worktrees, [...branchMap.values()], stashes),
  };
}

async function queryPullRequestMap(query, cwd) {
  try {
    return await query(cwd);
  } catch {
    return null;
  }
}

function annotatePullRequestEvidence(
  worktrees,
  branchMap,
  mergedPullRequests,
  checkStatus,
  draftPullRequests,
  draftCheckStatus,
) {
  const worktreesByBranch = groupWorktreesByBranch(worktrees);

  for (const branch of branchMap.values()) {
    const candidate = mergedPullRequests?.get(branch.name) ?? null;
    // A branch name can be reused after a PR merges. Only the PR whose head is
    // the branch's current tip proves that the live remote branch is the one
    // GitHub merged; an older same-name PR is evidence about different work.
    const pullRequest = candidate && (!candidate.head || candidate.head === branch.head)
      ? candidate
      : null;
    const status = checkStatus === 'checked'
      ? pullRequest
        ? 'merged'
        : candidate
          ? 'head-moved'
          : 'not-found'
      : checkStatus;
    const draftPullRequest = draftPullRequests?.get(branch.name) ?? null;
    const draftStatus = draftCheckStatus === 'checked'
      ? draftPullRequest
        ? 'open'
        : 'not-found'
      : draftCheckStatus;

    branch.pullRequest = pullRequest;
    branch.githubMergeStatus = status;
    branch.draftPullRequest = draftPullRequest;
    branch.githubDraftStatus = draftStatus;

    for (const worktree of worktreesByBranch.get(branch.name) ?? []) {
      worktree.pullRequest = pullRequest;
      worktree.githubMergeStatus = status;
      worktree.draftPullRequest = draftPullRequest;
      worktree.githubDraftStatus = draftStatus;
    }
  }
}

async function annotateRemovalCandidateHistory(cwd, worktrees, branchMap) {
  const baseRef = selectIntegrationBaseRef(branchMap);
  const candidates = worktrees.filter(
    (worktree) => worktree.tier === 'worktree-only' || worktree.tier === 'worktree-and-branch',
  );
  const bases = new Set(
    candidates.map((worktree) => worktree.mergedInto ?? baseRef).filter(Boolean),
  );
  const branchCountsByBase = new Map();
  const baseHeads = new Map();
  for (const candidateBase of bases) {
    const [counts, head] = await Promise.all([
      listCommitsNotInBaseByBranch(cwd, candidateBase),
      resolveRefHead(cwd, candidateBase),
    ]);
    branchCountsByBase.set(candidateBase, counts);
    baseHeads.set(candidateBase, head);
  }

  for (const worktree of candidates) {
    // A detached checkout must be compared at its own commit. Comparing the
    // containing branch/ref instead can count commits that happened after the
    // detached checkout was parked and wildly inflate its "unmerged" number.
    const comparisonRef = worktree.detached
      ? worktree.headFull
      : worktree.branch ?? worktree.containedIn;
    worktree.unmergedBase = worktree.mergedInto ?? baseRef;
    worktree.unmergedBaseHead = baseHeads.get(worktree.unmergedBase) ?? null;
    const branchCounts = branchCountsByBase.get(worktree.unmergedBase) ?? null;

    // Merge evidence decides whether retirement is safe; it must not rewrite
    // the ancestry metric. A squash-merged branch is safe and can truthfully
    // remain several commits outside the base history.
    if (worktree.branch && branchCounts?.has(worktree.branch)) {
      worktree.unmergedCommits = branchCounts.get(worktree.branch);
    } else {
      worktree.unmergedCommits = await countCommitsNotInBase(cwd, worktree.unmergedBase, comparisonRef);
    }

    if (!worktree.branch) continue;
    const branch = branchMap.get(worktree.branch);
    if (!branch) continue;
    branch.unmergedBase = worktree.unmergedBase;
    branch.unmergedBaseHead = worktree.unmergedBaseHead;
    branch.unmergedCommits = worktree.unmergedCommits;
  }
}

async function resolveRefHead(cwd, ref) {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
  return result.ok ? result.stdout.trim() : null;
}

async function listCommitsNotInBaseByBranch(cwd, baseRef) {
  // Modern Git can compare every local branch to one base in a single ref
  // walk. That keeps a 51-row cleanup bucket from adding 51 subprocesses to a
  // machine scan. Fall back to individual counts when the atom is unavailable.
  const result = await git(cwd, [
    'for-each-ref',
    `--format=%(refname:short)%09%(ahead-behind:${baseRef})`,
    'refs/heads',
  ]);
  if (!result.ok) return null;

  const counts = new Map();
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const [name, comparison = ''] = line.split('\t');
    const [ahead] = comparison.trim().split(/\s+/);
    const count = Number.parseInt(ahead, 10);
    if (name && Number.isFinite(count)) counts.set(name, count);
  }

  return counts;
}

function emptyPrimaryBranchEvidence() {
  return {
    repository: null,
    remote: DEFAULT_REMOTE,
    branch: null,
    ref: null,
    head: null,
    status: 'not-requested',
    checkedAt: null,
    error: null,
  };
}

async function inspectPrimaryBranch(cwd, options) {
  const getRepository = options.getRepositoryIdentity ?? getRepositoryIdentity;
  const evidence = {
    ...emptyPrimaryBranchEvidence(),
    repository: await getRepository(cwd),
  };

  if (options.liveRemoteCheck === false) {
    return { ...evidence, status: 'skipped' };
  }

  const inspect = options.inspectPrimaryBranch ?? inspectLivePrimaryBranch;
  try {
    const primary = await inspect(cwd, DEFAULT_REMOTE);
    if (!primary?.branch || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(primary.head ?? '')) {
      return {
        ...evidence,
        status: 'unavailable',
        checkedAt: primary?.checkedAt ?? null,
        error: primary?.error ?? null,
      };
    }

    return {
      ...evidence,
      branch: primary.branch,
      ref: `${DEFAULT_REMOTE}/${primary.branch}`,
      head: primary.head,
      status: 'checked',
      checkedAt: primary.checkedAt ?? new Date().toISOString(),
      error: null,
    };
  } catch {
    return { ...evidence, status: 'unavailable' };
  }
}

async function getRepositoryIdentity(cwd) {
  const result = await git(cwd, ['config', '--get', `remote.${DEFAULT_REMOTE}.url`]);
  if (!result.ok) return null;
  return parseRemoteRepository(result.stdout.trim());
}

async function annotatePrimaryBranchContainment(cwd, worktrees, branchMap, primaryBranch, options) {
  // Compare immutable objects, not branch names that may move during a scan.
  // A stale tracking ref is harmless when the live object is already local.
  const comparisons = new Map();
  const inspect = options.inspectContainment ?? inspectDefaultBranchContainment;
  const compare = async (head) => {
    if (!comparisons.has(head)) {
      comparisons.set(head, options.limitDefaultBranchComparison(() => inspect(cwd, head, primaryBranch)));
    }
    return comparisons.get(head);
  };
  const annotate = async (record, head) => {
    record.defaultBranch = primaryBranch.branch;
    record.defaultBranchRef = primaryBranch.ref;
    record.defaultBranchHead = primaryBranch.head;
    record.defaultBranchStatus = primaryBranch.status;
    record.defaultBranchCheckedAt = primaryBranch.checkedAt;
    record.defaultBranchError = primaryBranch.error ?? null;
    const result = await compare(head);
    record.defaultBranchContainment = result.containment;
    record.defaultBranchComparisonError = result.error ?? null;
  };

  await Promise.all([
    ...[...branchMap.values()].map((branch) => annotate(branch, branch.head)),
    ...worktrees.map((worktree) => annotate(worktree, worktree.headFull)),
  ]);
}

function selectIntegrationBaseRef(branchMap) {
  for (const name of ['dev', 'main', 'master']) {
    const branch = branchMap.get(name);
    if (!branch) continue;
    if (branch.upstream && branch.upstreamStatus !== 'gone') return branch.upstream;
    return branch.name;
  }

  return null;
}

async function countCommitsNotInBase(cwd, baseRef, comparisonRef) {
  if (!baseRef || !comparisonRef) return null;
  const result = await git(cwd, ['rev-list', '--count', `${baseRef}..${comparisonRef}`]);
  if (!result.ok) return null;

  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

function pickPrimaryPath(discoveryRoots, worktreePathsInGitOrder, sortedWorktreePaths) {
  const usableWorktreePathsInGitOrder = worktreePathsInGitOrder.filter((worktreePath) => !isGitStoragePath(worktreePath));

  if (usableWorktreePathsInGitOrder.length > 0) {
    return usableWorktreePathsInGitOrder[0];
  }

  return sortedWorktreePaths.find((worktreePath) => !isGitStoragePath(worktreePath)) ?? discoveryRoots[0];
}

async function scanWorktree(worktreePath, options, primaryPath, ignoredContentPolicy) {
  const inspectionErrors = [];
  for (const error of ignoredContentPolicy?.errors ?? []) {
    inspectionErrors.push(inspectionError('ignored-policy', error));
  }
  const inspectBranch = options.inspectCurrentBranch ?? inspectCurrentBranch;
  const branchProbe = await inspectBranch(worktreePath);
  if (!branchProbe.ok) inspectionErrors.push(inspectionError('branch', branchProbe.error));
  const branch = branchProbe.ok ? branchProbe.branch : null;
  const detached = branchProbe.ok ? branch === null : null;
  // Read the short SHA and commit date together. The date is decision context,
  // not an inactivity verdict: an old checkout can still be in active use.
  const inspectHead = options.inspectHead ?? inspectHeadCommit;
  const headProbe = await inspectHead(worktreePath);
  if (!headProbe.ok) inspectionErrors.push(inspectionError('head', headProbe.error));

  const inspectStatus = options.inspectStatusEntries ?? inspectStatusEntries;
  const statusProbe = await inspectStatus(worktreePath, options);
  if (!statusProbe.ok) inspectionErrors.push(inspectionError('status', statusProbe.error));
  const statusEntries = statusProbe.entries ?? [];
  const dirty = statusProbe.ok ? statusEntries.length > 0 : null;
  const largeFileEntries = statusProbe.ok
    ? await resolveLargeFileEntries(worktreePath, statusEntries, options)
    : [];
  const largeFiles = findLargeDirtyFiles(
    worktreePath,
    largeFileEntries,
    options.largeFileBytes ?? 10 * 1024 * 1024,
  );

  // A worktree on a branch gets its upstream and ahead/behind overwritten by
  // applyBranchStateToWorktrees from the branch map, which derives them from a
  // single for-each-ref per repository. Computing them here too would spawn two
  // more Git processes per worktree only to discard the answers. Detached HEADs
  // have no branch row, so they are the only case that still needs the lookup.
  const upstream = branch || detached !== true
    ? { name: null, status: 'none', error: null }
    : await getUpstream(worktreePath);
  const aheadBehind = detached === true && upstream.name
    ? await getAheadBehind(worktreePath, 'HEAD', upstream.name)
    : { ahead: null, behind: null, error: upstream.error ?? null };
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) inspectionErrors.push(inspectionError('git-dir', 'could not resolve worktree git directory'));
  const worktreeGitDir = gitDir ? safeRealpath(gitDir) ?? path.resolve(gitDir) : null;
  // Only clean worktrees can be proposed for removal, so they are the only ones
  // whose hidden files matter. This keeps the extra call off the majority.
  let preciousIgnored = [];
  let policyIgnored = [];
  if (dirty === false && worktreePath !== primaryPath) {
    const inspectIgnored = options.inspectPreciousIgnored ?? inspectPreciousIgnored;
    const ignoredProbe = await inspectIgnored(worktreePath, primaryPath, ignoredContentPolicy);
    preciousIgnored = ignoredProbe.precious ?? [];
    policyIgnored = ignoredProbe.policyIgnored ?? [];
    for (const error of ignoredProbe.errors ?? []) {
      inspectionErrors.push(inspectionError('ignored-files', error));
    }
  }

  let unreachableCommits = detached === true ? null : 0;
  let containedIn = null;
  let retentionVerified = null;
  let retentionSource = null;
  let retentionRefHead = null;
  let retentionRemote = null;
  let retentionBranch = null;
  if (detached === true) {
    const inspectRetention = options.inspectDetachedRetention ?? inspectDetachedRetention;
    const retention = await inspectRetention(worktreePath, options);
    unreachableCommits = retention.unreachableCommits;
    containedIn = retention.containedIn;
    retentionVerified = retention.retentionVerified;
    retentionSource = retention.retentionSource;
    retentionRefHead = retention.retentionRefHead ?? null;
    retentionRemote = retention.retentionRemote ?? null;
    retentionBranch = retention.retentionBranch ?? null;
    for (const error of retention.errors ?? []) {
      inspectionErrors.push(inspectionError('detached-retention', error));
    }
  }

  const locked = isLockedWorktree(gitDir);
  const inProgress = detectInProgress(gitDir);
  let submodules = [];
  if (dirty === false) {
    const submoduleProbe = await inspectInitialisedSubmodules(worktreePath);
    submodules = submoduleProbe.submodules;
    for (const error of submoduleProbe.errors) {
      inspectionErrors.push(inspectionError('submodules', error));
    }
  }
  // --sizes is deliberately independent of cleanup eligibility. With
  // --scope-strict, scanRoots turns it off only for registered worktrees beyond
  // the exact requested roots; their repository-wide Git metadata is retained.
  const bytes = options.sizes
    ? await measureDiskUsageBytes(worktreePath)
    : null;

  return {
    path: worktreePath,
    worktreeGitDir,
    aliasedWorktreePaths: [],
    bytes,
    tier: null,
    inspectionErrors,
    unreachableCommits,
    containedIn,
    retentionVerified,
    retentionSource,
    retentionRefHead,
    retentionRemote,
    retentionBranch,
    locked,
    inProgress,
    submodules,
    preciousIgnored,
    policyIgnored,
    branch: branch ?? null,
    detached,
    head: headProbe.head ?? '',
    headFull: headProbe.headFull ?? null,
    lastCommitDate: headProbe.lastCommitDate ?? null,
    upstream: upstream.name,
    upstreamStatus: upstream.status,
    cleanupStatus: null,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirty,
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
    '--format=%(refname:short)%09%(upstream:short)%09%(objectname)%09%(committerdate:iso8601)%09%(upstream:track,nobracket)%09%(upstream:remoteref)%09%(upstream:remotename)',
    'refs/heads',
  ]);

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, head, lastCommitDate, track, upstreamRemoteRef, upstreamRemote] = line.split('\t');
      const upstreamName = upstream || null;
      const tracking = parseUpstreamTrack(track, upstreamName);

      return {
        name,
        upstream: upstreamName,
        // Keep the configured remote branch separate from the display name.
        // Splitting `origin/feature/foo` on `/` is ambiguous because both
        // remote names and branch names may themselves contain slashes.
        upstreamBranch: parseUpstreamRemoteBranch(upstreamRemoteRef),
        upstreamRemote: upstreamRemote && upstreamRemote !== '.' ? upstreamRemote : null,
        upstreamStatus: tracking.status,
        liveUpstreamStatus: 'not-requested',
        liveUpstreamHead: null,
        liveUpstreamMatchesHead: null,
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

function parseUpstreamRemoteBranch(remoteRef) {
  const prefix = 'refs/heads/';
  return remoteRef?.startsWith(prefix) ? remoteRef.slice(prefix.length) : null;
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
    worktree.upstreamBranch = branch.upstreamBranch;
    worktree.upstreamRemote = branch.upstreamRemote;
    worktree.upstreamStatus = branch.upstreamStatus;
    worktree.liveUpstreamStatus = branch.liveUpstreamStatus;
    worktree.liveUpstreamHead = branch.liveUpstreamHead;
    worktree.liveUpstreamMatchesHead = branch.liveUpstreamMatchesHead;
    worktree.cleanupStatus = branch.cleanupStatus;
    worktree.ahead = branch.ahead;
    worktree.behind = branch.behind;
    worktree.lastCommitDate = branch.lastCommitDate;
  }
}

function annotateAliasedWorktreeGitDirs(worktrees) {
  const worktreesByGitDir = new Map();

  for (const worktree of worktrees) {
    if (!worktree.worktreeGitDir) continue;
    if (!worktreesByGitDir.has(worktree.worktreeGitDir)) {
      worktreesByGitDir.set(worktree.worktreeGitDir, []);
    }
    worktreesByGitDir.get(worktree.worktreeGitDir).push(worktree);
  }

  for (const aliases of worktreesByGitDir.values()) {
    if (aliases.length < 2) continue;
    const paths = aliases.map((worktree) => worktree.path).sort((a, b) => a.localeCompare(b));
    for (const worktree of aliases) {
      worktree.aliasedWorktreePaths = paths.filter((candidate) => candidate !== worktree.path);
    }
  }
}

function groupWorktreesByBranch(worktrees) {
  const grouped = new Map();
  for (const worktree of worktrees) {
    if (!worktree.branch) continue;
    if (!grouped.has(worktree.branch)) grouped.set(worktree.branch, []);
    grouped.get(worktree.branch).push(worktree);
  }
  return grouped;
}

async function annotateLiveUpstreamState(cwd, worktrees, branchMap, options) {
  if (options.liveRemoteCheck === false) return;

  const candidatesByRemote = collectLiveUpstreamCandidates(worktrees, branchMap, cwd, options);
  const queryRemoteHeads = options.listRemoteHeads ?? listRemoteHeads;

  for (const [remote, candidates] of candidatesByRemote) {
    let heads = null;
    try {
      heads = await queryRemoteHeads(cwd, remote, candidates.map((branch) => branch.upstreamBranch));
    } catch {
      heads = null;
    }

    for (const branch of candidates) {
      if (!(heads instanceof Map)) {
        branch.liveUpstreamStatus = 'unavailable';
        continue;
      }

      const liveHead = heads.get(branch.upstreamBranch) ?? null;
      branch.liveUpstreamStatus = liveHead ? 'present' : 'gone';
      branch.liveUpstreamHead = liveHead;
      branch.liveUpstreamMatchesHead = liveHead ? liveHead === branch.head : null;
    }
  }
}

function collectLiveUpstreamCandidates(worktrees, branchMap, primaryPath, options) {
  const candidateNames = new Set();
  const worktreesByBranch = groupWorktreesByBranch(worktrees);

  // A locally gone upstream is already asking for a cleanup decision. Confirm
  // it live so a branch recreated after the last prune cannot be retired from
  // stale local state.
  for (const branch of branchMap.values()) {
    if (branch.upstreamStatus !== 'gone') continue;
    if (worktreesByBranch.get(branch.name)?.some((worktree) => worktree.dirty)) continue;
    candidateNames.add(branch.name);
  }

  if (options.buckets) {
    // Bucket scans are specifically deciding whether clean linked checkouts can
    // be reclaimed. Probe those branches even when the local tracking ref says
    // "present": that is the stale-ref case this check exists to catch.
    for (const worktree of worktrees) {
      if (!isPotentialCheckoutRemoval(worktree, primaryPath)) continue;
      candidateNames.add(worktree.branch);
    }
  }

  const candidateRemotes = new Set();
  for (const name of candidateNames) {
    const branch = branchMap.get(name);
    if (!branch?.upstreamRemote || !branch.upstreamBranch) continue;
    candidateRemotes.add(branch.upstreamRemote);
  }

  const candidatesByRemote = new Map([...candidateRemotes].map((remote) => [remote, []]));
  for (const branch of branchMap.values()) {
    if (!candidateRemotes.has(branch.upstreamRemote) || !branch.upstreamBranch) continue;
    // Once a repository remote is already being contacted, include stale
    // same-named branches that no longer have a worktree. This adds refspecs to
    // the same request, not another network round trip, and keeps branch-only
    // cleanup visible after its checkout has been removed.
    if (!candidateNames.has(branch.name)
      && (branch.checkedOut || branch.upstreamBranch !== branch.name)) continue;
    candidatesByRemote.get(branch.upstreamRemote).push(branch);
  }

  return candidatesByRemote;
}

function isPotentialCheckoutRemoval(worktree, primaryPath) {
  if (!worktree.branch || worktree.path === primaryPath) return false;
  if (worktree.aliasedWorktreePaths?.length > 0) return false;
  if (worktree.inspectionErrors?.length > 0) return false;
  if (worktree.dirty !== false || worktree.locked || worktree.inProgress) return false;
  if (worktree.submodules?.length > 0) return false;
  if (worktree.preciousIgnored?.length > 0) return false;
  return !(worktree.detached && worktree.retentionVerified !== true);
}

async function listRemoteHeads(cwd, remote, branchNames) {
  const refs = [...new Set(branchNames)].map((branch) => `refs/heads/${branch}`);
  if (refs.length === 0) return new Map();

  // This contacts the remote but does not fetch: no remote-tracking ref,
  // FETCH_HEAD, branch, index, or working tree is changed. Limiting the refspecs
  // keeps a machine-wide bucket scan from downloading every branch name.
  const result = await git(cwd, ['ls-remote', '--heads', remote, ...refs], {
    timeoutMs: LIVE_REMOTE_TIMEOUT_MS,
  });
  if (!result.ok) return null;

  const heads = new Map();
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const [head, ref] = line.split(/\s+/, 2);
    const branch = parseUpstreamRemoteBranch(ref);
    if (head && branch) heads.set(branch, head);
  }
  return heads;
}

function effectiveUpstreamGone(branch) {
  // A successful live check outranks the local remote-tracking cache in both
  // directions. If the remote cannot be contacted, preserve the old local
  // behavior instead of turning uncertainty into a deletion recommendation.
  if (branch.liveUpstreamStatus === 'present') return false;
  if (branch.liveUpstreamStatus === 'gone') return true;
  return branch.upstreamStatus === 'gone';
}

function collectPruneCandidates(worktrees, branchMap) {
  const worktreesByBranch = groupWorktreesByBranch(worktrees);

  // A branch is a cleanup candidate on its own merits. Scoping this to branches
  // that still had a worktree meant removing the worktree made the branch
  // invisible -- and branches left behind by a cleanup pass are precisely the
  // ones that need looking at. A branch checked out in a dirty worktree is
  // still excluded: that worktree's state is the reason to leave it alone.
  return [...branchMap.values()].filter((branch) => {
    if (!effectiveUpstreamGone(branch)) return false;
    return !(worktreesByBranch.get(branch.name) ?? []).some(
      (worktree) => worktree.dirty !== false
        || worktree.inspectionErrors?.length > 0
        || worktree.aliasedWorktreePaths?.length > 0,
    );
  });
}

async function annotatePruneCandidates(cwd, worktrees, branchMap, candidates, options = {}) {
  const worktreeByBranch = new Map(
    worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch, worktree]),
  );

  // Resolving base refs costs roughly eight Git calls. Most repositories have
  // no candidate at all, so doing it first spent that on every repository on
  // the machine to answer a question with no askers.
  if (candidates.length === 0) return;

  const baseRefs = await listPruneBaseRefs(cwd);

  for (const branch of candidates) {
    // An open draft PR is an explicit WIP marker. Even if ancestry says the
    // current tip already landed elsewhere, branch cleanup must wait for the
    // draft to be resolved by its owner.
    if (branch.draftPullRequest) continue;

    let mergedInto = null;
    let mergedVia = null;

    // GitHub's own answer outranks anything derived locally.
    const pullRequest = branch.pullRequest;
    if (pullRequest) {
      mergedInto = `origin/${pullRequest.base}`;
      mergedVia = 'pr';
      branch.pullRequest = pullRequest;
    }

    // Ancestry next: cheap, and the common case for merge commits and
    // fast-forwards.
    for (const baseRef of mergedInto ? [] : baseRefs) {
      if (await isAncestor(cwd, branch.name, baseRef)) {
        mergedInto = baseRef;
        mergedVia = 'history';
        break;
      }
    }

    if (!mergedInto && options.squashDetect !== false) {
      for (const baseRef of baseRefs) {
        if (await isSquashMerged(cwd, branch.name, baseRef)) {
          mergedInto = baseRef;
          mergedVia = 'squash';
          break;
        }
      }
    }

    if (!mergedInto) continue;

    // Whether `git branch -d` will accept this is a separate question from how
    // the merge was proven: -d consults ancestry and nothing else. A pull
    // request can confirm a merge that ancestry cannot see, so this has to be
    // asked directly or the warning lands on every row and means nothing.
    const ancestryVisible = await isAncestor(cwd, branch.name, mergedInto);

    branch.cleanupStatus = 'prune-candidate';
    branch.mergedInto = mergedInto;
    branch.mergedVia = mergedVia;
    branch.ancestryVisible = ancestryVisible;

    const worktree = worktreeByBranch.get(branch.name);
    if (!worktree) continue;

    worktree.cleanupStatus = 'prune-candidate';
    worktree.mergedInto = mergedInto;
    worktree.mergedVia = mergedVia;
    worktree.ancestryVisible = ancestryVisible;
    worktree.pullRequest = branch.pullRequest ?? null;
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

// GitHub's default "Squash and merge" does not graft a branch onto the base.
// It collapses the branch's commits into one brand new commit with no shared
// ancestry, so `merge-base --is-ancestor` correctly answers "no" forever even
// though every line of the work is already on the base. Left there, a
// history-only check reports almost nothing as merged on a squash-merge repo.
//
// Content answers what ancestry cannot: synthesise the branch's cumulative
// change as a single commit off the merge base, then ask whether an equivalent
// patch already exists on the base. That is the same shape the squash produced,
// so their patch ids match.
//
// The synthetic object lives in a temporary object directory with the real
// object database mounted read-only as an alternate. The repository's object
// database and refs therefore remain unchanged even when detection is enabled.
async function isSquashMerged(cwd, branch, baseRef) {
  const mergeBase = (await git(cwd, ['merge-base', baseRef, branch])).stdout.trim();
  if (!mergeBase) return false;

  const tree = (await git(cwd, ['rev-parse', `${branch}^{tree}`])).stdout.trim();
  if (!tree) return false;

  const objects = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (!objects.ok || !objects.stdout.trim()) return false;

  const temporaryObjects = fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-objects-'));
  const alternates = [
    objects.stdout.trim(),
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
  ].filter(Boolean).join(path.delimiter);
  const env = {
    GIT_OBJECT_DIRECTORY: temporaryObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
  };

  try {
    const synthesised = await git(
      cwd,
      ['commit-tree', tree, '-p', mergeBase, '-m', 'git-groundskeeper probe'],
      { env },
    );
    if (!synthesised.ok) return false;

    const cherry = await git(cwd, ['cherry', baseRef, synthesised.stdout.trim()], { env });
    if (!cherry.ok) return false;

    // `git cherry` prints "- <sha>" when an equivalent patch is already upstream
    // and "+ <sha>" when it is not.
    return cherry.stdout.trim().startsWith('-');
  } finally {
    fs.rmSync(temporaryObjects, { recursive: true, force: true });
  }
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
      const worktreePath = canonicalPath(line.slice('worktree '.length));
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
async function inspectStatusEntries(cwd, options = {}) {
  const untrackedFiles = options.untrackedFiles === 'all' ? 'all' : 'normal';
  const result = await git(cwd, ['status', '--porcelain=v1', '-z', `--untracked-files=${untrackedFiles}`], {
    encoding: 'buffer',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!result.ok) {
    return {
      ok: false,
      entries: [],
      error: `git status failed: ${result.stderr.trim() || 'unknown error'}`,
    };
  }
  if (result.stdout.length === 0) return { ok: true, entries: [], error: null };

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

  return { ok: true, entries, error: null };
}

async function listStatusEntries(cwd, options = {}) {
  const probe = await inspectStatusEntries(cwd, options);
  return probe.ok ? probe.entries : [];
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

  const probe = await inspectStatusEntries(cwd, { ...options, untrackedFiles: 'all' });
  return probe.ok ? probe.entries : entries;
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
  const segments = parseRemotePathSegments(url);
  return segments?.length >= 2 ? segments[segments.length - 2] : null;
}

export function parseRemoteRepository(url) {
  const segments = parseRemotePathSegments(url);
  return segments?.length >= 2 ? `${segments[segments.length - 2]}/${segments[segments.length - 1]}` : null;
}

function parseRemotePathSegments(url) {
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

  return repoPath
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
}

// Files git is told to ignore are invisible to `git status`, so a worktree can
// report perfectly clean while holding the only copy of something you need.
//
// Listing the names that look precious is the wrong way round. That list is a
// guess about the future, and being wrong means deleting the one file that
// mattered -- a firebase.profile-1.json sailed straight through an earlier
// version of it. Guessing wrong about noise only costs a row in a table.
//
// So the question asked is "is this file unique to this worktree", answered by
// comparing against the primary checkout, and only known-regenerable output is
// filtered out. Wrong here means a harmless extra warning.
const REGENERABLE_IGNORED = [
  /(^|\/)\.DS_Store$/,
  /\.py[co]$/,
  /(^|\/)\.flutter-plugins-dependencies$/,
  /(^|\/)\.packages$/,
  /(^|\/)local\.properties$/,
  // Toolchain codegen. Named explicitly because these differ between worktrees
  // in ways location-normalisation cannot always absorb, and every one of them
  // is reproduced by a build.
  /(^|\/)Generated\.xcconfig$/,
  /(^|\/)flutter_export_environment\.sh$/,
  /(^|\/)Flutter\.podspec$/,
  /(^|\/)GeneratedPluginRegistrant\.(java|swift|m|h)$/,
  /(^|\/)generated_plugin_registrant\.(dart|cc)$/,
  /(^|\/)generated_plugins\.cmake$/,
  // Editor state. Named file by file rather than skipping .idea/ wholesale,
  // which is tempting and wrong: JetBrains keeps database credentials in
  // .idea/dataSources.local.xml, so a blanket rule would silence the one file
  // in there worth warning about. Anything unrecognised in .idea/ still shows.
  /(^|\/)\.idea\/\.gitignore$/,
  /(^|\/)\.idea\/[^/]+\.iml$/,
  /(^|\/)\.idea\/(workspace|modules|misc|vcs|php|compiler|encodings|jarRepositories|material_theme_project_new)\.xml$/,
  // A file that calls itself a cache is one.
  /\.cache$/,
];

// These directory names can contain millions of ignored files, so recursively
// hashing them would make a machine-wide scan unusable. Their names are only a
// convention, though: `build/signing.keystore` can still be the sole copy of
// user data. Record the directory itself as review-required instead of either
// walking it or assuming everything below it is safe to discard.
const COARSE_IGNORED_DIRECTORIES = new Set([
  '.build',
  '.dart_tool',
  '.dotnet',
  '.gradle',
  '.next',
  '.terraform',
  '.turbo',
  '.vercel',
  'DerivedData',
  'Pods',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'obj',
  'target',
  'vendor',
]);

// Removing a worktree never destroys a commit: the branch keeps them, and the
// checkout is just a materialised copy. So the bar for reclaiming disk is only
// "no uncommitted work here", which is far lower than the bar for deleting the
// branch itself. Conflating the two is what makes cleanup tools feel dangerous
// and makes people keep everything forever.
export function classifyTier(worktree, primaryPath) {
  if (worktree.path === primaryPath) return 'primary';
  // A copied worktree can carry the same .git pointer as the registered path.
  // Removing either through Git can delete the shared metadata and strand the
  // other directory, including any uncommitted files living there.
  if (worktree.aliasedWorktreePaths?.length > 0) return 'aliased';
  // A failed safety probe is not evidence of cleanliness. Keep it in its own
  // non-action tier so the report names the uncertainty instead of silently
  // turning it into a deletion recommendation.
  if (worktree.inspectionErrors?.length > 0) return 'inspection-error';
  if (worktree.dirty) return 'blocked';
  // Git locks a worktree precisely to say "do not reap this". Honour it.
  if (worktree.locked) return 'blocked';
  // A paused rebase or merge leaves no dirty files, so status calls it clean
  // while the operation's state lives in the worktree's git dir. Removing it
  // throws that away silently.
  if (worktree.inProgress) return 'blocked';
  // `git worktree remove` refuses outright: "working trees containing
  // submodules cannot be moved or removed". Proposing one is proposing a
  // command that cannot work. Worse, the submodule carries a branch of its own
  // whose merge state says nothing about the parent's, and nothing here looks
  // inside it.
  if (worktree.submodules?.length > 0) return 'submodule';
  // "Removing a worktree keeps your commits, the branch holds them" is the
  // whole basis of the worktree-only bucket -- and it is false for a detached
  // HEAD, where no branch holds anything. Unique commits there survive only in
  // the reflog, so this is the one clean worktree whose removal can lose work.
  if (worktree.detached && worktree.retentionVerified !== true) return 'blocked';
  // Clean and fully pushed does not mean abandoned. A matching open draft PR
  // is explicit operational intent to keep working on this branch, so it must
  // outrank every reclaimable cleanup classification.
  if (worktree.draftPullRequest) return 'wip';
  // Hidden, ignored data is still data. This guard must precede merge/prune
  // evidence: a merged branch says nothing about uncommitted ignored files.
  if (worktree.preciousIgnored?.length > 0) return 'check-first';
  if (worktree.cleanupStatus === 'prune-candidate') return 'worktree-and-branch';
  // "The branch keeps your commits" is true and not enough. Unpushed work
  // exists on exactly one disk, and removing its checkout leaves no reminder
  // that it exists at all: nobody browses a branch list looking for forgotten
  // work, and a dead SSD takes it with no reflog to appeal to. Reclaiming the
  // space is fine, but pushing has to come first.
  if (hasUnpushedWork(worktree)) return 'push-first';
  // A bucket is an action group, and these need an action first: look at the
  // file, then decide. Leaving them among the ready removal rows meant piping the
  // bucket's commands deleted them without pause, which made the whole Keeps
  // column decoration -- a warning that vanishes at the moment of acting.
  return 'worktree-only';
}

function hasUnpushedWork(worktree) {
  // A detached HEAD has no upstream by definition, so upstream status says
  // nothing about it either way. Whether its commits exist elsewhere is
  // answered by unreachableCommits, and that case is blocked above.
  if (worktree.detached) return false;
  // ls-remote can prove the remote currently points at this exact branch tip
  // even when the local remote-tracking ref is stale and reports commits ahead.
  if (worktree.liveUpstreamMatchesHead === true) return false;
  if (worktree.liveUpstreamStatus === 'gone') return true;
  // Never pushed: the branch exists here and nowhere else.
  if (worktree.upstreamStatus === 'none') return true;
  // The remote branch is gone and this is not a merged candidate, so whatever
  // is here is the only copy left.
  if (worktree.upstreamStatus === 'gone') return true;

  return Number.isInteger(worktree.ahead) && worktree.ahead > 0;
}

// Commits reachable from HEAD but from no branch or remote anywhere. Only asked
// of a detached HEAD, where the answer can be nonzero. Failure is explicitly
// unknown: zero is a safety claim and must never be manufactured from an error.
async function inspectUnreachableCommits(cwd) {
  const result = await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags']);
  if (!result.ok) {
    return {
      ok: false,
      count: null,
      error: `git rev-list failed: ${result.stderr.trim() || 'unknown error'}`,
    };
  }

  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(count)) {
    return { ok: false, count: null, error: 'git rev-list returned a non-numeric count' };
  }
  return { ok: true, count, error: null };
}

async function inspectContainingRefs(cwd) {
  const result = await git(cwd, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)',
    '--contains',
    'HEAD',
    'refs/heads',
    'refs/tags',
    'refs/remotes',
  ]);
  if (!result.ok) {
    return {
      ok: false,
      local: [],
      tags: [],
      remote: [],
      error: `git for-each-ref failed: ${result.stderr.trim() || 'unknown error'}`,
    };
  }

  const refs = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, head] = line.split('\t');
      return { ref, head };
    })
    .filter(({ ref }) => !ref.endsWith('/HEAD'));

  const local = refs
    .filter(({ ref }) => ref.startsWith('refs/heads/'))
    .map(({ ref, head }) => ({ name: ref.slice('refs/heads/'.length), head }));
  const tags = refs
    .filter(({ ref }) => ref.startsWith('refs/tags/'))
    .map(({ ref, head }) => ({ name: ref.slice('refs/tags/'.length), head }));

  // Local branches and tags are already durable retention evidence. Avoid a
  // separate remote/config probe when it cannot improve the safety answer.
  if (local.length > 0 || tags.length > 0) {
    return { ok: true, local, tags, remote: [], error: null };
  }

  const remoteResult = await git(cwd, ['remote']);
  if (!remoteResult.ok) {
    return {
      ok: false,
      local,
      tags,
      remote: [],
      error: `git remote failed: ${remoteResult.stderr.trim() || 'unknown error'}`,
    };
  }
  const remoteNames = remoteResult.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const remote = [];

  for (const { ref, head } of refs.filter(({ ref: name }) => name.startsWith('refs/remotes/'))) {
    const short = ref.slice('refs/remotes/'.length);
    const remoteName = remoteNames.find((candidate) => short.startsWith(`${candidate}/`));
    if (!remoteName) continue;
    remote.push({
      name: short,
      remote: remoteName,
      branch: short.slice(remoteName.length + 1),
      head,
    });
  }

  return { ok: true, local, tags, remote, error: null };
}

// A detached checkout is reclaimable only when another durable ref is proven
// to retain its commit. Local branch containment is checked directly. A local
// remote-tracking ref is merely a cache, so remote-only retention is confirmed
// with targeted `ls-remote` before it is called safe.
async function inspectDetachedRetention(cwd, options = {}) {
  const reachability = await inspectUnreachableCommits(cwd);
  if (!reachability.ok) {
    return {
      unreachableCommits: null,
      containedIn: null,
      retentionVerified: null,
      retentionSource: null,
      errors: [reachability.error],
    };
  }

  if (reachability.count > 0) {
    return {
      unreachableCommits: reachability.count,
      containedIn: null,
      retentionVerified: false,
      retentionSource: null,
      errors: [],
    };
  }

  const containing = await inspectContainingRefs(cwd);
  if (!containing.ok) {
    return {
      unreachableCommits: 0,
      containedIn: null,
      retentionVerified: null,
      retentionSource: null,
      errors: [containing.error],
    };
  }

  if (containing.local.length > 0) {
    return {
      unreachableCommits: 0,
      containedIn: containing.local[0].name,
      retentionVerified: true,
      retentionSource: 'local-branch',
      retentionRefHead: containing.local[0].head,
      errors: [],
    };
  }

  if (containing.tags.length > 0) {
    return {
      unreachableCommits: 0,
      containedIn: containing.tags[0].name,
      retentionVerified: true,
      retentionSource: 'local-tag',
      retentionRefHead: containing.tags[0].head,
      errors: [],
    };
  }

  if (containing.remote.length === 0) {
    return {
      unreachableCommits: 0,
      containedIn: null,
      retentionVerified: null,
      retentionSource: null,
      errors: ['no containing local branch or remote-tracking ref was found'],
    };
  }

  if (options.liveRemoteCheck === false) {
    return {
      unreachableCommits: 0,
      containedIn: null,
      retentionVerified: null,
      retentionSource: null,
      errors: ['live remote verification is disabled for a remote-only detached commit'],
    };
  }

  const queryRemoteHeads = options.listRemoteHeads ?? listRemoteHeads;
  const byRemote = new Map();
  for (const candidate of containing.remote) {
    if (!byRemote.has(candidate.remote)) byRemote.set(candidate.remote, []);
    byRemote.get(candidate.remote).push(candidate);
  }

  let unavailable = false;
  for (const [remoteName, candidates] of byRemote) {
    let liveHeads = null;
    try {
      liveHeads = await queryRemoteHeads(cwd, remoteName, candidates.map(({ branch }) => branch));
    } catch {
      liveHeads = null;
    }
    if (!(liveHeads instanceof Map)) {
      unavailable = true;
      continue;
    }
    const retained = candidates.find(({ branch, head }) => liveHeads.get(branch) === head);
    if (retained) {
      return {
        unreachableCommits: 0,
        containedIn: retained.name,
        retentionVerified: true,
        retentionSource: 'live-remote',
        retentionRefHead: retained.head,
        retentionRemote: retained.remote,
        retentionBranch: retained.branch,
        errors: [],
      };
    }
  }

  return {
    unreachableCommits: 0,
    containedIn: null,
    retentionVerified: unavailable ? null : false,
    retentionSource: null,
    errors: [unavailable
      ? 'could not contact the remote that alone retains this detached commit'
      : 'the remote-tracking ref that alone retained this detached commit is stale'],
  };
}

// Read from .gitmodules rather than asking git, so this costs no process. An
// entry with an empty directory was never initialised and does not block
// removal; only a populated one does.
async function inspectInitialisedSubmodules(worktreePath) {
  let declared;
  try {
    declared = fs.readFileSync(path.join(worktreePath, '.gitmodules'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { submodules: [], errors: [] };
    return {
      submodules: [],
      errors: [`could not read .gitmodules (${error.message})`],
    };
  }

  const submodules = [];
  const errors = [];

  for (const match of declared.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
    const submodulePath = match[1].trim();
    const absolute = path.join(worktreePath, submodulePath);

    try {
      if (fs.readdirSync(absolute).length === 0) continue;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      errors.push(`${submodulePath}: could not inspect submodule directory (${error.message})`);
      continue;
    }

    // The submodule's own branch is the thing the parent's merge state cannot
    // speak for, so it is worth naming.
    const branchResult = await git(absolute, ['branch', '--show-current']);
    if (!branchResult.ok) {
      errors.push(`${submodulePath}: could not read submodule branch (${branchResult.stderr.trim() || 'unknown error'})`);
    }
    const branch = branchResult.stdout.trim();
    submodules.push({ path: submodulePath, branch: branch || null });
  }

  return { submodules, errors };
}

// A linked worktree's .git is a file pointing at the real git dir; the primary
// worktree's is the directory itself. Resolving it by hand keeps the checks
// below on the filesystem instead of spawning more git processes.
function resolveGitDir(worktreePath) {
  const dotGit = path.join(worktreePath, '.git');

  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    return match ? path.resolve(worktreePath, match[1]) : null;
  } catch {
    return null;
  }
}

function detectInProgress(gitDir) {
  if (!gitDir) return null;

  const markers = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];

  for (const [marker, operation] of markers) {
    if (fs.existsSync(path.join(gitDir, marker))) return operation;
  }

  return null;
}

function isLockedWorktree(gitDir) {
  return gitDir ? fs.existsSync(path.join(gitDir, 'locked')) : false;
}

function getLastFetchAt(commonDir) {
  try {
    return fs.statSync(path.join(commonDir, 'FETCH_HEAD')).mtime.toISOString();
  } catch {
    return null;
  }
}

async function inspectPreciousIgnored(cwd, primaryPath, ignoredContentPolicy) {
  // The primary checkout is the reference every other worktree is compared
  // against, so it has nothing to be unique against.
  if (!primaryPath || cwd === primaryPath) {
    return { precious: [], policyIgnored: [], errors: [] };
  }

  const result = await git(cwd, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], {
    encoding: 'buffer',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (!result.ok) {
    return {
      precious: [],
      policyIgnored: [],
      errors: [`git status --ignored failed: ${result.stderr.trim() || 'unknown error'}`],
    };
  }
  if (result.stdout.length === 0) {
    return { precious: [], policyIgnored: [], errors: [] };
  }

  const candidates = result.stdout
    .toString('utf8')
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3));
  const files = [];
  const reviewDirectories = [];
  const policyIgnored = new Map();
  const errors = [];

  for (const candidate of candidates) {
    const policyRule = matchIgnoredContentPolicy(ignoredContentPolicy, candidate);
    if (policyRule) {
      recordPolicyIgnored(policyIgnored, candidate, policyRule);
      continue;
    }
    if (isRepoRegenerableIgnoredPath(cwd, candidate)) continue;
    const expanded = expandIgnoredCandidate(cwd, candidate);
    files.push(...expanded.files);
    reviewDirectories.push(...expanded.reviewDirectories);
    errors.push(...expanded.errors);
  }

  const precious = [];
  for (const directory of reviewDirectories) {
    const policyRule = matchIgnoredContentPolicy(ignoredContentPolicy, directory);
    if (policyRule) {
      recordPolicyIgnored(policyIgnored, directory, policyRule);
    } else if (!isRepoRegenerableIgnoredPath(cwd, directory)) {
      precious.push(directory);
    }
  }
  for (const filePath of new Set(files.sort((a, b) => a.localeCompare(b)))) {
    const policyRule = matchIgnoredContentPolicy(ignoredContentPolicy, filePath);
    if (policyRule) {
      recordPolicyIgnored(policyIgnored, filePath, policyRule);
      continue;
    }
    if (isRepoRegenerableIgnoredPath(cwd, filePath)) continue;
    if (REGENERABLE_IGNORED.some((pattern) => pattern.test(filePath))) continue;
    const comparison = compareIgnoredFile(
      path.join(cwd, filePath),
      path.join(primaryPath, filePath),
      cwd,
      primaryPath,
    );
    if (comparison.error) {
      errors.push(`${filePath}: ${comparison.error}`);
    } else if (comparison.unique) {
      precious.push(filePath);
    }
  }

  return {
    precious: [...new Set(precious)].sort((a, b) => a.localeCompare(b)),
    policyIgnored: [...policyIgnored.values()].sort((a, b) => a.path.localeCompare(b.path)),
    errors: [...new Set(errors)],
  };
}

function loadRepositoryIgnoredContentPolicy(commonDir) {
  const policyPath = path.join(commonDir, REPOSITORY_POLICY_FILE);
  const empty = { source: null, rules: [], errors: [] };
  let stat;
  try {
    stat = fs.lstatSync(policyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return empty;
    return {
      source: policyPath,
      rules: [],
      errors: [`could not inspect ${REPOSITORY_POLICY_FILE}: ${error.message}`],
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      source: policyPath,
      rules: [],
      errors: [`${REPOSITORY_POLICY_FILE} must not be a symbolic link`],
    };
  }
  if (!stat.isFile()) {
    return {
      source: policyPath,
      rules: [],
      errors: [`${REPOSITORY_POLICY_FILE} must be a regular file`],
    };
  }
  if (stat.size > MAX_REPOSITORY_POLICY_BYTES) {
    return {
      source: policyPath,
      rules: [],
      errors: [`${REPOSITORY_POLICY_FILE} exceeds ${MAX_REPOSITORY_POLICY_BYTES} bytes`],
    };
  }

  let document;
  try {
    document = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    return {
      source: policyPath,
      rules: [],
      errors: [`could not parse ${REPOSITORY_POLICY_FILE}: ${error.message}`],
    };
  }

  const errors = [];
  if (!isPlainObject(document)) {
    errors.push('policy root must be a JSON object');
  } else if (document.schemaVersion !== REPOSITORY_POLICY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REPOSITORY_POLICY_SCHEMA_VERSION}`);
  }

  const ignoredContent = isPlainObject(document?.ignoredContent)
    ? document.ignoredContent
    : null;
  if (!ignoredContent) {
    errors.push('ignoredContent must be a JSON object');
  }
  const disposable = ignoredContent?.disposable;
  if (!Array.isArray(disposable)) {
    errors.push('ignoredContent.disposable must be an array');
  }

  const rules = [];
  const seenPaths = new Set();
  for (const [index, entry] of (Array.isArray(disposable) ? disposable : []).entries()) {
    const parsed = parseIgnoredContentPolicyRule(entry, index);
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    const key = `${parsed.rule.type}\0${parsed.rule.displayPath}`;
    if (seenPaths.has(key)) {
      errors.push(`ignoredContent.disposable[${index}] duplicates ${parsed.rule.displayPath}`);
      continue;
    }
    seenPaths.add(key);
    rules.push(parsed.rule);
  }

  // A partly valid policy is more dangerous than no policy: an operator could
  // reasonably assume every reviewed entry took effect. Fail closed and leave
  // all ignored content in Keeps until the complete document validates.
  return {
    source: policyPath,
    rules: errors.length === 0 ? rules : [],
    errors,
  };
}

function parseIgnoredContentPolicyRule(entry, index) {
  const prefix = `ignoredContent.disposable[${index}]`;
  if (!isPlainObject(entry)) {
    return { error: `${prefix} must be a JSON object` };
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
    return { error: `${prefix}.reason must be a non-empty string` };
  }

  const hasPath = Object.hasOwn(entry, 'path');
  const hasGitignorePattern = Object.hasOwn(entry, 'gitignorePattern');
  if (hasPath === hasGitignorePattern) {
    return { error: `${prefix} must define exactly one of path or gitignorePattern` };
  }

  if (hasGitignorePattern) {
    return parseGitignorePatternPolicyRule(entry.gitignorePattern, entry.reason, prefix);
  }
  if (typeof entry.path !== 'string' || entry.path.trim().length === 0) {
    return { error: `${prefix}.path must be a non-empty string` };
  }

  const rawPath = entry.path.trim();
  if (rawPath.includes('\\') || rawPath.includes('\0') || /[*?\[\]{}]/.test(rawPath)) {
    return { error: `${prefix}.path must be an exact POSIX path without wildcards` };
  }
  if (path.posix.isAbsolute(rawPath) || rawPath.startsWith('./')) {
    return { error: `${prefix}.path must be relative to the repository root` };
  }

  const directory = rawPath.endsWith('/');
  const withoutTrailingSlash = rawPath.replace(/\/+$/, '');
  const segments = withoutTrailingSlash.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { error: `${prefix}.path must not contain empty, dot, or parent segments` };
  }
  if (segments[0] === '.git') {
    return { error: `${prefix}.path must not target Git metadata` };
  }

  const normalizedPath = segments.join('/');
  return {
    rule: {
      type: 'path',
      path: normalizedPath,
      displayPath: directory ? `${normalizedPath}/` : normalizedPath,
      directory,
      reason: entry.reason.trim(),
    },
  };
}

function parseGitignorePatternPolicyRule(value, reason, prefix) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: `${prefix}.gitignorePattern must be a non-empty string` };
  }
  const rawPattern = value.trim();
  if (rawPattern.startsWith('!')) {
    return { error: `${prefix}.gitignorePattern must not be a negation rule` };
  }
  if (rawPattern.includes('\\') || rawPattern.includes('\0') || /[\[\]{}]/.test(rawPattern)) {
    return { error: `${prefix}.gitignorePattern supports only literal text, *, ?, and /` };
  }
  if (path.posix.isAbsolute(rawPattern) || rawPattern.startsWith('./')) {
    return { error: `${prefix}.gitignorePattern must be relative to the repository root` };
  }

  const directory = rawPattern.endsWith('/');
  const withoutTrailingSlash = rawPattern.replace(/\/+$/, '');
  const segments = withoutTrailingSlash.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { error: `${prefix}.gitignorePattern must not contain empty, dot, or parent segments` };
  }
  if (segments[0] === '.git') {
    return { error: `${prefix}.gitignorePattern must not target Git metadata` };
  }
  const literalPrefix = withoutTrailingSlash.match(/^[^?*]*/)?.[0] ?? '';
  if (literalPrefix.replaceAll('/', '').length < 3) {
    return { error: `${prefix}.gitignorePattern is too broad; include a project-specific literal prefix` };
  }

  return {
    rule: {
      type: 'gitignore-pattern',
      pattern: withoutTrailingSlash,
      displayPath: directory ? `${withoutTrailingSlash}/` : withoutTrailingSlash,
      directory,
      regex: compileGitignorePattern(withoutTrailingSlash, directory),
      reason: reason.trim(),
    },
  };
}

function compileGitignorePattern(pattern, directory) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += directory ? '(?:/.*)?$' : '$';
  return new RegExp(source);
}

function matchIgnoredContentPolicy(policy, relativePath) {
  if (!policy || policy.errors.length > 0 || policy.rules.length === 0) return null;
  const normalizedPath = normalizeIgnoredContentPath(relativePath);
  return policy.rules.find((rule) => {
    if (rule.type === 'gitignore-pattern') return rule.regex.test(normalizedPath);
    return rule.directory
      ? normalizedPath === rule.path || normalizedPath.startsWith(`${rule.path}/`)
      : normalizedPath === rule.path;
  }) ?? null;
}

function recordPolicyIgnored(entries, relativePath, rule) {
  const normalizedPath = normalizeIgnoredContentPath(relativePath);
  entries.set(normalizedPath, {
    path: relativePath.endsWith('/') ? `${normalizedPath}/` : normalizedPath,
    rule: rule.displayPath,
    reason: rule.reason,
  });
}

function normalizeIgnoredContentPath(relativePath) {
  return relativePath
    .split(path.sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Coarse cache directories cannot safely be discarded by name alone: a
// generic `build/` may hold a signing key. A small set can, however, be tied to
// a repository-local tool manifest. This gives each checkout an inferred
// whitelist without turning another project's similarly named folder into
// disposable data.
function isRepoRegenerableIgnoredPath(cwd, relativePath) {
  const normalized = relativePath
    .split(path.sep)
    .join('/')
    .replace(/\/$/, '');
  const segments = normalized.split('/').filter(Boolean);

  if (toolDirectoryHasMarker(cwd, segments, '.dart_tool', ['pubspec.yaml'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.dotnet', ['global.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, 'node_modules', ['package.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.next', ['package.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.turbo', ['package.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.vercel', ['package.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, 'Pods', ['Podfile'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.build', ['Package.swift'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, 'target', ['Cargo.toml'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, 'vendor', ['composer.json'])) return true;
  if (toolDirectoryHasMarker(cwd, segments, '.gradle', [
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradlew',
  ])) return true;
  if (dotnetOutputHasProject(cwd, segments)) return true;
  if (frontendDistHasBuildManifest(cwd, segments)) return true;
  if (phpUnitCacheHasManifest(cwd, segments)) return true;
  if (codeIgniterFileSessionHasConfig(cwd, segments)) return true;
  if (flutterIdeaIndexHasManifest(cwd, normalized, segments)) return true;
  if (terraformCacheHasConfig(cwd, segments)) return true;
  if (isConfiguredTypeScriptOutput(cwd, normalized)) return true;

  const ephemeralIndex = segments.findIndex(
    (segment, index) => segment === 'ephemeral'
      && index > 0
      && segments[index - 1].toLowerCase() === 'flutter',
  );
  if (ephemeralIndex >= 0) {
    const platformDirectory = segments.slice(0, Math.max(0, ephemeralIndex - 1));
    return hasMarkerAtOrAbove(cwd, platformDirectory, 'pubspec.yaml');
  }

  return false;
}

function frontendDistHasBuildManifest(cwd, segments) {
  const distIndex = segments.indexOf('dist');
  if (distIndex < 0) return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, distIndex));
  const packagePath = path.join(ownerDirectory, 'package.json');
  let packageManifest;
  try {
    packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return false;
  }

  const buildScript = packageManifest?.scripts?.build;
  return typeof buildScript === 'string'
    && /(?:^|\s|&&|;)\b(?:vite|astro)\s+build\b/.test(buildScript);
}

function phpUnitCacheHasManifest(cwd, segments) {
  const cacheIndex = segments.indexOf('.phpunit.cache');
  if (cacheIndex < 0) return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, cacheIndex));
  return fs.existsSync(path.join(ownerDirectory, 'composer.json'))
    && (fs.existsSync(path.join(ownerDirectory, 'phpunit.xml'))
      || fs.existsSync(path.join(ownerDirectory, 'phpunit.xml.dist')));
}

function codeIgniterFileSessionHasConfig(cwd, segments) {
  const writableIndex = segments.indexOf('writable');
  if (writableIndex < 0 || segments[writableIndex + 1] !== 'session') return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, writableIndex));
  const configPath = path.join(ownerDirectory, 'app', 'Config', 'App.php');
  if (!fs.existsSync(path.join(ownerDirectory, 'spark'))) return false;

  let config;
  try {
    config = fs.readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }

  return /\$sessionDriver\s*=\s*['"]CodeIgniter\\Session\\Handlers\\FileHandler['"]\s*;/.test(config)
    && /\$sessionSavePath\s*=\s*WRITEPATH\s*\.\s*['"]session['"]\s*;/.test(config);
}

function flutterIdeaIndexHasManifest(cwd, normalizedPath, segments) {
  if (!/(?:^|\/)\.idea\/libraries\/(?:Dart_Packages|Dart_SDK|Flutter_Plugins)\.xml$/.test(normalizedPath)) {
    return false;
  }

  const ideaIndex = segments.indexOf('.idea');
  if (ideaIndex < 0) return false;
  return hasMarkerAtOrAbove(cwd, segments.slice(0, ideaIndex), 'pubspec.yaml');
}

function dotnetOutputHasProject(cwd, segments) {
  const outputIndex = segments.findIndex((segment) => segment === 'bin' || segment === 'obj');
  if (outputIndex < 0) return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, outputIndex));
  try {
    return fs.readdirSync(ownerDirectory, { withFileTypes: true }).some(
      (entry) => entry.isFile() && /\.(?:cs|fs|vb)proj$/i.test(entry.name),
    );
  } catch {
    return false;
  }
}

function terraformCacheHasConfig(cwd, segments) {
  const directoryIndex = segments.indexOf('.terraform');
  if (directoryIndex < 0) return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, directoryIndex));
  if (fs.existsSync(path.join(ownerDirectory, '.terraform.lock.hcl'))) return true;
  try {
    return fs.readdirSync(ownerDirectory, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith('.tf'));
  } catch {
    return false;
  }
}

function isConfiguredTypeScriptOutput(cwd, normalizedPath) {
  const candidate = path.resolve(cwd, normalizedPath);
  const segments = normalizedPath.split('/').filter(Boolean);

  for (let length = Math.max(0, segments.length - 1); length >= 0; length -= 1) {
    const configDirectory = path.join(cwd, ...segments.slice(0, length));
    const configPath = path.join(configDirectory, 'tsconfig.json');
    if (!fs.existsSync(configPath)) continue;

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // JSON-with-comments and inherited configs need a real TypeScript parser.
      // Failing closed is quieter than guessing an output path from text.
      continue;
    }

    const outDir = config?.compilerOptions?.outDir;
    if (typeof outDir !== 'string' || outDir.trim().length === 0) continue;
    const outputDirectory = path.resolve(configDirectory, outDir);
    if (outputDirectory === configDirectory) continue;
    const relation = path.relative(outputDirectory, candidate);
    if (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation))) return true;
  }

  return false;
}

function toolDirectoryHasMarker(cwd, segments, directoryName, markerNames) {
  const directoryIndex = segments.indexOf(directoryName);
  if (directoryIndex < 0) return false;

  const ownerDirectory = path.join(cwd, ...segments.slice(0, directoryIndex));
  return markerNames.some((marker) => fs.existsSync(path.join(ownerDirectory, marker)));
}

function hasMarkerAtOrAbove(cwd, directorySegments, markerName) {
  for (let length = directorySegments.length; length >= 0; length -= 1) {
    const candidate = path.join(cwd, ...directorySegments.slice(0, length), markerName);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

function expandIgnoredCandidate(cwd, candidate) {
  const files = [];
  const reviewDirectories = [];
  const errors = [];
  const relative = candidate.replace(/\/$/, '');
  const absolute = path.resolve(cwd, relative);
  const relation = path.relative(cwd, absolute);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    return { files, reviewDirectories, errors: [`refused ignored path outside worktree: ${candidate}`] };
  }

  walk(absolute, relation);
  return { files, reviewDirectories, errors };

  function walk(current, currentRelative) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      errors.push(`${currentRelative}: could not inspect (${error.message})`);
      return;
    }

    // A symlink is a pointer: removing the worktree leaves its target intact.
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files.push(currentRelative);
      return;
    }
    if (!stat.isDirectory()) {
      errors.push(`${currentRelative}: unsupported ignored filesystem entry`);
      return;
    }
    if (COARSE_IGNORED_DIRECTORIES.has(path.basename(currentRelative))) {
      reviewDirectories.push(`${currentRelative}/`);
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      errors.push(`${currentRelative}/: could not read directory (${error.message})`);
      return;
    }

    for (const entry of entries) {
      const childRelative = path.join(currentRelative, entry.name);
      // A nested repository inside an ignored directory is intrinsically
      // precious. Do not traverse its object database just to list thousands
      // of implementation files.
      if (entry.name === '.git') {
        files.push(childRelative);
        continue;
      }
      walk(path.join(current, entry.name), childRelative);
    }
  }
}

const NORMALISE_LIMIT_BYTES = 1024 * 1024;

// Unique means "the primary checkout does not have this content", so duplicates
// stay silent and anything you would actually lose does not.
//
// Byte comparison alone is not enough. Generated files bake their own absolute
// path into themselves -- Generated.xcconfig and flutter_export_environment.sh
// both do -- so every worktree's copy differs from every other while being
// identical in substance. Uniqueness by raw bytes therefore flags exactly the
// files that are cheapest to regenerate. Normalising each file's own location
// out first asks the question that was meant: does this differ in more than
// where it lives?
function compareIgnoredFile(here, reference, cwd, primaryPath) {
  try {
    if (!fs.statSync(here).isFile()) {
      return { unique: false, error: 'ignored entry is not a regular file' };
    }

    let referenceContent;
    try {
      referenceContent = fs.readFileSync(reference);
    } catch (error) {
      if (error.code === 'ENOENT') return { unique: true, error: null };
      return { unique: false, error: `could not read primary copy (${error.message})` };
    }

    const content = fs.readFileSync(here);
    if (content.equals(referenceContent)) return { unique: false, error: null };

    // Too big to be config worth normalising, and reading it as text would lie.
    if (content.length > NORMALISE_LIMIT_BYTES || referenceContent.length > NORMALISE_LIMIT_BYTES) {
      return { unique: true, error: null };
    }

    // Invalid UTF-8 buffers can both decode to the same replacement character,
    // so text normalisation would collapse distinct binary data. Only normalize
    // a buffer after a lossless UTF-8 round trip and reject embedded NULs.
    const contentText = decodeText(content);
    const referenceText = decodeText(referenceContent);
    if (contentText === null || referenceText === null) {
      return { unique: true, error: null };
    }

    const marker = '\0GIT_GROUNDSKEEPER_WORKTREE_PATH\0';
    return {
      unique: contentText.split(cwd).join(marker)
        !== referenceText.split(primaryPath).join(marker),
      error: null,
    };
  } catch (error) {
    return { unique: false, error: `could not inspect file (${error.message})` };
  }
}

function decodeText(content) {
  const text = content.toString('utf8');
  if (text.includes('\0')) return null;
  return Buffer.from(text, 'utf8').equals(content) ? text : null;
}

async function measureDiskUsageBytes(targetPath) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', targetPath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    // du -k reports 1024-byte blocks, so the multiplier is 1024 regardless of
    // how the result is later displayed. Stored values are always true bytes.
    const kibibytes = Number.parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : null;
  } catch {
    return null;
  }
}

export function classifyOwnership(repoOwners, myOwners) {
  if (myOwners.length === 0) return 'unknown';
  if (repoOwners.length === 0) return 'no-remote';

  const normalized = myOwners.map((owner) => owner.toLowerCase());
  const mine = repoOwners.some((owner) => normalized.includes(owner.toLowerCase()));

  return mine ? 'mine' : 'external';
}

async function inspectCurrentBranch(cwd) {
  const result = await git(cwd, ['branch', '--show-current']);
  if (!result.ok) {
    return {
      ok: false,
      branch: null,
      error: `git branch --show-current failed: ${result.stderr.trim() || 'unknown error'}`,
    };
  }
  return { ok: true, branch: result.stdout.trim() || null, error: null };
}

async function inspectHeadCommit(cwd) {
  const result = await git(cwd, ['show', '-s', '--format=%H%x09%h%x09%cI', 'HEAD']);
  if (!result.ok) {
    return {
      ok: false,
      headFull: null,
      head: '',
      lastCommitDate: null,
      error: `git show HEAD failed: ${result.stderr.trim() || 'unknown error'}`,
    };
  }
  const [headFull, head, lastCommitDate = null] = result.stdout.trim().split('\t');
  if (!headFull || !head) {
    return {
      ok: false,
      headFull: null,
      head: '',
      lastCommitDate: null,
      error: 'git show HEAD returned incomplete commit metadata',
    };
  }
  return { ok: true, headFull, head, lastCommitDate, error: null };
}

function inspectionError(probe, message) {
  return {
    probe,
    message: message || 'inspection failed for an unknown reason',
  };
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

  return canonicalPath(path.resolve(cwd, rawPath));
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
  const inspectionErrorWorktrees = worktrees.filter(
    (worktree) => worktree.inspectionErrors?.length > 0,
  ).length;
  const aliasedWorktrees = worktrees.filter(
    (worktree) => worktree.aliasedWorktreePaths?.length > 0,
  ).length;
  const draftWorktrees = worktrees.filter((worktree) => worktree.draftPullRequest).length;
  const branchesAhead = branches.filter((branch) => Number.isInteger(branch.ahead) && branch.ahead > 0).length;
  const noUpstream = branches.filter((branch) => branch.upstreamStatus === 'none').length;
  const goneUpstream = branches.filter((branch) => effectiveUpstreamGone(branch)).length;
  const detachedWorktrees = worktrees.filter((worktree) => worktree.detached).length;
  const largeFileWorktrees = worktrees.filter((worktree) => worktree.largeFiles.length > 0).length;

  if (dirtyWorktrees > 0) return 'commit-needed';
  if (inspectionErrorWorktrees > 0) return 'inspection-error';
  if (aliasedWorktrees > 0) return 'aliased-worktree';
  if (draftWorktrees > 0) return 'wip';
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
    inspectionErrorWorktreeCount: 0,
    aliasedWorktreeCount: 0,
    draftWorktreeCount: 0,
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
    summary.inspectionErrorWorktreeCount += repo.worktrees.filter(
      (worktree) => worktree.inspectionErrors?.length > 0,
    ).length;
    summary.aliasedWorktreeCount += repo.worktrees.filter(
      (worktree) => worktree.aliasedWorktreePaths?.length > 0,
    ).length;
    summary.draftWorktreeCount += repo.worktrees.filter(
      (worktree) => worktree.draftPullRequest,
    ).length;
    summary.branchAheadCount += repo.branches.filter((branch) => Number.isInteger(branch.ahead) && branch.ahead > 0).length;
    summary.noUpstreamBranchCount += repo.branches.filter((branch) => branch.upstreamStatus === 'none').length;
    summary.goneUpstreamBranchCount += repo.branches.filter((branch) => effectiveUpstreamGone(branch)).length;
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

function filesystemIdentity(candidatePath) {
  try {
    const stats = fs.statSync(candidatePath, { bigint: true });
    if (stats.ino !== 0n) return `fs:${stats.dev}:${stats.ino}`;
  } catch {
    // Missing and unreadable paths still need a stable fallback identity.
  }
  return `path:${canonicalPath(candidatePath)}`;
}

function resolveDirectoryIdentity(candidatePath, identityResolver) {
  try {
    return identityResolver(candidatePath) ?? `path:${canonicalPath(candidatePath)}`;
  } catch {
    return `path:${canonicalPath(candidatePath)}`;
  }
}

function preferredScanRootChildren(roots, identityResolver) {
  const preferred = new Map();

  for (const root of roots) {
    const resolvedRoot = safeRealpath(root);
    if (!resolvedRoot) continue;

    let entries;
    try {
      entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = safeRealpath(path.join(resolvedRoot, entry.name));
      if (!candidate) continue;
      const identity = resolveDirectoryIdentity(candidate, identityResolver);
      if (!preferred.has(identity)) preferred.set(identity, candidate);
    }
  }

  return preferred;
}

function uniquePathsByIdentity(paths, identityResolver) {
  const unique = new Map();
  for (const candidatePath of paths) {
    const canonical = canonicalPath(candidatePath);
    const identity = resolveDirectoryIdentity(canonical, identityResolver);
    if (!unique.has(identity)) unique.set(identity, canonical);
  }
  return [...unique.values()];
}

function canonicalPath(candidatePath) {
  const absolute = path.resolve(candidatePath);
  return safeRealpath(absolute) ?? absolute;
}

function isInsideAnyScanRoot(candidatePath, roots) {
  const candidate = canonicalPath(candidatePath);
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}
