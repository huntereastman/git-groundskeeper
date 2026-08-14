import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyReclaimReport, scanReclaimRoots } from '../src/reclaim.js';
import { extractFlutterWorkflowVersions } from '../src/runner-cache.js';

test('runner provider inventories every tool cache and expires only superseded Flutter versions', async (t) => {
  const fixture = createRunnerFixture(t);
  const report = await scanReclaimRoots([fixture.runner], runnerOptions(fixture));

  assert.equal(report.tool, 'runner');
  assert.equal(report.summary.candidateCount, 1);
  assert.equal(report.summary.retainedCount, 1);
  assert.equal(report.runnerInventory[0].tools.find((tool) => tool.tool === 'node').versions[0].name, '20.20.2');
  assert.equal(report.projects.find((project) => project.cacheVersion === '3.44.2').status, 'candidate');
  assert.equal(report.projects.find((project) => project.cacheVersion === '3.47.0').status, 'retained');
  assert.equal(fs.existsSync(fixture.oldCache), true);

  const applied = await applyReclaimReport(report, runnerOptions(fixture, {
    apply: true,
    yes: true,
    explicitRoots: true,
  }));
  assert.equal(applied.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(fixture.oldCache), false);
  assert.equal(fs.existsSync(fixture.currentCache), true);
});

test('runner provider holds every cache version when workflow configuration is dynamic or stable', async (t) => {
  const fixture = createRunnerFixture(t, { flutterVersion: 'stable' });
  const report = await scanReclaimRoots([fixture.runner], runnerOptions(fixture));

  assert.equal(report.summary.candidateCount, 0);
  assert.equal(report.projects.every((project) => project.status === 'blocked'), true);
  assert.match(report.projects[0].blockedReasons.join('\n'), /not an explicit version/);
  assert.equal(fs.existsSync(fixture.oldCache), true);
});

test('runner provider blocks deletion while a Runner.Worker process is active', async (t) => {
  const fixture = createRunnerFixture(t);
  const report = await scanReclaimRoots([fixture.runner], runnerOptions(fixture, {
    runnerProcessProbe: async () => ({
      ok: true,
      active: true,
      processes: ['123 Runner.Worker'],
      error: null,
    }),
  }));

  assert.equal(report.summary.candidateCount, 0);
  assert.match(report.projects[0].blockedReasons.join('\n'), /active Runner\.Worker/);
});

test('workflow parser resolves an explicit shared environment version and rejects stable drift', () => {
  const explicit = extractFlutterWorkflowVersions(`
env:
  FLUTTER_VERSION: 3.47.0
jobs:
  build:
    steps:
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          flutter-version: \${{ env.FLUTTER_VERSION }}
`, 'ci.yml');
  const drift = extractFlutterWorkflowVersions(`
jobs:
  build:
    steps:
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: stable
`, 'ci.yml');

  assert.deepEqual(explicit.versions, ['3.47.0']);
  assert.deepEqual(explicit.unresolved, []);
  assert.deepEqual(drift.versions, []);
  assert.match(drift.unresolved[0], /not an explicit version/);
});

function createRunnerFixture(t, options = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-runner-cache-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const workflows = path.join(parent, 'workflows');
  fs.mkdirSync(path.join(workflows, '.github', 'workflows'), { recursive: true });
  git(workflows, ['init', '-b', 'main']);
  git(workflows, ['config', 'user.email', 'groundskeeper@example.com']);
  git(workflows, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(workflows, '.github', 'workflows', 'ci.yml'), `
env:
  FLUTTER_VERSION: ${options.flutterVersion ?? '3.47.0'}
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          flutter-version: \${{ env.FLUTTER_VERSION }}
`);
  git(workflows, ['add', '.github/workflows/ci.yml']);
  git(workflows, ['commit', '-m', 'add workflow']);

  const runner = path.join(parent, 'runner');
  const flutterCache = path.join(runner, '_work', '_tool', 'flutter');
  const oldCache = path.join(flutterCache, 'stable-3.44.2-arm64');
  const currentCache = path.join(flutterCache, 'stable-3.47.0-arm64');
  fs.mkdirSync(oldCache, { recursive: true });
  fs.mkdirSync(currentCache, { recursive: true });
  fs.mkdirSync(path.join(runner, '_work', '_tool', 'node', '20.20.2'), { recursive: true });
  fs.writeFileSync(path.join(runner, '.runner'), '{"agentId": 1}\n');
  fs.writeFileSync(path.join(oldCache, 'sdk.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(currentCache, 'sdk.bin'), Buffer.alloc(4096, 2));
  return { runner, workflows, oldCache, currentCache };
}

function runnerOptions(fixture, overrides = {}) {
  return {
    tool: 'runner',
    workflowRoots: [fixture.workflows],
    minAgeMinutes: 0,
    explicitRoots: true,
    runnerProcessProbe: async () => ({ ok: true, active: false, processes: [], error: null }),
    ...overrides,
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
