import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { git } from './git.js';
import { scanRoots } from './scanner.js';

const execFileAsync = promisify(execFile);
const RETIRE_SCHEMA_VERSION = 1;
const RECLAIMABLE_TIERS = new Set(['worktree-only', 'worktree-and-branch']);

export async function retireWorktree(targetPath, options = {}) {
  const initial = await buildRetirePlan(targetPath, options);
  if (!options.apply) return initial;
  if (!initial.eligible) return { ...initial, apply: true, status: 'blocked' };

  // Treat even a same-process plan as stale. A second full inspection catches
  // changed Git state, ignored content, locks, operations, and process use.
  const current = await buildRetirePlan(targetPath, options);
  if (!current.eligible || current.fingerprint !== initial.fingerprint) {
    return {
      ...current,
      apply: true,
      status: 'blocked',
      blockedReasons: unique([
        ...current.blockedReasons,
        'evidence changed between plan and apply',
      ]),
      plannedFingerprint: initial.fingerprint,
    };
  }

  const identity = await inspectCurrentIdentity(current.target);
  if (!identity.ok
    || identity.head !== current.head
    || identity.branch !== current.branch
    || identity.detached !== current.detached) {
    return blockedAtApply(current, 'branch or HEAD changed after revalidation');
  }

  let retainedRef = current.branch ? `refs/heads/${current.branch}` : null;
  if (current.detached) {
    retainedRef = `refs/heads/git-groundskeeper/retained-detached/${current.head}`;
    const retained = await retainDetachedHead(current.primaryPath, retainedRef, current.head);
    if (!retained.ok) return blockedAtApply(current, retained.error);

    const afterRetention = await inspectCurrentIdentity(current.target);
    if (!afterRetention.ok || afterRetention.head !== current.head || !afterRetention.detached) {
      return blockedAtApply(current, 'detached HEAD changed while creating its safety branch');
    }
  }

  const removal = await git(current.primaryPath, ['worktree', 'remove', current.target]);
  if (!removal.ok) {
    return {
      ...current,
      apply: true,
      status: 'partial',
      retainedRef,
      error: removal.stderr.trim() || 'git worktree remove failed',
      completedAt: new Date().toISOString(),
    };
  }

  const retained = retainedRef
    ? await git(current.primaryPath, ['show-ref', '--verify', '--quiet', retainedRef])
    : { ok: false };
  const removed = !fs.existsSync(current.target);

  return {
    ...current,
    apply: true,
    status: removed && retained.ok ? 'removed' : 'partial',
    retainedRef,
    verification: {
      targetRemoved: removed,
      retainedRefExists: retained.ok,
    },
    completedAt: new Date().toISOString(),
    error: removed && retained.ok ? null : 'post-removal verification failed',
  };
}

export async function buildRetirePlan(targetPath, options = {}) {
  const generatedAt = new Date().toISOString();
  const target = canonicalExistingPath(targetPath);
  if (!target) return missingTargetPlan(targetPath, generatedAt);

  const scan = options.scanRoots ?? scanRoots;
  const report = await scan([target], {
    ...options,
    buckets: true,
    keepsDetails: true,
    sizes: true,
    scopeStrict: true,
    onProgress: options.onProgress,
  });
  const match = findWorktree(report, target);
  if (!match) return missingWorktreePlan(target, generatedAt, report);

  const { repo, worktree } = match;
  const inspectProcesses = options.inspectProcesses ?? inspectWorktreeProcesses;
  const processes = await inspectProcesses(target, options);
  const blockedReasons = collectBlockedReasons(repo, worktree, processes);
  const eligible = blockedReasons.length === 0;
  const evidence = {
    primaryPath: repo.primaryPath,
    target,
    branch: worktree.branch,
    detached: worktree.detached,
    head: worktree.headFull,
    tier: worktree.tier,
    dirty: worktree.dirty,
    locked: worktree.locked,
    inProgress: worktree.inProgress,
    inspectionErrors: worktree.inspectionErrors,
    aliasedWorktreePaths: worktree.aliasedWorktreePaths,
    submodules: worktree.submodules,
    preciousIgnored: worktree.preciousIgnored,
    policyIgnored: worktree.policyIgnored,
    retentionVerified: worktree.retentionVerified,
    retentionSource: worktree.retentionSource,
    containedIn: worktree.containedIn,
    processCheck: processes,
  };

  return {
    schemaVersion: RETIRE_SCHEMA_VERSION,
    kind: 'worktree-retirement-receipt',
    generatedAt,
    apply: false,
    status: eligible ? 'planned' : 'blocked',
    eligible,
    target,
    primaryPath: repo.primaryPath,
    branch: worktree.branch,
    detached: worktree.detached,
    head: worktree.headFull,
    tier: worktree.tier,
    bytes: worktree.bytes,
    branchPolicy: 'retain',
    taskOwnership: options.yes ? 'operator-confirmed-inactive' : 'confirm-before-apply',
    ignoredContent: {
      reviewRequired: worktree.preciousIgnored,
      policyClassified: worktree.policyIgnored,
    },
    processCheck: processes,
    blockedReasons,
    fingerprint: fingerprint(evidence),
  };
}

export function formatRetireText(report) {
  const lines = [
    'Git Groundskeeper Retire',
    `Mode: ${report.apply ? 'APPLY' : 'READ-ONLY PLAN'}`,
    `Target: ${report.target}`,
  ];

  if (report.primaryPath) lines.push(`Primary: ${report.primaryPath}`);
  if (report.head) lines.push(`Identity: ${report.branch ?? 'DETACHED'} @ ${report.head}`);
  if (report.tier) lines.push(`Bucket: ${report.tier}`);
  lines.push('Branch policy: retain (branch deletion is outside this command)');

  if (report.processCheck) {
    const processState = report.processCheck.ok
      ? report.processCheck.active
        ? `active (${report.processCheck.processes.length})`
        : 'clear'
      : `unavailable (${report.processCheck.error})`;
    lines.push(`Process check: ${processState}`);
  }

  if (report.fingerprint) lines.push(`Evidence: ${report.fingerprint}`);
  lines.push(`Decision: ${report.status}`);

  for (const reason of report.blockedReasons ?? []) lines.push(`BLOCKED: ${reason}`);
  if (report.retainedRef) lines.push(`Retained ref: ${report.retainedRef}`);
  if (report.error) lines.push(`ERROR: ${report.error}`);

  if (!report.apply && report.eligible) {
    lines.push('No changes made. Re-run the exact path with --retain-branch --apply --yes after confirming its owning task is inactive.');
  }

  return lines.join('\n');
}

function collectBlockedReasons(repo, worktree, processes) {
  const reasons = [];
  if (worktree.path === repo.primaryPath) reasons.push('target is the primary checkout');
  if (!RECLAIMABLE_TIERS.has(worktree.tier)) reasons.push(`bucket ${worktree.tier} is not eligible for checkout retirement`);
  if (worktree.dirty !== false) reasons.push('worktree is dirty or cleanliness is unknown');
  if (!isFullObjectId(worktree.headFull)) reasons.push('full HEAD object ID is unavailable');
  if (worktree.locked) reasons.push('worktree is locked');
  if (worktree.inProgress) reasons.push(`${worktree.inProgress} is in progress`);
  if (worktree.inspectionErrors?.length > 0) reasons.push('one or more safety inspections failed');
  if (worktree.aliasedWorktreePaths?.length > 0) reasons.push('worktree path has a filesystem alias');
  if (worktree.submodules?.length > 0) reasons.push('worktree has initialized submodules');
  if (worktree.preciousIgnored?.length > 0) reasons.push('review-required ignored content exists');
  if (worktree.detached && worktree.retentionVerified !== true) reasons.push('detached HEAD has no verified retaining ref');
  if (!processes.ok) reasons.push(`active process inspection failed: ${processes.error}`);
  else if (processes.active) reasons.push('one or more active processes use the worktree');
  return unique(reasons);
}

async function inspectCurrentIdentity(target) {
  const [head, branch] = await Promise.all([
    git(target, ['rev-parse', '--verify', 'HEAD']),
    git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ]);
  if (!head.ok) return { ok: false, head: null, branch: null, detached: null };
  return {
    ok: true,
    head: head.stdout.trim(),
    branch: branch.ok ? branch.stdout.trim() : null,
    detached: !branch.ok,
  };
}

async function retainDetachedHead(primaryPath, retainedRef, head) {
  const zero = '0'.repeat(head.length);
  const created = await git(primaryPath, ['update-ref', retainedRef, head, zero]);
  if (created.ok) return { ok: true, error: null };
  const existing = await git(primaryPath, ['rev-parse', '--verify', retainedRef]);
  if (existing.ok && existing.stdout.trim() === head) return { ok: true, error: null };
  return {
    ok: false,
    error: created.stderr.trim() || `could not create detached safety ref ${retainedRef}`,
  };
}

async function inspectWorktreeProcesses(target, options = {}) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '+D', target], {
      encoding: 'utf8',
      timeout: options.processTimeoutMs ?? 15_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    const processes = parseLsof(stdout).filter((entry) => entry.pid !== process.pid);
    return {
      ok: true,
      active: processes.length > 0,
      processes: processes.map((entry) => `${entry.pid} ${entry.command} ${entry.name}`.trim()),
      error: null,
    };
  } catch (error) {
    // lsof uses exit 1 for a successful query with no matching open files.
    if (error.code === 1 && !String(error.stdout ?? '').trim()) {
      return { ok: true, active: false, processes: [], error: null };
    }
    return {
      ok: false,
      active: null,
      processes: [],
      error: error.code === 'ENOENT' ? 'lsof is unavailable' : error.message,
    };
  }
}

function parseLsof(output) {
  const lines = output.split('\n').filter(Boolean);
  if (lines[0]?.startsWith('COMMAND')) lines.shift();
  return lines.map((line) => {
    const columns = line.trim().split(/\s+/);
    return {
      command: columns[0] ?? 'unknown',
      pid: Number(columns[1]),
      name: columns.slice(8).join(' '),
    };
  }).filter((entry) => Number.isInteger(entry.pid));
}

function findWorktree(report, target) {
  for (const repo of report.repos ?? []) {
    const worktree = repo.worktrees?.find((candidate) => candidate.path === target);
    if (worktree) return { repo, worktree };
  }
  return null;
}

function missingTargetPlan(targetPath, generatedAt) {
  return {
    schemaVersion: RETIRE_SCHEMA_VERSION,
    kind: 'worktree-retirement-receipt',
    generatedAt,
    apply: false,
    status: 'blocked',
    eligible: false,
    target: path.resolve(targetPath),
    branchPolicy: 'retain',
    blockedReasons: ['target does not exist or cannot be resolved'],
    fingerprint: null,
  };
}

function missingWorktreePlan(target, generatedAt, report) {
  return {
    schemaVersion: RETIRE_SCHEMA_VERSION,
    kind: 'worktree-retirement-receipt',
    generatedAt,
    apply: false,
    status: 'blocked',
    eligible: false,
    target,
    branchPolicy: 'retain',
    blockedReasons: ['target is not a registered Git worktree'],
    scanErrors: report.errors ?? [],
    fingerprint: null,
  };
}

function blockedAtApply(report, reason) {
  return {
    ...report,
    apply: true,
    status: 'blocked',
    blockedReasons: unique([...report.blockedReasons, reason]),
  };
}

function canonicalExistingPath(candidatePath) {
  try {
    return fs.realpathSync(path.resolve(candidatePath));
  } catch {
    return null;
  }
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isFullObjectId(value) {
  return /^[0-9a-f]{40,64}$/i.test(value ?? '');
}

function unique(values) {
  return [...new Set(values)];
}
