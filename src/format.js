import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
// Warp can reserve a couple of cells for block chrome or a scrollbar without
// immediately reflecting that smaller content area through the PTY window
// size. Leave a modest gutter on interactive reports so a nominally fitting
// border cannot spill its last cells onto a continuation line. The animated
// progress renderer has its own geometry and remains full-screen.
const INTERACTIVE_REPORT_GUTTER = 4;

export function formatScanText(report, options = {}) {
  if (!options.details) {
    return formatCompactScanText(report, options);
  }

  const lines = [];
  const { summary } = report;

  lines.push('Git Groundskeeper');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Roots: ${report.roots.join(', ')}`);
  const scopeWarning = formatFilesystemRootWarning(report);
  if (scopeWarning) lines.push(scopeWarning);
  lines.push(
    `Repos: ${summary.repoCount}, worktrees: ${summary.worktreeCount}, dirty worktrees: ${summary.dirtyWorktreeCount}, draft WIP: ${summary.draftWorktreeCount ?? 0}, aliased worktrees: ${summary.aliasedWorktreeCount ?? 0}, branches ahead: ${summary.branchAheadCount}, no upstream: ${summary.noUpstreamBranchCount}, upstream gone: ${summary.goneUpstreamBranchCount}, stashes: ${summary.stashCount}`,
  );
  lines.push('');

  const visibleRepos = options.all ? report.repos : report.repos.filter((repo) => repo.status !== 'clean');

  if (visibleRepos.length === 0) {
    lines.push('No outstanding Git state found.');
    if (!options.all && report.repos.length > 0) {
      lines.push('Use --all to show clean repos too.');
    }
    return lines.join('\n');
  }

  if (!options.all && visibleRepos.length < report.repos.length) {
    lines.push(`Showing ${visibleRepos.length} repos needing attention. Use --all to show ${report.repos.length - visibleRepos.length} clean repos too.`);
    lines.push('');
  }

  for (const repo of visibleRepos) {
    lines.push(`${statusIcon(repo.status)} ${repo.status} ${repo.primaryPath}`);

    const dirtyWorktrees = repo.worktrees.filter(
      (worktree) => worktree.dirty
        || worktree.draftPullRequest
        || worktree.aliasedWorktreePaths?.length > 0
        || options.all,
    );
    for (const worktree of dirtyWorktrees) {
      lines.push(formatWorktree(worktree));
      for (const largeFile of worktree.largeFiles.slice(0, 8)) {
        lines.push(`    large ${formatBytes(largeFile.bytes)} ${largeFile.path}`);
      }
      if (worktree.largeFiles.length > 8) {
        lines.push(`    ... ${worktree.largeFiles.length - 8} more large files`);
      }
    }

    const attentionBranches = repo.branches.filter((branch) => {
      return (
        (Number.isInteger(branch.ahead) && branch.ahead > 0) ||
        branch.upstreamStatus === 'none' ||
        branch.upstreamStatus === 'gone'
      );
    });

    for (const branch of attentionBranches) {
      lines.push(formatBranch(branch));
    }

    for (const stash of repo.stashes) {
      lines.push(`  stash ${stash.ref}: ${stash.message}`);
    }

    for (const nestedRepo of repo.nestedRepos.filter((nested) => nested.dirty)) {
      lines.push(`  nested-dirty ${path.relative(repo.primaryPath, nestedRepo.path)}`);
    }

    lines.push('');
  }

  if (options.keepsDetails) {
    const tableWidth = resolveOutputWidth(options.tableWidth, process.stdout.columns);
    const theme = createTheme(options);
    const scopedWorktrees = collectWorktreeItems(report)
      .filter(({ worktree }) => isInsideAnyRoot(worktree.path, report.roots));
    const keepsLines = formatKeepsReview(
      scopedWorktrees,
      report.roots,
      theme,
      tableWidth,
      true,
    );
    if (keepsLines.length > 0) lines.push(...keepsLines, '');
  }

  return lines.join('\n').trimEnd();
}

export function formatCompactScanText(report, options = {}) {
  const lines = [];
  const tableWidth = resolveOutputWidth(options.tableWidth, process.stdout.columns);
  const theme = createTheme(options);
  const worktreeItems = collectWorktreeItems(report);
  const scopedWorktrees = worktreeItems.filter(({ worktree }) => isInsideAnyRoot(worktree.path, report.roots));
  const scopedAttentionWorktrees = scopedWorktrees.filter(isAttentionWorktree);
  const visibleWorktrees = options.all ? scopedWorktrees : scopedAttentionWorktrees;
  const hiddenCleanWorktrees = scopedWorktrees.length - scopedAttentionWorktrees.length;
  const hiddenExternalAttentionWorktrees = worktreeItems.filter((item) => !isInsideAnyRoot(item.worktree.path, report.roots) && isAttentionWorktree(item)).length;
  const branchOnlyItems = collectBranchOnlyItems(report);
  const stashes = collectStashes(report);
  const scopedSummary = buildScopedSummary(scopedAttentionWorktrees, branchOnlyItems, stashes);

  lines.push('Git Groundskeeper Compact');
  lines.push(theme.muted(`Generated: ${report.generatedAt}`));
  lines.push(theme.muted(`Roots: ${report.roots.join(', ')}`));
  const scopeWarning = formatFilesystemRootWarning(report);
  if (scopeWarning) lines.push(theme.caution(scopeWarning));
  lines.push(
    [
      `In scope: ${theme.bold(scopedWorktrees.length)} ${plural(scopedWorktrees.length, 'worktree')}`,
      `${metric(scopedAttentionWorktrees.length, theme.warn)} need attention`,
      `(${metric(scopedSummary.dirty, theme.warn)} dirty, ${metric(scopedSummary.wip, theme.caution)} WIP, ${metric(scopedSummary.aliased, theme.bad)} aliased, ${metric(scopedSummary.push, theme.info)} push, ${metric(scopedSummary.noUpstream, theme.caution)} no upstream, ${metric(scopedSummary.gone, theme.bad)} gone, ${metric(scopedSummary.prune, theme.ok)} prune, ${metric(scopedSummary.detached, theme.bad)} detached)`,
      `repo-level: ${metric(branchOnlyItems.length, theme.caution)} ${plural(branchOnlyItems.length, 'branch', 'branches')}, ${metric(stashes.length, theme.info)} ${plural(stashes.length, 'stash', 'stashes')}`,
    ].join(', '),
  );
  // Bucket mode intentionally lists clean removal candidates. Calling them
  // hidden while rendering them below made the header contradict the table.
  if (!options.buckets && !options.all && hiddenCleanWorktrees > 0) {
    lines.push(theme.muted(`Clean worktrees hidden: ${hiddenCleanWorktrees}. Use --all to include them.`));
  }
  if (hiddenExternalAttentionWorktrees > 0) {
    lines.push(theme.muted(`Linked worktrees outside roots hidden: ${hiddenExternalAttentionWorktrees}. Use --details to audit all linked worktrees.`));
  }
  lines.push('');

  // --buckets answers "what can I remove, and what does it cost me" by grouping
  // worktrees under their tier. It replaces the flat list rather than preceding
  // it: showing both prints every worktree twice. This has to precede the
  // ordinary attention-state empty check because a clean removal candidate is
  // exactly what bucket mode exists to show.
  if (options.buckets) {
    lines.push(...formatTierBuckets(report, theme, tableWidth, options));
    if (options.commands) {
      lines.push(...formatCleanupCommands(report, theme, options.commandsTier));
    }
    return finalizeCompactOutput(lines, tableWidth, options);
  }

  if (visibleWorktrees.length === 0 && branchOnlyItems.length === 0 && stashes.length === 0) {
    lines.push('No outstanding Git state found.');
    return finalizeCompactOutput(lines, tableWidth, options);
  }

  if (visibleWorktrees.length > 0) {
    // One row per worktree, not a table per worktree. A vertical Field/Value
    // block reads well for one repo and becomes a thousand lines of scroll at
    // machine scale, which is where this tool now operates. --details still
    // renders the deep per-worktree view.
    const showSizes = visibleWorktrees.some(({ worktree }) => Number.isInteger(worktree.bytes));
    const ordered = showSizes
      ? [...visibleWorktrees].sort((a, b) => (b.worktree.bytes ?? 0) - (a.worktree.bytes ?? 0))
      : visibleWorktrees;

    lines.push(formatWorktreeSummaryTitle(visibleWorktrees.length, scopedAttentionWorktrees.length, scopedWorktrees.length, options.all));
    if (showSizes) {
      lines.push(theme.muted('Largest first.'));
    }
    lines.push(...renderTable(
      worktreeRowColumns(showSizes),
      formatWorktreeRows(ordered, report.roots, theme, showSizes, report.generatedAt),
      tableWidth,
      theme,
    ));
    if (showSizes) {
      const measuredSizes = summarizeNonOverlappingSizes(ordered);
      const unmeasuredCount = ordered.length - measuredSizes.measured.length;
      let sizeSummary;
      if (measuredSizes.excluded.length > 0 && unmeasuredCount === 0) {
        sizeSummary = `Total unique size shown: ${formatBytes(measuredSizes.totalBytes)} across ${measuredSizes.counted.length} top-level ${plural(measuredSizes.counted.length, 'worktree')}; ${measuredSizes.excluded.length} nested ${plural(measuredSizes.excluded.length, 'row')} excluded to prevent double-counting.`;
      } else if (measuredSizes.excluded.length > 0) {
        sizeSummary = `Measured unique size shown: ${formatBytes(measuredSizes.totalBytes)} across ${measuredSizes.counted.length} non-overlapping ${plural(measuredSizes.counted.length, 'worktree')}; ${unmeasuredCount} of ${ordered.length} rows unmeasured; ${measuredSizes.excluded.length} nested measured ${plural(measuredSizes.excluded.length, 'row')} excluded to prevent double-counting.`;
      } else if (unmeasuredCount === 0) {
        sizeSummary = `Total size shown: ${formatBytes(measuredSizes.totalBytes)} across ${measuredSizes.measured.length} ${plural(measuredSizes.measured.length, 'worktree')}.`;
      } else {
        sizeSummary = `Measured size shown: ${formatBytes(measuredSizes.totalBytes)} across ${measuredSizes.measured.length} of ${ordered.length} worktrees; ${unmeasuredCount} unmeasured.`;
      }
      lines.push(theme.bold(sizeSummary));
    }
    lines.push('');
  }

  if (options.keepsDetails) {
    const keepsLines = formatKeepsReview(
      scopedWorktrees,
      report.roots,
      theme,
      tableWidth,
      true,
    );
    if (keepsLines.length > 0) lines.push(...keepsLines, '');
  }

  if (branchOnlyItems.length > 0) {
    const branchHeading = branchOnlyItems.some(({ branch }) => branch.draftPullRequest)
      ? 'Repository-level branch attention'
      : 'Repository-level branch cleanup';
    lines.push(`${branchHeading} (${branchOnlyItems.length})`);
    lines.push(...renderTable(branchColumns(), formatBranchRows(branchOnlyItems, report.roots, theme, report.generatedAt), tableWidth, theme));
    lines.push('');
  }

  if (stashes.length > 0) {
    lines.push(`Repository-level state (${stashes.length})`);
    lines.push(...renderTable(repoStateColumns(), formatStashRows(stashes, report.roots, theme), tableWidth, theme));
    lines.push('');
  }

  return finalizeCompactOutput(lines, tableWidth, options);
}

const TIER_BUCKETS = [
  {
    tier: 'worktree-and-branch',
    unmerged: 'zero',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    deleteBranch: true,
    label: 'ready if unused: remove checkout + branch',
    note: 'clean, merged, remote branch already deleted; confirm no active task uses the path',
    reclaimable: true,
  },
  {
    key: 'worktree-and-branch-different-upstream',
    tier: 'worktree-and-branch',
    unmerged: 'zero',
    upstreamRelation: 'different',
    branchState: 'attached',
    label: 'review: remove checkout, retain branch; upstream name differs',
    note: 'merged and remote branch gone, but the configured upstream names a different branch',
    reclaimable: true,
  },
  {
    key: 'worktree-and-branch-unmerged',
    tier: 'worktree-and-branch',
    unmerged: 'positive',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    label: 'review: remove checkout, retain local branch history',
    note: 'remote is gone and the PR is merged, but original commits remain outside the base',
    reclaimable: true,
  },
  {
    key: 'worktree-and-branch-unmerged-different-upstream',
    tier: 'worktree-and-branch',
    unmerged: 'positive',
    upstreamRelation: 'different',
    branchState: 'attached',
    label: 'review: remove checkout, retain local branch history; upstream name differs',
    note: 'merged, but original commits remain outside the base and the configured upstream names another branch',
    reclaimable: true,
  },
  {
    key: 'worktree-and-branch-unknown',
    tier: 'worktree-and-branch',
    unmerged: 'unknown',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    label: 'review: remove checkout, retain local branch; integration unknown',
    note: 'remote is gone, but the original commits could not be compared to a base',
    reclaimable: true,
  },
  {
    key: 'worktree-and-branch-unknown-different-upstream',
    tier: 'worktree-and-branch',
    unmerged: 'unknown',
    upstreamRelation: 'different',
    branchState: 'attached',
    label: 'review: remove checkout, retain local branch; integration and upstream need review',
    note: 'no comparable base was found and the configured upstream names another branch',
    reclaimable: true,
  },
  {
    key: 'worktree-only-integrated-github-merged',
    tier: 'worktree-only',
    unmerged: 'zero',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'merged',
    label: 'ready if unused: remove checkout; merged branch can be retired',
    note: 'GitHub merged this exact branch tip; branch retirement remains separate',
    reclaimable: true,
  },
  {
    key: 'worktree-only-github-merged-unmerged',
    tier: 'worktree-only',
    unmerged: 'positive',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'merged',
    label: 'review: remove checkout, retain merged source branch',
    note: 'the PR is merged, but original commits remain outside the base',
    reclaimable: true,
  },
  {
    key: 'worktree-only-github-merged-unknown',
    tier: 'worktree-only',
    unmerged: 'unknown',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'merged',
    label: 'review: remove checkout, retain merged source branch; integration unknown',
    note: 'GitHub merged the tip, but the original commits could not be compared to a base',
    reclaimable: true,
  },
  {
    key: 'worktree-only-integrated-retained',
    tier: 'worktree-only',
    unmerged: 'zero',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'not-confirmed',
    label: 'ready if unused: remove checkout, retain branch',
    note: 'Git-safe checkout removal; no exact-name merged PR confirmation from GitHub',
    reclaimable: true,
  },
  {
    key: 'worktree-only-integrated-detached',
    tier: 'worktree-only',
    unmerged: 'zero',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'detached',
    retention: 'verified',
    label: 'ready if unused: remove detached checkout, commit retained',
    note: 'a verified local branch or live remote retains HEAD; confirm no active task uses this path',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unmerged-detached',
    tier: 'worktree-only',
    unmerged: 'positive',
    branchState: 'detached',
    retention: 'verified',
    label: 'review: remove detached checkout, retained commit is not integrated',
    note: 'a verified ref retains HEAD, but commits remain outside the integration base',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unknown-detached',
    tier: 'worktree-only',
    unmerged: 'unknown',
    branchState: 'detached',
    retention: 'verified',
    label: 'review: remove detached checkout, integration unknown',
    note: 'a verified ref retains HEAD, but no comparable integration base was found',
    reclaimable: true,
  },
  {
    key: 'worktree-only-integrated-different-upstream',
    tier: 'worktree-only',
    unmerged: 'zero',
    upstreamRelation: 'different',
    label: 'review: remove checkout, branch integrated, upstream name differs',
    note: 'clean; local branch tracks a differently named upstream branch',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unmerged',
    tier: 'worktree-only',
    unmerged: 'positive',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'not-confirmed',
    label: 'review: remove checkout, keep unmerged branch',
    note: 'clean and pushed; commits remain outside the base',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unmerged-different-upstream',
    tier: 'worktree-only',
    unmerged: 'positive',
    upstreamRelation: 'different',
    branchState: 'attached',
    label: 'review: remove checkout, keep unmerged branch, upstream name differs',
    note: 'clean; local branch tracks a differently named upstream branch',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unknown',
    tier: 'worktree-only',
    unmerged: 'unknown',
    upstreamRelation: 'own-or-unavailable',
    branchState: 'attached',
    githubMerge: 'not-confirmed',
    label: 'review: remove checkout, integration unknown',
    note: 'clean and pushed; no comparable base was found',
    reclaimable: true,
  },
  {
    key: 'worktree-only-unknown-different-upstream',
    tier: 'worktree-only',
    unmerged: 'unknown',
    upstreamRelation: 'different',
    branchState: 'attached',
    label: 'review: remove checkout, integration unknown, upstream name differs',
    note: 'clean; local branch tracks a differently named upstream branch',
    reclaimable: true,
  },
  {
    tier: 'wip',
    label: 'blocked: open draft PR marks active WIP',
    note: 'resolve or mark the draft ready before considering checkout removal',
    reclaimable: false,
  },
  {
    tier: 'check-first',
    label: 'check first: ignored content here',
    note: 'content differs from the primary checkout or lives in a directory that is not assumed disposable',
    reclaimable: false,
  },
  {
    tier: 'push-first',
    label: 'push first: branch is not safely retained upstream',
    note: 'the configured upstream does not currently verify this branch tip',
    reclaimable: false,
  },
  {
    tier: 'inspection-error',
    label: 'blocked: inspection failed',
    note: 'a required safety probe failed; no cleanup is proposed',
    reclaimable: false,
  },
  {
    tier: 'aliased',
    label: 'blocked: aliased worktree metadata',
    note: 'multiple paths share one Git worktree; removing one can break the others',
    reclaimable: false,
  },
  {
    tier: 'blocked',
    blockedReason: 'dirty',
    label: 'blocked: uncommitted work',
    note: 'removing this loses work',
    reclaimable: false,
  },
  {
    key: 'blocked-locked',
    tier: 'blocked',
    blockedReason: 'locked',
    label: 'blocked: worktree is locked',
    note: 'Git marks this checkout as not eligible for removal',
    reclaimable: false,
  },
  {
    key: 'blocked-in-progress',
    tier: 'blocked',
    blockedReason: 'in-progress',
    label: 'blocked: Git operation in progress',
    note: 'finish or abort the recorded operation before considering cleanup',
    reclaimable: false,
  },
  {
    key: 'blocked-detached',
    tier: 'blocked',
    blockedReason: 'detached',
    label: 'blocked: detached commits have no verified ref',
    note: 'removing this checkout can make commits difficult to recover',
    reclaimable: false,
  },
  {
    key: 'blocked-other',
    tier: 'blocked',
    blockedReason: 'other',
    label: 'blocked: cleanup is unsafe',
    note: 'the scanner found a blocking condition that requires review',
    reclaimable: false,
  },
  {
    key: 'worktree-only-detached-unverified',
    tier: 'worktree-only',
    branchState: 'detached',
    retention: 'unverified',
    label: 'blocked: detached retention is unverified',
    note: 'no verified local branch or live remote has been shown to retain HEAD',
    reclaimable: false,
  },
  {
    tier: 'submodule',
    label: 'blocked: submodule checked out',
    note: 'git refuses; check the submodule branch',
    reclaimable: false,
  },
  {
    tier: 'primary',
    label: 'primary checkout',
    note: 'never removed',
    reclaimable: false,
  },
];

// The worktrees themselves, one row each, grouped under the tier they sit in.
// A summary of counts answers "how much" and leaves nothing to act on; the
// point of a bucket is knowing which worktrees are in it.
export function formatTierBuckets(report, theme, tableWidth, options = {}) {
  const items = collectWorktreeItems(report)
    .filter(({ worktree }) => isInsideAnyRoot(worktree.path, report.roots));
  const lines = [
    theme.muted('Upstream = configured tracking branch. Push = commits ahead of it. Unmerged = commits absent from the repo integration base.'),
    theme.muted('GitHub = live merged-PR evidence. No exact-name PR match is not proof of no merge; PR heads can have different names and the query is capped.'),
    theme.muted('Candidate remote branches are checked live without fetching, pruning, or changing local refs.'),
    theme.muted('A differently named upstream gets its own review bucket. Merged PRs with nonzero Unmerged retain their source branch.'),
    theme.muted('? = no comparable upstream/base. Age = HEAD commit age, not proof of inactivity.'),
    '',
  ];
  const repositoryEvidence = formatRepositoryIntegrationEvidence(items, report.roots, theme, tableWidth);
  if (repositoryEvidence.length > 0) {
    lines.push(...repositoryEvidence, '');
  }
  const reclaimableItems = items.filter(({ worktree }) =>
    TIER_BUCKETS.some((bucket) => bucket.reclaimable && matchesTierBucket(bucket, worktree)),
  );
  const reclaimableSizes = summarizeNonOverlappingSizes(reclaimableItems);

  for (const bucket of TIER_BUCKETS) {
    const inBucket = items.filter(({ worktree }) => matchesTierBucket(bucket, worktree));
    if (inBucket.length === 0) continue;

    const bucketSizes = summarizeNonOverlappingSizes(inBucket);
    const sized = bucketSizes.measured;
    const bytes = bucketSizes.totalBytes;
    // --sizes describes every row regardless of cleanup eligibility. Safety is
    // still expressed by the bucket, and only reclaimable buckets contribute
    // to the reclaimable total below.
    const showSizes = sized.length > 0;

    const paint = bucket.label.startsWith('ready if unused')
      ? theme.ok
      : bucket.tier === 'wip'
        ? theme.caution
        : bucket.tier === 'worktree-only'
          ? theme.caution
          : bucket.reclaimable
            ? theme.ok
            : theme.muted;
    const total = showSizes
      ? `, ${formatBytes(bytes)}${bucket.reclaimable ? '' : ' on disk'}${bucketSizes.excluded.length > 0 ? `; ${bucketSizes.excluded.length} nested excluded` : ''}`
      : '';

    lines.push(`${paint(bucket.label)} (${inBucket.length}${total}) ${theme.muted(`- ${bucket.note}`)}`);

    const ordered = showSizes
      ? [...inBucket].sort((a, b) => (b.worktree.bytes ?? 0) - (a.worktree.bytes ?? 0))
      : inBucket;

    lines.push(...renderTable(
      worktreeRowColumns(showSizes, 'buckets'),
      formatWorktreeRows(ordered, report.roots, theme, showSizes, report.generatedAt),
      tableWidth,
      theme,
    ));
    if (bucket.tier === 'check-first') {
      lines.push('');
      lines.push(...formatKeepsReview(inBucket, report.roots, theme, tableWidth, options.keepsDetails));
    }
    lines.push('');
  }

  lines.push(...formatOrphanedBranchBucket(report, theme, tableWidth));

  // Orphaned prune candidates get their evidence-specific buckets above. The
  // other repository-level branches and stashes still matter in bucket mode;
  // omitting them made the header announce state the body never revealed.
  const otherBranches = collectBranchOnlyItems(report)
    .filter(({ branch }) => branch.cleanupStatus !== 'prune-candidate');
  if (otherBranches.length > 0) {
    lines.push(
      `Repository-level branch attention (${otherBranches.length})`,
      ...renderTable(
        branchColumns(),
        formatBranchRows(otherBranches, report.roots, theme, report.generatedAt),
        tableWidth,
        theme,
      ),
      '',
    );
  }

  const stashes = collectStashes(report);
  if (stashes.length > 0) {
    lines.push(
      `Repository-level state (${stashes.length})`,
      ...renderTable(repoStateColumns(), formatStashRows(stashes, report.roots, theme), tableWidth, theme),
      '',
    );
  }

  if (lines.length === 0) return lines;

  if (reclaimableSizes.measured.length > 0) {
    const nestedNote = reclaimableSizes.excluded.length > 0
      ? `; ${reclaimableSizes.excluded.length} nested ${plural(reclaimableSizes.excluded.length, 'row')} excluded to prevent double-counting`
      : '';
    lines.push(theme.bold(`Reclaimable after review: ${formatBytes(reclaimableSizes.totalBytes)}${nestedNote}`));
  }
  lines.push(...formatRemoteStaleness(report, theme));
  lines.push('');

  return lines;
}

function formatRepositoryIntegrationEvidence(items, roots, theme, tableWidth) {
  const byRepo = new Map();
  for (const item of items) {
    if (!byRepo.has(item.repo)) byRepo.set(item.repo, []);
    byRepo.get(item.repo).push(item);
  }

  const rows = [...byRepo.entries()].map(([repo, repoItems]) => {
    const bases = [...new Set(repoItems
      .map(({ worktree, branch }) => branch?.unmergedBase ?? worktree.unmergedBase)
      .filter(Boolean))];
    const baseHeads = [...new Set(repoItems
      .map(({ worktree, branch }) => branch?.unmergedBaseHead ?? worktree.unmergedBaseHead)
      .filter(Boolean))];
    const containment = summarizePrimaryContainment(repoItems);
    const liveUpstream = summarizeLiveUpstreams(repoItems);
    const primary = repo.defaultBranch
      ? repo.defaultBranchStatus === 'checked'
        ? repo.defaultBranch
        : `${repo.defaultBranch} (${repo.defaultBranchStatus})`
      : repo.defaultBranchStatus === 'unavailable'
        ? 'unavailable'
        : '-';

    return {
      repo: repo.repository ?? shortenPath(repo.primaryPath, roots),
      integration: bases.length > 0 ? bases.join(', ') : '-',
      integrationHead: baseHeads.length > 0 ? baseHeads.map(shortObjectId).join(', ') : '-',
      primary,
      primaryHead: shortObjectId(repo.defaultBranchHead),
      containment: colorPrimaryContainment(containment, theme),
      live: liveUpstream,
    };
  });

  if (rows.length === 0) return [];

  return [
    theme.bold('Repository integration evidence'),
    theme.muted('Primary is the remote default branch. Containment is Git ancestry against its current SHA; ? means live commit ancestry could not be verified. Inspect verification diagnostics.'),
    ...renderTable([
      { key: 'repo', header: 'Repo', minWidth: 14, maxWidth: 36 },
      { key: 'integration', header: 'Integration base', minWidth: 14, maxWidth: 28 },
      { key: 'integrationHead', header: 'Base SHA', minWidth: 10, maxWidth: 12 },
      { key: 'primary', header: 'Primary', minWidth: 8, maxWidth: 20 },
      { key: 'primaryHead', header: 'Primary SHA', minWidth: 10, maxWidth: 12 },
      { key: 'containment', header: 'Contained', minWidth: 12, maxWidth: 24, clip: 'end' },
      { key: 'live', header: 'Live upstream', minWidth: 10, maxWidth: 24, clip: 'end' },
    ], rows, tableWidth, theme),
  ];
}

function summarizePrimaryContainment(items) {
  const counts = { contained: 0, 'not-contained': 0, unknown: 0 };
  for (const { worktree } of items) {
    if (worktree.defaultBranchContainment in counts) {
      counts[worktree.defaultBranchContainment] += 1;
    }
  }

  return `yes ${counts.contained}, no ${counts['not-contained']}, ? ${counts.unknown}`;
}

function colorPrimaryContainment(value, theme) {
  if (/no [1-9]/.test(value)) return theme.bad(value);
  if (/\? [1-9]/.test(value)) return theme.caution(value);
  return theme.ok(value);
}

function summarizeLiveUpstreams(items) {
  const counts = new Map();
  for (const { worktree, branch } of items) {
    const status = (branch ?? worktree).liveUpstreamStatus ?? 'not-requested';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([status, count]) => `${status} ${count}`)
    .join(', ');
}

function shortObjectId(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : '-';
}

const KEEPS_DETAIL_LIMIT = 12;

function formatKeepsReview(items, roots, theme, tableWidth, showDetails = false) {
  const entries = items.flatMap(({ repo, worktree }) =>
    (worktree.preciousIgnored ?? []).map((relativePath) => ({
      repo,
      worktree,
      relativePath,
    })),
  );
  if (entries.length === 0) return [];

  const groups = groupKeepsEntries(entries);
  const lines = [
    theme.bold(`Keeps review (${entries.length} ${plural(entries.length, 'entry', 'entries')})`),
    theme.muted('Grouped by repository and path family. Rule advice is advisory only; Groundskeeper has not suppressed any of these paths.'),
    ...renderTable(
      keepsReviewColumns(),
      groups.map((group) => ({
        repo: shortenPath(group.repo.primaryPath, roots),
        family: group.family,
        checkouts: String(group.worktrees.size),
        entries: String(group.entries.length),
        advice: colorKeepsAdvice(group.advice, theme),
      })),
      tableWidth,
      theme,
    ),
  ];

  if (!showDetails) {
    lines.push(theme.muted('Use --keeps-details for exact path samples by checkout; --json contains every path.'));
    return lines;
  }

  lines.push('', theme.bold('Exact Keeps samples by checkout'));
  for (const { repo, worktree } of items) {
    const precious = worktree.preciousIgnored ?? [];
    if (precious.length === 0) continue;
    const checkout = shortenPath(worktree.path, roots);
    const repoName = shortenPath(repo.primaryPath, roots);
    lines.push(theme.caution(`${checkout} (${precious.length}) ${theme.muted(`- repo ${repoName}`)}`));

    for (const relativePath of precious.slice(0, KEEPS_DETAIL_LIMIT)) {
      const classification = classifyKeepsPath(relativePath);
      lines.push(`  ${classification.marker} ${relativePath} ${theme.muted(`- ${classification.detail}`)}`);
    }
    if (precious.length > KEEPS_DETAIL_LIMIT) {
      lines.push(theme.muted(`  ... ${precious.length - KEEPS_DETAIL_LIMIT} more; --json contains the complete preciousIgnored list.`));
    }
  }

  return lines;
}

function keepsReviewColumns() {
  return [
    { key: 'repo', header: 'Repo', minWidth: 12, maxWidth: 30 },
    { key: 'family', header: 'Keeps family', minWidth: 12, maxWidth: 30 },
    { key: 'checkouts', header: 'Trees', minWidth: 5, maxWidth: 5, clip: 'end' },
    { key: 'entries', header: 'Entries', minWidth: 7, maxWidth: 7, clip: 'end' },
    { key: 'advice', header: 'Rule advice', minWidth: 18, maxWidth: 40, clip: 'end' },
  ];
}

function groupKeepsEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const family = keepsPathFamily(entry.relativePath);
    const key = `${entry.repo.primaryPath}\0${family}`;
    if (!groups.has(key)) {
      groups.set(key, {
        repo: entry.repo,
        family,
        entries: [],
        worktrees: new Set(),
      });
    }
    const group = groups.get(key);
    group.entries.push(entry);
    group.worktrees.add(entry.worktree.path);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, advice: recommendKeepsRule(group) }))
    .sort((left, right) =>
      right.worktrees.size - left.worktrees.size
        || right.entries.length - left.entries.length
        || left.repo.primaryPath.localeCompare(right.repo.primaryPath)
        || left.family.localeCompare(right.family),
    );
}

function keepsPathFamily(relativePath) {
  const normalized = String(relativePath).split(path.sep).join('/');
  if (normalized.endsWith('/')) return normalized;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return normalized;
  if (segments[0] === '.idea') return '.idea/**';

  const basename = segments.at(-1);
  if (isGeneratedEvidencePath(normalized)) return `**/${basename}`;
  return `${segments.slice(0, Math.min(2, segments.length - 1)).join('/')}/**`;
}

function recommendKeepsRule(group) {
  const classifications = group.entries.map(({ relativePath }) => classifyKeepsPath(relativePath));
  if (classifications.some(({ kind }) => kind === 'coarse')) return 'inspect tree; no blanket rule';
  if (classifications.some(({ kind }) => kind === 'sensitive')) return 'preserve; never suggest rule';
  if (classifications.every(({ kind }) => kind === 'evidence')) return 'generated evidence; opt in only';
  if (classifications.every(({ kind }) => kind === 'editor')) return 'inspect settings; exact rule candidate';
  if (classifications.some(({ kind }) => kind === 'record')) return 'records may matter; keep visible';
  if (group.worktrees.size > 1) return 'repeats; inspect before exact rule';
  return 'inspect; no rule inferred';
}

function classifyKeepsPath(relativePath) {
  const normalized = String(relativePath).split(path.sep).join('/');
  const basename = path.posix.basename(normalized.replace(/\/$/, ''));

  if (normalized.endsWith('/')) {
    return {
      kind: 'coarse',
      marker: '[tree]',
      detail: 'coarse directory; contents were not inspected, so no blanket rule is suggested',
    };
  }
  if (isSensitiveKeepsPath(normalized)) {
    return {
      kind: 'sensitive',
      marker: '[keep]',
      detail: 'sensitive-looking local content; never auto-suggest a suppression rule',
    };
  }
  if (isGeneratedEvidencePath(normalized)) {
    return {
      kind: 'evidence',
      marker: '[output]',
      detail: 'likely generated evidence; an exact repository rule is possible only by explicit opt-in',
    };
  }
  if (normalized.startsWith('.idea/') || ['codeStyleConfig.xml', 'Project_Default.xml'].includes(basename)) {
    return {
      kind: 'editor',
      marker: '[editor]',
      detail: 'editor settings differ or exist only here; inspect before an exact repository rule',
    };
  }
  if (/(?:^|\/)(?:logs?|test-results?|reports?)(?:\/|$)/i.test(normalized)
    || /\.(?:log|lock|md|sqlite3?|db)$/i.test(basename)) {
    return {
      kind: 'record',
      marker: '[record]',
      detail: 'log, evidence, lock, or document content may be the reason this checkout still matters',
    };
  }
  return {
    kind: 'unknown',
    marker: '[review]',
    detail: 'absent from or different to the primary checkout; no rule is inferred from its name',
  };
}

function isSensitiveKeepsPath(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return basename === '.env'
    || basename.startsWith('.env.')
    || /(?:secret|credential|password|token|api[-_]?key)/i.test(relativePath)
    || /\.(?:pem|p12|pfx|jks|keystore|key)$/i.test(basename);
}

function isGeneratedEvidencePath(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return basename === 'coverage.cobertura.xml'
    || basename === 'junit.xml'
    || /(?:^|\/)test-results?\//i.test(relativePath);
}

function colorKeepsAdvice(advice, theme) {
  if (advice.startsWith('preserve') || advice.startsWith('records')) return theme.bad(advice);
  if (advice.includes('candidate') || advice.startsWith('repeats')) return theme.caution(advice);
  return theme.muted(advice);
}

function matchesTierBucket(bucket, worktree) {
  if (worktree.tier !== bucket.tier) return false;
  if (bucket.unmerged === 'zero' && worktree.unmergedCommits !== 0) return false;
  if (bucket.unmerged === 'positive'
    && !(Number.isInteger(worktree.unmergedCommits) && worktree.unmergedCommits > 0)) return false;
  if (bucket.unmerged === 'unknown' && Number.isInteger(worktree.unmergedCommits)) return false;
  if (bucket.branchState === 'attached' && !worktree.branch) return false;
  if (bucket.branchState === 'detached' && worktree.branch) return false;
  if (bucket.retention === 'verified' && worktree.retentionVerified !== true) return false;
  if (bucket.retention === 'unverified' && worktree.retentionVerified === true) return false;
  if (bucket.blockedReason && bucket.blockedReason !== blockedReason(worktree)) return false;
  if (bucket.githubMerge === 'merged' && worktree.githubMergeStatus !== 'merged') return false;
  if (bucket.githubMerge === 'not-confirmed' && worktree.githubMergeStatus === 'merged') return false;
  return matchesUpstreamRelation(bucket, worktree);
}

function blockedReason(worktree) {
  if (worktree.dirty) return 'dirty';
  if (worktree.locked) return 'locked';
  if (worktree.inProgress) return 'in-progress';
  if (worktree.detached) return 'detached';
  return 'other';
}

function matchesUpstreamRelation(bucket, worktree) {
  if (!bucket.upstreamRelation) return true;
  const differs = upstreamBranchNameDiffers(worktree);
  if (bucket.upstreamRelation === 'different') return differs;
  if (bucket.upstreamRelation === 'own-or-unavailable') return !differs;
  return true;
}

function upstreamBranchNameDiffers(worktree) {
  if (!worktree.branch || !worktree.upstream) return false;
  if (worktree.upstreamBranch) return worktree.upstreamBranch !== worktree.branch;

  // Backward-compatible fallback for JSON reports produced before
  // upstreamBranch was recorded. Scanner-produced reports use the exact
  // refs/heads value above, so slash-containing branch names are unambiguous.
  return worktree.upstream !== worktree.branch
    && !worktree.upstream.endsWith(`/${worktree.branch}`);
}

// Buckets are built from worktrees, so a merged branch that outlived its
// checkout appears in none of them. Those are the branches a cleanup pass
// leaves behind -- the tool would recommend removing worktrees and then go
// quiet about what that left, which is the one thing it created.
export function collectOrphanedCandidates(report) {
  return report.repos
    .flatMap((repo) => repo.branches.map((branch) => ({ repo, branch })))
    .filter(({ repo, branch }) =>
      branch.cleanupStatus === 'prune-candidate'
      && !branch.draftPullRequest
      && !branch.checkedOut
      && repoHasWorktreeInsideRoots(repo, report.roots))
    .sort((a, b) => {
      const repoCompare = a.repo.primaryPath.localeCompare(b.repo.primaryPath);
      return repoCompare || a.branch.name.localeCompare(b.branch.name);
    });
}

function formatOrphanedBranchBucket(report, theme, tableWidth) {
  const orphans = collectOrphanedCandidates(report);
  if (orphans.length === 0) return [];

  const safe = orphans.filter(({ branch }) => branch.ancestryVisible === true);
  const retained = orphans.filter(({ branch }) => branch.ancestryVisible !== true);
  const lines = [];

  if (safe.length > 0) {
    lines.push(
      `${theme.ok('safe: remove branch')} (${safe.length}) ${theme.muted('- command rechecks the named integration base; no worktree left')}`,
      ...renderTable(orphanColumns(), formatOrphanRows(safe, report, theme, 'base check'), tableWidth, theme),
      '',
    );
  }

  if (retained.length > 0) {
    lines.push(
      `${theme.caution('review: retain merged source branch')} (${retained.length}) ${theme.muted('- PR or squash merged, but original commits remain outside base history')}`,
      ...renderTable(orphanColumns(), formatOrphanRows(retained, report, theme, 'retained'), tableWidth, theme),
      '',
    );
  }

  return lines;
}

function formatOrphanRows(items, report, theme, deletes) {
  return items.map(({ repo, branch }) => ({
    branch: branch.name,
    repo: shortenPath(repo.primaryPath, report.roots),
    remote: colorRemote(formatRemoteState({ detached: false }, branch), theme),
    deletes: deletes === 'retained' ? theme.caution(deletes) : theme.ok(deletes),
  }));
}

function orphanColumns() {
  return [
    { key: 'branch', header: 'Branch', minWidth: 20, maxWidth: 44 },
    { key: 'repo', header: 'Repo', minWidth: 14, maxWidth: 40 },
    { key: 'remote', header: 'Remote', minWidth: 10, maxWidth: 22 },
    { key: 'deletes', header: 'Deletes', minWidth: 8, maxWidth: 9, clip: 'end' },
  ];
}

// `worktree remove` never forces: a refusal there means real uncommitted work,
// which is a second opinion worth deferring to.
//
// `branch -d` is not an integration-base check. When a branch has a configured
// upstream, Git may authorize deletion merely because the tip is contained by
// that (possibly stale) feature-branch ref. Recheck against the explicit base
// that established the scanner's merge evidence. `update-ref` then performs an
// atomic expected-old deletion: if the branch moved since the scan, it refuses
// instead of deleting work the report never inspected.
function branchDeleteCommand(repoPath, branch) {
  if (!branch?.name || !branch.mergedInto || !isFullObjectId(branch.head)) return null;

  const branchRef = `refs/heads/${branch.name}`;
  return [
    `git -C ${shellQuote(repoPath)} merge-base --is-ancestor ${shellQuote(branchRef)} ${shellQuote(branch.mergedInto)}`,
    `git -C ${shellQuote(repoPath)} update-ref -d ${shellQuote(branchRef)} ${shellQuote(branch.head)}`,
  ].join(' && ');
}

// Bind checkout removal to the exact identity the scan reviewed. Git already
// refuses ordinary dirty-state changes, while these two guards close the clean
// branch-switch and moved-HEAD races that `git worktree remove` cannot see.
function attachedWorktreeRemoveCommand(repoPath, worktree, branch) {
  const expectedHead = isFullObjectId(worktree.headFull)
    ? worktree.headFull
    : branch?.name === worktree.branch && isFullObjectId(branch.head)
      ? branch.head
      : null;
  if (!worktree.branch || !expectedHead) return null;

  const branchCheck = [
    `git -C ${shellQuote(worktree.path)} symbolic-ref --quiet --short HEAD`,
    `grep -Fqx -- ${shellQuote(worktree.branch)}`,
  ].join(' | ');
  const headCheck = `test "$(git -C ${shellQuote(worktree.path)} rev-parse --verify HEAD)" = ${shellQuote(expectedHead)}`;
  const remove = `git -C ${shellQuote(repoPath)} worktree remove ${shellQuote(worktree.path)}`;
  return `${branchCheck} && ${headCheck} && ${remove}`;
}

// A detached checkout has no branch of its own, so its scan-time retention
// evidence can disappear before a pasted command runs. Recheck both the exact
// detached HEAD and the durable ref, then materialize the scanned commit as a
// visible local safety branch before removal. The branch closes the retention
// race: even if the original local or remote ref changes after the check, the
// commit remains named locally. The ready-if-unused gate still matters because
// no pasted shell command can make concurrent use of the checkout safe.
function detachedWorktreeRemoveCommand(repoPath, worktree) {
  if (!worktree.detached || !isFullObjectId(worktree.headFull)) return null;

  const expectedHead = worktree.headFull;
  const headCheck = `test "$(git -C ${shellQuote(worktree.path)} rev-parse --verify HEAD)" = ${shellQuote(expectedHead)}`;
  let retentionCheck = null;

  if (worktree.retentionSource === 'local-branch' && worktree.containedIn) {
    retentionCheck = `git -C ${shellQuote(repoPath)} merge-base --is-ancestor ${shellQuote(expectedHead)} ${shellQuote(`refs/heads/${worktree.containedIn}`)}`;
  } else if (worktree.retentionSource === 'local-tag' && worktree.containedIn) {
    retentionCheck = `git -C ${shellQuote(repoPath)} merge-base --is-ancestor ${shellQuote(expectedHead)} ${shellQuote(`refs/tags/${worktree.containedIn}^{}`)}`;
  } else if (
    worktree.retentionSource === 'live-remote'
    && worktree.retentionRemote
    && worktree.retentionBranch
    && isFullObjectId(worktree.retentionRefHead)
  ) {
    const remoteRef = `refs/heads/${worktree.retentionBranch}`;
    const query = `git -C ${shellQuote(repoPath)} ls-remote --exit-code --heads ${shellQuote(worktree.retentionRemote)} ${shellQuote(remoteRef)}`;
    retentionCheck = `test "$(${query} | cut -f1)" = ${shellQuote(worktree.retentionRefHead)}`;
  }

  if (!retentionCheck) return null;
  const safetyRef = detachedSafetyRef(worktree);
  const zeroObjectId = '0'.repeat(expectedHead.length);
  const createSafetyRef = [
    `(git -C ${shellQuote(repoPath)} update-ref ${shellQuote(safetyRef)} ${shellQuote(expectedHead)} ${shellQuote(zeroObjectId)}`,
    `|| test "$(git -C ${shellQuote(repoPath)} rev-parse --verify ${shellQuote(safetyRef)})" = ${shellQuote(expectedHead)})`,
  ].join(' ');

  return `${headCheck} && ${retentionCheck} && ${createSafetyRef} && ${headCheck} && git -C ${shellQuote(repoPath)} worktree remove ${shellQuote(worktree.path)}`;
}

function detachedSafetyRef(worktree) {
  if (!worktree.detached || !isFullObjectId(worktree.headFull)) return null;
  return `refs/heads/git-groundskeeper/retained-detached/${worktree.headFull}`;
}

function isFullObjectId(value) {
  return /^[0-9a-f]{40,64}$/i.test(value ?? '');
}
export function formatCleanupCommands(report, theme, only = null) {
  const lines = [];
  const items = collectWorktreeItems(report)
    .filter(({ worktree }) => isInsideAnyRoot(worktree.path, report.roots));

  // Emitting every reclaimable bucket at once means piping the output removes
  // 79 worktrees when you meant 23, and the difference includes the one holding
  // a file that exists nowhere else. Scope by the command's actual effect, not
  // the scanner tier: review buckets can retain a branch even when the remote
  // branch is gone and the scanner calls them worktree-and-branch.
  const buckets = TIER_BUCKETS.filter(
    (candidate) => candidate.reclaimable && matchesCleanupCommandTier(candidate, only),
  );

  for (const bucket of buckets) {
    const inBucket = items.filter(({ worktree }) => matchesTierBucket(bucket, worktree));
    if (inBucket.length === 0) continue;

    lines.push(theme.muted(`# ${bucket.label} (${inBucket.length})`));

    for (const { repo, worktree, branch } of inBucket) {
      let removeWorktree = worktree.detached
        ? null
        : attachedWorktreeRemoveCommand(repo.primaryPath, worktree, branch);

      if (worktree.detached) {
        removeWorktree = detachedWorktreeRemoveCommand(repo.primaryPath, worktree);
        if (!removeWorktree) {
          lines.push(theme.muted(`# retained detached checkout ${worktree.path}: exact HEAD or current retention guard unavailable`));
          continue;
        }
        lines.push(theme.muted(`# creates safety branch ${detachedSafetyRef(worktree).slice('refs/heads/'.length)}`));
      } else if (!removeWorktree) {
        lines.push(theme.muted(`# retained checkout ${worktree.path}: exact branch or full HEAD guard unavailable`));
        continue;
      }

      // Branch retirement is a separate capability of the zero-unmerged
      // ready-if-unused bucket. Keep both actions on one `&&` chain: update-ref
      // intentionally
      // bypasses branch -d's stale-upstream semantics, so it must never run if
      // Git refuses to remove the checkout that still has the branch checked
      // out. Review buckets remove only the checkout and retain the branch.
      if (bucket.deleteBranch && worktree.branch) {
        const command = branchDeleteCommand(repo.primaryPath, branch ?? worktree);
        if (command) lines.push(`${removeWorktree} && ${command}`);
        else {
          lines.push(removeWorktree);
          lines.push(theme.muted(`# retained branch ${worktree.branch}: explicit base or scanned full branch OID unavailable`));
        }
      } else {
        lines.push(removeWorktree);
      }
    }

    lines.push('');
  }

  // Branches that outlived their worktree have no bucket to be emitted from,
  // so they would silently get no command at all.
  const orphans = collectOrphanedCandidates(report)
    .filter(({ branch }) => branch.ancestryVisible === true);
  if (orphans.length > 0 && (!only || only === 'branch')) {
    lines.push(theme.muted(`# safe: remove branch (${orphans.length})`));

    for (const { repo, branch } of orphans) {
      const command = branchDeleteCommand(repo.primaryPath, branch);
      if (command) lines.push(command);
      else lines.push(theme.muted(`# retained branch ${branch.name}: explicit base or scanned full branch OID unavailable`));
    }

    lines.push('');
  }

  return lines;
}

function matchesCleanupCommandTier(bucket, only) {
  if (!only) return true;
  if (only === 'worktree-and-branch') return bucket.deleteBranch === true;
  if (only === 'worktree-only') return bucket.deleteBranch !== true;
  return false;
}

function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

function formatRemoteStaleness(report, theme) {
  // Candidate branch existence is checked live, but ahead/behind and local
  // integration history still use remote-tracking refs. Their fetch age remains
  // useful context without weakening a confirmed live branch-deletion result.
  const claimingRepos = report.repos.filter(
    (repo) =>
      repoHasWorktreeInsideRoots(repo, report.roots)
      && (repo.worktrees.some(
        (worktree) => isInsideAnyRoot(worktree.path, report.roots)
          && worktree.cleanupStatus === 'prune-candidate',
      )
        || repo.worktrees.some(
          (worktree) => isInsideAnyRoot(worktree.path, report.roots)
            && worktree.githubMergeStatus === 'merged',
        )
        || repo.branches.some((branch) => branch.cleanupStatus === 'prune-candidate')),
  );

  if (claimingRepos.length === 0) return [];

  const unfetched = claimingRepos.filter((repo) => !repo.lastFetchAt).length;
  const fetchTimes = claimingRepos
    .map((repo) => new Date(repo.lastFetchAt ?? '').getTime())
    .filter((value) => Number.isFinite(value));

  if (fetchTimes.length === 0) {
    return [theme.caution('No fetch recorded. Local ahead/behind and integration comparisons may be stale. The scan did not fetch; candidate branch existence was checked live.')];
  }

  const oldestDays = Math.floor((Date.now() - Math.min(...fetchTimes)) / 86_400_000);

  // Only worth a line when it is old enough to act on. Stamping every run with
  // its own provenance is the tool narrating at the reader.
  if (oldestDays < 7 && unfetched === 0) return [];

  const unfetchedNote = unfetched > 0 ? `, ${unfetched} never fetched` : '';
  return [theme.caution(`Oldest local comparison data is ${oldestDays} days old${unfetchedNote}. The scan did not fetch; run git fetch --prune manually to refresh it. Candidate branch existence was checked live.`)];
}


function collectWorktreeItems(report) {
  return report.repos
    .flatMap((repo) => {
      const branchesByName = new Map(repo.branches.map((branch) => [branch.name, branch]));
      return repo.worktrees.map((worktree) => ({
        repo,
        worktree,
        branch: worktree.branch ? branchesByName.get(worktree.branch) ?? null : null,
      }));
    })
    .sort((a, b) => a.worktree.path.localeCompare(b.worktree.path));
}

function collectBranchOnlyItems(report) {
  return report.repos
    .flatMap((repo) => repo.branches.map((branch) => ({ repo, branch })))
    .filter(({ repo, branch }) => isAttentionBranch(branch) && !branch.checkedOut && repoHasWorktreeInsideRoots(repo, report.roots))
    .sort((a, b) => {
      const repoCompare = a.repo.primaryPath.localeCompare(b.repo.primaryPath);
      return repoCompare || a.branch.name.localeCompare(b.branch.name);
    });
}

function collectStashes(report) {
  return report.repos
    .flatMap((repo) => repo.stashes.map((stash) => ({ repo, stash })))
    .filter(({ repo }) => repoHasWorktreeInsideRoots(repo, report.roots))
    .sort((a, b) => a.repo.primaryPath.localeCompare(b.repo.primaryPath) || a.stash.ref.localeCompare(b.stash.ref));
}

function repoHasWorktreeInsideRoots(repo, roots) {
  return repo.worktrees.some((worktree) => isInsideAnyRoot(worktree.path, roots));
}

function isAttentionBranch(branch) {
  return Boolean(
    branch &&
      (branch.draftPullRequest ||
        (Number.isInteger(branch.ahead) && branch.ahead > 0) ||
        branch.upstreamStatus === 'none' ||
        effectiveUpstreamGone(branch)),
  );
}

function isAttentionWorktree({ worktree, branch }) {
  return worktree.dirty
    || worktree.detached
    || worktree.locked
    || Boolean(worktree.inProgress)
    || (worktree.submodules?.length ?? 0) > 0
    || (worktree.preciousIgnored?.length ?? 0) > 0
    || (worktree.inspectionErrors?.length ?? 0) > 0
    || worktree.aliasedWorktreePaths?.length > 0
    || worktree.draftPullRequest
    || ['blocked', 'submodule', 'check-first', 'push-first', 'inspection-error', 'wip'].includes(worktree.tier)
    || isAttentionBranch(branch);
}

function buildScopedSummary(worktreeItems, branchOnlyItems, stashes) {
  return {
    dirty: worktreeItems.filter(({ worktree }) => worktree.dirty).length,
    wip: worktreeItems.filter(({ worktree }) => worktree.draftPullRequest).length,
    aliased: worktreeItems.filter(
      ({ worktree }) => worktree.aliasedWorktreePaths?.length > 0,
    ).length,
    push:
      worktreeItems.filter(({ branch }) => Number.isInteger(branch?.ahead) && branch.ahead > 0).length +
      branchOnlyItems.filter(({ branch }) => Number.isInteger(branch.ahead) && branch.ahead > 0).length,
    noUpstream:
      worktreeItems.filter(({ branch }) => branch?.upstreamStatus === 'none').length +
      branchOnlyItems.filter(({ branch }) => branch.upstreamStatus === 'none').length,
    gone:
      worktreeItems.filter(({ branch }) => effectiveUpstreamGone(branch) && branch.cleanupStatus !== 'prune-candidate').length +
      branchOnlyItems.filter(({ branch }) => effectiveUpstreamGone(branch) && branch.cleanupStatus !== 'prune-candidate').length,
    prune:
      worktreeItems.filter(({ branch }) => branch?.cleanupStatus === 'prune-candidate').length +
      branchOnlyItems.filter(({ branch }) => branch.cleanupStatus === 'prune-candidate').length,
    detached: worktreeItems.filter(({ worktree }) => worktree.detached).length,
    stashes: stashes.length,
  };
}

function formatWorktreeSummaryTitle(visibleCount, attentionCount, totalCount, all) {
  if (all) {
    return `Worktree summaries (${visibleCount} in scope)`;
  }
  return `Worktree summaries (${attentionCount} needing attention / ${totalCount} in scope)`;
}

function worktreeRowColumns(showSizes, variant = 'list') {
  const columns = [
    { key: 'worktree', header: 'Worktree', minWidth: 22, maxWidth: 46 },
    { key: 'branch', header: 'Branch', minWidth: 10, maxWidth: 26 },
  ];

  if (variant === 'buckets') {
    columns.push({ key: 'upstream', header: 'Upstream', minWidth: 12, maxWidth: 32 });
    columns.push({ key: 'github', header: 'GitHub', minWidth: 10, maxWidth: 22 });
    // Primary and aliased worktrees do not inherit an action from their bucket
    // heading. Without a state column, a dirty primary checkout looked exactly
    // like a clean one even while the summary counted it as dirty.
    columns.push({ key: 'state', header: 'State', minWidth: 6, maxWidth: 24, clip: 'end' });
  }

  // In a bucket, the tier heading already states the need, so a Needs column
  // prints "prune" twenty-three times: real information, zero variance, and it
  // steals the width that Remote needs to name the ref the work landed in.
  if (variant !== 'buckets') {
    // Prose, read left to right.
    columns.push({ key: 'needs', header: 'Needs', minWidth: 14, maxWidth: 34, clip: 'end' });
  }

  columns.push(
    { key: 'remote', header: 'Remote', minWidth: 10, maxWidth: 20 },
    { key: 'push', header: 'Push', minWidth: 4, maxWidth: 4, clip: 'end' },
    { key: 'unmerged', header: 'Unmerged', minWidth: 8, maxWidth: 8, clip: 'end' },
    { key: 'age', header: 'Age', minWidth: 4, maxWidth: 6, clip: 'end' },
    // Unversioned files that vanish with the checkout. Named, not counted: the
    // decision is "do I still need assets/.env", which a number cannot answer.
    // Clipped from the end because the count is written first, so a squeezed
    // cell still says how many files are at stake.
    { key: 'keeps', header: 'Keeps', minWidth: 5, maxWidth: 24, clip: 'end' },
  );

  if (showSizes) {
    columns.push({ key: 'size', header: 'Size', minWidth: 6, maxWidth: 8 });
  }

  return columns;
}

function formatWorktreeRows(items, roots, theme, showSizes, generatedAt) {
  return items.map(({ worktree, branch }) => {
    const row = {
      worktree: shortenPath(worktree.path, roots),
      branch: worktree.branch ?? theme.bad('DETACHED'),
      upstream: branch?.upstream ?? worktree.upstream ?? '-',
      github: colorGithubEvidence(formatGithubEvidence(worktree, branch), theme),
      state: formatWorktreeState(worktree, theme),
      needs: colorNeeds(formatNeeds(worktree, branch), theme),
      remote: colorRemote(formatRemoteState(worktree, branch), theme),
      push: colorPushCount(formatPushCount(worktree, branch), theme),
      unmerged: colorUnmergedCount(formatUnmergedCount(worktree, branch), theme),
      age: formatCommitAge(branch?.lastCommitDate ?? worktree.lastCommitDate, generatedAt),
      keeps: formatPreciousIgnored(worktree, theme),
    };

    if (showSizes) {
      row.size = Number.isInteger(worktree.bytes) ? formatBytes(worktree.bytes) : '-';
    }

    return row;
  });
}

function formatWorktreeState(worktree, theme) {
  const inspectionErrors = worktree.inspectionErrors ?? [];
  if (inspectionErrors.length > 0) {
    const [error] = inspectionErrors;
    const probe = typeof error === 'string' ? 'inspection' : error.probe ?? 'inspection';
    const message = typeof error === 'string' ? error : error.message ?? 'failed';
    if (worktree.dirty) return theme.bad(`dirty; ${probe} failed`);
    return theme.bad(`${probe}: ${message}`);
  }

  if (worktree.dirty) return colorChanges(formatChanges(worktree), worktree, theme);
  if (worktree.locked) return theme.bad('locked');
  if (worktree.inProgress) return theme.bad(`in progress: ${worktree.inProgress}`);
  if (worktree.detached && worktree.retentionVerified !== true) return theme.bad('retention unverified');
  return theme.ok('clean');
}

function formatWorktreeSummaryRows({ worktree, branch }, theme) {
  return [
    { field: 'Branch', value: worktree.branch ?? 'DETACHED' },
    { field: 'Needs', value: colorNeeds(formatNeeds(worktree, branch), theme) },
    { field: 'Changes', value: colorChanges(formatChanges(worktree), worktree, theme) },
    { field: 'Remote', value: colorRemote(formatRemoteState(worktree, branch), theme) },
    { field: 'Push', value: colorPushCount(formatPushCount(worktree, branch), theme) },
    { field: 'Unmerged', value: colorUnmergedCount(formatUnmergedCount(worktree, branch), theme) },
    { field: 'Integration base', value: branch?.unmergedBase ?? worktree.unmergedBase ?? '-' },
    { field: 'GitHub', value: colorGithubEvidence(formatGithubEvidence(worktree, branch), theme) },
    { field: 'Commit date', value: branch?.lastCommitDate ?? worktree.lastCommitDate ?? '-' },
    { field: 'Upstream', value: branch?.upstream ?? worktree.upstream ?? '-' },
    { field: 'Live upstream', value: formatLiveUpstreamState(branch ?? worktree) },
    { field: 'Aliases', value: formatAliasedWorktreePaths(worktree) },
    { field: 'Large', value: worktree.largeFiles.length > 0 ? theme.bad(formatLargeFiles(worktree)) : formatLargeFiles(worktree) },
    { field: 'Head', value: worktree.head },
  ];
}

function formatLiveUpstreamState(state) {
  if (state.liveUpstreamStatus === 'gone') return 'gone';
  if (state.liveUpstreamStatus === 'unavailable') return 'unavailable; local state used';
  if (state.liveUpstreamStatus === 'present') {
    return state.liveUpstreamMatchesHead ? 'present; same tip' : 'present; different tip';
  }
  return 'not checked';
}

function formatAliasedWorktreePaths(worktree) {
  const aliases = worktree.aliasedWorktreePaths ?? [];
  return aliases.length > 0 ? aliases.join(', ') : '-';
}

function formatBranchRows(items, roots, theme, generatedAt) {
  return items.map(({ repo, branch }) => ({
    branch: branch.name,
    issue: colorBranchIssue(formatBranchIssue(branch), theme),
    push: colorPushCount(formatPushCount({}, branch), theme),
    unmerged: colorUnmergedCount(formatUnmergedCount({}, branch), theme),
    age: formatCommitAge(branch.lastCommitDate, generatedAt),
    upstream: branch.upstream ?? '-',
    repo: shortenPath(repo.primaryPath, roots),
  }));
}

function formatStashRows(items, roots, theme) {
  return items.map(({ repo, stash }) => ({
    repo: shortenPath(repo.primaryPath, roots),
    state: theme.info(stash.ref),
    detail: stash.message,
  }));
}

function formatPreciousIgnored(worktree, theme) {
  const precious = worktree.preciousIgnored ?? [];
  if (precious.length === 0) return '-';

  // One item gets its path, since assets/.env and .env are different questions.
  // Several lead with the count so that a clipped cell still warns you there
  // are four entries here, not one. Coarse cache entries end in `/`, so calling
  // every entry a file is inaccurate.
  const label = precious.length === 1
    ? precious[0]
    : `${precious.length} items: ${path.basename(precious[0])}`;

  return theme.caution(label);
}

function formatChanges(worktree) {
  if (!worktree.dirty) return 'clean';
  return `stg:${worktree.status?.staged ?? '?'} mod:${worktree.status?.unstaged ?? '?'} new:${worktree.status?.untracked ?? '?'}`;
}

function formatPushCount(worktree, branch) {
  const state = branch ?? worktree;

  // Detached HEAD has no configured upstream, so "ahead by zero" is not a
  // meaningful claim. Retention evidence belongs in Remote, not Push.
  if (worktree.detached) return '-';
  if (state.cleanupStatus === 'prune-candidate') return '0';
  if (state.liveUpstreamMatchesHead === true) return '0';
  if (state.liveUpstreamStatus === 'present' && state.liveUpstreamMatchesHead === false) {
    // A differently named upstream is normally a base branch, so a different
    // tip is expected and the cached ahead count remains the requested metric.
    // For a same-named remote branch, a moved live tip makes that count stale.
    const sameNamedUpstream = state.upstreamBranch && state.upstreamBranch === state.name;
    if (sameNamedUpstream) return '?';
  }
  if (Number.isInteger(state.ahead)) return String(state.ahead);
  return state.upstreamStatus === 'tracking' ? '0' : '?';
}

function formatUnmergedCount(worktree, branch) {
  const count = branch?.unmergedCommits ?? worktree.unmergedCommits;
  if (Number.isInteger(count)) return String(count);
  if (branch?.unmergedCommits === null || worktree.unmergedCommits === null) return '?';
  return '-';
}

function formatGithubEvidence(worktree, branch) {
  const state = branch ?? worktree;
  if (state.draftPullRequest) {
    return `Draft PR #${state.draftPullRequest.number} -> ${state.draftPullRequest.base}`;
  }
  if (state.pullRequest) {
    return `PR #${state.pullRequest.number} -> ${state.pullRequest.base}`;
  }

  if (state.githubMergeStatus === 'not-found') return 'no exact-name merged PR match';
  if (state.githubMergeStatus === 'head-moved') return 'merged PR head moved';
  if (state.githubMergeStatus === 'unavailable') return 'unavailable';
  if (state.githubMergeStatus === 'skipped') return 'skipped';
  return '-';
}

function formatCommitAge(lastCommitDate, generatedAt) {
  const committedAt = Date.parse(lastCommitDate ?? '');
  const observedAt = Date.parse(generatedAt ?? '');
  if (!Number.isFinite(committedAt) || !Number.isFinite(observedAt)) return '-';

  const elapsedMs = Math.max(0, observedAt - committedAt);
  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function formatNeeds(worktree, branch) {
  const needs = [];
  const draftPullRequest = branch?.draftPullRequest ?? worktree.draftPullRequest;
  if (draftPullRequest) needs.push(`WIP: draft PR #${draftPullRequest.number}`);
  if (worktree.unreachableCommits > 0) {
    needs.push(`${worktree.unreachableCommits} commits on no branch`);
  }
  if (worktree.inProgress) needs.push(`finish ${worktree.inProgress}`);
  if (worktree.locked) needs.push('locked');
  if (worktree.aliasedWorktreePaths?.length > 0) needs.push('resolve shared worktree metadata');
  // Name the submodule's branch, not just its presence: whether the parent
  // merged says nothing about whether that branch did, and nothing here checks.
  for (const submodule of worktree.submodules ?? []) {
    needs.push(submodule.branch ? `submodule on ${submodule.branch}` : `submodule ${submodule.path}`);
  }
  if (worktree.dirty) needs.push('commit');
  if (worktree.detached && worktree.retentionVerified !== true) needs.push('attach branch');
  if ((worktree.inspectionErrors ?? []).length > 0) needs.push('resolve inspection failure');
  if ((worktree.preciousIgnored?.length ?? 0) > 0) needs.push('review ignored content');
  if (branch?.liveUpstreamMatchesHead !== true
    && Number.isInteger(branch?.ahead) && branch.ahead > 0) needs.push('push');
  if (branch?.upstreamStatus === 'none') needs.push('set upstream');
  if (branch?.cleanupStatus === 'prune-candidate') needs.push('prune');
  else if (branch?.upstreamStatus === 'gone') needs.push('fix upstream');
  if (worktree.largeFiles.length > 0) needs.push('review large files');
  return needs.length > 0 ? needs.join(', ') : 'clean';
}

function formatRemoteState(worktree, branch) {
  if (worktree.detached) {
    if (worktree.retentionVerified === true && worktree.containedIn) {
      const evidence = worktree.retentionSource === 'live-remote' ? 'live' : 'local';
      return `kept (${worktree.containedIn}; ${evidence})`;
    }
    if (worktree.retentionVerified === false) return 'retention failed';
    return worktree.containedIn ? `unverified (${worktree.containedIn})` : 'detached';
  }
  if (!branch) return worktree.upstreamStatus ?? 'unknown';

  // How a merge was established changes how much the row can be trusted, so it
  // is shown rather than flattened into a single confident word. "pr" is
  // GitHub's answer; the rest are local inference.
  if (branch.cleanupStatus === 'prune-candidate' && branch.mergedInto) {
    const via = branch.mergedVia === 'pr' ? 'pr' : branch.mergedVia === 'squash' ? 'squash' : 'merged';
    return `${via} (${branch.mergedInto})`;
  }

  if (branch.liveUpstreamStatus === 'gone') {
    return 'live gone';
  }

  // A same-named upstream that exists at a different SHA has changed since
  // the local tracking ref was updated. Do not present cached ahead/behind as
  // current in that case.
  if (branch.upstreamBranch === branch.name && branch.liveUpstreamStatus === 'present') {
    return branch.liveUpstreamMatchesHead ? 'live current' : 'live moved';
  }

  if (branch.upstreamStatus === 'none') {
    return 'no upstream';
  }

  if (branch.upstreamStatus === 'gone') {
    return 'gone';
  }

  const ahead = Number.isInteger(branch.ahead) ? branch.ahead : 0;
  const behind = Number.isInteger(branch.behind) ? branch.behind : 0;

  if (ahead > 0 && behind > 0) {
    return `push +${ahead}, behind ${behind}`;
  }
  if (ahead > 0) {
    return `push +${ahead}`;
  }
  if (behind > 0) {
    return `behind ${behind}`;
  }

  return 'ok';
}

function formatLargeFiles(worktree) {
  if (worktree.largeFiles.length === 0) return '-';
  return `${worktree.largeFiles.length} / ${formatBytes(worktree.largeFiles[0].bytes)}`;
}

function formatBranchIssue(branch) {
  if (branch.draftPullRequest) return `WIP: draft PR #${branch.draftPullRequest.number}`;
  if (branch.upstreamStatus === 'none') return 'no upstream';
  if (branch.cleanupStatus === 'prune-candidate') return `prune (${branch.mergedInto})`;
  if (effectiveUpstreamGone(branch)) return branch.liveUpstreamStatus === 'gone' ? 'live gone' : 'gone';
  if (Number.isInteger(branch.ahead) && branch.ahead > 0) return `push +${branch.ahead}`;
  return branch.upstreamStatus;
}

function effectiveUpstreamGone(state) {
  if (!state) return false;
  if (state.liveUpstreamStatus === 'present') return false;
  if (state.liveUpstreamStatus === 'gone') return true;
  return state.upstreamStatus === 'gone';
}

function colorNeeds(needs, theme) {
  if (needs === 'clean') return theme.ok(needs);
  if (needs === 'prune') return theme.ok(needs);
  if (needs.includes('fix upstream')
    || needs.includes('attach branch')
    || needs.includes('inspection failure')
    || needs.includes('review large files')
    || needs.includes('resolve shared worktree metadata')) {
    return theme.bad(needs);
  }
  if (needs.includes('commit') || needs.includes('set upstream')) {
    return theme.warn(needs);
  }
  if (needs.includes('push')) {
    return theme.info(needs);
  }
  return theme.caution(needs);
}

function colorChanges(changes, worktree, theme) {
  if (!worktree.dirty) return theme.ok(changes);
  if ((worktree.status?.staged ?? 0) > 0 || (worktree.status?.untracked ?? 0) > 0) return theme.warn(changes);
  return theme.caution(changes);
}

function colorRemote(remote, theme) {
  if (remote === 'ok') return theme.ok(remote);
  if (remote === 'live current') return theme.ok(remote);
  if (remote.startsWith('kept')) return theme.ok(remote);
  if (remote.startsWith('prune')) return theme.ok(remote);
  if (remote === 'detached' || remote === 'gone' || remote === 'live gone' || remote === 'retention failed') return theme.bad(remote);
  if (remote === 'no upstream' || remote.startsWith('behind')) return theme.warn(remote);
  if (remote.startsWith('push')) return theme.info(remote);
  return theme.caution(remote);
}

function colorPushCount(count, theme) {
  if (count === '?') return theme.caution(count);
  if (count === '-') return theme.muted(count);
  if (count === '0') return theme.muted(count);
  return theme.info(count);
}

function colorUnmergedCount(count, theme) {
  if (count === '?') return theme.caution(count);
  if (count === '-') return theme.muted(count);
  if (count === '0') return theme.muted(count);
  return theme.caution(count);
}

function colorGithubEvidence(evidence, theme) {
  if (evidence.startsWith('Draft PR #')) return theme.caution(evidence);
  if (evidence.startsWith('PR #')) return theme.ok(evidence);
  if (evidence === 'unavailable' || evidence === 'skipped' || evidence === 'merged PR head moved') {
    return theme.caution(evidence);
  }
  if (evidence === 'no exact-name merged PR match') return theme.muted(evidence);
  return theme.muted(evidence);
}

function colorBranchIssue(issue, theme) {
  if (issue.startsWith('prune')) return theme.ok(issue);
  if (issue === 'gone' || issue === 'live gone') return theme.bad(issue);
  if (issue === 'no upstream') return theme.warn(issue);
  if (issue.startsWith('push')) return theme.info(issue);
  return theme.caution(issue);
}

function worktreeSummaryColumns() {
  return [
    { key: 'field', header: 'Field', minWidth: 8, maxWidth: 10, clip: 'end' },
    { key: 'value', header: 'Value', minWidth: 28, maxWidth: 96, clip: 'end' },
  ];
}

function branchColumns() {
  return [
    { key: 'branch', header: 'Branch', minWidth: 18, maxWidth: 38 },
    { key: 'issue', header: 'Issue', minWidth: 10, maxWidth: 16, clip: 'end' },
    { key: 'push', header: 'Push', minWidth: 4, maxWidth: 4, clip: 'end' },
    { key: 'unmerged', header: 'Unmerged', minWidth: 8, maxWidth: 8, clip: 'end' },
    { key: 'age', header: 'Age', minWidth: 4, maxWidth: 6, clip: 'end' },
    { key: 'upstream', header: 'Upstream', minWidth: 12, maxWidth: 32 },
    { key: 'repo', header: 'Repo', minWidth: 18, maxWidth: 42 },
  ];
}

function repoStateColumns() {
  return [
    { key: 'repo', header: 'Repo', minWidth: 18, maxWidth: 42 },
    { key: 'state', header: 'State', minWidth: 10, maxWidth: 14, clip: 'end' },
    { key: 'detail', header: 'Detail', minWidth: 18, maxWidth: 56, clip: 'end' },
  ];
}

function renderTable(columns, rows, maxWidth, theme = createTheme({ color: 'never' })) {
  const targetWidth = normalizeOutputWidth(maxWidth);
  const minimumWidths = columns.map((column) => column.minWidth);
  if (tableLineWidth(minimumWidths) > targetWidth) {
    return renderTableCards(columns, rows, targetWidth, theme);
  }

  const widths = fitColumnWidths(columns, rows, targetWidth);
  const border = theme.muted(`+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`);
  const lines = [border, renderTableRow(columns.map((column) => theme.muted(column.header)), widths, columns), border];

  for (const row of rows) {
    lines.push(renderTableRow(columns.map((column) => row[column.key] ?? ''), widths, columns));
  }

  lines.push(border);
  return lines;
}

// Tables are excellent while every safety field has enough room to remain
// recognizable. Below that point, crushing ten or eleven columns into a narrow
// pane technically fits but turns worktree, branch, remote, and retention
// evidence into indistinguishable fragments. Cards preserve every field and
// still give the terminal a hard no-autowrap width guarantee.
function renderTableCards(columns, rows, maxWidth, theme) {
  if (maxWidth < 12) {
    const separator = theme.muted('-'.repeat(maxWidth));
    const lines = [];
    for (const row of rows) {
      lines.push(separator);
      for (const column of columns) {
        const label = `${column.header}:`;
        const value = sanitizeTerminalCell(row[column.key] ?? '');
        const combined = `${theme.muted(label)} ${value}`;
        if (terminalCellWidth(combined) <= maxWidth) {
          lines.push(combined);
        } else {
          lines.push(clip(theme.muted(label), maxWidth, 'end'));
          lines.push(...wrapVisibleLine(value, maxWidth));
        }
      }
    }
    lines.push(separator);
    return lines;
  }

  const border = theme.muted(`+${'-'.repeat(maxWidth - 2)}+`);
  const available = maxWidth - 5;
  const longestHeader = Math.max(...columns.map((column) => terminalCellWidth(column.header)));
  const labelWidth = Math.min(longestHeader, Math.max(3, Math.floor(available * 0.25)));
  const valueWidth = available - labelWidth;
  const lines = [];

  for (const row of rows) {
    lines.push(border);
    for (const column of columns) {
      const label = padRight(clip(column.header, labelWidth, 'end'), labelWidth);
      const value = sanitizeTerminalCell(row[column.key] ?? '');
      const fittedValue = padRight(clip(value, valueWidth, column.clip), valueWidth);
      lines.push(`| ${theme.muted(label)} ${fittedValue} |`);
    }
  }

  lines.push(border);
  return lines;
}

function fitColumnWidths(columns, rows, maxWidth) {
  const longestCells = columns.map((column) =>
    rows.reduce(
      (longest, row) => Math.max(longest, visibleLength(String(row[column.key] ?? ''))),
      visibleLength(column.header),
    ),
  );

  const widths = columns.map((column, index) =>
    Math.min(Math.max(longestCells[index], column.minWidth), column.maxWidth),
  );

  const targetWidth = normalizeOutputWidth(maxWidth);

  while (tableLineWidth(widths) > targetWidth) {
    const shrinkIndex = widths.reduce((bestIndex, width, index) => {
      if (width <= columns[index].minWidth) return bestIndex;
      if (bestIndex === -1) return index;
      return width - columns[index].minWidth > widths[bestIndex] - columns[bestIndex].minWidth ? index : bestIndex;
    }, -1);

    if (shrinkIndex === -1) break;
    widths[shrinkIndex] -= 1;
  }

  // Spend whatever the terminal has left on columns that are still clipping.
  // maxWidth exists to stop one column hogging a narrow terminal, not to leave
  // half a wide one blank while paths are cut short. Truncating with empty
  // space to the right of the table is nobody's preference.
  while (tableLineWidth(widths) < targetWidth) {
    const growIndex = widths.reduce((bestIndex, width, index) => {
      if (width >= longestCells[index]) return bestIndex;
      if (bestIndex === -1) return index;
      return longestCells[index] - width > longestCells[bestIndex] - widths[bestIndex] ? index : bestIndex;
    }, -1);

    if (growIndex === -1) break;
    widths[growIndex] += 1;
  }

  return widths;
}

function tableLineWidth(widths) {
  return widths.reduce((total, width) => total + width, 0) + widths.length * 3 + 1;
}

function resolveOutputWidth(explicitWidth, terminalColumns) {
  if (Number.isFinite(explicitWidth)) return normalizeOutputWidth(explicitWidth);
  if (Number.isFinite(terminalColumns)) {
    // Avoid the final cell's deferred-autowrap behavior and tolerate terminal
    // UI that consumes another cell or two before its PTY size catches up.
    return Math.max(1, Math.floor(terminalColumns) - INTERACTIVE_REPORT_GUTTER);
  }
  // Redirected output has no viewport to overflow. Keep the traditional wide
  // tabular form instead of switching pipes and snapshots to vertical cards.
  return 180;
}

function normalizeOutputWidth(width) {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 180);
}

function finalizeCompactOutput(lines, maxWidth, options) {
  const fitted = lines.flatMap((line) => {
    // Generated commands must remain pasteable. The ordinary bucket report is
    // width-bounded; command mode keeps each guarded shell transaction intact.
    if (options.commands && /^(?:git|test)\s/.test(stripAnsi(line))) return [line];
    return wrapVisibleLine(sanitizeTerminalCell(line), maxWidth);
  });
  return fitted.join('\n').trimEnd();
}

function wrapVisibleLine(value, maxWidth) {
  if (terminalCellWidth(value) <= maxWidth) return [value];

  // Long explanatory lines are uncommon and color is secondary to preserving
  // their words and terminal geometry. Tables/cards retain their cell colors;
  // only a prose line that actually needs wrapping becomes plain text.
  let remaining = stripAnsi(value);
  const wrapped = [];
  while (terminalCellWidth(remaining) > maxWidth) {
    const { head, tail } = splitAtCellWidth(remaining, maxWidth);
    const breakAt = head.lastIndexOf(' ');
    if (breakAt > 0) {
      wrapped.push(head.slice(0, breakAt).trimEnd());
      remaining = `${head.slice(breakAt + 1)}${tail}`.trimStart();
    } else {
      wrapped.push(head);
      remaining = tail;
    }
  }
  if (remaining) wrapped.push(remaining);
  return wrapped;
}

function splitAtCellWidth(value, maxWidth) {
  let head = '';
  let used = 0;
  let consumedCodeUnits = 0;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = graphemeCellWidth(segment);
    if (used + segmentWidth > maxWidth) {
      // A two-cell glyph cannot fit in a one-cell viewport. Make progress with
      // a visible placeholder rather than looping forever or overflowing.
      if (head === '') {
        return { head: '?', tail: value.slice(index + segment.length) };
      }
      break;
    }
    head += segment;
    used += segmentWidth;
    consumedCodeUnits = index + segment.length;
  }
  return { head, tail: value.slice(consumedCodeUnits) };
}

function renderTableRow(values, widths, columns = []) {
  return `| ${values
    .map((value, index) => padRight(
      clip(sanitizeTerminalCell(value), widths[index], columns[index]?.clip),
      widths[index],
    ))
    .join(' | ')} |`;
}

// Almost everything this tool prints is an identifier whose meaning lives at
// the end: worktree paths share "Development/numbus/B2C/numbus-worktrees/",
// agent branches share "codex/", upstreams share "prune (origin/". Clipping
// the end of those keeps the boilerplate and discards the identity, so rows
// render identical and the table becomes decoration.
//
// Keeping the tail is therefore the default, and columns holding prose opt out
// with clip: 'end'. This was fixed reactively three separate times, once per
// column, before the pattern was worth admitting.
function clip(value, width, mode = 'start') {
  if (terminalCellWidth(value) <= width) return value;

  const plainValue = stripAnsi(value);
  if (width <= 3) return takeStartCells(plainValue, width);

  return mode === 'end'
    ? `${takeStartCells(plainValue, width - 3)}...`
    : `...${takeEndCells(plainValue, width - 3)}`;
}

function padRight(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - terminalCellWidth(value)))}`;
}

function sanitizeTerminalCell(value) {
  return String(value).replace(/\u001b\[[0-9;]*m|[\u0000-\u001f\u007f]/g, (token) => {
    if (token.startsWith('\u001b[')) return token;
    if (token === '\n') return '\\n';
    if (token === '\r') return '\\r';
    if (token === '\t') return '\\t';
    return `\\x${token.codePointAt(0).toString(16).padStart(2, '0')}`;
  });
}

function takeStartCells(value, width) {
  let result = '';
  let used = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(value))) {
    const segmentWidth = graphemeCellWidth(segment);
    if (used + segmentWidth > width) break;
    result += segment;
    used += segmentWidth;
  }
  return result;
}

function takeEndCells(value, width) {
  const segments = [...GRAPHEME_SEGMENTER.segment(String(value))].map(({ segment }) => segment);
  const kept = [];
  let used = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const segmentWidth = graphemeCellWidth(segment);
    if (used + segmentWidth > width) break;
    kept.push(segment);
    used += segmentWidth;
  }
  return kept.reverse().join('');
}

function shortenPath(candidatePath, roots) {
  const normalizedCandidate = normalizeComparablePath(candidatePath);

  for (const root of roots) {
    const normalizedRoot = normalizeComparablePath(root);
    if (isPathInside(normalizedRoot, normalizedCandidate)) {
      // A path relative to `/` loses the leading slash and looks like a
      // repository-relative path. Whole-filesystem scans must keep absolute
      // paths so copied commands and visual comparisons are unambiguous.
      if (normalizedRoot === path.parse(normalizedRoot).root) return normalizedCandidate;
      return path.relative(normalizedRoot, normalizedCandidate) || '.';
    }

    const rootParent = path.dirname(normalizedRoot);
    if (isPathInside(rootParent, normalizedCandidate)) {
      return path.join('..', path.relative(rootParent, normalizedCandidate));
    }
  }

  const home = process.env.HOME;
  const normalizedHome = home ? normalizeComparablePath(home) : null;
  if (normalizedHome && isPathInside(normalizedHome, normalizedCandidate)) {
    return path.join('~', path.relative(normalizedHome, normalizedCandidate));
  }

  return normalizedCandidate;
}

function formatFilesystemRootWarning(report) {
  const scansFilesystemRoot = report.roots.some((root) => {
    const normalizedRoot = normalizeComparablePath(root);
    return normalizedRoot === path.parse(normalizedRoot).root;
  });
  if (!scansFilesystemRoot) return null;

  const maxDepth = Number.isInteger(report.maxDepth) ? report.maxDepth : 8;
  return `Scope warning: a filesystem-root scan includes system/tool-managed repositories and descends at most ${maxDepth} ${plural(maxDepth, 'directory', 'directories')} from each root. Prefer explicit workspace roots before acting on cleanup results.`;
}

function isInsideAnyRoot(candidatePath, roots) {
  const normalizedCandidate = normalizeComparablePath(candidatePath);
  return roots.some((root) => isPathInside(normalizeComparablePath(root), normalizedCandidate));
}

function summarizeNonOverlappingSizes(items) {
  const measured = items.filter(({ worktree }) => Number.isInteger(worktree.bytes));
  const normalized = measured.map((item) => ({
    item,
    path: normalizeComparablePath(item.worktree.path),
  }));
  const counted = [];
  const excluded = [];

  for (const [index, candidate] of normalized.entries()) {
    const overlapsAncestor = normalized.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (other.path === candidate.path) return otherIndex < index;
      return isPathInside(other.path, candidate.path);
    });
    (overlapsAncestor ? excluded : counted).push(candidate.item);
  }

  return {
    measured,
    counted,
    excluded,
    totalBytes: counted.reduce((total, { worktree }) => total + worktree.bytes, 0),
  };
}

function normalizeComparablePath(candidatePath) {
  const resolved = path.resolve(candidatePath);
  try {
    // macOS exposes /tmp as a symlink to /private/tmp. Comparing only resolved
    // spelling made an in-root worktree look external (or vice versa), so use
    // the filesystem identity when the path exists and fall back for fixtures.
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function createTheme(options = {}) {
  const enabled = shouldUseColor(options);
  const wrap = (code) => (value) => (enabled ? `\u001b[${code}m${value}\u001b[0m` : String(value));

  return {
    enabled,
    bold: wrap('1'),
    muted: wrap('2'),
    ok: wrap('32'),
    info: wrap('36'),
    caution: wrap('35'),
    warn: wrap('33'),
    bad: wrap('31'),
  };
}

function shouldUseColor(options) {
  if (options.color === 'always') return true;
  if (options.color === 'never') return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function metric(value, colorize) {
  return value > 0 ? colorize(value) : String(value);
}

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function visibleLength(value) {
  return terminalCellWidth(value);
}

export function terminalCellWidth(value) {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(stripAnsi(value))) {
    width += graphemeCellWidth(segment);
  }
  return width;
}

function graphemeCellWidth(segment) {
  if (!segment || /^[\u0000-\u001f\u007f]+$/u.test(segment)) return 0;
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(segment)) return 0;
  if (/^[0-9#*]\ufe0f?\u20e3$/u.test(segment)) return 2;
  if (/\p{Extended_Pictographic}/u.test(segment) || /[\u{1f1e6}-\u{1f1ff}]/u.test(segment)) return 2;

  const base = [...segment].find((character) =>
    !/^[\p{Mark}\u200d\ufe0e\ufe0f]$/u.test(character));
  if (!base) return 0;
  return isFullWidthCodePoint(base.codePointAt(0)) ? 2 : 1;
}

function isFullWidthCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function formatWorktree(worktree) {
  const branch = worktree.branch ?? 'DETACHED';
  const upstream = worktree.upstream ?? worktree.upstreamStatus;
  const aheadBehind =
    Number.isInteger(worktree.ahead) && Number.isInteger(worktree.behind)
      ? `ahead ${worktree.ahead}, behind ${worktree.behind}`
      : worktree.upstreamStatus;

  const lines = [
    `  worktree ${worktree.path}`,
    `    branch ${branch} -> ${upstream} (${aheadBehind})`,
    `    dirty staged:${worktree.status.staged} unstaged:${worktree.status.unstaged} untracked:${worktree.status.untracked} total:${worktree.status.total}`,
  ];
  if (worktree.aliasedWorktreePaths?.length > 0) {
    lines.push(`    aliases shared-git-dir:${worktree.aliasedWorktreePaths.join(',')}`);
  }
  if (worktree.draftPullRequest) {
    const draft = worktree.draftPullRequest;
    lines.push(`    wip draft-pr:#${draft.number} base:${draft.base} url:${draft.url ?? '-'}`);
  }
  const policyIgnored = worktree.policyIgnored ?? [];
  if (policyIgnored.length === 1) {
    lines.push(`    policy-ignored ${policyIgnored[0].path}`);
  } else if (policyIgnored.length > 1) {
    lines.push(`    policy-ignored ${policyIgnored.length} items: ${policyIgnored[0].path}`);
  }
  return lines.join('\n');
}

function formatBranch(branch) {
  if (branch.upstreamStatus === 'none') {
    return `  branch ${branch.name} no-upstream${branch.checkedOut ? ` checked-out:${branch.worktreePath}` : ''}`;
  }

  if (branch.upstreamStatus === 'gone') {
    return `  branch ${branch.name} upstream-gone ${branch.upstream}`;
  }

  return `  branch ${branch.name} push-needed ahead:${branch.ahead} behind:${branch.behind} upstream:${branch.upstream}${branch.checkedOut ? ` checked-out:${branch.worktreePath}` : ''}`;
}

function statusIcon(status) {
  switch (status) {
    case 'commit-needed':
      return '!';
    case 'push-needed':
      return '^';
    case 'upstream-gone':
      return 'x';
    case 'no-upstream':
      return '?';
    case 'aliased-worktree':
      return '#';
    case 'wip':
      return '~';
    default:
      return '-';
  }
}

// Base 10, matching what macOS reports. These numbers exist to be compared
// against the free space in Finder or Disk Utility, and those divide by 1000.
// Dividing by 1024 and printing "GB" is a GiB wearing the wrong label: it
// understates the reclaim by 7% against the only figure a reader will check it
// against.
function formatBytes(bytes) {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)}MB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}
