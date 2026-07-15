import path from 'node:path';
import process from 'node:process';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function formatScanText(report, options = {}) {
  if (!options.details) {
    return formatCompactScanText(report, options);
  }

  const lines = [];
  const { summary } = report;

  lines.push('Git Groundskeeper');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Roots: ${report.roots.join(', ')}`);
  lines.push(
    `Repos: ${summary.repoCount}, worktrees: ${summary.worktreeCount}, dirty worktrees: ${summary.dirtyWorktreeCount}, branches ahead: ${summary.branchAheadCount}, no upstream: ${summary.noUpstreamBranchCount}, upstream gone: ${summary.goneUpstreamBranchCount}, stashes: ${summary.stashCount}`,
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

    const dirtyWorktrees = repo.worktrees.filter((worktree) => worktree.dirty || options.all);
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

  return lines.join('\n').trimEnd();
}

export function formatCompactScanText(report, options = {}) {
  const lines = [];
  const tableWidth = options.tableWidth ?? process.stdout.columns ?? 120;
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
  lines.push(
    [
      `In scope: ${theme.bold(scopedWorktrees.length)} ${plural(scopedWorktrees.length, 'worktree')}`,
      `${metric(scopedAttentionWorktrees.length, theme.warn)} need attention`,
      `(${metric(scopedSummary.dirty, theme.warn)} dirty, ${metric(scopedSummary.push, theme.info)} push, ${metric(scopedSummary.noUpstream, theme.caution)} no upstream, ${metric(scopedSummary.gone, theme.bad)} gone, ${metric(scopedSummary.prune, theme.ok)} prune, ${metric(scopedSummary.detached, theme.bad)} detached)`,
      `repo-level: ${metric(branchOnlyItems.length, theme.caution)} ${plural(branchOnlyItems.length, 'branch', 'branches')}, ${metric(stashes.length, theme.info)} ${plural(stashes.length, 'stash', 'stashes')}`,
    ].join(', '),
  );
  if (!options.all && hiddenCleanWorktrees > 0) {
    lines.push(theme.muted(`Clean worktrees hidden: ${hiddenCleanWorktrees}. Use --all to include them.`));
  }
  if (hiddenExternalAttentionWorktrees > 0) {
    lines.push(theme.muted(`Linked worktrees outside roots hidden: ${hiddenExternalAttentionWorktrees}. Use --details to audit all linked worktrees.`));
  }
  lines.push('');

  if (visibleWorktrees.length === 0 && branchOnlyItems.length === 0 && stashes.length === 0) {
    lines.push('No outstanding Git state found.');
    return lines.join('\n');
  }

  // --buckets answers "what can I remove, and what does it cost me" by grouping
  // worktrees under their tier. It replaces the flat list rather than preceding
  // it: showing both prints every worktree twice.
  if (options.buckets) {
    lines.push(...formatTierBuckets(report, theme, tableWidth));
    return lines.join('\n').trimEnd();
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
      formatWorktreeRows(ordered, report.roots, theme, showSizes),
      tableWidth,
      theme,
    ));
    lines.push('');
  }

  if (branchOnlyItems.length > 0) {
    lines.push(`Repository-level branch cleanup (${branchOnlyItems.length})`);
    lines.push(...renderTable(branchColumns(), formatBranchRows(branchOnlyItems, report.roots, theme), tableWidth, theme));
    lines.push('');
  }

  if (stashes.length > 0) {
    lines.push(`Repository-level state (${stashes.length})`);
    lines.push(...renderTable(repoStateColumns(), formatStashRows(stashes, report.roots, theme), tableWidth, theme));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

const TIER_BUCKETS = [
  {
    tier: 'worktree-and-branch',
    label: 'safe: remove worktree + branch',
    note: 'clean, merged, upstream gone',
    reclaimable: true,
  },
  {
    tier: 'worktree-only',
    label: 'safe: remove worktree',
    note: 'clean; branch and commits kept',
    reclaimable: true,
  },
  {
    tier: 'blocked',
    label: 'blocked: uncommitted work',
    note: 'removing this loses work',
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
export function formatTierBuckets(report, theme, tableWidth) {
  const items = collectWorktreeItems(report);
  const lines = [];
  let reclaimableBytes = 0;
  let anySize = false;

  for (const bucket of TIER_BUCKETS) {
    const inBucket = items.filter(({ worktree }) => worktree.tier === bucket.tier);
    if (inBucket.length === 0) continue;

    const sized = inBucket.filter(({ worktree }) => Number.isInteger(worktree.bytes));
    const bytes = sized.reduce((total, { worktree }) => total + worktree.bytes, 0);
    const showSizes = sized.length > 0;
    if (showSizes) anySize = true;
    if (bucket.reclaimable) reclaimableBytes += bytes;

    const paint = bucket.reclaimable ? theme.ok : theme.muted;
    // Blocked and primary never advertise a size. A number beside "removing
    // this loses work" reads as an invitation.
    const total = bucket.reclaimable && showSizes ? `, ${formatBytes(bytes)}` : '';

    lines.push(`${paint(bucket.label)} (${inBucket.length}${total}) ${theme.muted(`- ${bucket.note}`)}`);

    const ordered = showSizes
      ? [...inBucket].sort((a, b) => (b.worktree.bytes ?? 0) - (a.worktree.bytes ?? 0))
      : inBucket;

    lines.push(...renderTable(
      worktreeRowColumns(showSizes, 'buckets'),
      formatWorktreeRows(ordered, report.roots, theme, showSizes),
      tableWidth,
      theme,
    ));
    lines.push('');
  }

  if (lines.length === 0) return lines;

  lines.push(
    anySize
      ? theme.bold(`Reclaimable now: ${formatBytes(reclaimableBytes)}`)
      : theme.muted('Sizes not measured. Use --sizes to total what each bucket reclaims.'),
  );
  lines.push(...formatRemoteStaleness(report, theme));
  lines.push('');

  return lines;
}

// "merged" and "upstream gone" are claims about a remote this tool never
// contacts. They are only as true as the last fetch, so the reader is told how
// old that is rather than left to assume it is now.
function formatRemoteStaleness(report, theme) {
  // Only repositories that actually make a remote claim matter here. Measuring
  // every repo on the machine let one cloned-once-in-2022 reference drag the
  // figure to four years and cry wolf about buckets resting on fresh data.
  const claimingRepos = report.repos.filter((repo) =>
    repo.worktrees.some((worktree) => worktree.cleanupStatus === 'prune-candidate'),
  );

  if (claimingRepos.length === 0) return [];

  const unfetched = claimingRepos.filter((repo) => !repo.lastFetchAt).length;
  const fetchTimes = claimingRepos
    .map((repo) => new Date(repo.lastFetchAt ?? '').getTime())
    .filter((value) => Number.isFinite(value));

  if (fetchTimes.length === 0) {
    return [theme.caution('No fetch recorded for the repos claiming "merged". Run git fetch --prune before trusting them.')];
  }

  const oldestDays = Math.floor((Date.now() - Math.min(...fetchTimes)) / 86_400_000);
  const scope = claimingRepos.length === 1 ? 'the repo claiming' : `the ${claimingRepos.length} repos claiming`;
  const unfetchedNote = unfetched > 0 ? ` ${unfetched} recorded no fetch at all.` : '';
  const message = `"merged" and "gone" rest on the last fetch of ${scope} them; the oldest is ${oldestDays} ${oldestDays === 1 ? 'day' : 'days'} old.${unfetchedNote} This tool never fetches.`;

  return [oldestDays >= 7 || unfetched > 0 ? theme.caution(message) : theme.muted(message)];
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
      ((Number.isInteger(branch.ahead) && branch.ahead > 0) ||
        branch.upstreamStatus === 'none' ||
        branch.upstreamStatus === 'gone'),
  );
}

function isAttentionWorktree({ worktree, branch }) {
  return worktree.dirty || worktree.detached || isAttentionBranch(branch);
}

function buildScopedSummary(worktreeItems, branchOnlyItems, stashes) {
  return {
    dirty: worktreeItems.filter(({ worktree }) => worktree.dirty).length,
    push:
      worktreeItems.filter(({ branch }) => Number.isInteger(branch?.ahead) && branch.ahead > 0).length +
      branchOnlyItems.filter(({ branch }) => Number.isInteger(branch.ahead) && branch.ahead > 0).length,
    noUpstream:
      worktreeItems.filter(({ branch }) => branch?.upstreamStatus === 'none').length +
      branchOnlyItems.filter(({ branch }) => branch.upstreamStatus === 'none').length,
    gone:
      worktreeItems.filter(({ branch }) => branch?.upstreamStatus === 'gone' && branch.cleanupStatus !== 'prune-candidate').length +
      branchOnlyItems.filter(({ branch }) => branch.upstreamStatus === 'gone' && branch.cleanupStatus !== 'prune-candidate').length,
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

  // In a bucket, the tier heading already states the need, so a Needs column
  // prints "prune" twenty-three times: real information, zero variance, and it
  // steals the width that Remote needs to name the ref the work landed in.
  if (variant !== 'buckets') {
    // Prose, read left to right.
    columns.push({ key: 'needs', header: 'Needs', minWidth: 14, maxWidth: 34, clip: 'end' });
  }

  columns.push(
    { key: 'remote', header: 'Remote', minWidth: 10, maxWidth: 20 },
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

function formatWorktreeRows(items, roots, theme, showSizes) {
  return items.map(({ worktree, branch }) => {
    const row = {
      worktree: shortenPath(worktree.path, roots),
      branch: worktree.branch ?? theme.bad('DETACHED'),
      needs: colorNeeds(formatNeeds(worktree, branch), theme),
      remote: colorRemote(formatRemoteState(worktree, branch), theme),
      keeps: formatPreciousIgnored(worktree, theme),
    };

    if (showSizes) {
      row.size = Number.isInteger(worktree.bytes) ? formatBytes(worktree.bytes) : '-';
    }

    return row;
  });
}

function formatWorktreeSummaryRows({ worktree, branch }, theme) {
  return [
    { field: 'Branch', value: worktree.branch ?? 'DETACHED' },
    { field: 'Needs', value: colorNeeds(formatNeeds(worktree, branch), theme) },
    { field: 'Changes', value: colorChanges(formatChanges(worktree), worktree, theme) },
    { field: 'Remote', value: colorRemote(formatRemoteState(worktree, branch), theme) },
    { field: 'Upstream', value: branch?.upstream ?? worktree.upstream ?? '-' },
    { field: 'Large', value: worktree.largeFiles.length > 0 ? theme.bad(formatLargeFiles(worktree)) : formatLargeFiles(worktree) },
    { field: 'Head', value: worktree.head },
  ];
}

function formatBranchRows(items, roots, theme) {
  return items.map(({ repo, branch }) => ({
    branch: branch.name,
    issue: colorBranchIssue(formatBranchIssue(branch), theme),
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

  // One file gets its path, since assets/.env and .env are different questions.
  // Several lead with the count so that a clipped cell still warns you there
  // are four files here, not one.
  const label = precious.length === 1
    ? precious[0]
    : `${precious.length} files: ${path.basename(precious[0])}`;

  return theme.caution(label);
}

function formatChanges(worktree) {
  if (!worktree.dirty) return 'clean';
  return `stg:${worktree.status.staged} mod:${worktree.status.unstaged} new:${worktree.status.untracked}`;
}

function formatNeeds(worktree, branch) {
  const needs = [];
  if (worktree.inProgress) needs.push(`finish ${worktree.inProgress}`);
  if (worktree.locked) needs.push('locked');
  if (worktree.dirty) needs.push('commit');
  if (worktree.detached) needs.push('attach branch');
  if (Number.isInteger(branch?.ahead) && branch.ahead > 0) needs.push('push');
  if (branch?.upstreamStatus === 'none') needs.push('set upstream');
  if (branch?.cleanupStatus === 'prune-candidate') needs.push('prune');
  else if (branch?.upstreamStatus === 'gone') needs.push('fix upstream');
  if (worktree.largeFiles.length > 0) needs.push('review large files');
  return needs.length > 0 ? needs.join(', ') : 'clean';
}

function formatRemoteState(worktree, branch) {
  if (worktree.detached) return 'detached';
  if (!branch) return worktree.upstreamStatus ?? 'unknown';

  // How a merge was established changes how much the row can be trusted, so it
  // is shown rather than flattened into a single confident word. "pr" is
  // GitHub's answer; the rest are local inference.
  if (branch.cleanupStatus === 'prune-candidate' && branch.mergedInto) {
    const via = branch.mergedVia === 'pr' ? 'pr' : branch.mergedVia === 'squash' ? 'squash' : 'merged';
    return `${via} (${branch.mergedInto})`;
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
  if (branch.upstreamStatus === 'none') return 'no upstream';
  if (branch.cleanupStatus === 'prune-candidate') return `prune (${branch.mergedInto})`;
  if (branch.upstreamStatus === 'gone') return 'gone';
  if (Number.isInteger(branch.ahead) && branch.ahead > 0) return `push +${branch.ahead}`;
  return branch.upstreamStatus;
}

function colorNeeds(needs, theme) {
  if (needs === 'clean') return theme.ok(needs);
  if (needs === 'prune') return theme.ok(needs);
  if (needs.includes('fix upstream') || needs.includes('attach branch') || needs.includes('review large files')) {
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
  if (worktree.status.staged > 0 || worktree.status.untracked > 0) return theme.warn(changes);
  return theme.caution(changes);
}

function colorRemote(remote, theme) {
  if (remote === 'ok') return theme.ok(remote);
  if (remote.startsWith('prune')) return theme.ok(remote);
  if (remote === 'detached' || remote === 'gone') return theme.bad(remote);
  if (remote === 'no upstream' || remote.startsWith('behind')) return theme.warn(remote);
  if (remote.startsWith('push')) return theme.info(remote);
  return theme.caution(remote);
}

function colorBranchIssue(issue, theme) {
  if (issue.startsWith('prune')) return theme.ok(issue);
  if (issue === 'gone') return theme.bad(issue);
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
  const widths = fitColumnWidths(columns, rows, maxWidth);
  const border = theme.muted(`+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`);
  const lines = [border, renderTableRow(columns.map((column) => theme.muted(column.header)), widths, columns), border];

  for (const row of rows) {
    lines.push(renderTableRow(columns.map((column) => row[column.key] ?? ''), widths, columns));
  }

  lines.push(border);
  return lines;
}

function fitColumnWidths(columns, rows, maxWidth) {
  const widths = columns.map((column) => {
    const longestCell = rows.reduce((longest, row) => Math.max(longest, visibleLength(String(row[column.key] ?? ''))), visibleLength(column.header));
    return Math.min(Math.max(longestCell, column.minWidth), column.maxWidth);
  });

  const targetWidth = Math.max(72, maxWidth);
  while (tableLineWidth(widths) > targetWidth) {
    const shrinkIndex = widths.reduce((bestIndex, width, index) => {
      if (width <= columns[index].minWidth) return bestIndex;
      if (bestIndex === -1) return index;
      return width - columns[index].minWidth > widths[bestIndex] - columns[bestIndex].minWidth ? index : bestIndex;
    }, -1);

    if (shrinkIndex === -1) break;
    widths[shrinkIndex] -= 1;
  }

  return widths;
}

function tableLineWidth(widths) {
  return widths.reduce((total, width) => total + width, 0) + widths.length * 3 + 1;
}

function renderTableRow(values, widths, columns = []) {
  return `| ${values
    .map((value, index) => padRight(clip(String(value), widths[index], columns[index]?.clip), widths[index]))
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
  if (visibleLength(value) <= width) return value;

  const plainValue = stripAnsi(value);
  if (width <= 3) return plainValue.slice(0, width);

  return mode === 'end'
    ? `${plainValue.slice(0, width - 3)}...`
    : `...${plainValue.slice(plainValue.length - (width - 3))}`;
}

function padRight(value, width) {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function shortenPath(candidatePath, roots) {
  const normalizedCandidate = path.resolve(candidatePath);

  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    if (isPathInside(normalizedRoot, normalizedCandidate)) {
      return path.relative(normalizedRoot, normalizedCandidate) || '.';
    }

    const rootParent = path.dirname(normalizedRoot);
    if (isPathInside(rootParent, normalizedCandidate)) {
      return path.join('..', path.relative(rootParent, normalizedCandidate));
    }
  }

  const home = process.env.HOME;
  if (home && isPathInside(home, normalizedCandidate)) {
    return path.join('~', path.relative(home, normalizedCandidate));
  }

  return normalizedCandidate;
}

function isInsideAnyRoot(candidatePath, roots) {
  const normalizedCandidate = path.resolve(candidatePath);
  return roots.some((root) => isPathInside(path.resolve(root), normalizedCandidate));
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

function visibleLength(value) {
  return stripAnsi(value).length;
}

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function formatWorktree(worktree) {
  const branch = worktree.branch ?? 'DETACHED';
  const upstream = worktree.upstream ?? worktree.upstreamStatus;
  const aheadBehind =
    Number.isInteger(worktree.ahead) && Number.isInteger(worktree.behind)
      ? `ahead ${worktree.ahead}, behind ${worktree.behind}`
      : worktree.upstreamStatus;

  return [
    `  worktree ${worktree.path}`,
    `    branch ${branch} -> ${upstream} (${aheadBehind})`,
    `    dirty staged:${worktree.status.staged} unstaged:${worktree.status.unstaged} untracked:${worktree.status.untracked} total:${worktree.status.total}`,
  ].join('\n');
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
