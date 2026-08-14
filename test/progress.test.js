import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { renderSpatialScene } from '../src/progress-3d.js';
import { renderPulseScene } from '../src/progress-pulse.js';
import { renderSignalScene } from '../src/progress-signal.js';
import { renderWaveScene } from '../src/progress-wave.js';
import {
  createProgressReporter,
  createProgressState,
  reduceProgressEvent,
  render3DProgressFrame,
  renderPulseProgressFrame,
  renderProgressFrame,
  renderSignalProgressFrame,
  renderWaveProgressFrame,
  stripAnsi,
} from '../src/progress.js';

test('the full dashboard renders a truthful deep-forest command center', () => {
  const state = sampleState();
  const frame = renderProgressFrame(state, {
    columns: 101,
    rows: 30,
    now: 12_000,
    color: false,
    unicode: true,
  });

  assert.match(frame, /GIT GROUNDSKEEPER \/\/ DEEP FOREST TELEMETRY/);
  assert.match(frame, /◆ CANOPY ━ ◆ MAP ━ ◆ CLAIMS ━ ◉ TREES ━ ◇ VERDICT/);
  assert.match(frame, /SCANNING WORKTREES/);
  assert.match(frame, /67 \/ 139  48\.2%/);
  assert.match(frame, /RATE 13\.4 trees\/s/);
  assert.match(frame, /LEAVE NO BRANCH BEHIND/);
  assert.equal(frame.split('\n').length, 9);
  assertLinesFit(frame, 101);
});

test('the dashboard adapts from full telemetry to a single narrow line', () => {
  const state = sampleState();

  for (const [columns, rows, expectedLines] of [
    [121, 30, 9],
    [80, 30, 6],
    [52, 30, 1],
    [25, 4, 1],
    [12, 4, 1],
  ]) {
    const frame = renderProgressFrame(state, {
      columns,
      rows,
      now: 12_000,
      color: false,
      unicode: true,
    });
    assert.equal(frame.split('\n').length, expectedLines, `${columns} columns`);
    assert.equal(frame.includes('\u001b['), false, `${columns} columns leaked ANSI`);
    assertLinesFit(frame, columns);
  }
});

test('ANSI color does not change layout width', () => {
  const frame = renderProgressFrame(sampleState(), {
    columns: 101,
    rows: 30,
    now: 12_000,
    color: true,
    unicode: true,
  });

  assert.match(frame, /\u001b\[1;38;2;/);
  assertLinesFit(frame, 101);
});

test('3D progress fills the safe terminal viewport with Spatial Arbor', () => {
  const frame = render3DProgressFrame(sampleState(), {
    columns: 161,
    rows: 42,
    now: 12_000,
    color: false,
    unicode: true,
  });
  const lines = frame.split('\n');

  assert.equal(lines.length, 41);
  assert.equal(Math.max(...lines.map((line) => [...stripAnsi(line)].length)), 160);
  assert.match(frame, /DEEP FOREST TELEMETRY/);
  assert.match(frame, /SPATIAL ARBOR \/\/ WORKTREE STRATUM/);
  assert.match(frame, /67\/139 · 48\.2%/);
  assert.match(frame, /LIDAR LIVE · PHASE DEPTH 48\.2% · CAMERA FORWARD/);
  assertLinesFit(frame, 161);
});

test('3D truecolor preserves full-screen geometry', () => {
  const frame = render3DProgressFrame(sampleState(), {
    columns: 121,
    rows: 30,
    now: 12_000,
    color: true,
    unicode: true,
  });

  assert.equal(frame.split('\n').length, 29);
  assert.match(frame, /\u001b\[38;2;193;123;255m/);
  assertLinesFit(frame, 121);
});

test('3D progress recomposes across wide, ordinary, and short terminals', () => {
  for (const [columns, rows] of [
    [241, 80],
    [121, 30],
    [80, 24],
    [50, 10],
  ]) {
    const frame = render3DProgressFrame(sampleState(), {
      columns,
      rows,
      now: 12_000,
      color: false,
      unicode: true,
    });
    const lines = frame.split('\n');

    assert.equal(lines.length, rows - 1, `${columns}x${rows} did not use the safe height`);
    assert.equal(
      Math.max(...lines.map((line) => [...stripAnsi(line)].length)),
      columns - 1,
      `${columns}x${rows} did not use the safe width`,
    );
    assertLinesFit(frame, columns);
  }
});

test('Signal Garden fills the safe viewport with four live instruments', () => {
  const frame = renderSignalProgressFrame(sampleState(), {
    columns: 161,
    rows: 42,
    now: 12_000,
    color: false,
    unicode: true,
  });
  const lines = frame.split('\n');

  assert.equal(lines.length, 41);
  assert.equal(Math.max(...lines.map((line) => [...stripAnsi(line)].length)), 160);
  assert.match(frame, /DEEP FOREST TELEMETRY/);
  assert.match(frame, /SIGNAL GARDEN \/\/ WORKTREE SIGNAL FIELD/);
  assert.match(frame, /LINE SCAN/);
  assert.match(frame, /CENTRE WAVE/);
  assert.match(frame, /REGISTER 67\/139/);
  assert.match(frame, /ARROW FIELD/);
  assert.match(frame, /CELLULAR DEPTH 48\.2%/);
  assertLinesFit(frame, 161);
});

test('Signal Garden recomposes across wide, ordinary, and short terminals', () => {
  for (const [columns, rows] of [
    [241, 80],
    [121, 30],
    [80, 24],
    [50, 10],
  ]) {
    const frame = renderSignalProgressFrame(sampleState(), {
      columns,
      rows,
      now: 12_000,
      color: false,
      unicode: true,
    });
    const lines = frame.split('\n');

    assert.equal(lines.length, rows - 1, `${columns}x${rows} did not use the safe height`);
    assert.equal(
      Math.max(...lines.map((line) => [...stripAnsi(line)].length)),
      columns - 1,
      `${columns}x${rows} did not use the safe width`,
    );
    assertLinesFit(frame, columns);
  }
});

test('the Signal Garden scene is deterministic, exact-size ASCII art', () => {
  const options = {
    width: 96,
    height: 24,
    completed: 67,
    total: 139,
    frame: 11,
    phase: 'worktrees',
    ratio: 0.482,
  };
  const first = renderSignalScene(options);
  const second = renderSignalScene(options);

  assert.deepEqual(first, second);
  assert.equal(first.length, options.height);
  for (const line of first) {
    assert.equal([...line].length, options.width);
    assert.match(line, /^[\x20-\x7e]*$/);
  }
  assert.match(first.join('\n'), /LINE SCAN/);
  assert.match(first.join('\n'), /CENTRE WAVE/);
  assert.match(first.join('\n'), /REGISTER 67\/139/);
  assert.match(first.join('\n'), /ARROW FIELD/);
});

test('indeterminate Signal Garden animation changes without percentage leakage', () => {
  const first = renderSignalScene({
    width: 96,
    height: 24,
    frame: 1,
    phase: 'discovery',
    ratio: null,
  }).join('\n');
  const second = renderSignalScene({
    width: 96,
    height: 24,
    frame: 2,
    phase: 'discovery',
    ratio: null,
  }).join('\n');

  assert.notEqual(first, second);
  assert.match(first, /NO TOTAL \/\/ SIGNAL SEEK/);
  assert.doesNotMatch(first, /\d+(?:\.\d+)?%/);
});

test('Pulse Observatory fills the safe viewport with a live ECG instrument', () => {
  const frame = renderPulseProgressFrame(sampleState(), {
    columns: 161,
    rows: 42,
    now: 12_000,
    color: false,
    unicode: true,
  });
  const lines = frame.split('\n');

  assert.equal(lines.length, 41);
  assert.equal(Math.max(...lines.map((line) => [...stripAnsi(line)].length)), 160);
  assert.match(frame, /DEEP FOREST TELEMETRY/);
  assert.match(frame, /PULSE OBSERVATORY \/\/ WORKTREE VITALS/);
  assert.match(frame, /LEAD 01 \/\/ PHASE LOCK/);
  assert.match(frame, /DEPTH 48\.2%/);
  assert.match(frame, /SINUS RHYTHM \/\/ 67\/139 \/\/ 48\.2%/);
  assert.match(frame, /CONDUCTION NOMINAL/);
  assertLinesFit(frame, 161);
});

test('Pulse Observatory recomposes across wide, ordinary, and short terminals', () => {
  for (const [columns, rows] of [
    [241, 80],
    [121, 30],
    [80, 24],
    [50, 10],
  ]) {
    const frame = renderPulseProgressFrame(sampleState(), {
      columns,
      rows,
      now: 12_000,
      color: false,
      unicode: true,
    });
    const lines = frame.split('\n');

    assert.equal(lines.length, rows - 1, `${columns}x${rows} did not use the safe height`);
    assert.equal(
      Math.max(...lines.map((line) => [...stripAnsi(line)].length)),
      columns - 1,
      `${columns}x${rows} did not use the safe width`,
    );
    assertLinesFit(frame, columns);
  }
});

test('the pulse scene is deterministic, exact-size ASCII art', () => {
  const options = {
    width: 96,
    height: 24,
    completed: 67,
    total: 139,
    frame: 11,
    phase: 'worktrees',
    ratio: 0.482,
  };
  const first = renderPulseScene(options);
  const second = renderPulseScene(options);

  assert.deepEqual(first, second);
  assert.equal(first.length, options.height);
  for (const line of first) {
    assert.equal([...line].length, options.width);
    assert.match(line, /^[\x20-\x7e]*$/);
  }
  assert.match(first.join('\n'), /PULSE OBSERVATORY \/\/ WORKTREES/);
  assert.match(first.join('\n'), /LEAD 01 \/\/ PHASE LOCK/);
  assert.match(first.join('\n'), /SINUS RHYTHM \/\/ 67\/139 \/\/ 48\.2%/);
});

test('indeterminate pulse animation changes without percentage leakage', () => {
  const first = renderPulseScene({
    width: 96,
    height: 24,
    frame: 1,
    phase: 'discovery',
    ratio: null,
  }).join('\n');
  const second = renderPulseScene({
    width: 96,
    height: 24,
    frame: 2,
    phase: 'discovery',
    ratio: null,
  }).join('\n');

  assert.notEqual(first, second);
  assert.match(first, /LEAD 01 \/\/ ACQUIRING/);
  assert.match(first, /RHYTHM LIVE \/\/ NO TOTAL/);
  assert.doesNotMatch(first, /\d+(?:\.\d+)?%/);
});

test('Centre Wave fills the safe viewport with phase-offset topography', () => {
  const frame = renderWaveProgressFrame(sampleState(), {
    columns: 161,
    rows: 42,
    now: 12_000,
    color: false,
    unicode: true,
  });
  const lines = frame.split('\n');

  assert.equal(lines.length, 41);
  assert.equal(Math.max(...lines.map((line) => [...stripAnsi(line)].length)), 160);
  assert.match(frame, /DEEP FOREST TELEMETRY/);
  assert.match(frame, /CENTRE WAVE \/\/ WORKTREE INTERFERENCE/);
  assert.match(frame, /INTERFERENCE FIELD \/\/ WORKTREES/);
  assert.match(frame, /ROW PHASE OFFSET \/\/ BLACK CHANNELS LIVE/);
  assert.match(frame, /PHASE GATE 48\.2%/);
  assert.match(frame, /WAVE LIVE · PHASE DEPTH 48\.2% · CRESTS AMBIENT/);
  assertLinesFit(frame, 161);
});

test('Centre Wave recomposes across wide, ordinary, and short terminals', () => {
  for (const [columns, rows] of [
    [241, 80],
    [121, 30],
    [80, 24],
    [50, 10],
  ]) {
    const frame = renderWaveProgressFrame(sampleState(), {
      columns,
      rows,
      now: 12_000,
      color: false,
      unicode: true,
    });
    const lines = frame.split('\n');

    assert.equal(lines.length, rows - 1, `${columns}x${rows} did not use the safe height`);
    assert.equal(
      Math.max(...lines.map((line) => [...stripAnsi(line)].length)),
      columns - 1,
      `${columns}x${rows} did not use the safe width`,
    );
    assertLinesFit(frame, columns);
  }
});

test('the Centre Wave scene is deterministic, exact-size ASCII art', () => {
  const options = {
    width: 96,
    height: 24,
    completed: 67,
    total: 139,
    frame: 11,
    phase: 'worktrees',
    ratio: 0.482,
  };
  const first = renderWaveScene(options);
  const second = renderWaveScene(options);

  assert.deepEqual(first, second);
  assert.equal(first.length, options.height);
  for (const line of first) {
    assert.equal([...line].length, options.width);
    assert.match(line, /^[\x20-\x7e]*$/);
  }
  assert.match(first.join('\n'), /INTERFERENCE FIELD \/\/ WORKTREES/);
  assert.match(first.join('\n'), /ROW PHASE OFFSET \/\/ BLACK CHANNELS LIVE/);
  assert.match(first.join('\n'), /67\/139 \/\/ 48\.2%/);
});

test('indeterminate Centre Wave animation changes without percentage leakage', () => {
  const first = renderWaveScene({
    width: 96,
    height: 24,
    frame: 1,
    phase: 'discovery',
    ratio: null,
  }).join('\n');
  const second = renderWaveScene({
    width: 96,
    height: 24,
    frame: 2,
    phase: 'discovery',
    ratio: null,
  }).join('\n');

  assert.notEqual(first, second);
  assert.match(first, /NO TOTAL \/\/ ACQUIRING/);
  assert.match(first, /ACQUISITION SWEEP/);
  assert.doesNotMatch(first, /\d+(?:\.\d+)?%/);
});

test('3D discovery uses an indeterminate LIDAR sweep without inventing a percentage', () => {
  let state = createProgressState(0);
  state = reduceProgressEvent(state, discoveryEvent(640, 37), 1_000);
  const frame = render3DProgressFrame({ ...state, frame: 9 }, {
    columns: 121,
    rows: 30,
    now: 2_000,
    color: false,
    unicode: true,
  });

  assert.match(frame, /SPATIAL ARBOR \/\/ CANOPY LIDAR/);
  assert.match(frame, /INDETERMINATE LIDAR/);
  assert.doesNotMatch(frame, /\d+(?:\.\d+)?%/);
});

test('the Spatial Arbor scene is deterministic, exact-size ASCII art', () => {
  const options = {
    width: 96,
    height: 24,
    frame: 11,
    phase: 'worktrees',
    ratio: 0.482,
    unicode: false,
  };
  const first = renderSpatialScene(options);
  const second = renderSpatialScene(options);

  assert.deepEqual(first, second);
  assert.equal(first.length, options.height);
  for (const line of first) {
    assert.equal([...line].length, options.width);
    assert.match(line, /^[\x20-\x7e]*$/);
  }
  assert.match(first.join('\n'), /VOLUMETRIC FOREST/);
  assert.match(first.join('\n'), /DEPTH 48\.2%/);
});

test('the indeterminate spatial scene animates without percentage leakage', () => {
  const first = renderSpatialScene({
    width: 96,
    height: 24,
    frame: 1,
    phase: 'discovery',
    ratio: null,
  }).join('\n');
  const second = renderSpatialScene({
    width: 96,
    height: 24,
    frame: 2,
    phase: 'discovery',
    ratio: null,
  }).join('\n');

  assert.notEqual(first, second);
  assert.match(first, /INDETERMINATE LIDAR/);
  assert.doesNotMatch(first, /\d+(?:\.\d+)?%/);
});

test('forced progress in a pipe is milestone-based plain text', () => {
  const stream = new MemoryStream({ isTTY: false, columns: 80 });
  let now = 0;
  const reporter = createProgressReporter(
    { progress: 'always', color: 'always', json: false },
    stream,
    { now: () => now, env: {} },
  );

  reporter.update(discoveryEvent(0, 0));
  reporter.update(discoveryEvent(100, 3));
  reporter.update(discoveryEvent(249, 8));
  reporter.update(discoveryEvent(250, 9));
  for (const completed of [0, 10, 26, 51, 76, 100]) {
    now += 100;
    reporter.update({ phase: 'worktrees', label: 'Scanning worktrees', completed, total: 100 });
  }
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 1, total: 1 });
  reporter.dispose();

  assert.equal(stream.output.includes('\u001b['), false);
  assert.match(stream.output, /Discovering repositories · 0 dirs · 0 repos/);
  assert.match(stream.output, /Scanning worktrees \[##############################\] 100\/100/);
  assert.match(stream.output, /OK FOREST MAPPED/);
  assert.ok(stream.output.split('\n').filter(Boolean).length < 12, 'plain progress became a per-item log');
});

test('forced pipe progress starts fresh for every watch cycle', () => {
  const stream = new MemoryStream({ isTTY: false, columns: 80 });
  const reporter = createProgressReporter(
    { progress: 'always', color: 'auto', json: false },
    stream,
    { now: () => 0, env: {} },
  );

  for (let cycle = 0; cycle < 2; cycle += 1) {
    reporter.update(discoveryEvent(0, 0));
    reporter.update({ phase: 'worktrees', label: 'Scanning worktrees', completed: 0, total: 1 });
    reporter.update({ phase: 'complete', label: 'Scan complete', completed: 1, total: 1 });
  }
  reporter.dispose();

  assert.equal((stream.output.match(/Discovering repositories/g) ?? []).length, 2);
  assert.equal((stream.output.match(/OK FOREST MAPPED/g) ?? []).length, 2);
});

test('a termination signal restores the cursor and removes lifecycle hooks', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 101, rows: 30 });
  const signals = new EventEmitter();
  const reporter = createProgressReporter(
    { progress: 'always', color: 'never', json: false },
    stream,
    {
      now: () => 0,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  signals.emit('SIGTERM');

  assert.match(stream.output, /\u001b\[\?25l/);
  assert.match(stream.output, /\u001b\[\?25h/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGHUP'), 0);
});

test('interactive animation redraws atomically and restores the cursor', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 101, rows: 30 });
  const signals = new EventEmitter();
  let now = 0;
  let tick = null;
  let cleared = false;
  let unrefed = false;
  const reporter = createProgressReporter(
    { progress: 'always', color: 'never', json: false },
    stream,
    {
      now: () => now,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: (callback) => {
        tick = callback;
        return { unref: () => { unrefed = true; } };
      },
      clearInterval: () => { cleared = true; },
    },
  );

  reporter.update(discoveryEvent(96, 4));
  assert.equal(unrefed, true);
  assert.match(stream.writes[0], /\u001b\[\?25l/);
  assert.match(stream.writes[0], /DEEP FOREST TELEMETRY/);

  now = 100;
  tick();
  assert.match(stream.writes[1], /\u001b\[1A/);
  assert.notEqual(stream.writes[0], stream.writes[1]);

  now = 1_000;
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 4, total: 4 });
  assert.equal(cleared, true);
  assert.match(stream.output, /\u001b\[\?25h/);
  assert.match(stream.output, /◆ FOREST MAPPED · 4 repositories analyzed · 1\.0s/);

  reporter.dispose();
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGHUP'), 0);
});

test('3D progress owns the alternate screen, coalesces updates, and survives resize', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 121, rows: 30 });
  const signals = new EventEmitter();
  let now = 0;
  let tick = null;
  const reporter = createProgressReporter(
    { progress: 'always', progress3d: true, color: 'never', json: false },
    stream,
    {
      now: () => now,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  assert.match(stream.writes[0], /^\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
  assert.match(stream.writes[0], /SPATIAL ARBOR/);
  assert.doesNotMatch(stream.writes[0], /\u001b\[(?:1;)?38;2;/);

  reporter.update(discoveryEvent(192, 8));
  assert.equal(stream.writes.length, 1, 'a repository event forced a full-screen redraw');

  now = 100;
  tick();
  assert.equal(stream.writes.length, 2);
  assert.match(stream.writes[1], /^\u001b\[H/);
  assert.doesNotMatch(stream.writes[1], /\u001b\[\?1049h/);

  stream.columns = 80;
  stream.rows = 24;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 23);

  stream.columns = 20;
  stream.rows = 4;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 1);
  assert.doesNotMatch(stream.writes.at(-1), /SPATIAL ARBOR/);

  stream.columns = 121;
  stream.rows = 30;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 29);
  assert.match(stream.writes.at(-1), /SPATIAL ARBOR/);

  now = 1_000;
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 8, total: 8 });
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h◆ FOREST MAPPED/);
  reporter.dispose();
  assert.equal(stream.listenerCount('resize'), 0);
});

test('Signal Garden owns the alternate screen, coalesces updates, and survives resize', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 121, rows: 30 });
  const signals = new EventEmitter();
  let now = 0;
  let tick = null;
  const reporter = createProgressReporter(
    { progress: 'always', progressSignal: true, color: 'never', json: false },
    stream,
    {
      now: () => now,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  assert.match(stream.writes[0], /^\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
  assert.match(stream.writes[0], /SIGNAL GARDEN/);
  assert.match(stream.writes[0], /NO INVENTED PERCENT/);

  reporter.update(discoveryEvent(192, 8));
  assert.equal(stream.writes.length, 1, 'a repository event forced a full-screen redraw');

  now = 100;
  tick();
  assert.equal(stream.writes.length, 2);
  assert.match(stream.writes[1], /^\u001b\[H/);

  stream.columns = 80;
  stream.rows = 24;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 23);

  stream.columns = 20;
  stream.rows = 4;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 1);
  assert.doesNotMatch(stream.writes.at(-1), /SIGNAL GARDEN/);

  stream.columns = 121;
  stream.rows = 30;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 29);
  assert.match(stream.writes.at(-1), /SIGNAL GARDEN/);

  now = 1_000;
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 8, total: 8 });
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h◆ FOREST MAPPED/);
  reporter.dispose();
  assert.equal(stream.listenerCount('resize'), 0);
});

test('Pulse Observatory owns the alternate screen, coalesces updates, and survives resize', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 121, rows: 30 });
  const signals = new EventEmitter();
  let now = 0;
  let tick = null;
  const reporter = createProgressReporter(
    { progress: 'always', progressPulse: true, color: 'never', json: false },
    stream,
    {
      now: () => now,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  assert.match(stream.writes[0], /^\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
  assert.match(stream.writes[0], /PULSE OBSERVATORY/);
  assert.match(stream.writes[0], /NO INVENTED PERCENT/);

  reporter.update(discoveryEvent(192, 8));
  assert.equal(stream.writes.length, 1, 'a repository event forced a full-screen redraw');

  now = 100;
  tick();
  assert.equal(stream.writes.length, 2);
  assert.match(stream.writes[1], /^\u001b\[H/);

  stream.columns = 80;
  stream.rows = 24;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 23);

  stream.columns = 20;
  stream.rows = 4;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 1);
  assert.doesNotMatch(stream.writes.at(-1), /PULSE OBSERVATORY/);

  stream.columns = 121;
  stream.rows = 30;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 29);
  assert.match(stream.writes.at(-1), /PULSE OBSERVATORY/);

  now = 1_000;
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 8, total: 8 });
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h◆ FOREST MAPPED/);
  reporter.dispose();
  assert.equal(stream.listenerCount('resize'), 0);
});

test('Centre Wave owns the alternate screen, coalesces updates, and survives resize', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 121, rows: 30 });
  const signals = new EventEmitter();
  let now = 0;
  let tick = null;
  const reporter = createProgressReporter(
    { progress: 'always', progressWave: true, color: 'never', json: false },
    stream,
    {
      now: () => now,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  assert.match(stream.writes[0], /^\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
  assert.match(stream.writes[0], /CENTRE WAVE/);
  assert.match(stream.writes[0], /NO INVENTED PERCENT/);

  reporter.update(discoveryEvent(192, 8));
  assert.equal(stream.writes.length, 1, 'a repository event forced a full-screen redraw');

  now = 100;
  tick();
  assert.equal(stream.writes.length, 2);
  assert.match(stream.writes[1], /^\u001b\[H/);

  stream.columns = 80;
  stream.rows = 24;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 23);

  stream.columns = 20;
  stream.rows = 4;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 1);
  assert.doesNotMatch(stream.writes.at(-1), /CENTRE WAVE/);

  stream.columns = 121;
  stream.rows = 30;
  stream.emit('resize');
  assert.equal(stream.writes.at(-1).split('\n').length, 29);
  assert.match(stream.writes.at(-1), /CENTRE WAVE/);

  now = 1_000;
  reporter.update({ phase: 'complete', label: 'Scan complete', completed: 8, total: 8 });
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h◆ FOREST MAPPED/);
  reporter.dispose();
  assert.equal(stream.listenerCount('resize'), 0);
});

test('explicit 3D progress honors a TTY even when TERM is dumb', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 101, rows: 30 });
  const signals = new EventEmitter();
  const reporter = createProgressReporter(
    { progress: 'always', progress3d: true, color: 'never', json: false },
    stream,
    {
      now: () => 0,
      env: { TERM: 'dumb', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));

  assert.match(stream.output, /\u001b\[\?1049h/);
  assert.match(stream.output, /SPATIAL ARBOR/);

  reporter.dispose();
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h$/);
});

test('3D watch cycles leave and re-enter the alternate screen cleanly', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 101, rows: 30 });
  const signals = new EventEmitter();
  const reporter = createProgressReporter(
    { progress: 'always', progress3d: true, color: 'never', json: false },
    stream,
    {
      now: () => 0,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    },
  );

  for (let cycle = 0; cycle < 2; cycle += 1) {
    reporter.update(discoveryEvent(96, 4));
    reporter.update({ phase: 'complete', label: 'Scan complete', completed: 4, total: 4 });
  }
  reporter.dispose();

  assert.equal((stream.output.match(/\u001b\[\?1049h/g) ?? []).length, 2);
  assert.equal((stream.output.match(/\u001b\[\?1049l/g) ?? []).length, 2);
  assert.equal((stream.output.match(/FOREST MAPPED/g) ?? []).length, 2);
});

test('a termination signal exits the 3D alternate screen before cleanup', () => {
  const stream = new MemoryStream({ isTTY: true, columns: 101, rows: 30 });
  const signals = new EventEmitter();
  const reporter = createProgressReporter(
    { progress: 'always', progress3d: true, color: 'never', json: false },
    stream,
    {
      now: () => 0,
      env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      signalSource: signals,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    },
  );

  reporter.update(discoveryEvent(96, 4));
  signals.emit('SIGTERM');

  assert.match(stream.output, /\u001b\[\?1049h/);
  assert.match(stream.output, /\u001b\[\?1049l\u001b\[\?25h$/);
  assert.equal(stream.listenerCount('resize'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

function sampleState() {
  let state = createProgressState(0);
  state = reduceProgressEvent(state, discoveryEvent(640, 37), 1_000);
  state = reduceProgressEvent(state, { phase: 'resolve', label: 'Resolving repositories', completed: 37, total: 100 }, 3_000);
  state = reduceProgressEvent(state, { phase: 'ownership', label: 'Reading repository ownership', completed: 100, total: 100 }, 5_000);
  state = reduceProgressEvent(state, { phase: 'worktrees', label: 'Scanning worktrees', completed: 0, total: 139 }, 7_000);
  state = reduceProgressEvent(state, { phase: 'worktrees', label: 'Scanning worktrees', completed: 67, total: 139 }, 12_000);
  return { ...state, frame: 5 };
}

function discoveryEvent(visitedDirectories, discoveredRepositories) {
  return {
    phase: 'discovery',
    label: 'Discovering repositories',
    completed: visitedDirectories,
    total: null,
    visitedDirectories,
    discoveredRepositories,
  };
}

function assertLinesFit(frame, columns) {
  for (const line of frame.split('\n')) {
    assert.ok([...stripAnsi(line)].length < columns, `${[...stripAnsi(line)].length} >= ${columns}: ${stripAnsi(line)}`);
  }
}

class MemoryStream extends EventEmitter {
  constructor({ isTTY, columns, rows = 24 }) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
    this.rows = rows;
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
    return true;
  }

  get output() {
    return this.writes.join('');
  }
}
