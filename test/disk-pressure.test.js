import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanDiskPressure } from '../src/disk-pressure.js';

test('disk-pressure reports and then reclaims eligible linked-worktree caches only with explicit apply', async (t) => {
  const fixture = createLinkedXcodeFixture(t);
  const options = pressureOptions();
  const report = await scanDiskPressure([fixture.parent], options);

  assert.equal(report.pressureDetected, true);
  assert.equal(report.apply, false);
  assert.equal(report.reclaim.summary.candidateCount, 1);
  assert.equal(fs.existsSync(fixture.derivedData), true);

  const applied = await scanDiskPressure([fixture.parent], {
    ...options,
    apply: true,
    yes: true,
    explicitRoots: true,
  });
  assert.equal(applied.result, 'pressure-cleanup-applied');
  assert.equal(applied.reclaim.summary.cleanedCount, 1);
  assert.equal(fs.existsSync(fixture.derivedData), false);
});

test('disk-pressure never cleans when the measured filesystem meets the threshold', async (t) => {
  const fixture = createLinkedXcodeFixture(t);
  const report = await scanDiskPressure([fixture.parent], {
    ...pressureOptions(),
    minFreeBytes: 1,
    apply: true,
    yes: true,
    explicitRoots: true,
  });

  assert.equal(report.pressureDetected, false);
  assert.equal(report.result, 'threshold-met-no-cleanup-run');
  assert.equal(fs.existsSync(fixture.derivedData), true);
});

function pressureOptions() {
  return {
    minFreeBytes: 2048,
    minAgeMinutes: 0,
    filesystemSpaceProbe: async () => ({ ok: true, availableBytes: 1024, error: null }),
    activeProcessProbe: async () => ({ ok: true, active: false, processes: [], error: null }),
  };
}

function createLinkedXcodeFixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-disk-pressure-')));
  const primary = path.join(parent, 'primary');
  const linked = path.join(parent, 'linked');
  fs.mkdirSync(primary);
  git(primary, ['init', '-b', 'main']);
  git(primary, ['config', 'user.email', 'groundskeeper@example.com']);
  git(primary, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(primary, 'project.yml'), 'name: fixture\n');
  fs.writeFileSync(path.join(primary, '.gitignore'), 'DerivedData/\n');
  git(primary, ['add', 'project.yml', '.gitignore']);
  git(primary, ['commit', '-m', 'initial fixture']);
  git(primary, ['worktree', 'add', '-b', 'feature', linked]);
  const derivedData = path.join(linked, 'DerivedData');
  fs.mkdirSync(derivedData);
  fs.writeFileSync(path.join(derivedData, 'artifact.bin'), Buffer.alloc(4096, 3));
  t.after(() => {
    try { git(primary, ['worktree', 'remove', '--force', linked]); } catch {}
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, primary, linked, derivedData };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
