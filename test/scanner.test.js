import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  classifyOwnership,
  defaultRoots,
  discoverWorktrees,
  discoverWorktreesAsync,
  parseRemoteOwner,
  parseRemoteRepository,
  scanRoots,
} from '../src/scanner.js';
import { formatScanText } from '../src/format.js';

const temporaryDirectories = new Set();

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test('scanRoots reports dirty worktrees and branches without upstream', async () => {
  const fixture = createFixture();

  git(fixture.repo, ['checkout', '-b', 'feature/no-upstream']);
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(fixture.repo, ['add', 'feature.txt']);
  git(fixture.repo, ['commit', '-m', 'add feature']);
  fs.writeFileSync(path.join(fixture.repo, 'dirty.txt'), 'dirty\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.status, 'commit-needed');
  assert.equal(repo.worktrees.some((worktree) => worktree.dirty), true);
  assert.equal(repo.branches.some((branch) => branch.name === 'feature/no-upstream' && branch.upstreamStatus === 'none'), true);
});

test('scanRoots reports branch ahead of upstream even when worktree is clean', async () => {
  const fixture = createFixture();

  fs.writeFileSync(path.join(fixture.repo, 'ahead.txt'), 'ahead\n');
  git(fixture.repo, ['add', 'ahead.txt']);
  git(fixture.repo, ['commit', '-m', 'ahead local']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const main = repo.branches.find((branch) => branch.name === 'main');

  assert.equal(repo.status, 'push-needed');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
});

test('scanRoots follows linked worktrees from a discovered repo', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'linked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/linked', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');

  const report = await scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));

  assert.ok(repo);
  assert.equal(repo.primaryPath, fixture.repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === linked && worktree.dirty), true);
});

test('repository discovery lists registered worktrees once and preserves Git primary order', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'linked-list-once');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/list-once', linked, 'main']);
  let calls = 0;

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    listLinkedWorktreePaths: async (cwd) => {
      calls += 1;
      return git(cwd, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => fs.realpathSync(line.slice('worktree '.length)));
    },
  });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));

  assert.equal(calls, 1);
  assert.equal(repo.primaryPath, fixture.repo);
  assert.equal(repo.worktrees.length, 2);
});

test('scan roots and reported paths use canonical filesystem identities', async () => {
  const fixture = createFixture();
  const aliases = makeTemporaryDirectory('git-groundskeeper-alias-root-');
  const alias = path.join(aliases, 'same-root');
  fs.symlinkSync(fixture.parent, alias, 'dir');

  const report = await scanRoots([alias], { maxDepth: 4 });

  assert.deepEqual(report.roots, [fixture.parent]);
  assert.ok(report.repos.some((repo) => repo.primaryPath === fixture.repo));
});

test('scan-to-command output never targets a linked worktree outside a narrow root', async () => {
  const fixture = createFixture();
  const outside = path.join(fixture.parent, 'outside-narrow-root');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/outside-narrow-root', outside, 'main']);

  const report = await scanRoots([fixture.repo], {
    maxDepth: 1,
    buckets: true,
    prCheck: false,
    liveRemoteCheck: false,
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  assert.ok(repo.worktrees.some((worktree) => worktree.path === outside), 'repository context lost linked worktree');

  const output = formatScanText(report, {
    buckets: true,
    commands: true,
    tableWidth: 200,
  });
  assert.doesNotMatch(output, new RegExp(escapeRegExp(outside)));
  assert.match(output, /Linked worktrees outside roots hidden: 1/);
});

test('scanRoots marks clean gone-upstream worktrees as prune candidates when merged', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'merged-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/merged', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'merged.txt'), 'merged\n');
  git(linked, ['add', 'merged.txt']);
  git(linked, ['commit', '-m', 'merged feature']);
  git(fixture.repo, ['merge', '--ff-only', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(linked, ['push', 'origin', 'feature/merged']);
  git(linked, ['branch', '--set-upstream-to=origin/feature/merged', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/merged']);
  git(linked, ['fetch', '--prune', 'origin']);

  const report = await scanRoots([linked], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/merged');

  assert.equal(worktree.upstreamStatus, 'gone');
  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedInto, 'origin/main');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
});

test('bucket scans detect a remotely deleted branch without fetching or pruning local refs', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'stale-tracking-ref');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/stale-tracking-ref', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'merged.txt'), 'merged\n');
  git(linked, ['add', 'merged.txt']);
  git(linked, ['commit', '-m', 'merged feature']);
  git(linked, ['push', '-u', 'origin', 'feature/stale-tracking-ref']);
  const branchHead = git(linked, ['rev-parse', 'HEAD']).trim();
  git(fixture.repo, ['merge', '--ff-only', 'feature/stale-tracking-ref']);
  git(fixture.repo, ['push', 'origin', 'main']);

  // Simulate deletion from GitHub, not from this checkout. The local tracking
  // ref deliberately remains, which is exactly the stale state that hid the
  // user's deleted branch before this regression fix.
  git(fixture.remote, ['update-ref', '-d', 'refs/heads/feature/stale-tracking-ref']);
  assert.equal(
    git(fixture.repo, ['show-ref', '--verify', 'refs/remotes/origin/feature/stale-tracking-ref']).trim().length > 0,
    true,
  );
  const fetchHead = path.join(fixture.repo, '.git', 'FETCH_HEAD');
  assert.equal(fs.existsSync(fetchHead), false);

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    buckets: true,
    listMergedPullRequests: async () => new Map([
      ['feature/stale-tracking-ref', {
        base: 'main',
        head: branchHead,
        number: 239,
        mergedAt: '2026-07-19',
      }],
    ]),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/stale-tracking-ref');

  assert.equal(branch.upstreamStatus, 'tracking');
  assert.equal(branch.liveUpstreamStatus, 'gone');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.liveUpstreamStatus, 'gone');
  assert.equal(worktree.tier, 'worktree-and-branch');
  // ls-remote is observational: the scan neither fetches nor prunes.
  assert.equal(fs.existsSync(fetchHead), false);
  assert.equal(
    git(fixture.repo, ['show-ref', '--verify', 'refs/remotes/origin/feature/stale-tracking-ref']).trim().length > 0,
    true,
  );
});

test('a live remote branch overrides a stale local gone marker', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'remote-recreated');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/remote-recreated', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'work.txt'), 'remote copy\n');
  git(linked, ['add', 'work.txt']);
  git(linked, ['commit', '-m', 'remote copy']);
  git(linked, ['push', '-u', 'origin', 'feature/remote-recreated']);
  git(fixture.repo, ['update-ref', '-d', 'refs/remotes/origin/feature/remote-recreated']);

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    buckets: true,
    prCheck: false,
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/remote-recreated');

  assert.equal(branch.upstreamStatus, 'gone');
  assert.equal(branch.liveUpstreamStatus, 'present');
  assert.equal(branch.liveUpstreamMatchesHead, true);
  assert.equal(branch.cleanupStatus, null);
  assert.equal(worktree.tier, 'worktree-only');
});

test('an ignored file unique to a worktree is reported whatever it is called', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-unique-file');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'scratch-notes.txt\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore scratch']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/unique', linked, 'main']);

  // A name no precious-pattern list would ever have guessed. That is the point:
  // guessing names means being wrong loses data, so uniqueness is the test.
  fs.writeFileSync(path.join(linked, 'scratch-notes.txt'), 'do not lose me\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.dirty, false);
  assert.deepEqual(worktree.preciousIgnored, ['scratch-notes.txt']);
});

test('ignored directories are inspected recursively and block merged cleanup', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'ignored-directory');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'private/\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore private directory']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/ignored-directory', linked, 'main']);
  git(linked, ['push', '-u', 'origin', 'feature/ignored-directory']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/ignored-directory']);
  git(linked, ['fetch', '--prune', 'origin']);

  fs.mkdirSync(path.join(linked, 'private', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(linked, 'private', 'deep', 'only-copy.txt'), 'do not delete\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.deepEqual(worktree.preciousIgnored, ['private/deep/only-copy.txt']);
  assert.equal(worktree.tier, 'check-first');
});

test('a generated-looking ignored directory is never assumed disposable', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'ignored-build-directory');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'build/\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore build directory']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/ignored-build', linked, 'main']);
  fs.mkdirSync(path.join(linked, 'build'));
  fs.writeFileSync(path.join(linked, 'build', 'signing.keystore'), 'only signing key\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['build/']);
  assert.equal(worktree.tier, 'check-first');
});

test('repository-local policy suppresses exact and pattern paths but retains state and secrets', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'policy-ignored-content');

  fs.mkdirSync(path.join(fixture.repo, 'functions'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'ios'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    [
      'app.log',
      'build/',
      'dataconnect/.dataconnect/',
      'exportedData-profile-1/',
      'functions/.secret.local',
      'ios/Podfile.lock',
      '',
    ].join('\n'),
  );
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore local outputs']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/policy-ignored-content', linked, 'main']);

  fs.writeFileSync(
    path.join(fixture.repo, '.git', 'groundskeeper-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      ignoredContent: {
        disposable: [
          { path: 'build/', reason: 'fixture build output' },
          { path: 'ios/Podfile.lock', reason: 'fixture generated lock' },
          { path: 'app.log', reason: 'fixture debug log' },
          {
            gitignorePattern: 'exportedData-profile-*/',
            reason: 'fixture emulator exports',
          },
        ],
      },
    }),
  );

  const ignoredFiles = [
    ['app.log'],
    ['build', 'output.bin'],
    ['dataconnect', '.dataconnect', 'pgliteData', 'state.db'],
    ['exportedData-profile-1', 'firestore_export', 'output-0'],
    ['functions', '.secret.local'],
    ['ios', 'Podfile.lock'],
  ];
  for (const segments of ignoredFiles) {
    const file = path.join(linked, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture for ${segments.join('/')}\n`);
  }

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(repo.ignoredContentPolicy.errors, []);
  assert.equal(repo.ignoredContentPolicy.ruleCount, 4);
  assert.deepEqual(
    worktree.policyIgnored.map((entry) => entry.path),
    ['app.log', 'build/', 'exportedData-profile-1/', 'ios/Podfile.lock'],
  );
  assert.deepEqual(worktree.preciousIgnored, [
    'dataconnect/.dataconnect/pgliteData/state.db',
    'functions/.secret.local',
  ]);
  assert.equal(worktree.tier, 'check-first');
});

test('an invalid repository-local ignored-content policy fails closed', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'invalid-policy');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'build/\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore build output']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/invalid-policy', linked, 'main']);
  fs.mkdirSync(path.join(linked, 'build'));
  fs.writeFileSync(path.join(linked, 'build', 'output.bin'), 'fixture output\n');

  fs.writeFileSync(
    path.join(fixture.repo, '.git', 'groundskeeper-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      ignoredContent: {
        disposable: [
          { path: 'build/', reason: 'fixture build output' },
          { path: '../secret', reason: 'must be rejected' },
          { gitignorePattern: '*/', reason: 'must also be rejected' },
        ],
      },
    }),
  );

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(repo.ignoredContentPolicy.ruleCount, 0);
  assert.ok(repo.ignoredContentPolicy.errors.some((error) => /parent segments/.test(error)));
  assert.ok(repo.ignoredContentPolicy.errors.some((error) => /too broad/.test(error)));
  assert.deepEqual(worktree.policyIgnored, []);
  assert.deepEqual(worktree.preciousIgnored, ['build/']);
  assert.ok(worktree.inspectionErrors.some((error) => error.probe === 'ignored-policy'));
  assert.equal(worktree.tier, 'inspection-error');
});

test('repo-aware rules hide only caches proven by local tool manifests', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'repo-aware-caches');

  fs.mkdirSync(path.join(fixture.repo, 'android'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'infra'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'ios'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'functions'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'astro-site'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'plain-site'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'php'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, 'pubspec.yaml'), 'name: fixture\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(fixture.repo, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(fixture.repo, 'Package.swift'), '// swift-tools-version: 6.0\n');
  fs.writeFileSync(path.join(fixture.repo, 'global.json'), '{"sdk":{"version":"10.0.100"}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'android', 'build.gradle'), '// generated fixture\n');
  fs.writeFileSync(path.join(fixture.repo, 'infra', 'main.tf'), 'terraform {}\n');
  fs.writeFileSync(path.join(fixture.repo, 'ios', 'Podfile'), "platform :ios, '15.0'\n");
  fs.writeFileSync(path.join(fixture.repo, 'php', 'composer.json'), '{"require":{}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'php', 'phpunit.xml'), '<phpunit />\n');
  fs.writeFileSync(path.join(fixture.repo, 'frontend', 'package.json'), '{"scripts":{"build":"vite build"}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'astro-site', 'package.json'), '{"scripts":{"build":"astro build"}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'plain-site', 'package.json'), '{"scripts":{"build":"webpack"}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'functions', 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(fixture.repo, 'functions', 'tsconfig.json'),
    '{"compilerOptions":{"outDir":"./lib"},"include":["src/**/*"]}\n',
  );
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    [
      '.build/',
      '.dart_tool/',
      '.dotnet/',
      '.idea/',
      'android/.gradle/',
      'assets/.env',
      'build/',
      'functions/.next/',
      'functions/.turbo/',
      'functions/.vercel/',
      'functions/lib/',
      'functions/node_modules/',
      'frontend/dist/',
      'astro-site/dist/',
      'plain-site/dist/',
      'infra/.terraform/',
      'ios/Flutter/ephemeral/',
      'ios/Pods/',
      'php/vendor/',
      'php/.phpunit.cache/',
      'target/',
      '',
    ].join('\n'),
  );
  git(fixture.repo, ['add', '.gitignore', 'Cargo.toml', 'Package.swift', 'global.json', 'pubspec.yaml', 'android', 'astro-site', 'frontend', 'functions', 'infra', 'ios', 'php', 'plain-site']);
  git(fixture.repo, ['commit', '-m', 'add tool manifests']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/repo-aware-caches', linked, 'main']);

  const ignoredFiles = [
    ['.build', 'checkouts', 'dependency.txt'],
    ['.dart_tool', 'package_config.json'],
    ['.dotnet', 'sdk', '10.0.100', 'dotnet.dll'],
    ['.idea', 'libraries', 'Dart_Packages.xml'],
    ['.idea', 'libraries', 'Dart_SDK.xml'],
    ['.idea', 'libraries', 'Flutter_Plugins.xml'],
    ['android', '.gradle', 'cache.bin'],
    ['functions', '.next', 'cache.bin'],
    ['functions', '.turbo', 'cache.bin'],
    ['functions', '.vercel', 'project.json'],
    ['functions', 'lib', 'generated.js'],
    ['functions', 'node_modules', 'dependency', 'index.js'],
    ['frontend', 'dist', 'index.html'],
    ['astro-site', 'dist', 'index.html'],
    ['plain-site', 'dist', 'only-copy.txt'],
    ['infra', '.terraform', 'providers', 'provider.bin'],
    ['ios', 'Flutter', 'ephemeral', 'flutter_native_integration.env'],
    ['ios', 'Pods', 'dependency', 'source.m'],
    ['php', 'vendor', 'composer', 'autoload_real.php'],
    ['php', '.phpunit.cache', 'test-results'],
    ['target', 'debug', 'fixture'],
    ['assets', '.env'],
    ['build', 'signing.keystore'],
  ];
  for (const segments of ignoredFiles) {
    const file = path.join(linked, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture for ${segments.join('/')}\n`);
  }

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.dirty, false);
  assert.deepEqual(worktree.preciousIgnored, ['assets/.env', 'build/', 'plain-site/dist/']);
  assert.equal(worktree.tier, 'check-first');
});

test('CodeIgniter file sessions are hidden only when the configured save path proves ownership', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'codeigniter-session-cache');
  const appRoot = path.join(fixture.repo, 'src');

  fs.mkdirSync(path.join(appRoot, 'app', 'Config'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'spark'), '#!/usr/bin/env php\n');
  fs.writeFileSync(
    path.join(appRoot, 'app', 'Config', 'App.php'),
    [
      '<?php',
      "public $sessionDriver = 'CodeIgniter\\Session\\Handlers\\FileHandler';",
      "public $sessionSavePath = WRITEPATH . 'session';",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'src/writable/\n');
  git(fixture.repo, ['add', '.gitignore', 'src/app/Config/App.php', 'src/spark']);
  git(fixture.repo, ['commit', '-m', 'add codeigniter session config']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/codeigniter-session', linked, 'main']);

  const session = path.join(linked, 'src', 'writable', 'session', 'ci_session123');
  const log = path.join(linked, 'src', 'writable', 'logs', 'debug.log');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(session, 'ephemeral session\n');
  fs.writeFileSync(log, 'retain diagnostic evidence\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['src/writable/logs/debug.log']);
  assert.equal(worktree.tier, 'check-first');
});

test('additional cache rules fail closed when their owning evidence is missing', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'unproven-additional-caches');

  fs.mkdirSync(path.join(fixture.repo, 'framework'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'php'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, 'framework', 'spark'), '#!/usr/bin/env php\n');
  fs.writeFileSync(path.join(fixture.repo, 'frontend', 'package.json'), '{"scripts":{"build":"webpack"}}\n');
  fs.writeFileSync(path.join(fixture.repo, 'php', 'composer.json'), '{"require":{}}\n');
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    [
      '.idea/',
      'framework/writable/',
      'frontend/dist/',
      'php/.phpunit.cache/',
      '',
    ].join('\n'),
  );
  git(fixture.repo, ['add', '.gitignore', 'framework/spark', 'frontend/package.json', 'php/composer.json']);
  git(fixture.repo, ['commit', '-m', 'add incomplete tool evidence']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/unproven-additional-caches', linked, 'main']);

  const ignoredFiles = [
    ['.idea', 'libraries', 'Dart_SDK.xml'],
    ['framework', 'writable', 'session', 'ci_session123'],
    ['frontend', 'dist', 'only-copy.txt'],
    ['php', '.phpunit.cache', 'test-results'],
  ];
  for (const segments of ignoredFiles) {
    const file = path.join(linked, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `unproven ${segments.join('/')}\n`);
  }

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, [
    '.idea/libraries/Dart_SDK.xml',
    'framework/writable/session/ci_session123',
    'frontend/dist/',
    'php/.phpunit.cache/test-results',
  ]);
  assert.equal(worktree.tier, 'check-first');
});

test('dotnet bin and obj outputs are hidden only beside a project manifest', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'dotnet-output-caches');

  fs.mkdirSync(path.join(fixture.repo, 'service'), { recursive: true });
  fs.mkdirSync(path.join(fixture.repo, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, 'service', 'service.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    'service/bin/\nservice/obj/\nscratch/bin/\n',
  );
  git(fixture.repo, ['add', '.gitignore', 'service/service.csproj']);
  git(fixture.repo, ['commit', '-m', 'add dotnet project']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/dotnet-outputs', linked, 'main']);

  const ignoredFiles = [
    ['service', 'bin', 'Debug', 'net10.0', 'service.dll'],
    ['service', 'obj', 'project.assets.json'],
    ['scratch', 'bin', 'only-copy.txt'],
  ];
  for (const segments of ignoredFiles) {
    const file = path.join(linked, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture for ${segments.join('/')}\n`);
  }

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['scratch/bin/']);
  assert.equal(worktree.tier, 'check-first');
});

test('a cache-shaped directory without its repository manifest stays review-required', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'unproven-dart-cache');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), '.dart_tool/\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore cache-shaped directory']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/unproven-dart-cache', linked, 'main']);
  fs.mkdirSync(path.join(linked, '.dart_tool'));
  fs.writeFileSync(path.join(linked, '.dart_tool', 'only-copy.txt'), 'not proven to be a Dart cache\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['.dart_tool/']);
  assert.equal(worktree.tier, 'check-first');
});

test('valuable ignored log, lock, and generated-name files are not silently discarded', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'valuable-ignored-names');

  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    'debug.log\nPodfile.lock\nfirebase_options.dart\n__pycache__/\n',
  );
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore local outputs']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/valuable-ignored', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'debug.log'), 'the only diagnostic record\n');
  fs.writeFileSync(path.join(linked, 'Podfile.lock'), 'the only dependency resolution\n');
  fs.writeFileSync(path.join(linked, 'firebase_options.dart'), 'the only generated config\n');
  fs.mkdirSync(path.join(linked, '__pycache__'));
  fs.writeFileSync(path.join(linked, '__pycache__', 'module.cpython-313.pyc'), Buffer.from([0, 1, 2]));

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, [
    'debug.log',
    'firebase_options.dart',
    'Podfile.lock',
  ]);
});

test('distinct invalid UTF-8 ignored files cannot compare equal through replacement characters', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'binary-ignored');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'blob.bin\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore binary blob']);
  fs.writeFileSync(path.join(fixture.repo, 'blob.bin'), Buffer.from([0x80]));
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/binary-ignored', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'blob.bin'), Buffer.from([0x81]));

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['blob.bin']);
});

test('failed safety probes become inspection-error instead of clean', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'status-unavailable');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/status-unavailable', linked, 'main']);

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    inspectStatusEntries: async () => ({
      ok: false,
      entries: [],
      error: 'injected status failure',
    }),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.dirty, null);
  assert.equal(worktree.tier, 'inspection-error');
  assert.deepEqual(worktree.inspectionErrors, [
    { probe: 'status', message: 'injected status failure' },
  ]);
  assert.equal(report.summary.inspectionErrorWorktreeCount, 2);
});

test('failed ignored-file inspection cannot produce a reclaimable tier', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'ignored-inspection-unavailable');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/ignored-inspection-unavailable', linked, 'main']);

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    inspectPreciousIgnored: async () => ({
      precious: [],
      errors: ['injected ignored-file failure'],
    }),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.tier, 'inspection-error');
  assert.deepEqual(worktree.inspectionErrors, [
    { probe: 'ignored-files', message: 'injected ignored-file failure' },
  ]);
});

test('editor state is filtered but a secret sitting beside it is not', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-idea');

  // JetBrains does not ignore .idea/ wholesale; it ignores individual files,
  // which is why they are visible here at all. Ignoring the directory would
  // collapse it to a single entry and the tool would see nothing inside.
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    '.idea/workspace.xml\n.idea/*.iml\n.idea/dataSources.local.xml\n',
  );
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore idea state']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/idea', linked, 'main']);

  fs.mkdirSync(path.join(linked, '.idea'));
  fs.writeFileSync(path.join(linked, '.idea', 'workspace.xml'), '<project/>\n');
  fs.writeFileSync(path.join(linked, '.idea', 'has-idea.iml'), '<module/>\n');
  // JetBrains keeps database passwords here. Skipping .idea/ wholesale would
  // be tidier and would silence exactly the file worth warning about.
  fs.writeFileSync(path.join(linked, '.idea', 'dataSources.local.xml'), '<password>hunter2</password>\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['.idea/dataSources.local.xml']);
});

test('an ignored file duplicated from the primary checkout stays silent', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-duplicate');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'config.json\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore config']);
  fs.writeFileSync(path.join(fixture.repo, 'config.json'), '{"shared":true}\n');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/dup', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'config.json'), '{"shared":true}\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // Byte-identical to the primary checkout, so nothing is lost by removal and
  // warning about it would be the noise that buries a real finding.
  assert.deepEqual(worktree.preciousIgnored, []);
});

test('ignored text differing only by its worktree path stays silent', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-path-normalized-copy');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'generated.env\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore generated environment']);
  fs.writeFileSync(path.join(fixture.repo, 'generated.env'), `ROOT=${fixture.repo}\nMODE=debug\n`);

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/path-normalized-copy', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'generated.env'), `ROOT=${linked}\nMODE=debug\n`);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, []);
});

test('a scan containing only a clean checkout renders its bucket instead of empty state', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'clean-only-scan');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/clean-only-scan', linked, 'main']);
  git(linked, ['push', '-u', 'origin', 'feature/clean-only-scan']);

  const report = await scanRoots([linked], {
    maxDepth: 1,
    buckets: true,
    prCheck: false,
    liveRemoteCheck: false,
  });
  const output = formatScanText(report, { buckets: true, commands: true, tableWidth: 180 });

  assert.match(output, /In scope: 1 worktree, 0 need attention/);
  assert.match(output, /ready if unused: remove checkout, retain branch \(1\)/);
  assert.match(output, /\| \.\s+\| feature\/clean-only-scan\s+\|/);
  assert.doesNotMatch(output, /No outstanding Git state found/);
});

test('a symlinked env file is not reported: removing the worktree cannot lose it', async () => {
  const fixture = createFixture();
  const shared = path.join(fixture.parent, 'shared.env');

  fs.writeFileSync(shared, 'API_KEY=shared\n');
  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'assets/.env\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore env']);
  fs.mkdirSync(path.join(fixture.repo, 'assets'));
  fs.symlinkSync(shared, path.join(fixture.repo, 'assets', '.env'));

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === fixture.repo);

  // Symlinking .env into each worktree is a normal way to avoid copying it.
  // Warning about those buries the one worktree holding a real file.
  assert.deepEqual(worktree.preciousIgnored, []);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'API_KEY=shared\n');
});

test('a worktree paused mid-rebase is blocked even though it looks clean', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'rebasing');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/rebasing', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'theirs.txt'), 'theirs\n');
  git(linked, ['add', 'theirs.txt']);
  git(linked, ['commit', '-m', 'theirs']);

  fs.writeFileSync(path.join(fixture.repo, 'theirs.txt'), 'ours\n');
  git(fixture.repo, ['add', 'theirs.txt']);
  git(fixture.repo, ['commit', '-m', 'ours']);

  // Deliberately conflicting rebase, left paused.
  try {
    git(linked, ['rebase', 'main']);
  } catch {
    // Expected: the rebase stops on the conflict.
  }
  git(linked, ['checkout', '--ours', '.']);
  git(linked, ['add', '.']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.inProgress, 'rebase');
  assert.equal(worktree.tier, 'blocked');
});

test('a worktree with a checked-out submodule is never proposed for removal', async () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'has-submodule');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/subs', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = await scanRoots([fixture.parent], { maxDepth: 3 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // `git worktree remove` fails outright here: "working trees containing
  // submodules cannot be moved or removed". Offering it proposes a command
  // that cannot work, and the submodule's own branch is unexamined besides.
  assert.equal(worktree.submodules.length, 1);
  assert.equal(worktree.submodules[0].path, 'admin');
  assert.equal(worktree.tier, 'submodule');
});

test('a clean worktree with unpushed commits is push-first, not safe', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'unpushed');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/unpushed', linked, 'main']);
  git(linked, ['push', '-u', 'origin', 'feature/unpushed']);
  fs.writeFileSync(path.join(linked, 'work.txt'), 'work\n');
  git(linked, ['add', 'work.txt']);
  git(linked, ['commit', '-m', 'not pushed anywhere']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // The branch does keep the commit, which is why this is not "blocked". But
  // it exists on one disk with no checkout to remind anyone, so calling it
  // safe to remove is how work quietly stops existing.
  assert.equal(worktree.dirty, false);
  assert.equal(worktree.ahead, 1);
  assert.equal(worktree.tier, 'push-first');
});

test('bucket scans count pushed commits that are still absent from the integration base', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'pushed-not-merged');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/pushed-not-merged', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'work.txt'), 'pushed but not merged\n');
  git(linked, ['add', 'work.txt']);
  git(linked, ['commit', '-m', 'pushed work']);
  git(linked, ['push', '-u', 'origin', 'feature/pushed-not-merged']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.tier, 'worktree-only');
  assert.equal(worktree.ahead, 0);
  assert.equal(worktree.unmergedBase, 'origin/main');
  assert.equal(worktree.unmergedCommits, 1);
});

test('bucket scans preserve the exact upstream branch name when it differs locally', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'tracks-main');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/tracks-main', linked, 'main']);
  git(linked, ['branch', '--set-upstream-to=origin/main', 'feature/tracks-main']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.tier, 'worktree-only');
  assert.equal(worktree.upstream, 'origin/main');
  assert.equal(worktree.upstreamBranch, 'main');
  assert.equal(worktree.unmergedCommits, 0);
});

test('bucket scans distinguish the integration base from the remote default branch', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'integrated-into-dev');

  git(fixture.repo, ['checkout', '-b', 'dev', 'main']);
  fs.writeFileSync(path.join(fixture.repo, 'dev.txt'), 'dev-only\n');
  git(fixture.repo, ['add', 'dev.txt']);
  git(fixture.repo, ['commit', '-m', 'dev-only work']);
  git(fixture.repo, ['push', '-u', 'origin', 'dev']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/integrated-into-dev', linked, 'dev']);
  git(linked, ['branch', '--set-upstream-to=origin/dev', 'feature/integrated-into-dev']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(repo.defaultBranch, 'main');
  assert.equal(repo.defaultBranchRef, 'origin/main');
  assert.match(repo.defaultBranchHead, /^[0-9a-f]{40}$/);
  assert.equal(worktree.unmergedBase, 'origin/dev');
  assert.match(worktree.unmergedBaseHead, /^[0-9a-f]{40}$/);
  assert.equal(worktree.unmergedCommits, 0);
  assert.equal(worktree.defaultBranchContainment, 'not-contained');
  assert.equal(repo.repository, null);
});

test('bucket scans attach live GitHub merge evidence to an integrated branch', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'merged-live');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/merged-live', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'merged.txt'), 'merged\n');
  git(linked, ['add', 'merged.txt']);
  git(linked, ['commit', '-m', 'merged work']);
  git(linked, ['push', '-u', 'origin', 'feature/merged-live']);
  git(fixture.repo, ['merge', '--ff-only', 'feature/merged-live']);
  git(fixture.repo, ['push', 'origin', 'main']);
  const branchHead = git(linked, ['rev-parse', 'HEAD']).trim();

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    buckets: true,
    listMergedPullRequests: async () => new Map([
      ['feature/merged-live', {
        base: 'main',
        head: branchHead,
        number: 412,
        mergedAt: '2026-07-19',
      }],
    ]),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.tier, 'worktree-only');
  assert.equal(worktree.unmergedCommits, 0);
  assert.equal(worktree.githubMergeStatus, 'merged');
  assert.deepEqual(worktree.pullRequest, {
    base: 'main',
    head: branchHead,
    number: 412,
    mergedAt: '2026-07-19',
  });

  const movedReport = await scanRoots([fixture.parent], {
    maxDepth: 4,
    buckets: true,
    listMergedPullRequests: async () => new Map([
      ['feature/merged-live', {
        base: 'main',
        head: '0000000000000000000000000000000000000000',
        number: 411,
        mergedAt: '2026-07-18',
      }],
    ]),
  });
  const movedRepo = movedReport.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const movedWorktree = movedRepo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(movedWorktree.githubMergeStatus, 'head-moved');
  assert.equal(movedWorktree.pullRequest, null);
});

test('an open draft PR marks a clean checkout as WIP without requiring bucket output', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'draft-wip');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/draft-wip', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'draft.txt'), 'work in progress\n');
  git(linked, ['add', 'draft.txt']);
  git(linked, ['commit', '-m', 'draft work']);
  git(linked, ['push', '-u', 'origin', 'feature/draft-wip']);
  const branchHead = git(linked, ['rev-parse', 'HEAD']).trim();
  const draftPullRequest = {
    base: 'feature/foundation',
    head: branchHead,
    number: 294,
    updatedAt: '2026-07-23',
    url: 'https://github.example/pull/294',
  };

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    listDraftPullRequests: async () => new Map([
      ['feature/draft-wip', draftPullRequest],
    ]),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/draft-wip');

  assert.equal(worktree.dirty, false);
  assert.equal(worktree.tier, 'wip');
  assert.equal(repo.status, 'wip');
  assert.equal(report.summary.draftWorktreeCount, 1);
  assert.equal(report.summary.attentionCount, 1);
  assert.deepEqual(worktree.draftPullRequest, draftPullRequest);
  assert.deepEqual(branch.draftPullRequest, draftPullRequest);

  const compact = formatScanText(report, { tableWidth: 180 });
  assert.match(compact, /WIP: draft PR #294/);

  const detailed = formatScanText(report, { details: true, tableWidth: 180 });
  assert.match(detailed, /wip draft-pr:#294 base:feature\/foundation/);
  assert.match(detailed, /https:\/\/github\.example\/pull\/294/);

  const buckets = formatScanText(report, {
    buckets: true,
    commands: true,
    all: true,
    tableWidth: 180,
  });
  assert.match(buckets, /blocked: open draft PR marks active WIP \(1\)/);
  assert.match(buckets, /Draft PR #294 -> feature\/foundation/);
  assert.doesNotMatch(buckets, new RegExp(`worktree remove '${escapeRegExp(linked)}'`));

  let draftQueryCalled = false;
  const skippedReport = await scanRoots([fixture.parent], {
    maxDepth: 4,
    prCheck: false,
    listDraftPullRequests: async () => {
      draftQueryCalled = true;
      return new Map([['feature/draft-wip', draftPullRequest]]);
    },
  });
  const skippedRepo = skippedReport.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const skippedWorktree = skippedRepo.worktrees.find((candidate) => candidate.path === linked);
  assert.equal(draftQueryCalled, false);
  assert.equal(skippedWorktree.draftPullRequest, null);
  assert.equal(skippedWorktree.githubDraftStatus, 'skipped');
  assert.equal(skippedWorktree.tier, 'worktree-only');
});

test('a branch that was never pushed is push-first even with nothing ahead', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'no-upstream');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/never-pushed', linked, 'main']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // No upstream at all: the branch exists here and nowhere else.
  assert.equal(worktree.upstreamStatus, 'none');
  assert.equal(worktree.tier, 'push-first');
});

test('a detached HEAD holding commits on no branch is blocked, not called safe', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-work');

  git(fixture.repo, ['worktree', 'add', '--detach', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'orphan.txt'), 'only here\n');
  git(linked, ['add', 'orphan.txt']);
  git(linked, ['commit', '-m', 'work with no branch to hold it']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // The worktree-only bucket rests on "the branch keeps your commits". Here no
  // branch does: remove this and the commit survives only in the reflog. It is
  // clean, so every other check calls it safe.
  assert.equal(worktree.dirty, false);
  assert.equal(worktree.detached, true);
  assert.equal(worktree.unreachableCommits, 1);
  assert.equal(worktree.containedIn, null);
  assert.equal(worktree.tier, 'blocked');
});

test('a detached HEAD parked on an existing branch is still removable', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-parked');

  git(fixture.repo, ['worktree', 'add', '--detach', linked, 'main']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // Detached is not itself dangerous. Detached with nowhere else to find the
  // commits is. Blocking every detached HEAD would be the usual false alarm.
  assert.equal(worktree.unreachableCommits, 0);
  assert.equal(worktree.containedIn, 'main');
  assert.equal(worktree.retentionVerified, true);
  assert.equal(worktree.retentionSource, 'local-branch');
  assert.equal(worktree.tier, 'worktree-only');
});

test('detached unmerged history is measured at the detached commit, not its containing branch tip', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-before-main-advanced');
  git(fixture.repo, ['worktree', 'add', '--detach', linked, 'main']);

  fs.writeFileSync(path.join(fixture.repo, 'later-one.txt'), 'later one\n');
  git(fixture.repo, ['add', 'later-one.txt']);
  git(fixture.repo, ['commit', '-m', 'main advanced once']);
  fs.writeFileSync(path.join(fixture.repo, 'later-two.txt'), 'later two\n');
  git(fixture.repo, ['add', 'later-two.txt']);
  git(fixture.repo, ['commit', '-m', 'main advanced twice']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.containedIn, 'main');
  assert.equal(worktree.unmergedBase, 'origin/main');
  assert.equal(worktree.unmergedCommits, 0);
});

test('a remote-only detached commit is safe only while the live remote retains it', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-remote-only');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/remote-retention', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'remote-only.txt'), 'retained remotely\n');
  git(linked, ['add', 'remote-only.txt']);
  git(linked, ['commit', '-m', 'remote-only detached work']);
  git(linked, ['push', '-u', 'origin', 'feature/remote-retention']);
  git(linked, ['checkout', '--detach']);
  git(fixture.repo, ['branch', '-D', 'feature/remote-retention']);

  const retainedReport = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const retainedRepo = retainedReport.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const retained = retainedRepo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(retained.unreachableCommits, 0);
  assert.equal(retained.containedIn, 'origin/feature/remote-retention');
  assert.equal(retained.retentionVerified, true);
  assert.equal(retained.retentionSource, 'live-remote');
  assert.equal(retained.retentionRemote, 'origin');
  assert.equal(retained.retentionBranch, 'feature/remote-retention');
  assert.equal(retained.retentionRefHead, retained.headFull);
  assert.equal(retained.tier, 'worktree-only');

  const commandOutput = formatScanText(retainedReport, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-only',
    tableWidth: 200,
  });
  const guardedRemoval = commandOutput
    .split('\n')
    .find((line) => line.startsWith('test ') && line.includes(`worktree remove '${linked}'`));
  assert.ok(guardedRemoval);
  assert.match(guardedRemoval, /ls-remote --exit-code --heads 'origin' 'refs\/heads\/feature\/remote-retention'/);

  // Delete the remote ref without fetching, leaving the local remote-tracking
  // ref stale. A command produced by the earlier scan must recheck the live
  // ref and refuse before removing the checkout.
  git(fixture.remote, ['update-ref', '-d', 'refs/heads/feature/remote-retention']);
  const removal = spawnSync('/bin/sh', ['-c', guardedRemoval], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(removal.status, 0);
  assert.equal(fs.existsSync(linked), true);

  const staleReport = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const staleRepo = staleReport.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const stale = staleRepo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(stale.unreachableCommits, 0);
  assert.equal(stale.containedIn, null);
  assert.equal(stale.retentionVerified, false);
  assert.equal(stale.tier, 'inspection-error');
  assert.match(stale.inspectionErrors[0].message, /remote-tracking ref.*stale/);
});

test('detached removal preserves the commit if its remote ref vanishes after the live check', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-retention-race');
  const branch = 'feature/detached-retention-race';

  git(fixture.repo, ['worktree', 'add', '-b', branch, linked, 'main']);
  fs.writeFileSync(path.join(linked, 'remote-only.txt'), 'retained during race\n');
  git(linked, ['add', 'remote-only.txt']);
  git(linked, ['commit', '-m', 'detached retention race']);
  git(linked, ['push', '-u', 'origin', branch]);
  const expectedHead = git(linked, ['rev-parse', 'HEAD']).trim();
  git(linked, ['checkout', '--detach']);
  git(fixture.repo, ['branch', '-D', branch]);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const commandOutput = formatScanText(report, {
    buckets: true,
    commands: true,
    commandsTier: 'worktree-only',
    tableWidth: 220,
  });
  const guardedRemoval = commandOutput
    .split('\n')
    .find((line) => line.startsWith('test ') && line.includes(`worktree remove '${linked}'`));
  assert.ok(guardedRemoval);

  const wrapperDirectory = makeTemporaryDirectory('git-groundskeeper-git-wrapper-');
  const wrapper = path.join(wrapperDirectory, 'git');
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const realGit = process.env.GROUNDSKEEPER_REAL_GIT;
const result = spawnSync(realGit, args, { encoding: null });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status === 0 && args.includes('ls-remote')) {
  const deletion = spawnSync(realGit, [
    '-C',
    process.env.GROUNDSKEEPER_RACE_REMOTE,
    'update-ref',
    '-d',
    process.env.GROUNDSKEEPER_RACE_REF,
  ]);
  if (deletion.status !== 0) process.exit(deletion.status ?? 1);
}
process.exit(result.status ?? 1);
`);
  fs.chmodSync(wrapper, 0o755);

  // The wrapper lets ls-remote return the verified tip, deletes that remote
  // ref before the next shell command starts, and then delegates normally.
  // Removal must still preserve the scanned commit under a visible local
  // safety branch.
  const removal = spawnSync('/bin/sh', ['-c', guardedRemoval], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH}`,
      GROUNDSKEEPER_REAL_GIT: findGitExecutable(),
      GROUNDSKEEPER_RACE_REMOTE: fixture.remote,
      GROUNDSKEEPER_RACE_REF: `refs/heads/${branch}`,
    },
  });
  assert.equal(removal.status, 0, removal.stderr);
  assert.equal(fs.existsSync(linked), false);

  const safetyRef = `refs/heads/git-groundskeeper/retained-detached/${expectedHead}`;
  assert.equal(git(fixture.repo, ['rev-parse', '--verify', safetyRef]).trim(), expectedHead);
  const remoteRef = spawnSync('git', ['show-ref', '--verify', `refs/heads/${branch}`], {
    cwd: fixture.remote,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(remoteRef.status, 0);
});

test('a local tag is durable retention for a detached checkout', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-tagged');

  git(fixture.repo, ['worktree', 'add', '--detach', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'tagged.txt'), 'tagged work\n');
  git(linked, ['add', 'tagged.txt']);
  git(linked, ['commit', '-m', 'tagged detached work']);
  const head = git(linked, ['rev-parse', 'HEAD']).trim();
  git(fixture.repo, ['tag', 'saved-detached', head]);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.unreachableCommits, 0);
  assert.equal(worktree.containedIn, 'saved-detached');
  assert.equal(worktree.retentionVerified, true);
  assert.equal(worktree.retentionSource, 'local-tag');
  assert.equal(worktree.tier, 'worktree-only');
});

test('unknown detached reachability is an inspection error, never zero', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'detached-unknown');
  git(fixture.repo, ['worktree', 'add', '--detach', linked, 'main']);

  const report = await scanRoots([fixture.parent], {
    maxDepth: 4,
    inspectDetachedRetention: async () => ({
      unreachableCommits: null,
      containedIn: null,
      retentionVerified: null,
      retentionSource: null,
      errors: ['injected reachability failure'],
    }),
  });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.unreachableCommits, null);
  assert.equal(worktree.retentionVerified, null);
  assert.equal(worktree.tier, 'inspection-error');
  assert.deepEqual(worktree.inspectionErrors, [
    { probe: 'detached-retention', message: 'injected reachability failure' },
  ]);
});

test('a locked worktree is never proposed for removal', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'locked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/locked', linked, 'main']);
  git(fixture.repo, ['worktree', 'lock', linked]);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // Locking a worktree is git's own way of saying "do not reap this".
  assert.equal(worktree.locked, true);
  assert.equal(worktree.tier, 'blocked');
});

test('copied paths sharing one worktree git dir are both blocked as aliases', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'registered-worktree');
  const copied = path.join(fixture.parent, 'copied-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/aliased', linked, 'main']);
  fs.cpSync(linked, copied, { recursive: true });

  const report = await scanRoots([fixture.parent], { maxDepth: 4, buckets: true });
  const repo = report.repos.find((candidate) =>
    candidate.worktrees.some((worktree) => worktree.path === linked),
  );
  const registered = repo.worktrees.find((worktree) => worktree.path === linked);
  const alias = repo.worktrees.find((worktree) => worktree.path === copied);

  assert.ok(registered);
  assert.ok(alias);
  assert.equal(registered.worktreeGitDir, alias.worktreeGitDir);
  assert.deepEqual(registered.aliasedWorktreePaths, [copied]);
  assert.deepEqual(alias.aliasedWorktreePaths, [linked]);
  assert.equal(registered.tier, 'aliased');
  assert.equal(alias.tier, 'aliased');
  assert.equal(repo.status, 'aliased-worktree');
  assert.equal(report.summary.aliasedWorktreeCount, 2);
});

test('scanRoots detects squash-merged branches that share no history with the base', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'squashed-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/squashed', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'one.txt'), 'one\n');
  git(linked, ['add', 'one.txt']);
  git(linked, ['commit', '-m', 'first half']);
  fs.writeFileSync(path.join(linked, 'two.txt'), 'two\n');
  git(linked, ['add', 'two.txt']);
  git(linked, ['commit', '-m', 'second half']);

  git(linked, ['push', '-u', 'origin', 'feature/squashed']);

  // Exactly what GitHub's "Squash and merge" does: collapse the branch into one
  // new commit on main that shares no ancestry with it, then drop the remote
  // branch. The work is fully merged; the history says otherwise.
  git(fixture.repo, ['merge', '--squash', 'feature/squashed']);
  git(fixture.repo, ['commit', '-m', 'squashed feature (#1)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/squashed']);
  git(linked, ['fetch', '--prune', 'origin']);

  // Ancestry genuinely cannot see this, which is the whole problem.
  assert.throws(() => git(linked, ['merge-base', '--is-ancestor', 'feature/squashed', 'origin/main']));

  const report = await scanRoots([linked], { maxDepth: 1, buckets: true });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedVia, 'squash');
  assert.equal(worktree.mergedInto, 'origin/main');
  // Safety evidence and ancestry are different facts. The squash proof makes
  // retirement safe but must not rewrite two absent commits to zero.
  assert.equal(worktree.unmergedCommits, 2);
  // Proving the merge does not make `git branch -d` accept it: -d consults
  // ancestry, which is exactly what a squash destroys. This is what tells the
  // reader they will need -D here and nowhere else.
  assert.equal(worktree.ancestryVisible, false);
});

test('a merged branch with no worktree is still found, which is what a prune leaves behind', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'temporary');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/left-behind', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'work.txt'), 'work\n');
  git(linked, ['add', 'work.txt']);
  git(linked, ['commit', '-m', 'the work']);
  git(linked, ['push', '-u', 'origin', 'feature/left-behind']);
  git(fixture.repo, ['merge', '--squash', 'feature/left-behind']);
  git(fixture.repo, ['commit', '-m', 'squashed (#7)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/left-behind']);
  git(fixture.repo, ['fetch', '--prune', 'origin']);

  // Exactly what a cleanup pass produces: the worktree is gone, the branch is
  // not. Scoping candidate detection to worktrees made these invisible the
  // moment they became the only thing left to clean up.
  git(fixture.repo, ['worktree', 'remove', linked]);

  const report = await scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/left-behind');

  assert.ok(branch, 'the branch outlived its worktree and must still be examined');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
  assert.equal(branch.mergedVia, 'squash');
  assert.equal(branch.ancestryVisible, false);
});

test('squash detection can be disabled to keep the scan strictly read-only', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'squashed-optout');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/optout', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'thing.txt'), 'thing\n');
  git(linked, ['add', 'thing.txt']);
  git(linked, ['commit', '-m', 'work']);
  git(linked, ['push', '-u', 'origin', 'feature/optout']);
  git(fixture.repo, ['merge', '--squash', 'feature/optout']);
  git(fixture.repo, ['commit', '-m', 'squashed (#2)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/optout']);
  git(linked, ['fetch', '--prune', 'origin']);

  const report = await scanRoots([linked], { maxDepth: 1, squashDetect: false });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.cleanupStatus, null);
});

test('scanRoots reports nested submodule folders instead of Git storage paths', async () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'linked-with-submodule');
  const nestedAdmin = path.join(linked, 'admin');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/submodule', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = await scanRoots([linked], { maxDepth: 2 });
  const primaryPaths = report.repos.map((repo) => repo.primaryPath);
  const nestedRepo = report.repos.find((repo) => repo.primaryPath === nestedAdmin);

  assert.equal(primaryPaths.some((primaryPath) => primaryPath.includes(`${path.sep}.git${path.sep}`)), false);
  assert.ok(nestedRepo, primaryPaths.join('\n'));
  assert.equal(nestedRepo.worktrees.some((worktree) => worktree.path === nestedAdmin), true);
});

test('defaultRoots discovers from the home directory so no layout knowledge is needed', async () => {
  assert.deepEqual(defaultRoots(), [os.homedir()]);
});

test('scanner source remains ordinary text without literal NUL bytes', () => {
  const source = fs.readFileSync(new URL('../src/scanner.js', import.meta.url));
  assert.equal(source.includes(0), false);
});

test('size scans measure primary, dirty, and clean worktrees independently of cleanup state', async () => {
  const fixture = createFixture();
  const clean = path.join(fixture.parent, 'clean-sized');
  const dirty = path.join(fixture.parent, 'dirty-unsized');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/clean-sized', clean, 'main']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/dirty-unsized', dirty, 'main']);
  fs.writeFileSync(path.join(dirty, 'dirty.txt'), 'dirty\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, sizes: true });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const primary = repo.worktrees.find((worktree) => worktree.path === fixture.repo);
  const cleanWorktree = repo.worktrees.find((worktree) => worktree.path === clean);
  const dirtyWorktree = repo.worktrees.find((worktree) => worktree.path === dirty);

  assert.equal(Number.isInteger(primary.bytes), true);
  assert.equal(Number.isInteger(dirtyWorktree.bytes), true);
  assert.equal(Number.isInteger(cleanWorktree.bytes), true);
});

test('discoverWorktrees prunes home-level noise but keeps real project roots', async () => {
  const parent = makeTemporaryDirectory('git-groundskeeper-noise-');
  const cachedRepo = path.join(parent, 'Library', 'Caches', 'vendor');
  const projectRepo = path.join(parent, 'code', 'app');

  fs.mkdirSync(path.dirname(cachedRepo), { recursive: true });
  fs.mkdirSync(path.dirname(projectRepo), { recursive: true });
  createStandaloneRepo(cachedRepo);
  createStandaloneRepo(projectRepo);

  const found = discoverWorktrees([parent], { maxDepth: 6 });

  assert.equal(found.includes(projectRepo), true);
  assert.equal(found.includes(cachedRepo), false);
});

test('discovery skips suffixed Xcode and SwiftPM dependency checkouts', async () => {
  const parent = makeTemporaryDirectory('git-groundskeeper-tool-caches-');
  const projectRepo = path.join(parent, 'code', 'app');
  const xcodeCheckout = path.join(parent, 'code', '.derivedData-3i', 'SourcePackages', 'checkouts', 'dependency');
  const swiftCheckout = path.join(parent, 'code', '.build', 'checkouts', 'dependency');

  fs.mkdirSync(path.dirname(projectRepo), { recursive: true });
  fs.mkdirSync(path.dirname(xcodeCheckout), { recursive: true });
  fs.mkdirSync(path.dirname(swiftCheckout), { recursive: true });
  createStandaloneRepo(projectRepo);
  createStandaloneRepo(xcodeCheckout);
  createStandaloneRepo(swiftCheckout);

  const synchronous = discoverWorktrees([parent], { maxDepth: 8 });
  const cooperative = await discoverWorktreesAsync([parent], {
    maxDepth: 8,
    discoveryYieldEvery: 1,
  });

  for (const found of [synchronous, cooperative]) {
    assert.equal(found.includes(projectRepo), true);
    assert.equal(found.includes(xcodeCheckout), false);
    assert.equal(found.includes(swiftCheckout), false);
  }
});

test('cooperative discovery yields and reports monotonic forest growth', async () => {
  const fixture = createFixture();
  const events = [];
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);

  const discovered = await discoverWorktreesAsync([fixture.parent], {
    maxDepth: 4,
    discoveryYieldEvery: 1,
    onProgress: (event) => events.push(event),
  });

  assert.equal(timerFired, true, 'discovery blocked the event loop until completion');
  assert.ok(discovered.includes(fixture.repo));
  assert.ok(events.length > 1);
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].visitedDirectories >= events[index - 1].visitedDirectories);
    assert.ok(events[index].discoveredRepositories >= events[index - 1].discoveredRepositories);
  }
  assert.ok(events.at(-1).discoveredRepositories >= 1);
});

test('cooperative discovery still yields across rejected depth-boundary candidates', async () => {
  const root = makeTemporaryDirectory('git-groundskeeper-wide-');
  for (let index = 0; index < 40; index += 1) {
    fs.mkdirSync(path.join(root, `child-${index}`));
  }
  let yieldCount = 0;

  await discoverWorktreesAsync([root], {
    maxDepth: 0,
    discoveryYieldEvery: 8,
    discoveryYield: async () => { yieldCount += 1; },
  });

  assert.ok(yieldCount >= 5, `only yielded ${yieldCount} times across rejected candidates`);
});

test('scanRoots attributes agent worktrees in hidden home directories to their repo', async () => {
  const fixture = createFixture();
  const agentWorktree = path.join(fixture.parent, '.codex', 'worktrees', '2e34', 'app');

  fs.mkdirSync(path.dirname(agentWorktree), { recursive: true });
  git(fixture.repo, ['worktree', 'add', '-b', 'agent/task', agentWorktree]);

  const report = await scanRoots([fixture.parent], { maxDepth: 6 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === agentWorktree), true);
});

test('large files hidden inside untracked directories are still weighed', async () => {
  const fixture = createFixture();
  const buildDir = path.join(fixture.repo, 'build-output');

  fs.mkdirSync(buildDir);
  fs.writeFileSync(path.join(buildDir, 'artifact.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(buildDir, 'small.txt'), 'small\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === fixture.repo);

  // The default sweep never looks inside untracked directories, so finding this
  // proves the deep second pass ran for a worktree that needed it.
  assert.equal(worktree.largeFiles.some((file) => file.path === 'build-output/artifact.bin'), true);
  // ...and the summary still reports one untracked directory, not its contents.
  assert.equal(worktree.status.untracked, 1);
});

test('parseRemoteOwner handles every remote URL shape', async () => {
  assert.equal(parseRemoteOwner('git@github.com:huntereastman/git-groundskeeper.git'), 'huntereastman');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus.git'), 'numbus-llc');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus'), 'numbus-llc');
  assert.equal(parseRemoteOwner('ssh://git@gitlab.com/group/thing.git'), 'group');
  assert.equal(parseRemoteOwner('https://user@dev.azure.com/org/project'), 'org');
  // Local path remotes have no owner, and must not be mistaken for one.
  assert.equal(parseRemoteOwner('/tmp/fixtures/remote.git'), null);
  assert.equal(parseRemoteOwner('../sibling/remote.git'), null);
});

test('parseRemoteRepository preserves the owner/repository identity', () => {
  assert.equal(parseRemoteRepository('git@github.com:huntereastman/git-groundskeeper.git'), 'huntereastman/git-groundskeeper');
  assert.equal(parseRemoteRepository('https://github.com/numbus-llc/numbus.git'), 'numbus-llc/numbus');
  assert.equal(parseRemoteRepository('ssh://git@gitlab.com/group/thing.git'), 'group/thing');
  assert.equal(parseRemoteRepository('/tmp/fixtures/remote.git'), null);
});

test('classifyOwnership separates my repos from everything else on the disk', async () => {
  assert.equal(classifyOwnership(['huntereastman'], ['huntereastman', 'numbus-llc']), 'mine');
  // Owner matching is case-insensitive: Git remotes are not consistent here.
  assert.equal(classifyOwnership(['NumBus-LLC'], ['numbus-llc']), 'mine');
  assert.equal(classifyOwnership(['some-vendor'], ['huntereastman']), 'external');
  assert.equal(classifyOwnership([], ['huntereastman']), 'no-remote');
  // With no owners declared the tool must not guess, or it would silently
  // hide repositories it merely failed to recognise.
  assert.equal(classifyOwnership(['huntereastman'], []), 'unknown');
});

test('scanRoots tags repo ownership from its remote', async () => {
  const fixture = createFixture();
  git(fixture.repo, ['remote', 'set-url', 'origin', 'https://github.com/huntereastman/app.git']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, owners: ['huntereastman'] });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.deepEqual(repo.owners, ['huntereastman']);
  assert.equal(repo.ownership, 'mine');
});

function createFixture() {
  const parent = makeTemporaryDirectory('git-groundskeeper-');
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');

  createStandaloneRepo(repo);

  git(parent, ['clone', '--bare', repo, remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);

  return { parent, repo, remote };
}

function makeTemporaryDirectory(prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.add(directory);
  return directory;
}

function createStandaloneRepo(repo) {
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function findGitExecutable() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory || '.', 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error('git executable not found on PATH');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
