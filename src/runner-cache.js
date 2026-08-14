import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { git } from './git.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MIN_AGE_MINUTES = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const FLUTTER_CACHE_NAME = /^stable-(\d+\.\d+\.\d+)(?:-[A-Za-z0-9._-]+)?$/;
const EXPLICIT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export async function scanRunnerCacheRoots(roots, options = {}) {
  const minAgeMinutes = options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES;
  const reports = await Promise.all(roots.map((root) => scanRunnerCacheRoot(root, {
    ...options,
    minAgeMinutes,
  })));
  const projects = reports
    .flatMap((report) => report.projects)
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes || a.projectRoot.localeCompare(b.projectRoot));
  const errors = reports
    .flatMap((report) => report.errors)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const report = {
    schemaVersion: 2,
    type: 'reclaim',
    generatedAt: new Date().toISOString(),
    roots: reports.map((entry) => entry.runnerRoot).filter(Boolean),
    tool: 'runner',
    mode: 'github-runner-tool-cache',
    minAgeMinutes,
    apply: false,
    errors: [...new Set(errors)],
    runnerInventory: reports.map((entry) => entry.inventory).filter(Boolean),
    workflowEvidence: reports.map((entry) => entry.workflowEvidence).filter(Boolean),
    summary: summarizeRunnerProjects(projects, errors),
    projects,
  };
  return options.apply ? applyRunnerCacheReport(report, options) : report;
}

export async function applyRunnerCacheReport(report, options = {}) {
  if (options.yes !== true) throw new Error('Permanent reclaim requires --apply --yes.');
  if (options.explicitRoots !== true) {
    throw new Error('Permanent reclaim requires at least one explicit root.');
  }

  const projects = [];
  for (const project of report.projects) {
    if (project.status !== 'candidate') {
      projects.push(project);
      continue;
    }
    const refreshed = await analyzeRunnerFlutterCache(project.projectRoot, project.cacheRelativePath, options);
    if (!refreshed) {
      projects.push({
        ...project,
        status: 'unchanged',
        verifiedTargetBytesRemoved: 0,
        blockedReasons: [],
        actionResult: { message: 'runner cache entry no longer exists' },
      });
      continue;
    }
    if (refreshed.status !== 'candidate') {
      projects.push({
        ...refreshed,
        status: 'blocked',
        blockedReasons: [...new Set(['apply recheck failed', ...refreshed.blockedReasons])],
      });
      continue;
    }
    if (refreshed.evidenceFingerprint !== project.evidenceFingerprint) {
      projects.push({
        ...refreshed,
        status: 'blocked',
        blockedReasons: ['evidence changed after the reclaim plan was created'],
      });
      continue;
    }

    const removal = await removeRunnerCacheTarget(refreshed.targets[0], options);
    const remaining = await pathBytes(refreshed.targets[0].absolutePath, options);
    const verifiedTargetBytesRemoved = Math.max(
      0,
      refreshed.estimatedBytes - (remaining.ok ? remaining.bytes : refreshed.estimatedBytes),
    );
    const partialReasons = [];
    if (!removal.ok) partialReasons.push(removal.error || 'cleanup action failed');
    if (!remaining.ok && remaining.error !== 'target no longer exists') partialReasons.push(remaining.error);
    projects.push({
      ...refreshed,
      status: partialReasons.length > 0 ? 'partial' : 'cleaned',
      verifiedTargetBytesRemoved,
      blockedReasons: partialReasons,
      actionResult: removal,
    });
  }

  return {
    ...report,
    apply: true,
    appliedAt: new Date().toISOString(),
    projects,
    summary: {
      ...summarizeRunnerProjects(projects, report.errors),
      plannedReclaimBytes: report.summary.plannedReclaimBytes,
    },
  };
}

export function extractFlutterWorkflowVersions(source, label = 'workflow') {
  const lines = String(source).split(/\r?\n/);
  const environment = new Map();
  const versions = new Set();
  const unresolved = [];
  for (const line of lines) {
    const match = line.match(/^\s{2,}([A-Z][A-Z0-9_]*):\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/);
    if (match && EXPLICIT_VERSION.test(match[2])) environment.set(match[1], match[2]);
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!/\buses:\s*subosito\/flutter-action@/i.test(lines[index])) continue;
    const actionIndent = lines[index].match(/^\s*/)[0].length;
    let value = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const raw = lines[cursor];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = raw.match(/^\s*/)[0].length;
      if (indent < actionIndent || (indent === actionIndent && /^-\s/.test(trimmed))) break;
      const versionMatch = trimmed.match(/^flutter-version:\s*(.+?)\s*(?:#.*)?$/);
      if (versionMatch) {
        value = unquote(versionMatch[1]);
        break;
      }
    }
    if (value === null) {
      unresolved.push(`${label}: flutter-action has no explicit flutter-version`);
      continue;
    }
    const envMatch = value.match(/^\$\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*}}$/);
    if (envMatch) value = environment.get(envMatch[1]) ?? value;
    if (EXPLICIT_VERSION.test(value)) versions.add(value);
    else unresolved.push(`${label}: flutter-version ${value} is not an explicit version`);
  }
  return { versions: [...versions].sort((a, b) => a.localeCompare(b)), unresolved };
}

async function scanRunnerCacheRoot(inputRoot, options) {
  let runnerRoot;
  try {
    runnerRoot = await fs.promises.realpath(inputRoot);
  } catch (error) {
    return { runnerRoot: null, projects: [], errors: [`${path.resolve(inputRoot)}: ${error.message}`] };
  }
  const toolRoot = path.join(runnerRoot, '_work', '_tool');
  const errors = [];
  let markerValid = true;
  try {
    const marker = await fs.promises.lstat(path.join(runnerRoot, '.runner'));
    if (!marker.isFile()) {
      markerValid = false;
      errors.push(`${runnerRoot}: .runner is not a regular file`);
    }
  } catch (error) {
    markerValid = false;
    errors.push(`${runnerRoot}: GitHub runner marker .runner unavailable: ${error.message}`);
  }

  const workflowEvidence = await collectWorkflowEvidence(options.workflowRoots ?? [], options);
  errors.push(...workflowEvidence.errors);
  const inventory = await inventoryRunnerToolCache(runnerRoot, toolRoot, options);
  errors.push(...inventory.errors);
  const runnerProbe = options.runnerProcessProbe
    ? await options.runnerProcessProbe(runnerRoot)
    : await detectActiveRunnerWorker(runnerRoot, options);
  if (!runnerProbe.ok) errors.push(`${runnerRoot}: runner activity probe failed: ${runnerProbe.error}`);

  const flutterInventory = inventory.tools.find((tool) => tool.tool === 'flutter');
  const projects = [];
  for (const entry of flutterInventory?.versions ?? []) {
    const project = await analyzeRunnerFlutterCache(runnerRoot, entry.relativePath, {
      ...options,
      workflowEvidence,
      runnerProbe,
      runnerMarkerValid: markerValid,
    });
    if (project) projects.push(project);
  }
  return { runnerRoot, projects, errors, inventory, workflowEvidence };
}

async function analyzeRunnerFlutterCache(runnerRoot, cacheRelativePath, options) {
  const target = await inspectRunnerCacheTarget(runnerRoot, cacheRelativePath, options);
  if (!target.exists) return null;
  const version = versionFromCachePath(cacheRelativePath);
  const blockedReasons = [...target.blockedReasons];
  const proof = [];
  const workflowEvidence = options.workflowEvidence
    ?? await collectWorkflowEvidence(options.workflowRoots ?? [], options);
  const runnerProbe = options.runnerProbe
    ?? (options.runnerProcessProbe
      ? await options.runnerProcessProbe(runnerRoot)
      : await detectActiveRunnerWorker(runnerRoot, options));
  if (options.runnerMarkerValid === false) blockedReasons.push('GitHub runner marker validation failed');
  else proof.push('GitHub runner marker .runner is present');
  if (!runnerProbe.ok) blockedReasons.push(`runner activity probe failed: ${runnerProbe.error}`);
  else if (runnerProbe.active) blockedReasons.push(`active Runner.Worker process uses this runner: ${runnerProbe.processes.join(', ')}`);
  else proof.push('no active Runner.Worker process uses this runner');
  if (workflowEvidence.errors.length > 0) blockedReasons.push(...workflowEvidence.errors);
  if (workflowEvidence.unresolved.length > 0) blockedReasons.push(...workflowEvidence.unresolved);
  if (!version) blockedReasons.push(`${cacheRelativePath} is not a recognized Flutter SDK cache version`);
  if (version && workflowEvidence.versions.includes(version)) {
    proof.push(`Flutter ${version} is referenced by live workflow evidence`);
  } else if (version && workflowEvidence.unresolved.length === 0 && workflowEvidence.errors.length === 0) {
    proof.push(`Flutter ${version} is superseded by workflow versions: ${workflowEvidence.versions.join(', ') || 'none'}`);
  }
  if (target.recent === false) {
    proof.push(`${target.relativePath} did not change within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  }
  const retained = Boolean(version && workflowEvidence.versions.includes(version));
  const status = retained ? 'retained' : blockedReasons.length > 0 ? 'blocked' : 'candidate';
  const identity = {
    runnerRoot,
    cacheRelativePath,
    version,
    target: {
      realPath: target.realPath,
      device: target.device,
      inode: target.inode,
      mtimeMs: target.mtimeMs,
      bytes: target.bytes,
    },
    workflowVersions: workflowEvidence.versions,
    workflowSources: workflowEvidence.sources,
  };
  return {
    tool: 'runner',
    mode: 'github-runner-tool-cache',
    projectRoot: runnerRoot,
    gitRoot: null,
    worktreeRole: 'runner',
    cacheRelativePath,
    cacheVersion: version,
    targets: [target],
    estimatedBytes: target.bytes ?? 0,
    verifiedTargetBytesRemoved: null,
    proof: [...new Set(proof)],
    blockedReasons: [...new Set(blockedReasons)],
    action: `permanently delete superseded GitHub runner Flutter cache ${cacheRelativePath}`,
    status,
    evidenceFingerprint: sha256(JSON.stringify(identity)),
  };
}

async function collectWorkflowEvidence(workflowRoots, options) {
  const versions = new Set();
  const unresolved = [];
  const errors = [];
  const sources = [];
  if (workflowRoots.length === 0) {
    unresolved.push('no --workflow-root was provided; no runner cache entry is eligible for deletion');
    return { versions: [], unresolved, errors, sources };
  }
  for (const workflowRoot of workflowRoots) {
    let root;
    try {
      root = await fs.promises.realpath(workflowRoot);
    } catch (error) {
      errors.push(`${path.resolve(workflowRoot)}: workflow root unavailable: ${error.message}`);
      continue;
    }
    const rootResult = await git(root, ['rev-parse', '--show-toplevel']);
    if (!rootResult.ok) {
      errors.push(`${root}: workflow root is not a Git worktree`);
      continue;
    }
    const refs = await workflowRefs(root, options);
    if (refs.length === 0) {
      errors.push(`${root}: no workflow Git refs are available`);
      continue;
    }
    for (const ref of refs) {
      const pathsResult = await git(root, ['ls-tree', '-r', '--name-only', ref, '--', '.github/workflows']);
      if (!pathsResult.ok) {
        errors.push(`${root}@${ref}: cannot read workflow paths: ${pathsResult.stderr.trim()}`);
        continue;
      }
      const workflowPaths = pathsResult.stdout.split('\n')
        .filter((entry) => /^\.github\/workflows\/.*\.ya?ml$/i.test(entry));
      if (workflowPaths.length === 0) {
        errors.push(`${root}@${ref}: no workflow YAML files found`);
        continue;
      }
      for (const workflowPath of workflowPaths) {
        const content = await git(root, ['show', `${ref}:${workflowPath}`]);
        if (!content.ok) {
          errors.push(`${root}@${ref}:${workflowPath}: cannot read workflow: ${content.stderr.trim()}`);
          continue;
        }
        const label = `${root}@${ref}:${workflowPath}`;
        const parsed = extractFlutterWorkflowVersions(content.stdout, label);
        parsed.versions.forEach((version) => versions.add(version));
        unresolved.push(...parsed.unresolved);
        sources.push(label);
      }
    }
  }
  return {
    versions: [...versions].sort((a, b) => a.localeCompare(b)),
    unresolved: [...new Set(unresolved)].sort((a, b) => a.localeCompare(b)),
    errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)),
    sources: [...new Set(sources)].sort((a, b) => a.localeCompare(b)),
  };
}

async function workflowRefs(root, options) {
  if (options.workflowRefs?.length > 0) return [...new Set(options.workflowRefs)];
  const refs = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
  if (!refs.ok) return ['HEAD'];
  const preferred = refs.stdout.split('\n')
    .filter((ref) => /^origin\/(?:main|master|dev|develop)$/.test(ref));
  return preferred.length > 0 ? preferred.sort((a, b) => a.localeCompare(b)) : ['HEAD'];
}

async function inventoryRunnerToolCache(runnerRoot, toolRoot, options) {
  const errors = [];
  const tools = [];
  let entries;
  try {
    entries = await fs.promises.readdir(toolRoot, { withFileTypes: true });
  } catch (error) {
    return { runnerRoot, toolRoot, tools, errors: [`${runnerRoot}: runner tool cache unavailable: ${error.message}`] };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const toolPath = path.join(toolRoot, entry.name);
    const size = await pathBytes(toolPath, options);
    if (!size.ok) errors.push(`${toolPath}: ${size.error}`);
    const versions = [];
    try {
      const versionEntries = await fs.promises.readdir(toolPath, { withFileTypes: true });
      for (const versionEntry of versionEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) continue;
        versions.push({
          name: versionEntry.name,
          relativePath: path.relative(runnerRoot, path.join(toolPath, versionEntry.name)),
        });
      }
    } catch (error) {
      errors.push(`${toolPath}: cannot inventory version directories: ${error.message}`);
    }
    tools.push({ tool: entry.name, bytes: size.ok ? size.bytes : 0, versions });
  }
  return { runnerRoot, toolRoot, tools, errors };
}

async function inspectRunnerCacheTarget(runnerRoot, relativePath, options) {
  const absolutePath = path.resolve(runnerRoot, relativePath);
  const allowedRoot = path.join(runnerRoot, '_work', '_tool', 'flutter');
  const blockedReasons = [];
  if (!isInside(absolutePath, allowedRoot)) blockedReasons.push(`${relativePath} is outside the Flutter runner tool cache`);
  let stat;
  try {
    stat = await fs.promises.lstat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, relativePath };
    return runnerInspectionFailure(relativePath, absolutePath, `cannot inspect target: ${error.message}`);
  }
  if (!stat.isDirectory()) blockedReasons.push(`${relativePath} is not a directory`);
  if (stat.isSymbolicLink()) blockedReasons.push(`${relativePath} is a symlink`);
  let realPath = null;
  try {
    realPath = await fs.promises.realpath(absolutePath);
    if (!isInside(realPath, allowedRoot)) blockedReasons.push(`${relativePath} resolves outside the Flutter runner tool cache`);
  } catch (error) {
    blockedReasons.push(`${relativePath} cannot be resolved: ${error.message}`);
  }
  const measured = await pathBytes(absolutePath, options);
  if (!measured.ok) blockedReasons.push(measured.error);
  const recent = await isRecent(absolutePath, options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES, options);
  if (!recent.ok) blockedReasons.push(`cannot inspect freshness for ${relativePath}: ${recent.error}`);
  if (recent.recent) blockedReasons.push(`${relativePath} changed within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  return {
    exists: true,
    relativePath,
    absolutePath,
    realPath,
    bytes: measured.ok ? measured.bytes : 0,
    device: String(stat.dev),
    inode: String(stat.ino),
    mtimeMs: stat.mtimeMs,
    symlink: stat.isSymbolicLink(),
    crossesSymlink: false,
    insideProject: isInside(realPath ?? absolutePath, allowedRoot),
    ignored: null,
    tracked: null,
    recent: recent.ok ? recent.recent : null,
    blockedReasons,
  };
}

async function detectActiveRunnerWorker(runnerRoot, options) {
  const result = await runCommand('ps', ['-axo', 'pid=,command='], options);
  if (!result.ok) return { ok: false, active: null, processes: [], error: result.error };
  const processes = result.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(runnerRoot) && /Runner\.Worker/i.test(line));
  return { ok: true, active: processes.length > 0, processes, error: null };
}

async function removeRunnerCacheTarget(target, options) {
  let current;
  try {
    current = await fs.promises.lstat(target.absolutePath);
  } catch (error) {
    return { ok: false, error: `cannot recheck target before deletion: ${target.relativePath}: ${error.message}` };
  }
  if (String(current.dev) !== target.device || String(current.ino) !== target.inode || current.mtimeMs !== target.mtimeMs) {
    return { ok: false, error: `target identity changed before deletion: ${target.relativePath}` };
  }
  try {
    if (options.removeTarget) await options.removeTarget(target.absolutePath);
    else await fs.promises.rm(target.absolutePath, { recursive: true, force: false });
    return { ok: true, removed: [target.relativePath] };
  } catch (error) {
    return { ok: false, error: `cannot delete target: ${target.relativePath}: ${error.message}` };
  }
}

async function pathBytes(targetPath, options) {
  try {
    await fs.promises.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, bytes: 0, error: 'target no longer exists' };
    return { ok: false, bytes: 0, error: `cannot inspect target: ${error.message}` };
  }
  if (options.pathSizeProbe) return options.pathSizeProbe(targetPath);
  const result = await runCommand('du', ['-sk', targetPath], options);
  if (!result.ok) return { ok: false, bytes: 0, error: result.error };
  const kibibytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(kibibytes)) return { ok: false, bytes: 0, error: `unexpected du output: ${result.stdout.trim()}` };
  return { ok: true, bytes: kibibytes * 1024, error: null };
}

async function isRecent(targetPath, minAgeMinutes, options) {
  if (minAgeMinutes <= 0) return { ok: true, recent: false, error: null };
  try {
    const stat = await fs.promises.lstat(targetPath);
    return { ok: true, recent: Date.now() - stat.mtimeMs < minAgeMinutes * 60_000, error: null };
  } catch (error) {
    return { ok: false, recent: null, error: error.message };
  }
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return { ok: true, stdout, stderr, error: null };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.message };
  }
}

function versionFromCachePath(relativePath) {
  const match = path.basename(relativePath).match(FLUTTER_CACHE_NAME);
  return match ? match[1] : null;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runnerInspectionFailure(relativePath, absolutePath, reason) {
  return {
    exists: true,
    relativePath,
    absolutePath,
    realPath: null,
    bytes: 0,
    device: null,
    inode: null,
    mtimeMs: null,
    symlink: false,
    crossesSymlink: null,
    insideProject: false,
    ignored: null,
    tracked: null,
    recent: null,
    blockedReasons: [reason],
  };
}

function summarizeRunnerProjects(projects, errors = []) {
  const candidateProjects = projects.filter((project) => project.status === 'candidate');
  return {
    projectCount: projects.length,
    candidateCount: candidateProjects.length,
    retainedCount: projects.filter((project) => project.status === 'retained').length,
    blockedCount: projects.filter((project) => project.status === 'blocked').length,
    cleanedCount: projects.filter((project) => project.status === 'cleaned').length,
    partialCount: projects.filter((project) => project.status === 'partial').length,
    unchangedCount: projects.filter((project) => project.status === 'unchanged').length,
    reclaimableBytes: candidateProjects.reduce((sum, project) => sum + project.estimatedBytes, 0),
    plannedReclaimBytes: candidateProjects.reduce((sum, project) => sum + project.estimatedBytes, 0),
    verifiedTargetBytesRemoved: projects.reduce((sum, project) => sum + (project.verifiedTargetBytesRemoved ?? 0), 0),
    errorCount: errors.length,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
