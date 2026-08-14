import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const binPath = path.resolve('bin/git-groundskeeper.js');

test('reclaim CLI is read-only by default and emits JSON evidence', (t) => {
  const fixture = createFixture(t);
  const result = runCli([
    'reclaim',
    fixture.repo,
    '--json',
    '--no-progress',
    '--min-age-minutes',
    '0',
  ], fixture.flutter);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.type, 'reclaim');
  assert.equal(report.apply, false);
  assert.equal(report.summary.candidateCount, 1, JSON.stringify(report.projects, null, 2));
  assert.equal(report.projects[0].targets[0].relativePath, 'build');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('reclaim CLI requires --apply and --yes together', (t) => {
  const fixture = createFixture(t);
  const result = runCli([
    'reclaim',
    fixture.repo,
    '--apply',
    '--min-age-minutes=0',
  ], fixture.flutter);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Permanent reclaim requires --apply --yes/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('reclaim CLI refuses permanent apply without an explicit root', (t) => {
  const fixture = createFixture(t);
  const result = runCli(['reclaim', '--apply', '--yes'], fixture.flutter);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires at least one explicit root/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('explicit CLI apply revalidates and removes only Flutter build output', (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.repo, '.dart_tool'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, '.dart_tool', 'keep.txt'), 'keep\n');
  const result = runCli([
    'reclaim',
    fixture.repo,
    '--json',
    '--apply',
    '--yes',
    '--min-age-minutes=0',
  ], fixture.flutter);

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.apply, true);
  assert.equal(report.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build')), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, '.dart_tool', 'keep.txt')), true);
});

test('full-clean CLI delegates to Flutter only after explicit apply', (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.repo, '.dart_tool'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, '.dart_tool', 'state'), 'state\n');
  const result = runCli([
    'reclaim',
    fixture.repo,
    '--json',
    '--full-clean',
    '--apply',
    '--yes',
    '--min-age-minutes=0',
  ], fixture.flutter);

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'full-clean');
  assert.equal(report.summary.cleanedCount, 1);
  assert.equal(report.projects[0].actionResult.ok, true);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build')), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, '.dart_tool')), false);
});

test('reclaim-only flags fail on scan and unsupported providers fail closed', (t) => {
  const fixture = createFixture(t);
  const scan = runCli(['scan', fixture.repo, '--full-clean'], fixture.flutter);
  const unsupported = runCli(['reclaim', fixture.repo, '--tool', 'gradle'], fixture.flutter);

  assert.equal(scan.status, 1);
  assert.match(scan.stderr, /only valid with reclaim/);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Unsupported reclaim tool: gradle.*auto, flutter, node, swiftpm, xcode/);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'build', 'artifact.bin')), true);
});

test('Xcode reclaim CLI is read-only by default and can apply exact DerivedData cleanup', (t) => {
  const fixture = createXcodeFixture(t);
  const dryRun = runCli([
    'reclaim', fixture.repo, '--tool', 'xcode', '--json', '--min-age-minutes=0',
  ]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).summary.candidateCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), true);

  const apply = runCli([
    'reclaim', fixture.repo, '--tool', 'xcode', '--json', '--apply', '--yes', '--min-age-minutes=0',
  ]);
  assert.equal(apply.status, 0, `${apply.stderr}\n${apply.stdout}`);
  assert.equal(JSON.parse(apply.stdout).summary.cleanedCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), false);
});

test('Xcode provider rejects Flutter-only full clean mode', (t) => {
  const fixture = createXcodeFixture(t);
  const result = runCli(['reclaim', fixture.repo, '--tool', 'xcode', '--full-clean']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /full-clean is currently supported only with --tool flutter/);
});

test('CLI accepts auto and worktree scoping controls', (t) => {
  const fixture = createXcodeFixture(t);
  const auto = runCli([
    'reclaim', fixture.repo, '--tool', 'auto', '--json', '--worktrees-only', '--min-age-minutes=0',
  ]);

  assert.equal(auto.status, 0, auto.stderr);
  assert.equal(JSON.parse(auto.stdout).tool, 'auto');
  assert.equal(JSON.parse(auto.stdout).summary.projectCount, 0);
  const invalid = runCli(['scan', fixture.repo, '--exclude-primary']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /only valid with reclaim/);
});

test('disk-pressure CLI remains read-only and scopes its plan to linked worktrees', (t) => {
  const fixture = createXcodeFixture(t);
  const result = runCli([
    'disk-pressure', fixture.repo, '--json', '--min-free-gb', '9999', '--min-age-minutes=0',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.type, 'disk-pressure');
  assert.equal(report.apply, false);
  assert.equal(report.pressureDetected, true);
  assert.equal(report.reclaim.summary.projectCount, 0);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), true);
});

test('session-complete is an exact-root auto-provider integration surface', (t) => {
  const fixture = createXcodeFixture(t);
  const dryRun = runCli(['session-complete', fixture.repo, '--json', '--min-age-minutes=0']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).tool, 'auto');
  assert.equal(JSON.parse(dryRun.stdout).apply, false);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), true);

  const apply = runCli([
    'session-complete', fixture.repo, '--json', '--apply', '--yes', '--min-age-minutes=0',
  ]);
  assert.equal(apply.status, 0, `${apply.stderr}\n${apply.stdout}`);
  assert.equal(JSON.parse(apply.stdout).summary.cleanedCount, 1);
  assert.equal(fs.existsSync(path.join(fixture.repo, 'DerivedData')), false);
  assert.equal(fs.existsSync(fixture.repo), true);

  const missing = runCli(['session-complete']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /exactly one explicit worktree root/);
});

test('help documents the permanent-apply boundary', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /git-groundskeeper reclaim \[roots\.\.\.\]/);
  assert.match(result.stdout, /git-groundskeeper disk-pressure \[roots\.\.\.\]/);
  assert.match(result.stdout, /--apply --yes/);
  assert.match(result.stdout, /at least one explicit root/);
});

function createFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-reclaim-cli-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'Flutter CLI Project');
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'pubspec.yaml'), 'name: fixture\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n.dart_tool/\n');
  git(repo, ['add', 'pubspec.yaml', '.gitignore']);
  git(repo, ['commit', '-m', 'initial fixture']);
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'artifact.bin'), Buffer.alloc(4096, 4));

  const flutter = path.join(parent, 'fake-flutter');
  fs.writeFileSync(flutter, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'config --list') {
  process.stdout.write('Settings:\\n  build-dir: (Not set)\\n');
  process.exit(0);
}
if (process.argv.slice(2).join(' ') === '--suppress-analytics clean') {
  const fs = require('node:fs');
  fs.rmSync('build', { recursive: true, force: true });
  fs.rmSync('.dart_tool', { recursive: true, force: true });
  process.stdout.write('cleaned\\n');
  process.exit(0);
}
process.stderr.write('unexpected fake Flutter invocation\\n');
process.exit(2);
`);
  fs.chmodSync(flutter, 0o755);
  return { parent, repo: fs.realpathSync(repo), flutter };
}

function createXcodeFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-xcode-cli-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'Xcode CLI Project');
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'project.yml'), 'name: Fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'DerivedData/\n');
  git(repo, ['add', 'project.yml', '.gitignore']);
  git(repo, ['commit', '-m', 'initial fixture']);
  fs.mkdirSync(path.join(repo, 'DerivedData'));
  fs.writeFileSync(path.join(repo, 'DerivedData', 'artifact.bin'), Buffer.alloc(4096, 5));
  return { parent, repo: fs.realpathSync(repo) };
}

function runCli(args, flutter) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(flutter ? { GIT_GROUNDSKEEPER_FLUTTER: flutter } : {}),
    },
  });
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
