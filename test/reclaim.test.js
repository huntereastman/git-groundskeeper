import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeFlutterProject,
  analyzeNodeProject,
  analyzeSwiftPmProject,
  analyzeXcodeProject,
  applyReclaimReport,
  discoverProjectRoots,
  formatReclaimText,
  hasFlutterSdkDependency,
  scanReclaimRoots,
} from '../src/reclaim.js';

const flutterConfig = {
  ok: true,
  command: 'flutter',
  buildDirectory: 'build',
  error: null,
};

const inactiveBuildProbe = async () => ({
  ok: true,
  active: false,
  processes: [],
  error: null,
});

test('Flutter proof requires dependencies.flutter.sdk: flutter', () => {
  assert.equal(hasFlutterSdkDependency(`
name: app
dependencies:
  flutter:
    sdk: flutter
`), true);
  assert.equal(hasFlutterSdkDependency(`
name: package
dev_dependencies:
  flutter_test:
    sdk: flutter
`), false);
  assert.equal(hasFlutterSdkDependency(`
name: package
dependencies:
  flutter: ^1.0.0
`), false);
});

test('dry-run finds an ignored Flutter build directory without changing it', async (t) => {
  const fixture = createFlutterFixture(t, { name: 'Flutter Project With Spaces' });
  const artifact = path.join(fixture.repo, 'build', 'artifact.bin');

  const report = await scanReclaimRoots([fixture.parent], safeOptions());

  assert.equal(report.apply, false);
  assert.equal(report.summary.candidateCount, 1);
  assert.equal(report.summary.reclaimableBytes > 0, true);
  assert.equal(report.summary.plannedReclaimBytes, report.summary.reclaimableBytes);
  assert.equal(report.projects[0].projectRoot, fixture.repo);
  assert.deepEqual(report.projects[0].targets.map((target) => target.relativePath), ['build']);
  assert.match(formatReclaimText(report), /\[CANDIDATE\].*Flutter Project With Spaces/);
  assert.match(formatReclaimText(report), /No files were changed/);
  assert.equal(fs.existsSync(artifact), true);
});

test('dirty source and unrelated keeps do not block exact build-output reclaim', async (t) => {
  const fixture = createFlutterFixture(t);
  const manifest = path.join(fixture.repo, 'pubspec.yaml');
  const untrackedNote = path.join(fixture.repo, 'local-notes.txt');
  const ignoredSecret = path.join(fixture.repo, '.env');
  fs.appendFileSync(manifest, '# uncommitted source edit\n');
  fs.writeFileSync(untrackedNote, 'preserve me\n');
  fs.appendFileSync(path.join(fixture.repo, '.gitignore'), '.env\n');
  fs.writeFileSync(ignoredSecret, 'preserve me too\n');

  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    apply: true,
    yes: true,
    explicitRoots: true,
  }));

  assert.equal(report.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build')), false);
  assert.match(fs.readFileSync(manifest, 'utf8'), /uncommitted source edit/);
  assert.equal(fs.readFileSync(untrackedNote, 'utf8'), 'preserve me\n');
  assert.equal(fs.readFileSync(ignoredSecret, 'utf8'), 'preserve me too\n');
  assert.match(git(fixture.repo, ['status', '--short']), /pubspec\.yaml/);
  assert.match(git(fixture.repo, ['status', '--short']), /local-notes\.txt/);
});

test('discovery finds nested Flutter projects and skips build trees', async (t) => {
  const root = makeTemporaryDirectory(t);
  const first = createFlutterRepo(path.join(root, 'clients', 'one'));
  const second = createFlutterRepo(path.join(root, 'packages', 'nested', 'two'));
  fs.mkdirSync(path.join(first, 'build', 'fake-project'), { recursive: true });
  fs.writeFileSync(path.join(first, 'build', 'fake-project', 'pubspec.yaml'), flutterManifest());

  const discovery = await discoverProjectRoots([root], { maxDepth: 8 });

  assert.deepEqual(discovery.projects, [first, second].sort((a, b) => a.localeCompare(b)));
});

test('a generic ignored build directory is blocked without Flutter manifest proof', async (t) => {
  const fixture = createFlutterFixture(t, { flutter: false });

  const project = await analyzeFlutterProject(fixture.repo, safeOptions({ mode: 'build-output' }));

  assert.equal(project.status, 'blocked');
  assert.match(project.blockedReasons.join('\n'), /does not prove a Flutter SDK dependency/);
});

test('a tracked file below an ignored build target blocks reclaim', async (t) => {
  const fixture = createFlutterFixture(t);
  git(fixture.repo, ['add', '-f', 'build/artifact.bin']);
  git(fixture.repo, ['commit', '-m', 'track protected build artifact']);

  const project = await analyzeFlutterProject(fixture.repo, safeOptions({ mode: 'build-output' }));

  assert.equal(project.status, 'blocked');
  assert.match(project.blockedReasons.join('\n'), /contains tracked files/);
});

test('a symlinked target that escapes the project blocks reclaim', async (t) => {
  const fixture = createFlutterFixture(t);
  const outside = path.join(fixture.parent, 'outside-build');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'do-not-delete.txt'), 'protected\n');
  fs.rmSync(path.join(fixture.repo, 'build'), { recursive: true });
  fs.symlinkSync(outside, path.join(fixture.repo, 'build'));

  const project = await analyzeFlutterProject(fixture.repo, safeOptions({ mode: 'build-output' }));

  assert.equal(project.status, 'blocked');
  assert.match(project.blockedReasons.join('\n'), /is a symlink/);
  assert.match(project.blockedReasons.join('\n'), /resolves outside the project/);
  assert.equal(fs.existsSync(path.join(outside, 'do-not-delete.txt')), true);
});

test('a custom build target crossing an ancestor symlink blocks reclaim', async (t) => {
  const fixture = createFlutterFixture(t);
  fs.rmSync(path.join(fixture.repo, 'build'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'actual', 'output'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, 'actual', 'output', 'artifact.bin'), 'protected\n');
  fs.symlinkSync(path.join(fixture.repo, 'actual'), path.join(fixture.repo, 'generated'));
  fs.appendFileSync(path.join(fixture.repo, '.gitignore'), 'generated/output/\n');
  const config = { ...flutterConfig, buildDirectory: 'generated/output' };

  const project = await analyzeFlutterProject(
    fixture.repo,
    safeOptions({ mode: 'build-output', flutterConfig: config }),
  );

  assert.equal(project.status, 'blocked');
  assert.match(project.blockedReasons.join('\n'), /crosses symlink boundary generated/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'actual', 'output', 'artifact.bin')), true);
});

test('a configured project-root or Git-metadata target fails closed', async (t) => {
  const fixture = createFlutterFixture(t);
  const projectRootTarget = await analyzeFlutterProject(fixture.repo, safeOptions({
    mode: 'build-output',
    flutterConfig: { ...flutterConfig, buildDirectory: '.' },
  }));
  const gitMetadataTarget = await analyzeFlutterProject(fixture.repo, safeOptions({
    mode: 'build-output',
    flutterConfig: { ...flutterConfig, buildDirectory: '.git/objects' },
  }));

  assert.equal(projectRootTarget.status, 'blocked');
  assert.match(projectRootTarget.blockedReasons.join('\n'), /may not be the project root/);
  assert.equal(gitMetadataTarget.status, 'blocked');
  assert.match(gitMetadataTarget.blockedReasons.join('\n'), /may not enter Git metadata/);
  assert.equal(fs.existsSync(path.join(fixture.repo, '.git')), true);
});

test('custom Flutter build-dir is the exact planned target', async (t) => {
  const fixture = createFlutterFixture(t, { target: 'generated/output' });
  const config = { ...flutterConfig, buildDirectory: 'generated/output' };

  const project = await analyzeFlutterProject(
    fixture.repo,
    safeOptions({ mode: 'build-output', flutterConfig: config }),
  );

  assert.equal(project.status, 'candidate');
  assert.deepEqual(project.targets.map((target) => target.relativePath), ['generated/output']);
});

test('recent outputs and active build processes each block reclaim', async (t) => {
  const fixture = createFlutterFixture(t);
  const recent = await analyzeFlutterProject(fixture.repo, safeOptions({
    mode: 'build-output',
    minAgeMinutes: 10,
    recentPathProbe: async () => ({ ok: true, recent: true, error: null }),
  }));
  const active = await analyzeFlutterProject(fixture.repo, safeOptions({
    mode: 'build-output',
    activeProcessProbe: async () => ({
      ok: true,
      active: true,
      processes: ['123 flutter build'],
      error: null,
    }),
  }));

  assert.equal(recent.status, 'blocked');
  assert.match(recent.blockedReasons.join('\n'), /changed within 10 minutes/);
  assert.equal(active.status, 'blocked');
  assert.match(active.blockedReasons.join('\n'), /active build process/);
});

test('explicit apply deletes only the proven build output', async (t) => {
  const fixture = createFlutterFixture(t);
  fs.mkdirSync(path.join(fixture.repo, '.dart_tool'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, '.dart_tool', 'keep.txt'), 'keep\n');

  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    apply: true,
    yes: true,
    explicitRoots: true,
  }));

  assert.equal(report.apply, true);
  assert.equal(report.summary.cleanedCount, 1);
  assert.equal(report.summary.verifiedTargetBytesRemoved > 0, true);
  assert.equal(report.summary.plannedReclaimBytes > 0, true);
  assert.match(formatReclaimText(report), /\[CLEANED\]/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build')), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, '.dart_tool', 'keep.txt')), true);
});

test('changed evidence between plan and apply blocks deletion', async (t) => {
  const fixture = createFlutterFixture(t);
  const report = await scanReclaimRoots([fixture.repo], safeOptions());
  fs.writeFileSync(path.join(fixture.repo, 'build', 'changed-after-plan.bin'), Buffer.alloc(8192, 1));

  const applied = await applyReclaimReport(report, safeOptions({
    yes: true,
    explicitRoots: true,
    mode: 'build-output',
  }));

  assert.equal(applied.summary.blockedCount, 1);
  assert.match(applied.projects[0].blockedReasons.join('\n'), /evidence changed/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('failed Flutter clean is reported as partial and preserves remaining targets', async (t) => {
  const fixture = createFlutterFixture(t);
  fs.mkdirSync(path.join(fixture.repo, '.dart_tool'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, '.dart_tool', 'state'), 'state\n');

  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    fullClean: true,
    apply: true,
    yes: true,
    explicitRoots: true,
    flutterCleanRunner: async () => ({ ok: false, error: 'simulated flutter clean failure' }),
  }));

  assert.equal(report.summary.partialCount, 1);
  assert.match(report.projects[0].blockedReasons.join('\n'), /simulated flutter clean failure/);
  assert.match(report.projects[0].blockedReasons.join('\n'), /cleanup targets remain/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build')), true);
});

test('direct deletion failure is reported as partial instead of aborting the report', async (t) => {
  const fixture = createFlutterFixture(t);
  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    apply: true,
    yes: true,
    explicitRoots: true,
    removeTarget: async () => {
      throw new Error('simulated permission failure');
    },
  }));

  assert.equal(report.summary.partialCount, 1);
  assert.match(report.projects[0].blockedReasons.join('\n'), /simulated permission failure/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('failed size measurement blocks cleanup instead of guessing', async (t) => {
  const fixture = createFlutterFixture(t);
  const project = await analyzeFlutterProject(fixture.repo, safeOptions({
    mode: 'build-output',
    pathSizeProbe: async () => ({ ok: false, bytes: 0, error: 'simulated du failure' }),
  }));

  assert.equal(project.status, 'blocked');
  assert.match(project.blockedReasons.join('\n'), /cannot measure build: simulated du failure/);
});

test('Xcode dry-run discovers project-local DerivedData', async (t) => {
  const fixture = createXcodeFixture(t);
  const report = await scanReclaimRoots([fixture.parent], safeOptions({ tool: 'xcode' }));

  assert.equal(report.tool, 'xcode');
  assert.equal(report.mode, 'derived-data');
  assert.equal(report.summary.candidateCount, 1);
  assert.deepEqual(report.projects[0].targets.map((target) => target.relativePath), ['DerivedData']);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData', 'artifact.bin')), true);
});

test('Xcode reclaim preserves dirty source and unrelated keeps', async (t) => {
  const fixture = createXcodeFixture(t);
  const source = path.join(fixture.repo, 'Sources', 'Feature.swift');
  const secret = path.join(fixture.repo, '.env');
  fs.appendFileSync(source, '// uncommitted edit\n');
  fs.writeFileSync(secret, 'preserve\n');

  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    tool: 'xcode', apply: true, yes: true, explicitRoots: true,
  }));

  assert.equal(report.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), false);
  assert.match(fs.readFileSync(source, 'utf8'), /uncommitted edit/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'preserve\n');
});

test('apply reports target bytes removed separately from filesystem space gained', async (t) => {
  const fixture = createXcodeFixture(t);
  const available = [1_000_000, 4_000_000];
  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    tool: 'xcode',
    apply: true,
    yes: true,
    explicitRoots: true,
    filesystemSpaceProbe: async () => ({
      ok: true,
      availableBytes: available.shift(),
      error: null,
    }),
  }));

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.summary.verifiedTargetBytesRemoved, 4096);
  assert.equal(report.filesystemSpace.availableBytesGained, 3_000_000);
  assert.equal(report.filesystemSpace.volumes.length, 1);
  assert.match(formatReclaimText(report), /Verified target bytes removed: 4\.10 KB/);
  assert.match(formatReclaimText(report), /Filesystem space gained: 3\.00 MB/);
  assert.doesNotMatch(formatReclaimText(report), /Actual reclaimed/);
});

test('filesystem-space reporting preserves a negative concurrent-activity delta', async (t) => {
  const fixture = createXcodeFixture(t);
  const available = [4_000_000, 1_000_000];
  const report = await scanReclaimRoots([fixture.repo], safeOptions({
    tool: 'xcode',
    apply: true,
    yes: true,
    explicitRoots: true,
    filesystemSpaceProbe: async () => ({
      ok: true,
      availableBytes: available.shift(),
      error: null,
    }),
  }));

  assert.equal(report.filesystemSpace.availableBytesGained, -3_000_000);
  assert.match(formatReclaimText(report), /Filesystem space gained: -3\.00 MB/);
});

test('auto provider combines Flutter and Xcode plans without duplicate apply semantics', async (t) => {
  const root = makeTemporaryDirectory(t);
  const flutter = createFlutterRepo(path.join(root, 'flutter-app'));
  const xcodeFixture = createXcodeRepo(path.join(root, 'xcode-app'));
  const report = await scanReclaimRoots([root], safeOptions({ tool: 'auto' }));

  assert.equal(report.tool, 'auto');
  assert.deepEqual(report.providers, ['flutter', 'node', 'swiftpm', 'xcode']);
  assert.equal(report.summary.candidateCount, 2);
  assert.deepEqual(new Set(report.projects.map((project) => project.tool)), new Set(['flutter', 'xcode']));
  assert.equal(fs.existsSync(path.join(flutter, 'build')), true);
  assert.equal(fs.existsSync(path.join(xcodeFixture, 'DerivedData')), true);
});

test('Node and SwiftPM providers reclaim only manifest-owned local targets', async (t) => {
  const root = makeTemporaryDirectory(t);
  const nodeRepo = createManifestCacheRepo(path.join(root, 'node-app'), {
    manifest: 'package.json', target: 'node_modules', manifestContent: '{"name":"fixture"}\n',
  });
  const swiftRepo = createManifestCacheRepo(path.join(root, 'swift-app'), {
    manifest: 'Package.swift', target: '.build', manifestContent: '// swift-tools-version: 6.0\n',
  });
  fs.writeFileSync(path.join(nodeRepo, 'local-note.txt'), 'keep\n');

  const node = await analyzeNodeProject(nodeRepo, safeOptions({ tool: 'node' }));
  const swift = await analyzeSwiftPmProject(swiftRepo, safeOptions({ tool: 'swiftpm' }));
  assert.equal(node.status, 'candidate');
  assert.equal(swift.status, 'candidate');

  const report = await scanReclaimRoots([root], safeOptions({
    tool: 'auto', apply: true, yes: true, explicitRoots: true,
  }));
  assert.equal(report.projects.filter((project) => project.status === 'cleaned').length, 2);
  assert.equal(fs.existsSync(path.join(nodeRepo, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(swiftRepo, '.build')), false);
  assert.equal(fs.readFileSync(path.join(nodeRepo, 'local-note.txt'), 'utf8'), 'keep\n');
});

test('Node and SwiftPM providers block tracked cache contents', async (t) => {
  const root = makeTemporaryDirectory(t);
  const nodeRepo = createManifestCacheRepo(path.join(root, 'node-app'), {
    manifest: 'package.json', target: 'node_modules', manifestContent: '{"name":"fixture"}\n',
  });
  git(nodeRepo, ['add', '-f', 'node_modules/artifact.bin']);
  git(nodeRepo, ['commit', '-m', 'track dependency artifact']);
  const node = await analyzeNodeProject(nodeRepo, safeOptions({ tool: 'node' }));
  assert.match(node.blockedReasons.join('\n'), /contains tracked files/);
});

test('worktrees-only excludes primary caches and retains linked-worktree candidates', async (t) => {
  const parent = makeTemporaryDirectory(t);
  const primary = createXcodeRepo(path.join(parent, 'primary'));
  const linked = path.join(parent, 'linked');
  git(primary, ['branch', 'feature']);
  git(primary, ['worktree', 'add', linked, 'feature']);
  fs.mkdirSync(path.join(linked, 'DerivedData'));
  fs.writeFileSync(path.join(linked, 'DerivedData', 'artifact.bin'), Buffer.alloc(4096, 6));
  t.after(() => {
    try { git(primary, ['worktree', 'remove', '--force', linked]); } catch {}
  });

  const report = await scanReclaimRoots([parent], safeOptions({
    tool: 'xcode', worktreesOnly: true, excludePrimary: true,
  }));

  assert.equal(report.summary.candidateCount, 1);
  assert.equal(report.projects[0].projectRoot, fs.realpathSync(linked));
  assert.equal(report.projects[0].worktreeRole, 'linked');
  assert.equal(fs.existsSync(path.join(primary, 'DerivedData')), true);
});

test('Xcode reclaim blocks tracked, symlinked, active, and recent DerivedData', async (t) => {
  const trackedFixture = createXcodeFixture(t);
  git(trackedFixture.repo, ['add', '-f', 'DerivedData/artifact.bin']);
  git(trackedFixture.repo, ['commit', '-m', 'track derived artifact']);
  const tracked = await analyzeXcodeProject(trackedFixture.repo, safeOptions({ tool: 'xcode' }));
  assert.match(tracked.blockedReasons.join('\n'), /contains tracked files/);

  const symlinkFixture = createXcodeFixture(t);
  const outside = path.join(symlinkFixture.parent, 'outside-derived-data');
  fs.mkdirSync(outside);
  fs.rmSync(path.join(symlinkFixture.repo, 'DerivedData'), { recursive: true });
  fs.symlinkSync(outside, path.join(symlinkFixture.repo, 'DerivedData'));
  const symlinked = await analyzeXcodeProject(symlinkFixture.repo, safeOptions({ tool: 'xcode' }));
  assert.match(symlinked.blockedReasons.join('\n'), /is a symlink/);

  const activeFixture = createXcodeFixture(t);
  const active = await analyzeXcodeProject(activeFixture.repo, safeOptions({
    tool: 'xcode',
    activeProcessProbe: async () => ({ ok: true, active: true, processes: ['42 xcodebuild'], error: null }),
  }));
  assert.match(active.blockedReasons.join('\n'), /active build process/);

  const recent = await analyzeXcodeProject(activeFixture.repo, safeOptions({
    tool: 'xcode',
    recentPathProbe: async () => ({ ok: true, recent: true, error: null }),
  }));
  assert.match(recent.blockedReasons.join('\n'), /changed within/);
});

function safeOptions(overrides = {}) {
  return {
    flutterConfig,
    minAgeMinutes: 0,
    maxDepth: 8,
    activeProcessProbe: inactiveBuildProbe,
    ...overrides,
  };
}

function createFlutterFixture(t, options = {}) {
  const parent = makeTemporaryDirectory(t);
  const repo = createFlutterRepo(path.join(parent, options.name ?? 'app'), options);
  return { parent, repo };
}

function createXcodeFixture(t) {
  const parent = makeTemporaryDirectory(t);
  const repo = createXcodeRepo(path.join(parent, 'Xcode Project With Spaces'));
  return { parent, repo };
}

function createXcodeRepo(repo) {
  fs.mkdirSync(path.join(repo, 'Sources'), { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'project.yml'), 'name: Fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'DerivedData/\n.env\n');
  fs.writeFileSync(path.join(repo, 'Sources', 'Feature.swift'), 'struct Feature {}\n');
  git(repo, ['add', 'project.yml', '.gitignore', 'Sources/Feature.swift']);
  git(repo, ['commit', '-m', 'initial Xcode fixture']);
  fs.mkdirSync(path.join(repo, 'DerivedData'));
  fs.writeFileSync(path.join(repo, 'DerivedData', 'artifact.bin'), Buffer.alloc(4096, 8));
  return fs.realpathSync(repo);
}

function createManifestCacheRepo(repo, options) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, options.manifest), options.manifestContent);
  fs.writeFileSync(path.join(repo, '.gitignore'), `${options.target}/\n`);
  git(repo, ['add', options.manifest, '.gitignore']);
  git(repo, ['commit', '-m', 'initial cache fixture']);
  fs.mkdirSync(path.join(repo, options.target));
  fs.writeFileSync(path.join(repo, options.target, 'artifact.bin'), Buffer.alloc(4096, 3));
  return fs.realpathSync(repo);
}

function createFlutterRepo(repo, options = {}) {
  const target = options.target ?? 'build';
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'pubspec.yaml'), options.flutter === false ? dartManifest() : flutterManifest());
  fs.writeFileSync(path.join(repo, '.gitignore'), `${target}/\n.dart_tool/\n.android/\n.ios/\nios/Flutter/ephemeral/\n.flutter-plugins-dependencies\n`);
  git(repo, ['add', 'pubspec.yaml', '.gitignore']);
  git(repo, ['commit', '-m', 'initial fixture']);
  fs.mkdirSync(path.join(repo, target), { recursive: true });
  fs.writeFileSync(path.join(repo, target, 'artifact.bin'), Buffer.alloc(4096, 7));
  return fs.realpathSync(repo);
}

function flutterManifest() {
  return `name: fixture\ndependencies:\n  flutter:\n    sdk: flutter\n`;
}

function dartManifest() {
  return `name: fixture\ndependencies:\n  path: ^1.9.0\n`;
}

function makeTemporaryDirectory(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-reclaim-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
