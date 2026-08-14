import fs from 'node:fs';
import path from 'node:path';
import { applyReclaimReport, scanReclaimRoots, summarizeReclaimProjects } from './reclaim.js';

export const DEFAULT_MIN_FREE_GIB = 20;

export async function scanDiskPressure(roots, options = {}) {
  const thresholdBytes = options.minFreeBytes ?? (options.minFreeGb ?? DEFAULT_MIN_FREE_GIB) * 1024 ** 3;
  const volumes = await inspectVolumes(roots, options);
  const pressuredDevices = new Set(
    volumes.volumes
      .filter((volume) => volume.availableBytes < thresholdBytes)
      .map((volume) => volume.device),
  );
  const reclaim = await scanReclaimRoots(roots, {
    ...options,
    tool: 'auto',
    apply: false,
    excludePrimary: true,
    worktreesOnly: true,
  });
  const projects = [];
  for (const project of reclaim.projects) {
    const device = await projectDevice(project.projectRoot);
    if (device && pressuredDevices.has(device)) projects.push(project);
  }
  const scopedReclaim = {
    ...reclaim,
    projects,
    summary: summarizeReclaimProjects(projects, reclaim.errors),
  };
  const pressureDetected = pressuredDevices.size > 0;
  const appliedReclaim = options.apply && pressureDetected
    ? await applyReclaimReport(scopedReclaim, options)
    : scopedReclaim;
  return {
    schemaVersion: 1,
    type: 'disk-pressure',
    generatedAt: new Date().toISOString(),
    roots: [...new Set(roots.map((root) => path.resolve(root)))].sort((a, b) => a.localeCompare(b)),
    thresholdBytes,
    thresholdGiB: thresholdBytes / 1024 ** 3,
    pressureDetected,
    apply: Boolean(options.apply),
    deletionEnabled: Boolean(options.apply && options.yes),
    volumes: volumes.volumes.map((volume) => ({
      ...volume,
      underThreshold: volume.availableBytes < thresholdBytes,
      deficitBytes: Math.max(0, thresholdBytes - volume.availableBytes),
    })),
    errors: [...new Set([...volumes.errors, ...reclaim.errors])],
    reclaim: appliedReclaim,
    result: !pressureDetected
      ? 'threshold-met-no-cleanup-run'
      : options.apply
        ? 'pressure-cleanup-applied'
        : 'pressure-reported-no-cleanup-run',
  };
}

export function formatDiskPressureText(report) {
  const lines = [
    'Git Groundskeeper Disk Pressure',
    `Threshold: ${formatBytes(report.thresholdBytes)} free per filesystem`,
    `Pressure: ${report.pressureDetected ? 'detected' : 'not detected'}`,
    `Mode: ${report.apply ? 'permanent apply' : 'read-only'}`,
    '',
    'Filesystems:',
  ];
  for (const volume of report.volumes) {
    lines.push(`  ${volume.probePath}: ${formatBytes(volume.availableBytes)} free${volume.underThreshold ? ` (${formatBytes(volume.deficitBytes)} below threshold)` : ''}`);
  }
  lines.push(
    '',
    `Eligible linked-worktree cache removal: ${formatBytes(report.reclaim.summary.plannedReclaimBytes)}`,
    `Projects: ${report.reclaim.summary.projectCount} (${report.reclaim.summary.candidateCount} candidate, ${report.reclaim.summary.blockedCount} blocked)`,
  );
  if (report.apply && report.pressureDetected) {
    lines.push(`Verified target bytes removed: ${formatBytes(report.reclaim.summary.verifiedTargetBytesRemoved)}`);
  }
  if (!report.apply) {
    lines.push('', 'No files were changed. Cleanup only runs below the threshold with explicit --apply --yes.');
  } else if (!report.pressureDetected) {
    lines.push('', 'No files were changed because every measured filesystem meets the threshold.');
  }
  if (report.errors.length > 0) {
    lines.push('', 'Discovery errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }
  return lines.join('\n');
}

async function inspectVolumes(roots, options) {
  const volumes = [];
  const errors = [];
  const seenDevices = new Set();
  for (const inputRoot of roots) {
    let root;
    try {
      root = await fs.promises.realpath(inputRoot);
      const stat = await fs.promises.lstat(root);
      const device = String(stat.dev);
      if (seenDevices.has(device)) continue;
      seenDevices.add(device);
      const measured = options.filesystemSpaceProbe
        ? await options.filesystemSpaceProbe(root)
        : await filesystemSpace(root);
      if (!measured.ok) {
        errors.push(`${root}: ${measured.error}`);
        continue;
      }
      volumes.push({ device, probePath: root, availableBytes: measured.availableBytes });
    } catch (error) {
      errors.push(`${path.resolve(inputRoot)}: cannot identify filesystem: ${error.message}`);
    }
  }
  return { volumes, errors };
}

async function projectDevice(projectRoot) {
  try {
    return String((await fs.promises.lstat(projectRoot)).dev);
  } catch {
    return null;
  }
}

async function filesystemSpace(probePath) {
  try {
    const stats = await fs.promises.statfs(probePath, { bigint: true });
    return { ok: true, availableBytes: Number(stats.bavail * stats.bsize), error: null };
  } catch (error) {
    return { ok: false, availableBytes: null, error: `cannot measure filesystem space: ${error.message}` };
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}
