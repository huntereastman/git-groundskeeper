import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { git } from './git.js';
import { mapWithConcurrency, resolveConcurrency } from './scanner.js';
import { applyRunnerCacheReport, scanRunnerCacheRoots } from './runner-cache.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MIN_AGE_MINUTES = 10;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const FULL_CLEAN_TIMEOUT_MS = 30 * 60 * 1000;

const SKIP_DIRECTORIES = new Set([
  '.build',
  '.dart_tool',
  '.git',
  '.gradle',
  '.next',
  '.pub-cache',
  '.terraform',
  '.turbo',
  '.vercel',
  'Applications',
  'DerivedData',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'Pods',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const FULL_CLEAN_TARGETS = [
  '.dart_tool',
  '.android',
  '.ios',
  'ios/Flutter/ephemeral',
  'ios/Flutter/Generated.xcconfig',
  'ios/Flutter/flutter_export_environment.sh',
  'ios/Flutter/App.framework',
  'ios/Flutter/Flutter.framework',
  'ios/Flutter/Flutter.podspec',
  'linux/flutter/ephemeral',
  'macos/Flutter/ephemeral',
  'windows/flutter/ephemeral',
  '.flutter-plugins-dependencies',
];

export async function scanReclaimRoots(roots, options = {}) {
  const tool = options.tool ?? 'flutter';
  if (!['auto', 'flutter', 'node', 'swiftpm', 'xcode', 'runner'].includes(tool)) {
    throw new Error(`Unsupported reclaim tool: ${tool}. Available tools: auto, flutter, node, swiftpm, xcode, runner`);
  }
  if (!['auto', 'flutter'].includes(tool) && options.fullClean) {
    throw new Error('--full-clean is currently supported only with --tool flutter.');
  }

  if (tool === 'auto') return scanAllReclaimProviders(roots, options);
  if (tool === 'runner') return scanRunnerCacheRoots(roots, options);

  return scanSingleReclaimProvider(roots, options);
}

async function scanAllReclaimProviders(roots, options) {
  const generatedAt = new Date().toISOString();
  const providerOptions = { ...options, apply: false };
  const [flutter, node, swiftpm, xcode] = await Promise.all([
    scanSingleReclaimProvider(roots, { ...providerOptions, tool: 'flutter' }),
    scanSingleReclaimProvider(roots, { ...providerOptions, tool: 'node', fullClean: false }),
    scanSingleReclaimProvider(roots, { ...providerOptions, tool: 'swiftpm', fullClean: false }),
    scanSingleReclaimProvider(roots, { ...providerOptions, tool: 'xcode', fullClean: false }),
  ]);
  const projects = [...flutter.projects, ...node.projects, ...swiftpm.projects, ...xcode.projects]
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes || a.projectRoot.localeCompare(b.projectRoot));
  const errors = [...new Set([...flutter.errors, ...node.errors, ...swiftpm.errors, ...xcode.errors])]
    .sort((a, b) => a.localeCompare(b));
  let report = {
    schemaVersion: 2,
    type: 'reclaim',
    generatedAt,
    roots: [...new Set([...flutter.roots, ...node.roots, ...swiftpm.roots, ...xcode.roots])]
      .sort((a, b) => a.localeCompare(b)),
    tool: 'auto',
    mode: options.fullClean ? 'multi-provider-flutter-full-clean' : 'multi-provider',
    providers: ['flutter', 'node', 'swiftpm', 'xcode'],
    minAgeMinutes: options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES,
    apply: false,
    errors,
    summary: summarizeReclaimProjects(projects, errors),
    projects,
  };
  if (options.apply) {
    report = await applyReclaimReport(report, {
      ...options,
      flutterConfig: options.flutterConfig ?? await readFlutterConfig(options),
      refreshFlutterConfig: options.flutterConfig == null,
    });
  }
  return report;
}

async function scanSingleReclaimProvider(roots, options) {
  const tool = options.tool ?? 'flutter';

  const generatedAt = new Date().toISOString();
  const mode = providerMode(tool, options);
  const minAgeMinutes = options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES;
  const refreshFlutterConfig = tool === 'flutter' && options.flutterConfig == null;
  const discovery = await discoverProjectRoots(roots, { ...options, tool });
  const flutterConfig = tool === 'flutter'
    ? options.flutterConfig ?? await readFlutterConfig(options)
    : null;
  const analyzeProject = providerAnalyzer(tool);
  const concurrency = resolveConcurrency(options);
  const analyzed = await mapWithConcurrency(
    discovery.projects,
    concurrency,
    (projectRoot) => analyzeProject(projectRoot, {
      ...options,
      flutterConfig,
      minAgeMinutes,
      mode,
    }),
  );
  const present = analyzed.filter(Boolean);
  const withRoles = await mapWithConcurrency(
    present,
    concurrency,
    async (project) => ({ ...project, worktreeRole: await identifyWorktreeRole(project.gitRoot) }),
  );
  const projects = withRoles
    .filter((project) => !shouldExcludeProject(project, options))
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes || a.projectRoot.localeCompare(b.projectRoot));

  let report = {
    schemaVersion: 2,
    type: 'reclaim',
    generatedAt,
    roots: discovery.roots,
    tool,
    mode,
    minAgeMinutes,
    apply: false,
    errors: discovery.errors,
    summary: summarizeReclaimProjects(projects, discovery.errors),
    projects,
  };

  if (options.apply) {
    report = await applyReclaimReport(report, {
      ...options,
      flutterConfig,
      minAgeMinutes,
      mode,
      refreshFlutterConfig,
    });
  }

  return report;
}

function shouldExcludeProject(project, options) {
  if (!options.excludePrimary && !options.worktreesOnly) return false;
  return project.worktreeRole !== 'linked';
}

async function identifyWorktreeRole(gitRoot) {
  if (!gitRoot) return 'unknown';
  const result = await git(gitRoot, ['worktree', 'list', '--porcelain']);
  if (!result.ok) return 'unknown';
  const first = result.stdout.split('\n').find((line) => line.startsWith('worktree '));
  if (!first) return 'unknown';
  try {
    const primary = await fs.promises.realpath(first.slice('worktree '.length));
    return primary === gitRoot ? 'primary' : 'linked';
  } catch {
    return 'unknown';
  }
}

export async function discoverProjectRoots(roots, options = {}) {
  const tool = options.tool ?? 'flutter';
  const maxDepth = options.maxDepth ?? 8;
  const projects = new Set();
  const seen = new Set();
  const errors = [];
  const normalizedRoots = [];
  const pending = roots.map((root) => ({ directory: path.resolve(root), depth: 0 })).reverse();

  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    if (depth > maxDepth) continue;

    let resolved;
    try {
      resolved = await fs.promises.realpath(directory);
    } catch (error) {
      if (depth === 0) errors.push(`${directory}: ${error.message}`);
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (depth === 0) normalizedRoots.push(resolved);

    let entries;
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      errors.push(`${resolved}: ${error.message}`);
      continue;
    }

    const isProject = tool === 'xcode'
      ? entries.some((entry) => (
        entry.name === 'Package.swift'
        || entry.name === 'project.yml'
        || entry.name.endsWith('.xcodeproj')
        || entry.name.endsWith('.xcworkspace')
      ))
      : tool === 'swiftpm'
        ? entries.some((entry) => entry.name === 'Package.swift' && (entry.isFile() || entry.isSymbolicLink()))
        : tool === 'node'
          ? entries.some((entry) => entry.name === 'package.json' && (entry.isFile() || entry.isSymbolicLink()))
          : entries.some((entry) => entry.name === 'pubspec.yaml' && (entry.isFile() || entry.isSymbolicLink()));
    if (isProject) {
      projects.add(resolved);
    }

    if (depth === maxDepth) continue;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      pending.push({ directory: path.join(resolved, entry.name), depth: depth + 1 });
    }
  }

  return {
    roots: [...new Set(normalizedRoots)].sort((a, b) => a.localeCompare(b)),
    projects: [...projects].sort((a, b) => a.localeCompare(b)),
    errors: [...new Set(errors)].sort((a, b) => a.localeCompare(b)),
  };
}

function providerMode(tool, options = {}) {
  if (tool === 'xcode') return 'derived-data';
  if (tool === 'swiftpm') return 'swift-build';
  if (tool === 'node') return 'dependencies';
  return options.fullClean ? 'full-clean' : 'build-output';
}

function providerAnalyzer(tool) {
  if (tool === 'xcode') return analyzeXcodeProject;
  if (tool === 'swiftpm') return analyzeSwiftPmProject;
  if (tool === 'node') return analyzeNodeProject;
  return analyzeFlutterProject;
}

export async function analyzeSwiftPmProject(projectRoot, options = {}) {
  return analyzeManifestOwnedTarget(projectRoot, {
    ...options,
    tool: 'swiftpm',
    mode: 'swift-build',
    manifest: 'Package.swift',
    target: '.build',
    action: 'permanently delete .build',
  });
}

export async function analyzeNodeProject(projectRoot, options = {}) {
  return analyzeManifestOwnedTarget(projectRoot, {
    ...options,
    tool: 'node',
    mode: 'dependencies',
    manifest: 'package.json',
    target: 'node_modules',
    action: 'permanently delete node_modules',
  });
}

async function analyzeManifestOwnedTarget(projectRoot, options) {
  const blockedReasons = [];
  const proof = [];
  let root;
  try {
    root = await fs.promises.realpath(projectRoot);
  } catch (error) {
    return blockedProject(projectRoot, options, [`project root unavailable: ${error.message}`]);
  }
  const manifestPath = path.join(root, options.manifest);
  let manifestStat;
  try {
    manifestStat = await fs.promises.lstat(manifestPath);
    if (manifestStat.isSymbolicLink()) blockedReasons.push(`${options.manifest} is a symlink`);
    if (!manifestStat.isFile() && !manifestStat.isSymbolicLink()) {
      blockedReasons.push(`${options.manifest} is not a file`);
    } else {
      proof.push(`${options.manifest} proves ${options.tool} project ownership`);
    }
  } catch (error) {
    return blockedProject(root, options, [`${options.manifest} unavailable: ${error.message}`]);
  }

  let gitRoot = null;
  const gitRootResult = await git(root, ['rev-parse', '--show-toplevel']);
  if (!gitRootResult.ok) {
    blockedReasons.push(`Git worktree unavailable: ${gitRootResult.stderr.trim() || 'not a Git worktree'}`);
  } else {
    try {
      gitRoot = await fs.promises.realpath(gitRootResult.stdout.trim());
      proof.push('project is inside a Git worktree');
    } catch (error) {
      blockedReasons.push(`Git worktree root unavailable: ${error.message}`);
    }
  }

  const target = await inspectTarget(root, gitRoot, options.target, options);
  if (!target.exists) return null;
  blockedReasons.push(...target.blockedReasons);
  const activeProbe = options.activeProcessProbe
    ? await options.activeProcessProbe(root)
    : await detectActiveBuildProcesses(root, options);
  if (!activeProbe.ok) blockedReasons.push(`active-build probe failed: ${activeProbe.error}`);
  else if (activeProbe.active) {
    blockedReasons.push(`active build process uses this project: ${activeProbe.processes.join(', ')}`);
  } else proof.push('no matching active build process');
  if (target.ignored === true) proof.push(`${options.target} is ignored by Git`);
  if (target.tracked === false) proof.push(`no tracked files exist below ${options.target}`);
  if (target.insideProject === true && target.symlink === false && target.crossesSymlink === false) {
    proof.push(`${options.target} resolves inside the project without symlinks`);
  }
  if (target.recent === false) {
    proof.push(`${options.target} did not change within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  }
  const identity = {
    manifest: options.manifest,
    manifestDevice: String(manifestStat.dev),
    manifestInode: String(manifestStat.ino),
    gitRoot,
    target: {
      realPath: target.realPath,
      device: target.device,
      inode: target.inode,
      mtimeMs: target.mtimeMs,
      bytes: target.bytes,
    },
  };
  return {
    tool: options.tool,
    mode: options.mode,
    projectRoot: root,
    gitRoot,
    targets: [target],
    estimatedBytes: target.bytes ?? 0,
    verifiedTargetBytesRemoved: null,
    proof: [...new Set(proof)],
    blockedReasons: [...new Set(blockedReasons)],
    action: options.action,
    status: blockedReasons.length > 0 ? 'blocked' : 'candidate',
    evidenceFingerprint: sha256(JSON.stringify(identity)),
  };
}

export async function analyzeXcodeProject(projectRoot, options = {}) {
  const blockedReasons = [];
  const proof = [];
  let root;
  try {
    root = await fs.promises.realpath(projectRoot);
  } catch (error) {
    return blockedProject(projectRoot, { ...options, tool: 'xcode', mode: 'derived-data' }, [
      `project root unavailable: ${error.message}`,
    ]);
  }

  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    return blockedProject(root, { ...options, tool: 'xcode', mode: 'derived-data' }, [
      `project root unavailable: ${error.message}`,
    ]);
  }
  const markers = entries
    .filter((entry) => (
      entry.name === 'Package.swift'
      || entry.name === 'project.yml'
      || entry.name.endsWith('.xcodeproj')
      || entry.name.endsWith('.xcworkspace')
    ))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (markers.length === 0) {
    blockedReasons.push('project root has no Xcode, XcodeGen, or Swift package marker');
  } else {
    proof.push(`project marker: ${markers.join(', ')}`);
  }

  let gitRoot = null;
  const gitRootResult = await git(root, ['rev-parse', '--show-toplevel']);
  if (!gitRootResult.ok) {
    blockedReasons.push(`Git worktree unavailable: ${gitRootResult.stderr.trim() || 'not a Git worktree'}`);
  } else {
    try {
      gitRoot = await fs.promises.realpath(gitRootResult.stdout.trim());
      proof.push('project is inside a Git worktree');
    } catch (error) {
      blockedReasons.push(`Git worktree root unavailable: ${error.message}`);
    }
  }

  const target = await inspectTarget(root, gitRoot, 'DerivedData', options);
  if (!target.exists) return null;
  blockedReasons.push(...target.blockedReasons);
  const targets = [target];

  const activeProbe = options.activeProcessProbe
    ? await options.activeProcessProbe(root)
    : await detectActiveBuildProcesses(root, options);
  if (!activeProbe.ok) {
    blockedReasons.push(`active-build probe failed: ${activeProbe.error}`);
  } else if (activeProbe.active) {
    blockedReasons.push(`active build process uses this project: ${activeProbe.processes.join(', ')}`);
  } else {
    proof.push('no matching active build process');
  }
  if (target.ignored === true) proof.push('DerivedData is ignored by Git');
  if (target.tracked === false) proof.push('no tracked files exist below DerivedData');
  if (target.insideProject === true && target.symlink === false && target.crossesSymlink === false) {
    proof.push('DerivedData resolves inside the project without symlinks');
  }
  if (target.recent === false) {
    proof.push(`DerivedData did not change within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  }

  const identity = {
    markers,
    gitRoot,
    target: {
      realPath: target.realPath,
      device: target.device,
      inode: target.inode,
      mtimeMs: target.mtimeMs,
      bytes: target.bytes,
    },
  };
  return {
    tool: 'xcode',
    mode: 'derived-data',
    projectRoot: root,
    gitRoot,
    projectMarkers: markers,
    targets,
    estimatedBytes: target.bytes ?? 0,
    verifiedTargetBytesRemoved: null,
    proof: [...new Set(proof)],
    blockedReasons: [...new Set(blockedReasons)],
    action: 'permanently delete DerivedData',
    status: blockedReasons.length > 0 ? 'blocked' : 'candidate',
    evidenceFingerprint: sha256(JSON.stringify(identity)),
  };
}

export async function analyzeFlutterProject(projectRoot, options = {}) {
  const blockedReasons = [];
  const proof = [];
  let root;
  try {
    root = await fs.promises.realpath(projectRoot);
  } catch (error) {
    return blockedProject(projectRoot, options, [`project root unavailable: ${error.message}`]);
  }

  const manifestPath = path.join(root, 'pubspec.yaml');
  let manifest;
  let manifestStat;
  try {
    manifestStat = await fs.promises.lstat(manifestPath);
    if (manifestStat.isSymbolicLink()) blockedReasons.push('pubspec.yaml is a symlink');
    manifest = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    return blockedProject(root, options, [`pubspec.yaml unavailable: ${error.message}`]);
  }

  if (hasFlutterSdkDependency(manifest)) {
    proof.push('pubspec.yaml declares dependencies.flutter.sdk: flutter');
  } else {
    blockedReasons.push('pubspec.yaml does not prove a Flutter SDK dependency');
  }

  const flutterConfig = options.flutterConfig ?? await readFlutterConfig(options);
  if (!flutterConfig.ok) blockedReasons.push(`Flutter configuration unavailable: ${flutterConfig.error}`);
  const buildDirectory = flutterConfig.ok ? flutterConfig.buildDirectory : 'build';
  const relativeTargets = options.mode === 'full-clean' || options.fullClean
    ? [buildDirectory, ...FULL_CLEAN_TARGETS]
    : [buildDirectory];

  let gitRoot = null;
  const gitRootResult = await git(root, ['rev-parse', '--show-toplevel']);
  if (!gitRootResult.ok) {
    blockedReasons.push(`Git worktree unavailable: ${gitRootResult.stderr.trim() || 'not a Git worktree'}`);
  } else {
    try {
      gitRoot = await fs.promises.realpath(gitRootResult.stdout.trim());
      proof.push('project is inside a Git worktree');
    } catch (error) {
      blockedReasons.push(`Git worktree root unavailable: ${error.message}`);
    }
  }

  const targets = [];
  for (const relativePath of [...new Set(relativeTargets)]) {
    const target = await inspectTarget(root, gitRoot, relativePath, options);
    if (!target.exists) continue;
    targets.push(target);
    blockedReasons.push(...target.blockedReasons);
  }

  if (targets.length === 0) return null;

  const activeProbe = options.activeProcessProbe
    ? await options.activeProcessProbe(root)
    : await detectActiveBuildProcesses(root, options);
  if (!activeProbe.ok) {
    blockedReasons.push(`active-build probe failed: ${activeProbe.error}`);
  } else if (activeProbe.active) {
    blockedReasons.push(`active build process uses this project: ${activeProbe.processes.join(', ')}`);
  } else {
    proof.push('no matching active build process');
  }

  if (targets.every((target) => target.ignored === true)) proof.push('all cleanup targets are ignored by Git');
  if (targets.every((target) => target.tracked === false)) proof.push('no tracked files exist below cleanup targets');
  if (targets.every((target) => (
    target.insideProject === true
    && target.symlink === false
    && target.crossesSymlink === false
  ))) {
    proof.push('all cleanup targets resolve inside the project without symlinks');
  }
  if (targets.every((target) => target.recent === false)) {
    proof.push(`no cleanup target changed within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  }

  const estimatedBytes = targets.reduce((sum, target) => sum + (target.bytes ?? 0), 0);
  const identity = {
    manifestHash: sha256(manifest),
    manifestDevice: String(manifestStat.dev),
    manifestInode: String(manifestStat.ino),
    buildDirectory,
    gitRoot,
    targets: targets.map((target) => ({
      relativePath: target.relativePath,
      realPath: target.realPath,
      device: target.device,
      inode: target.inode,
      mtimeMs: target.mtimeMs,
      bytes: target.bytes,
    })),
  };

  return {
    tool: 'flutter',
    mode: options.mode ?? (options.fullClean ? 'full-clean' : 'build-output'),
    projectRoot: root,
    gitRoot,
    buildDirectory,
    targets,
    estimatedBytes,
    verifiedTargetBytesRemoved: null,
    proof: [...new Set(proof)],
    blockedReasons: [...new Set(blockedReasons)],
    action: options.mode === 'full-clean' || options.fullClean
      ? `${flutterConfig.command ?? options.flutterCommand ?? 'flutter'} --suppress-analytics clean`
      : `permanently delete ${targets.map((target) => target.relativePath).join(', ')}`,
    status: blockedReasons.length > 0 ? 'blocked' : 'candidate',
    evidenceFingerprint: sha256(JSON.stringify(identity)),
  };
}

export function hasFlutterSdkDependency(manifest) {
  const lines = String(manifest).split(/\r?\n/);
  let inDependencies = false;
  let flutterIndent = null;

  for (const rawLine of lines) {
    if (/\t/.test(rawLine)) return false;
    const uncommented = rawLine.replace(/\s+#.*$/, '');
    if (!uncommented.trim()) continue;
    const indent = uncommented.length - uncommented.trimStart().length;
    const text = uncommented.trim();

    if (indent === 0) {
      inDependencies = text === 'dependencies:';
      flutterIndent = null;
      continue;
    }
    if (!inDependencies) continue;

    if (flutterIndent === null) {
      if (/^flutter:\s*$/.test(text)) flutterIndent = indent;
      continue;
    }

    if (indent <= flutterIndent) {
      flutterIndent = /^flutter:\s*$/.test(text) ? indent : null;
      continue;
    }
    if (/^sdk:\s*flutter\s*$/.test(text)) return true;
  }

  return false;
}

export async function applyReclaimReport(report, options = {}) {
  if (report.tool === 'runner') return applyRunnerCacheReport(report, options);
  if (options.yes !== true) throw new Error('Permanent reclaim requires --apply --yes.');
  if (options.explicitRoots !== true) throw new Error('Permanent reclaim requires at least one explicit root.');

  const filesystemBefore = await captureFilesystemAvailability(
    report.projects.filter((project) => project.status === 'candidate'),
    options,
  );
  const projects = [];
  for (const project of report.projects) {
    if (project.status !== 'candidate') {
      projects.push(project);
      continue;
    }

    const refreshedOptions = project.tool === 'flutter' && options.refreshFlutterConfig
      ? { ...options, flutterConfig: await readFlutterConfig(options) }
      : options;
    const refreshed = await providerAnalyzer(project.tool)(project.projectRoot, {
      ...refreshedOptions,
      mode: project.mode,
    });
    if (!refreshed) {
      projects.push({
        ...project,
        status: 'unchanged',
        verifiedTargetBytesRemoved: 0,
        blockedReasons: [],
        actionResult: { message: 'cleanup targets no longer exist' },
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

    let actionResult;
    try {
      if (project.mode === 'full-clean') {
        actionResult = refreshedOptions.flutterCleanRunner
          ? await refreshedOptions.flutterCleanRunner(project.projectRoot, refreshedOptions)
          : await runFlutterClean(project.projectRoot, refreshedOptions);
      } else {
        actionResult = await removeExactTargets(refreshed.targets, refreshedOptions);
      }
    } catch (error) {
      actionResult = { ok: false, error: error.message };
    }

    const remainingBytes = await measureRemainingBytes(refreshed.targets, refreshedOptions);
    const verifiedTargetBytesRemoved = Math.max(0, refreshed.estimatedBytes - remainingBytes.bytes);
    const partialReasons = [];
    if (!actionResult.ok) partialReasons.push(actionResult.error || 'cleanup action failed');
    if (remainingBytes.errors.length > 0) partialReasons.push(...remainingBytes.errors);
    if (remainingBytes.existing.length > 0) {
      partialReasons.push(`cleanup targets remain: ${remainingBytes.existing.join(', ')}`);
    }

    projects.push({
      ...refreshed,
      status: partialReasons.length > 0 ? 'partial' : 'cleaned',
      verifiedTargetBytesRemoved,
      blockedReasons: partialReasons,
      actionResult,
    });
  }

  const filesystemAfter = await captureFilesystemAvailabilityFromVolumes(
    filesystemBefore.volumes,
    options,
  );
  const filesystemSpace = compareFilesystemAvailability(filesystemBefore, filesystemAfter);

  return {
    ...report,
    apply: true,
    appliedAt: new Date().toISOString(),
    filesystemSpace,
    projects,
    summary: {
      ...summarizeReclaimProjects(projects, report.errors),
      plannedReclaimBytes: report.summary.plannedReclaimBytes,
    },
  };
}

export function formatReclaimText(report) {
  const lines = [
    'Git Groundskeeper Reclaim',
    `Tool: ${report.tool}`,
    `Mode: ${report.mode}${report.apply ? ' (permanent apply)' : ' (read-only)'}`,
    `Roots: ${report.roots.join(', ') || '-'}`,
    '',
    `Projects: ${report.summary.projectCount} (${report.summary.candidateCount} candidate, ${report.summary.retainedCount ?? 0} retained, ${report.summary.blockedCount} blocked, ${report.summary.cleanedCount} cleaned, ${report.summary.partialCount} partial)`,
    `${report.apply ? 'Planned target removal' : 'Potential target removal'}: ${formatBytes(report.summary.plannedReclaimBytes)}`,
  ];

  if (report.apply) {
    lines.push(`Verified target bytes removed: ${formatBytes(report.summary.verifiedTargetBytesRemoved)}`);
    if (report.filesystemSpace?.measured) {
      lines.push(`Filesystem space gained: ${formatSignedBytes(report.filesystemSpace.availableBytesGained)}`);
    } else {
      lines.push('Filesystem space gained: unavailable');
    }
  }

  for (const project of report.projects) {
    lines.push('');
    lines.push(`[${project.status.toUpperCase()}] ${formatBytes(project.estimatedBytes)} ${project.projectRoot}`);
    lines.push(`  action: ${project.action}`);
    lines.push(`  targets: ${project.targets.map((target) => target.relativePath).join(', ')}`);
    if (project.proof.length > 0) lines.push(`  proof: ${project.proof.join('; ')}`);
    if (project.blockedReasons.length > 0) lines.push(`  blocked: ${project.blockedReasons.join('; ')}`);
    if (project.verifiedTargetBytesRemoved !== null) {
      lines.push(`  target bytes removed: ${formatBytes(project.verifiedTargetBytesRemoved)}`);
    }
  }

  if (report.runnerInventory?.length > 0) {
    lines.push('', 'Runner tool-cache inventory:');
    for (const runner of report.runnerInventory) {
      lines.push(`  ${runner.runnerRoot}`);
      for (const tool of runner.tools) {
        lines.push(`    ${tool.tool}: ${formatBytes(tool.bytes)} (${tool.versions.length} version directories)`);
      }
    }
  }

  if (report.errors.length > 0) {
    lines.push('', 'Discovery errors:');
    for (const error of report.errors) lines.push(`  - ${error}`);
  }

  if (!report.apply) {
    lines.push('', 'No files were changed. Permanent cleanup requires explicit roots plus --apply --yes.');
  }

  return lines.join('\n');
}

async function inspectTarget(projectRoot, gitRoot, relativePath, options) {
  const blockedReasons = [];
  const normalized = normalizeRelativeTarget(relativePath);
  if (!normalized.ok) {
    return {
      exists: true,
      relativePath,
      absolutePath: path.resolve(projectRoot, relativePath),
      realPath: null,
      bytes: 0,
      blockedReasons: [normalized.error],
      ignored: false,
      tracked: null,
      insideProject: false,
      symlink: false,
      recent: null,
    };
  }

  const absolutePath = path.resolve(projectRoot, normalized.value);
  let stat;
  try {
    stat = await fs.promises.lstat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, relativePath: normalized.value };
    return targetInspectionFailure(normalized.value, absolutePath, `cannot inspect target: ${error.message}`);
  }

  const symlink = stat.isSymbolicLink();
  if (symlink) blockedReasons.push(`${normalized.value} is a symlink`);
  let crossesSymlink = false;
  try {
    const boundary = await findSymlinkBoundary(projectRoot, normalized.value);
    if (boundary) {
      crossesSymlink = true;
      blockedReasons.push(`${normalized.value} crosses symlink boundary ${boundary}`);
    }
  } catch (error) {
    blockedReasons.push(`cannot inspect symlink boundaries for ${normalized.value}: ${error.message}`);
  }
  let realPath = null;
  let insideProject = false;
  try {
    realPath = await fs.promises.realpath(absolutePath);
    insideProject = isPathInside(realPath, projectRoot);
    if (!insideProject) blockedReasons.push(`${normalized.value} resolves outside the project`);
  } catch (error) {
    blockedReasons.push(`${normalized.value} cannot be resolved: ${error.message}`);
  }

  let ignored = false;
  let tracked = null;
  if (gitRoot) {
    const relativeToGit = path.relative(gitRoot, absolutePath).split(path.sep).join('/');
    const ignoredResult = await git(gitRoot, ['check-ignore', '-q', '--', relativeToGit]);
    ignored = ignoredResult.ok;
    if (!ignored) {
      if (ignoredResult.status !== 1 && ignoredResult.stderr.trim()) {
        blockedReasons.push(`git check-ignore failed for ${normalized.value}: ${ignoredResult.stderr.trim()}`);
      } else {
        blockedReasons.push(`${normalized.value} is not ignored by Git`);
      }
    }

    const trackedResult = await git(gitRoot, ['ls-files', '-z', '--', relativeToGit]);
    if (!trackedResult.ok) {
      blockedReasons.push(`git ls-files failed for ${normalized.value}: ${trackedResult.stderr.trim()}`);
    } else {
      tracked = trackedResult.stdout.length > 0;
      if (tracked) blockedReasons.push(`${normalized.value} contains tracked files`);
    }
  }

  const measured = options.pathSizeProbe
    ? await options.pathSizeProbe(absolutePath)
    : await measurePathBytes(absolutePath, options);
  if (!measured.ok) blockedReasons.push(`cannot measure ${normalized.value}: ${measured.error}`);

  const recentProbe = options.recentPathProbe
    ? await options.recentPathProbe(absolutePath, options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES)
    : await hasRecentEntry(absolutePath, options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES, options);
  if (!recentProbe.ok) blockedReasons.push(`cannot inspect freshness for ${normalized.value}: ${recentProbe.error}`);
  if (recentProbe.recent) {
    blockedReasons.push(`${normalized.value} changed within ${options.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES} minutes`);
  }

  return {
    exists: true,
    relativePath: normalized.value,
    absolutePath,
    realPath,
    bytes: measured.ok ? measured.bytes : 0,
    device: String(stat.dev),
    inode: String(stat.ino),
    mtimeMs: stat.mtimeMs,
    symlink,
    crossesSymlink,
    insideProject,
    ignored,
    tracked,
    recent: recentProbe.ok ? recentProbe.recent : null,
    blockedReasons,
  };
}

async function readFlutterConfig(options = {}) {
  const command = options.flutterCommand ?? process.env.GIT_GROUNDSKEEPER_FLUTTER ?? 'flutter';
  const result = await runCommand(command, ['config', '--list'], {
    cwd: options.cwd,
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (!result.ok) {
    return { ok: false, command, buildDirectory: null, error: result.error };
  }

  const match = result.stdout.match(/^\s*build-dir:\s*(.+?)\s*$/m);
  const configured = match && match[1] !== '(Not set)' ? match[1] : 'build';
  const normalized = normalizeRelativeTarget(configured);
  if (!normalized.ok) {
    return { ok: false, command, buildDirectory: null, error: `invalid Flutter build-dir: ${configured}` };
  }
  return { ok: true, command, buildDirectory: normalized.value, error: null };
}

async function runFlutterClean(projectRoot, options) {
  const command = options.flutterConfig?.command
    ?? options.flutterCommand
    ?? process.env.GIT_GROUNDSKEEPER_FLUTTER
    ?? 'flutter';
  return runCommand(command, ['--suppress-analytics', 'clean'], {
    cwd: projectRoot,
    timeoutMs: options.fullCleanTimeoutMs ?? FULL_CLEAN_TIMEOUT_MS,
  });
}

async function removeExactTargets(targets, options) {
  const removed = [];
  for (const target of targets) {
    let current;
    try {
      current = await fs.promises.lstat(target.absolutePath);
    } catch (error) {
      return {
        ok: false,
        removed,
        error: `cannot recheck target before deletion: ${target.relativePath}: ${error.message}`,
      };
    }
    if (
      String(current.dev) !== target.device
      || String(current.ino) !== target.inode
      || current.mtimeMs !== target.mtimeMs
    ) {
      return {
        ok: false,
        removed,
        error: `target identity changed before deletion: ${target.relativePath}`,
      };
    }
    try {
      if (options.removeTarget) await options.removeTarget(target.absolutePath);
      else await fs.promises.rm(target.absolutePath, { recursive: true, force: false });
    } catch (error) {
      return {
        ok: false,
        removed,
        error: `cannot delete target: ${target.relativePath}: ${error.message}`,
      };
    }
    removed.push(target.relativePath);
  }
  return { ok: true, removed, error: null };
}

async function measureRemainingBytes(targets, options) {
  let bytes = 0;
  const existing = [];
  const errors = [];
  for (const target of targets) {
    try {
      await fs.promises.lstat(target.absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      errors.push(`${target.relativePath}: ${error.message}`);
      continue;
    }
    existing.push(target.relativePath);
    const measured = options.pathSizeProbe
      ? await options.pathSizeProbe(target.absolutePath)
      : await measurePathBytes(target.absolutePath, options);
    if (measured.ok) bytes += measured.bytes;
    else errors.push(`${target.relativePath}: ${measured.error}`);
  }
  return { bytes, existing, errors };
}

async function captureFilesystemAvailability(projects, options = {}) {
  const volumes = [];
  const errors = [];
  const seenDevices = new Set();
  for (const project of projects) {
    let device;
    try {
      device = String((await fs.promises.lstat(project.projectRoot)).dev);
    } catch (error) {
      errors.push(`${project.projectRoot}: cannot identify filesystem: ${error.message}`);
      continue;
    }
    if (seenDevices.has(device)) continue;
    seenDevices.add(device);
    const measured = await probeFilesystemAvailability(project.projectRoot, options);
    if (!measured.ok) {
      errors.push(`${project.projectRoot}: ${measured.error}`);
      continue;
    }
    volumes.push({ device, probePath: project.projectRoot, availableBytes: measured.availableBytes });
  }
  return { volumes, errors };
}

async function captureFilesystemAvailabilityFromVolumes(volumes, options = {}) {
  const measuredVolumes = [];
  const errors = [];
  for (const volume of volumes) {
    const measured = await probeFilesystemAvailability(volume.probePath, options);
    if (!measured.ok) {
      errors.push(`${volume.probePath}: ${measured.error}`);
      continue;
    }
    measuredVolumes.push({ ...volume, availableBytes: measured.availableBytes });
  }
  return { volumes: measuredVolumes, errors };
}

async function probeFilesystemAvailability(probePath, options = {}) {
  if (options.filesystemSpaceProbe) return options.filesystemSpaceProbe(probePath);
  try {
    const stats = await fs.promises.statfs(probePath, { bigint: true });
    return {
      ok: true,
      availableBytes: Number(stats.bavail * stats.bsize),
      error: null,
    };
  } catch (error) {
    return { ok: false, availableBytes: null, error: `cannot measure filesystem space: ${error.message}` };
  }
}

function compareFilesystemAvailability(before, after) {
  const afterByDevice = new Map(after.volumes.map((volume) => [volume.device, volume]));
  const volumes = [];
  for (const prior of before.volumes) {
    const current = afterByDevice.get(prior.device);
    if (!current) continue;
    volumes.push({
      device: prior.device,
      probePath: prior.probePath,
      beforeAvailableBytes: prior.availableBytes,
      afterAvailableBytes: current.availableBytes,
      availableBytesGained: current.availableBytes - prior.availableBytes,
    });
  }
  return {
    measured: volumes.length > 0,
    availableBytesGained: volumes.reduce((sum, volume) => sum + volume.availableBytesGained, 0),
    volumes,
    errors: [...before.errors, ...after.errors],
    note: 'Concurrent filesystem activity can affect available-space deltas.',
  };
}

async function measurePathBytes(targetPath, options = {}) {
  const result = await runCommand('du', ['-sk', targetPath], {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, bytes: 0, error: result.error };
  const kibibytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(kibibytes)) {
    return { ok: false, bytes: 0, error: `unexpected du output: ${result.stdout.trim()}` };
  }
  return { ok: true, bytes: kibibytes * 1024, error: null };
}

async function hasRecentEntry(targetPath, minAgeMinutes, options = {}) {
  if (minAgeMinutes <= 0) return { ok: true, recent: false, error: null };
  let stat;
  try {
    stat = await fs.promises.lstat(targetPath);
  } catch (error) {
    return { ok: false, recent: null, error: error.message };
  }
  if (Date.now() - stat.mtimeMs < minAgeMinutes * 60_000) {
    return { ok: true, recent: true, error: null };
  }
  if (!stat.isDirectory()) return { ok: true, recent: false, error: null };

  const result = await runCommand('find', [
    targetPath,
    '-type',
    'f',
    '-mmin',
    `-${minAgeMinutes}`,
    '-print',
    '-quit',
  ], { timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });
  if (!result.ok) return { ok: false, recent: null, error: result.error };
  return { ok: true, recent: result.stdout.trim().length > 0, error: null };
}

async function detectActiveBuildProcesses(projectRoot, options = {}) {
  const ps = await runCommand('ps', ['-axo', 'pid=,command='], {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (!ps.ok) return { ok: false, active: null, processes: [], error: ps.error };

  const candidates = ps.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\b(?:flutter|dart|xcodebuild|swiftc|gradle|node|npm|npx|pnpm|yarn|bun|vite|next)\b|\bswift\s+(?:build|test|run)\b/i.test(line))
    .map((line) => {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((candidate) => candidate && candidate.pid !== process.pid);
  const active = [];

  for (const candidate of candidates) {
    if (candidate.command.includes(projectRoot)) {
      active.push(`${candidate.pid} ${candidate.command}`);
      continue;
    }

    const cwd = await processWorkingDirectory(candidate.pid, options);
    if (!cwd.ok) {
      if (cwd.exited) continue;
      return { ok: false, active: null, processes: [], error: cwd.error };
    }
    if (isPathInside(cwd.path, projectRoot)) active.push(`${candidate.pid} ${candidate.command}`);
  }

  return { ok: true, active: active.length > 0, processes: active, error: null };
}

async function processWorkingDirectory(pid, options) {
  if (process.platform === 'linux') {
    try {
      return { ok: true, path: await fs.promises.realpath(`/proc/${pid}/cwd`), exited: false, error: null };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, path: null, exited: true, error: null };
      return { ok: false, path: null, exited: false, error: error.message };
    }
  }
  if (process.platform !== 'darwin') {
    return { ok: false, path: null, exited: false, error: `active process inspection is unsupported on ${process.platform}` };
  }

  const result = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (!result.ok) {
    if (result.status === 1) return { ok: false, path: null, exited: true, error: null };
    return { ok: false, path: null, exited: false, error: result.error };
  }
  const cwdLine = result.stdout.split('\n').find((line) => line.startsWith('n'));
  if (!cwdLine) return { ok: false, path: null, exited: true, error: null };
  try {
    return { ok: true, path: await fs.promises.realpath(cwdLine.slice(1)), exited: false, error: null };
  } catch (error) {
    return { ok: false, path: null, exited: false, error: error.message };
  }
}

async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: options.timeoutMs,
      env: { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true' },
    });
    return { ok: true, stdout, stderr, status: 0, error: null };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
      status: typeof error.code === 'number' ? error.code : null,
      error: error.stderr?.toString().trim() || error.message,
    };
  }
}

function normalizeRelativeTarget(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, value: null, error: 'cleanup target is empty' };
  }
  if (path.isAbsolute(value)) {
    return { ok: false, value: null, error: `cleanup target must be relative: ${value}` };
  }
  const normalized = path.normalize(value.trim());
  if (normalized === '.') {
    return { ok: false, value: null, error: 'cleanup target may not be the project root' };
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return { ok: false, value: null, error: `cleanup target escapes the project: ${value}` };
  }
  if (normalized === '.git' || normalized.startsWith(`.git${path.sep}`)) {
    return { ok: false, value: null, error: `cleanup target may not enter Git metadata: ${value}` };
  }
  return { ok: true, value: normalized, error: null };
}

async function findSymlinkBoundary(projectRoot, relativePath) {
  let current = projectRoot;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) return path.relative(projectRoot, current) || '.';
  }
  return null;
}

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function blockedProject(projectRoot, options, blockedReasons) {
  return {
    tool: options.tool ?? 'flutter',
    mode: options.mode ?? (options.fullClean ? 'full-clean' : 'build-output'),
    projectRoot: path.resolve(projectRoot),
    gitRoot: null,
    buildDirectory: null,
    targets: [],
    estimatedBytes: 0,
    verifiedTargetBytesRemoved: null,
    proof: [],
    blockedReasons,
    action: 'none',
    status: 'blocked',
    evidenceFingerprint: null,
  };
}

function targetInspectionFailure(relativePath, absolutePath, reason) {
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
    ignored: false,
    tracked: null,
    recent: null,
    blockedReasons: [reason],
  };
}

export function summarizeReclaimProjects(projects, errors = []) {
  const reclaimableBytes = projects
    .filter((project) => project.status === 'candidate')
    .reduce((sum, project) => sum + project.estimatedBytes, 0);
  return {
    projectCount: projects.length,
    candidateCount: projects.filter((project) => project.status === 'candidate').length,
    blockedCount: projects.filter((project) => project.status === 'blocked').length,
    cleanedCount: projects.filter((project) => project.status === 'cleaned').length,
    partialCount: projects.filter((project) => project.status === 'partial').length,
    unchangedCount: projects.filter((project) => project.status === 'unchanged').length,
    reclaimableBytes,
    plannedReclaimBytes: reclaimableBytes,
    verifiedTargetBytesRemoved: projects.reduce(
      (sum, project) => sum + (project.verifiedTargetBytesRemoved ?? 0),
      0,
    ),
    errorCount: errors.length,
  };
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

function formatSignedBytes(bytes) {
  const value = Number(bytes) || 0;
  return `${value < 0 ? '-' : ''}${formatBytes(Math.abs(value))}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
