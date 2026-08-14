import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { terminalCellWidth } from '../src/format.js';
import { stripAnsi } from '../src/progress.js';
import { execFileSync, spawnSync } from 'node:child_process';

const binPath = path.resolve('bin/git-groundskeeper.js');

test('scan exits 0 when attention is found by default', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
  assert.match(result.stdout, /Worktree summaries \(1 needing attention \/ 1 in scope\)/);
  assert.match(result.stdout, /\| Worktree\s+\| Branch\s+\| Needs\s+\| Remote\s+\|/);
  assert.equal(result.stderr, '');
});

test('scan exits 1 for attention when fail-on-attention is requested', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--fail-on-attention']);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Worktree summaries \(1 needing attention \/ 1 in scope\)/);
});

test('forced progress renders scan phases on stderr without altering stdout', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--progress']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolving repositories/);
  assert.match(result.stderr, /Scanning worktrees/);
  assert.match(result.stderr, /Analyzing repositories/);
  assert.match(result.stderr, /OK FOREST MAPPED/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.doesNotMatch(result.stdout, /Scanning worktrees/);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
});

test('progress on stderr keeps forced JSON output machine-readable', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--json', '--progress', '--color=always']);

  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.match(result.stderr, /Scanning worktrees/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
});

test('3D progress implies progress and falls back cleanly when stderr is piped', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--3d-progress']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolving repositories/);
  assert.match(result.stderr, /Scanning worktrees/);
  assert.match(result.stderr, /Analyzing repositories/);
  assert.match(result.stderr, /OK FOREST MAPPED/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.doesNotMatch(result.stdout, /Scanning worktrees/);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
});

test('Signal Garden implies progress and falls back cleanly when stderr is piped', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--signal-progress']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolving repositories/);
  assert.match(result.stderr, /Scanning worktrees/);
  assert.match(result.stderr, /Analyzing repositories/);
  assert.match(result.stderr, /OK FOREST MAPPED/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.doesNotMatch(result.stdout, /Scanning worktrees/);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
});

test('Pulse Observatory implies progress and falls back cleanly when stderr is piped', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--pulse-progress']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolving repositories/);
  assert.match(result.stderr, /Scanning worktrees/);
  assert.match(result.stderr, /Analyzing repositories/);
  assert.match(result.stderr, /OK FOREST MAPPED/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.doesNotMatch(result.stdout, /Scanning worktrees/);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
});

test('Centre Wave implies progress and falls back cleanly when stderr is piped', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--wave-progress']);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Resolving repositories/);
  assert.match(result.stderr, /Scanning worktrees/);
  assert.match(result.stderr, /Analyzing repositories/);
  assert.match(result.stderr, /OK FOREST MAPPED/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
  assert.doesNotMatch(result.stdout, /Scanning worktrees/);
  assert.match(result.stdout, /Git Groundskeeper Compact/);
});

test('help describes the full-terminal 3D progress mode', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--3d-progress/);
  assert.match(result.stdout, /available TTY width and/);
  assert.match(result.stdout, /Implies --progress/);
});

test('help describes the full-terminal Signal Garden mode', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--signal-progress/);
  assert.match(result.stdout, /cell scans, waves, registers, and vector/);
  assert.match(result.stdout, /driven by phase-local progress/);
});

test('help describes the full-terminal Pulse Observatory mode', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--pulse-progress/);
  assert.match(result.stdout, /live ECG/);
  assert.match(result.stdout, /truthful phase-progress gate/);
});

test('help describes the full-terminal Centre Wave mode', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--wave-progress/);
  assert.match(result.stdout, /phase-offset ASCII/);
  assert.match(result.stdout, /truthful progress gate/);
});

test('Keeps details preserve the selected report layout', (t) => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--keeps-details/);
  assert.match(help.stdout, /repository-scoped rule/);
  assert.match(help.stdout, /selected report layout/);
  assert.match(help.stdout, /never suppresses content/);
  const keepsHelp = help.stdout.slice(
    help.stdout.indexOf('--keeps-details'),
    help.stdout.indexOf('--commands'),
  );
  assert.doesNotMatch(keepsHelp, /Implies --buckets/);

  const repo = createDirtyRepo(t);
  const compact = runCli(['scan', repo, '--keeps-details', '--no-progress']);
  assert.equal(compact.status, 0);
  assert.match(compact.stdout, /Git Groundskeeper Compact/);
  assert.match(compact.stdout, /Worktree summaries/);
  assert.doesNotMatch(compact.stdout, /primary checkout/);

  const detailed = runCli([
    'scan',
    repo,
    '--details',
    '--keeps-details',
    '--no-progress',
  ]);
  assert.equal(detailed.status, 0);
  assert.match(detailed.stdout, /^Git Groundskeeper\n/);
  assert.match(detailed.stdout, /worktree /);
  assert.doesNotMatch(detailed.stdout, /Git Groundskeeper Compact/);
  assert.doesNotMatch(detailed.stdout, /primary checkout/);
});

test('3D progress keeps JSON parseable and its piped fallback escape-free', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--json', '--3d-progress', '--color=always']);

  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.match(result.stderr, /Scanning worktrees/);
  assert.doesNotMatch(result.stderr, /\u001b\[/);
});

test('a later --no-progress disables 3D progress', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--3d-progress', '--no-progress']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('a later --no-progress disables Signal Garden', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--signal-progress', '--no-progress']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('a later --no-progress disables Pulse Observatory', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--pulse-progress', '--no-progress']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('a later --no-progress disables Centre Wave', (t) => {
  const repo = createDirtyRepo(t);
  const result = runCli(['scan', repo, '--wave-progress', '--no-progress']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('3D handoff keeps a Warp-safe gutter in narrow and wide TTYs', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/expect')) {
    t.skip('macOS pseudo-TTY regression');
    return;
  }

  const repo = createDirtyRepo(t);
  for (const columns of [80, 200]) {
    const command = [
      process.execPath,
      binPath,
      'scan',
      repo,
      '--buckets',
      '--sizes',
      '--3d-progress',
      '--no-detect-owners',
      '--all',
      '--no-live-remote-check',
      '--no-squash-detect',
    ].map(shellQuote).join(' ');
    const expectScript = [
      'set timeout 30',
      `spawn -noecho /bin/zsh -c {stty columns ${columns} rows 24; exec ${command} 2>&1}`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const leaveAlternateScreen = '\u001b[?1049l';
    const handoff = result.stdout.lastIndexOf(leaveAlternateScreen);
    assert.ok(handoff >= 0, '3D progress never left the alternate screen');
    const reportOutput = result.stdout.slice(handoff + leaveAlternateScreen.length);
    assert.match(stripAnsi(reportOutput), /Git Groundskeeper Compact/);

    const safeWidth = columns - 4;
    for (const rawLine of reportOutput.split('\n')) {
      const line = stripAnsi(rawLine.replace(/\r/g, ''));
      const width = terminalCellWidth(line);
      assert.ok(
        width <= safeWidth,
        `${columns}-column post-3D report overflowed (${width} > ${safeWidth}): ${line}`,
      );
    }
  }
});

test('Signal Garden handoff keeps a Warp-safe gutter in narrow and wide TTYs', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/expect')) {
    t.skip('macOS pseudo-TTY regression');
    return;
  }

  const repo = createDirtyRepo(t);
  for (const columns of [80, 200]) {
    const command = [
      process.execPath,
      binPath,
      'scan',
      repo,
      '--buckets',
      '--sizes',
      '--signal-progress',
      '--no-detect-owners',
      '--all',
      '--no-live-remote-check',
      '--no-squash-detect',
    ].map(shellQuote).join(' ');
    const expectScript = [
      'set timeout 30',
      `spawn -noecho /bin/zsh -c {stty columns ${columns} rows 24; exec ${command} 2>&1}`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const leaveAlternateScreen = '\u001b[?1049l';
    const handoff = result.stdout.lastIndexOf(leaveAlternateScreen);
    assert.ok(handoff >= 0, 'Signal Garden never left the alternate screen');
    assert.match(stripAnsi(result.stdout.slice(0, handoff)), /SIGNAL GARDEN/);
    const reportOutput = result.stdout.slice(handoff + leaveAlternateScreen.length);
    assert.match(stripAnsi(reportOutput), /Git Groundskeeper Compact/);

    const safeWidth = columns - 4;
    for (const rawLine of reportOutput.split('\n')) {
      const line = stripAnsi(rawLine.replace(/\r/g, ''));
      const width = terminalCellWidth(line);
      assert.ok(
        width <= safeWidth,
        `${columns}-column post-signal report overflowed (${width} > ${safeWidth}): ${line}`,
      );
    }
  }
});

test('Pulse Observatory handoff keeps a Warp-safe gutter in narrow and wide TTYs', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/expect')) {
    t.skip('macOS pseudo-TTY regression');
    return;
  }

  const repo = createDirtyRepo(t);
  for (const columns of [80, 200]) {
    const command = [
      process.execPath,
      binPath,
      'scan',
      repo,
      '--buckets',
      '--sizes',
      '--pulse-progress',
      '--no-detect-owners',
      '--all',
      '--no-live-remote-check',
      '--no-squash-detect',
    ].map(shellQuote).join(' ');
    const expectScript = [
      'set timeout 30',
      `spawn -noecho /bin/zsh -c {stty columns ${columns} rows 24; exec ${command} 2>&1}`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const leaveAlternateScreen = '\u001b[?1049l';
    const handoff = result.stdout.lastIndexOf(leaveAlternateScreen);
    assert.ok(handoff >= 0, 'Pulse Observatory never left the alternate screen');
    assert.match(stripAnsi(result.stdout.slice(0, handoff)), /PULSE OBSERVATORY/);
    const reportOutput = result.stdout.slice(handoff + leaveAlternateScreen.length);
    assert.match(stripAnsi(reportOutput), /Git Groundskeeper Compact/);

    const safeWidth = columns - 4;
    for (const rawLine of reportOutput.split('\n')) {
      const line = stripAnsi(rawLine.replace(/\r/g, ''));
      const width = terminalCellWidth(line);
      assert.ok(
        width <= safeWidth,
        `${columns}-column post-pulse report overflowed (${width} > ${safeWidth}): ${line}`,
      );
    }
  }
});

test('Centre Wave handoff keeps a Warp-safe gutter in narrow and wide TTYs', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/expect')) {
    t.skip('macOS pseudo-TTY regression');
    return;
  }

  const repo = createDirtyRepo(t);
  for (const columns of [80, 200]) {
    const command = [
      process.execPath,
      binPath,
      'scan',
      repo,
      '--buckets',
      '--sizes',
      '--wave-progress',
      '--no-detect-owners',
      '--all',
      '--no-live-remote-check',
      '--no-squash-detect',
    ].map(shellQuote).join(' ');
    const expectScript = [
      'set timeout 30',
      `spawn -noecho /bin/zsh -c {stty columns ${columns} rows 24; exec ${command} 2>&1}`,
      'expect eof',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('\n');
    const result = spawnSync('/usr/bin/expect', ['-c', expectScript], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color' },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const leaveAlternateScreen = '\u001b[?1049l';
    const handoff = result.stdout.lastIndexOf(leaveAlternateScreen);
    assert.ok(handoff >= 0, 'Centre Wave never left the alternate screen');
    assert.match(stripAnsi(result.stdout.slice(0, handoff)), /CENTRE WAVE/);
    const reportOutput = result.stdout.slice(handoff + leaveAlternateScreen.length);
    assert.match(stripAnsi(reportOutput), /Git Groundskeeper Compact/);

    const safeWidth = columns - 4;
    for (const rawLine of reportOutput.split('\n')) {
      const line = stripAnsi(rawLine.replace(/\r/g, ''));
      const width = terminalCellWidth(line);
      assert.ok(
        width <= safeWidth,
        `${columns}-column post-wave report overflowed (${width} > ${safeWidth}): ${line}`,
      );
    }
  }
});

function createDirtyRepo(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-cli-')));
  t.after(() => fs.rmSync(parent, { force: true, recursive: true }));
  const repo = path.join(parent, 'repo');

  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');

  return repo;
}

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}
