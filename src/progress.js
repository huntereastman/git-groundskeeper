import process from 'node:process';
import { renderSpatialScene } from './progress-3d.js';
import { renderPulseScene } from './progress-pulse.js';
import { renderSignalScene } from './progress-signal.js';
import { renderWaveScene } from './progress-wave.js';

const TICK_MS = 100;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ENTER_ALT_SCREEN = '\u001b[?1049h';
const LEAVE_ALT_SCREEN = '\u001b[?1049l';
const CLEAR_SCREEN = '\u001b[2J';
const CLEAR_TO_END = '\u001b[J';
const CURSOR_HOME = '\u001b[H';
const SPINNER = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const PHASES = [
  { id: 'owners', short: 'ACCOUNT', unit: 'accounts/s' },
  { id: 'discovery', short: 'CANOPY', unit: 'dirs/s' },
  { id: 'resolve', short: 'MAP', unit: 'repos/s' },
  { id: 'ownership', short: 'CLAIMS', unit: 'repos/s' },
  { id: 'worktrees', short: 'TREES', unit: 'trees/s' },
  { id: 'analysis', short: 'VERDICT', unit: 'repos/s' },
];

const LEGACY_PHASES = new Map([
  ['detecting-owners', 'owners'],
  ['resolving-repositories', 'resolve'],
  ['reading-repository-ownership', 'ownership'],
  ['scanning-worktrees', 'worktrees'],
  ['analyzing-repositories', 'analysis'],
]);

const ACTIVITY = {
  owners: 'matching remotes to their keepers',
  discovery: 'listening for .git beneath the canopy',
  resolve: 'mapping roots, trunks, and linked paths',
  ownership: 'separating your forest from the wild',
  worktrees: 'checking every checkout for living work',
  analysis: 'weighing history before anything gets cut',
};

const PALETTE = {
  leaf: [103, 255, 137],
  moss: [42, 190, 111],
  pine: [24, 86, 51],
  fern: [58, 148, 98],
  mint: [112, 180, 142],
  sun: [255, 207, 92],
  sky: [75, 221, 255],
  bone: [226, 239, 230],
  fog: [103, 126, 114],
  bark: [191, 151, 98],
  orchid: [193, 123, 255],
};

const SPATIAL_PHASE_TITLES = {
  owners: 'ACCOUNT SIGNAL ARRAY',
  discovery: 'CANOPY LIDAR',
  resolve: 'ROUTE STRATUM',
  ownership: 'CLAIM PARCELS',
  worktrees: 'WORKTREE STRATUM',
  analysis: 'VERDICT APERTURE',
};

const SIGNAL_PHASE_TITLES = {
  owners: 'IDENTITY HANDSHAKE',
  discovery: 'CANOPY ACQUISITION',
  resolve: 'REPOSITORY RESOLUTION',
  ownership: 'OWNERSHIP CLAIMS',
  worktrees: 'WORKTREE SIGNAL FIELD',
  analysis: 'VERDICT SYNTHESIS',
};

const PULSE_PHASE_TITLES = {
  owners: 'IDENTITY PULSE',
  discovery: 'CANOPY ACQUISITION',
  resolve: 'REPOSITORY CONDUCTION',
  ownership: 'CLAIM VITALS',
  worktrees: 'WORKTREE VITALS',
  analysis: 'VERDICT RHYTHM',
};

const WAVE_PHASE_TITLES = {
  owners: 'IDENTITY RESONANCE',
  discovery: 'CANOPY INTERFERENCE',
  resolve: 'REPOSITORY HARMONICS',
  ownership: 'CLAIM RESONANCE',
  worktrees: 'WORKTREE INTERFERENCE',
  analysis: 'VERDICT COHERENCE',
};

export function createProgressState(startedAt = Date.now()) {
  return {
    startedAt,
    completedAt: null,
    activePhase: null,
    stages: new Map(),
    frame: 0,
    finished: false,
    finalTotal: null,
  };
}

export function reduceProgressEvent(state, rawEvent, now = Date.now()) {
  const event = normalizeEvent(rawEvent);
  let next = state.finished && event.phase !== 'complete'
    ? createProgressState(now)
    : {
        ...state,
        stages: new Map(state.stages),
      };

  if (event.phase === 'complete') {
    const active = next.stages.get(next.activePhase);
    if (active) {
      next.stages.set(active.phase, { ...active, status: 'done', endedAt: now });
    }
    return {
      ...next,
      activePhase: null,
      completedAt: now,
      finished: true,
      finalTotal: Number.isInteger(event.total) ? event.total : null,
    };
  }

  if (next.activePhase && next.activePhase !== event.phase) {
    const previous = next.stages.get(next.activePhase);
    if (previous) {
      next.stages.set(previous.phase, { ...previous, status: 'done', endedAt: now });
    }
  }

  const existing = next.stages.get(event.phase);
  const completed = Number.isInteger(event.completed) ? event.completed : null;
  const samples = [...(existing?.samples ?? [])];
  if (completed !== null) {
    samples.push({ at: now, completed });
    while (samples.length > 24 || (samples[0] && now - samples[0].at > 5_000)) {
      samples.shift();
    }
  }

  next.stages.set(event.phase, {
    phase: event.phase,
    label: event.label,
    status: 'active',
    startedAt: existing?.startedAt ?? now,
    endedAt: null,
    completed,
    total: Number.isInteger(event.total) ? event.total : null,
    visitedDirectories: Number.isInteger(event.visitedDirectories)
      ? event.visitedDirectories
      : existing?.visitedDirectories ?? null,
    discoveredRepositories: Number.isInteger(event.discoveredRepositories)
      ? event.discoveredRepositories
      : existing?.discoveredRepositories ?? null,
    samples,
  });

  return { ...next, activePhase: event.phase };
}

export function renderProgressFrame(state, options = {}) {
  const terminalColumns = Number.isFinite(options.columns) ? Math.floor(options.columns) : 80;
  const columns = Math.max(1, Math.min(120, terminalColumns - 1));
  const rows = options.rows ?? 24;
  const now = options.now ?? Date.now();
  const unicode = options.unicode !== false;
  const theme = createTheme(options.color === true);

  if (columns < 54 || rows < 5) {
    return renderTiny(state, columns, now, unicode, theme);
  }
  if (columns < 88 || rows < 10) {
    return renderCompact(state, columns, now, unicode, theme);
  }
  return renderFull(state, columns, now, unicode, theme);
}

export function render3DProgressFrame(state, options = {}) {
  const terminalColumns = Number.isFinite(options.columns) ? Math.floor(options.columns) : 80;
  const terminalRows = Number.isFinite(options.rows) ? Math.floor(options.rows) : 24;
  const columns = Math.max(1, terminalColumns - 1);
  const rows = Math.max(1, terminalRows - 1);
  const now = options.now ?? Date.now();
  const unicode = options.unicode !== false;
  const theme = createTheme(options.color === true);

  if (columns < 32 || rows < 8) {
    return renderProgressFrame(state, {
      ...options,
      columns: terminalColumns,
      rows: terminalRows,
    });
  }

  const dashboard = rows >= 18 && columns >= 88
    ? renderFull(state, columns, now, unicode, theme)
    : rows >= 11 && columns >= 54
      ? renderCompact(state, columns, now, unicode, theme)
      : renderTiny(state, columns, now, unicode, theme);
  const dashboardLines = dashboard.split('\n').length;
  const sceneHeight = rows - dashboardLines;
  if (sceneHeight < 5) return dashboard;

  return `${dashboard}\n${renderSpatialViewport(
    state,
    columns,
    sceneHeight,
    unicode,
    theme,
  )}`;
}

export function renderSignalProgressFrame(state, options = {}) {
  const terminalColumns = Number.isFinite(options.columns) ? Math.floor(options.columns) : 80;
  const terminalRows = Number.isFinite(options.rows) ? Math.floor(options.rows) : 24;
  const columns = Math.max(1, terminalColumns - 1);
  const rows = Math.max(1, terminalRows - 1);
  const now = options.now ?? Date.now();
  const unicode = options.unicode !== false;
  const theme = createTheme(options.color === true);

  if (columns < 32 || rows < 8) {
    return renderProgressFrame(state, {
      ...options,
      columns: terminalColumns,
      rows: terminalRows,
    });
  }

  const dashboard = rows >= 18 && columns >= 88
    ? renderFull(state, columns, now, unicode, theme)
    : rows >= 11 && columns >= 54
      ? renderCompact(state, columns, now, unicode, theme)
      : renderTiny(state, columns, now, unicode, theme);
  const dashboardLines = dashboard.split('\n').length;
  const sceneHeight = rows - dashboardLines;
  if (sceneHeight < 5) return dashboard;

  return `${dashboard}\n${renderSignalViewport(
    state,
    columns,
    sceneHeight,
    unicode,
    theme,
  )}`;
}

export function renderPulseProgressFrame(state, options = {}) {
  const terminalColumns = Number.isFinite(options.columns) ? Math.floor(options.columns) : 80;
  const terminalRows = Number.isFinite(options.rows) ? Math.floor(options.rows) : 24;
  const columns = Math.max(1, terminalColumns - 1);
  const rows = Math.max(1, terminalRows - 1);
  const now = options.now ?? Date.now();
  const unicode = options.unicode !== false;
  const theme = createTheme(options.color === true);

  if (columns < 32 || rows < 8) {
    return renderProgressFrame(state, {
      ...options,
      columns: terminalColumns,
      rows: terminalRows,
    });
  }

  const dashboard = rows >= 18 && columns >= 88
    ? renderFull(state, columns, now, unicode, theme)
    : rows >= 11 && columns >= 54
      ? renderCompact(state, columns, now, unicode, theme)
      : renderTiny(state, columns, now, unicode, theme);
  const dashboardLines = dashboard.split('\n').length;
  const sceneHeight = rows - dashboardLines;
  if (sceneHeight < 5) return dashboard;

  return `${dashboard}\n${renderPulseViewport(
    state,
    columns,
    sceneHeight,
    unicode,
    theme,
  )}`;
}

export function renderWaveProgressFrame(state, options = {}) {
  const terminalColumns = Number.isFinite(options.columns) ? Math.floor(options.columns) : 80;
  const terminalRows = Number.isFinite(options.rows) ? Math.floor(options.rows) : 24;
  const columns = Math.max(1, terminalColumns - 1);
  const rows = Math.max(1, terminalRows - 1);
  const now = options.now ?? Date.now();
  const unicode = options.unicode !== false;
  const theme = createTheme(options.color === true);

  if (columns < 32 || rows < 8) {
    return renderProgressFrame(state, {
      ...options,
      columns: terminalColumns,
      rows: terminalRows,
    });
  }

  const dashboard = rows >= 18 && columns >= 88
    ? renderFull(state, columns, now, unicode, theme)
    : rows >= 11 && columns >= 54
      ? renderCompact(state, columns, now, unicode, theme)
      : renderTiny(state, columns, now, unicode, theme);
  const dashboardLines = dashboard.split('\n').length;
  const sceneHeight = rows - dashboardLines;
  if (sceneHeight < 5) return dashboard;

  return `${dashboard}\n${renderWaveViewport(
    state,
    columns,
    sceneHeight,
    unicode,
    theme,
  )}`;
}

export function createProgressReporter(options, stream = process.stderr, runtime = {}) {
  const env = runtime.env ?? process.env;
  const enabled = options.progress === 'always'
    || (options.progress === 'auto' && stream.isTTY && !options.json);
  if (!enabled) return null;

  const tty = Boolean(stream.isTTY);
  const immersiveRequested = options.progress3d === true
    || options.progressSignal === true
    || options.progressPulse === true
    || options.progressWave === true;
  // Full-screen progress flags are explicit terminal-capability opt-ins. Some capable
  // integrated terminals advertise TERM=dumb, so treating that value as an
  // unconditional veto silently turns the requested scene into plain logs.
  // Keep auto/regular progress conservative, while honoring an explicit immersive
  // request whenever stderr is still a real TTY. Pipes remain escape-free.
  const interactive = tty && (env.TERM !== 'dumb' || immersiveRequested);
  const color = interactive && (
    options.color === 'always'
      || (options.color !== 'never' && !('NO_COLOR' in env))
  );
  const unicode = interactive && supportsUnicode(env);
  const wave = interactive && options.progressWave === true;
  const pulse = interactive && options.progressPulse === true && !wave;
  const signal = interactive && options.progressSignal === true && !pulse && !wave;
  const spatial = interactive && options.progress3d === true
    && !signal && !pulse && !wave;
  const immersive = wave || pulse || signal || spatial;
  const now = runtime.now ?? Date.now;
  const schedule = runtime.setInterval ?? setInterval;
  const unschedule = runtime.clearInterval ?? clearInterval;
  const signalSource = runtime.signalSource ?? process;
  let state = createProgressState(now());
  let timer = null;
  let renderedLines = 0;
  let cursorHidden = false;
  let alternateScreen = false;
  let disposed = false;
  let streamFailed = false;
  const plainMilestones = new Set();
  const signalHandlers = new Map();

  function safeWrite(value) {
    if (streamFailed) return false;
    try {
      stream.write(value);
      return true;
    } catch {
      streamFailed = true;
      return false;
    }
  }

  function draw() {
    if (!interactive || disposed || state.finished || streamFailed) return;
    const renderer = wave
      ? renderWaveProgressFrame
        : pulse
        ? renderPulseProgressFrame
        : signal
          ? renderSignalProgressFrame
          : spatial
            ? render3DProgressFrame
            : renderProgressFrame;
    const frame = renderer(state, {
      columns: stream.columns ?? 80,
      rows: stream.rows ?? 24,
      now: now(),
      color,
      unicode,
    });
    const nextLineCount = frame.split('\n').length;
    if (immersive) {
      const enter = alternateScreen
        ? CURSOR_HOME
        : `${ENTER_ALT_SCREEN}\u001b[?25l${CLEAR_SCREEN}${CURSOR_HOME}`;
      if (safeWrite(`${enter}${frame}${CLEAR_TO_END}`)) {
        alternateScreen = true;
        cursorHidden = true;
        renderedLines = nextLineCount;
      }
      return;
    }
    const hide = cursorHidden ? '' : '\u001b[?25l';
    const output = `${eraseLines(renderedLines)}${hide}${frame}`;
    if (safeWrite(output)) {
      renderedLines = nextLineCount;
      cursorHidden = true;
    }
  }

  function startTimer() {
    if (!interactive || timer || disposed) return;
    timer = schedule(() => {
      state = { ...state, frame: state.frame + 1 };
      draw();
    }, runtime.tickMs ?? TICK_MS);
    timer?.unref?.();
  }

  function stopTimer() {
    if (!timer) return;
    unschedule(timer);
    timer = null;
  }

  function restoreCursor() {
    if (!cursorHidden) return '';
    cursorHidden = false;
    return '\u001b[?25h';
  }

  function clear() {
    stopTimer();
    const leave = alternateScreen ? LEAVE_ALT_SCREEN : '';
    alternateScreen = false;
    const output = immersive
      ? `${leave}${restoreCursor()}`
      : `${eraseLines(renderedLines)}${restoreCursor()}`;
    renderedLines = 0;
    if (output) safeWrite(output);
  }

  function finish(event) {
    state = reduceProgressEvent(state, event, now());
    stopTimer();
    if (interactive) {
      const summary = renderCompletionSummary(state, { color, unicode });
      const leave = alternateScreen ? LEAVE_ALT_SCREEN : '';
      alternateScreen = false;
      const output = immersive
        ? `${leave}${restoreCursor()}${summary}\n`
        : `${eraseLines(renderedLines)}${restoreCursor()}${summary}\n`;
      renderedLines = 0;
      safeWrite(output);
    } else {
      safeWrite(`${renderInventoryPrefix(event)}${renderCompletionSummary(state, { color, unicode: false })}\n`);
    }
    // A reporter is reused by `watch`; milestones belong to one scan cycle.
    plainMilestones.clear();
  }

  function update(rawEvent) {
    if (disposed || streamFailed) return;
    const event = normalizeEvent(rawEvent);
    if (event.phase === 'complete') {
      finish(event);
      return;
    }

    state = reduceProgressEvent(state, event, now());
    if (interactive) {
      if (!immersive || !alternateScreen) draw();
      startTimer();
      return;
    }

    const milestone = plainMilestone(event);
    if (plainMilestones.has(milestone)) return;
    plainMilestones.add(milestone);
    safeWrite(`${renderPlainProgressLine(event, stream.columns ?? 100)}\n`);
  }

  function removeLifecycleHandlers() {
    for (const [signal, handler] of signalHandlers) {
      signalSource.removeListener?.(signal, handler);
    }
    signalHandlers.clear();
    signalSource.removeListener?.('exit', exitHandler);
    stream.removeListener?.('error', streamErrorHandler);
    stream.removeListener?.('resize', resizeHandler);
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    removeLifecycleHandlers();
  }

  function exitHandler() {
    clear();
  }

  function streamErrorHandler() {
    streamFailed = true;
    stopTimer();
  }

  function resizeHandler() {
    draw();
  }

  if (interactive) {
    signalSource.once?.('exit', exitHandler);
    stream.on?.('error', streamErrorHandler);
    if (immersive) stream.on?.('resize', resizeHandler);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        dispose();
        if (signalSource === process) {
          process.kill(process.pid, signal);
        }
      };
      signalHandlers.set(signal, handler);
      signalSource.once?.(signal, handler);
    }
  }

  return { clear, dispose, update };
}

export function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function renderFull(state, width, now, unicode, theme) {
  const stage = currentStage(state);
  const spinner = unicode ? SPINNER[state.frame % SPINNER.length] : spinnerAscii(state.frame);
  const ratio = progressRatio(stage);
  const elapsed = formatDuration(now - state.startedAt, true);
  const title = 'GIT GROUNDSKEEPER // DEEP FOREST TELEMETRY';
  const count = formatCount(stage);
  const percent = ratio === null ? '' : `  ${formatPercent(ratio)}`;
  const current = joinSides(
    theme.leaf(`${spinner} ${(stage?.label ?? 'Initializing scan').toUpperCase()}`),
    theme.bone(`${count}${percent}`),
    width - 4,
  );
  const metrics = joinSides(
    formatRate(stage, now, theme),
    `${formatPhasePosition(state)}  ·  ${formatEta(stage, now)}  ·  T+${elapsed}`,
    width - 4,
  );
  const radarWidth = Math.max(16, width - 37);
  const radar = renderRadar(radarWidth, state.frame, unicode, theme);
  const signal = renderSignal(10, state.frame, unicode, theme);

  return [
    renderTitleBorder(title, `T+${elapsed}`, width, theme),
    boxLine(renderPhaseRail(state, width - 4, unicode, theme), width, theme),
    divider(width, theme),
    boxLine(current, width, theme),
    boxLine(renderBar(width - 4, ratio, state.frame, unicode, theme), width, theme),
    boxLine(metrics, width, theme),
    boxLine(`${theme.fog(unicode ? '↳' : '>')} ${theme.bone(ACTIVITY[stage?.phase] ?? 'warming the instruments')}`, width, theme),
    boxLine(joinSides(`${theme.moss('CANOPY')} ${radar}`, `${signal} ${theme.sky('SIGNAL NOMINAL')}`, width - 4), width, theme),
    renderBottomBorder('LEAVE NO BRANCH BEHIND', width, theme),
  ].join('\n');
}

function renderCompact(state, width, now, unicode, theme) {
  const stage = currentStage(state);
  const spinner = unicode ? SPINNER[state.frame % SPINNER.length] : spinnerAscii(state.frame);
  const ratio = progressRatio(stage);
  const elapsed = formatDuration(now - state.startedAt, true);
  return [
    renderTitleBorder('GIT GROUNDSKEEPER // DEEP SCAN', `T+${elapsed}`, width, theme),
    boxLine(joinSides(theme.leaf(`${spinner} ${(stage?.label ?? 'Initializing').toUpperCase()}`), `${formatCount(stage)}${ratio === null ? '' : `  ${formatPercent(ratio)}`}`, width - 4), width, theme),
    boxLine(renderBar(width - 4, ratio, state.frame, unicode, theme), width, theme),
    boxLine(joinSides(formatRate(stage, now, theme), `${formatPhasePosition(state)} · ${formatEta(stage, now)}`, width - 4), width, theme),
    boxLine(renderPhaseRail(state, width - 4, unicode, theme), width, theme),
    renderBottomBorder('LEAVE NO BRANCH BEHIND', width, theme),
  ].join('\n');
}

function renderTiny(state, width, now, unicode, theme) {
  const stage = currentStage(state);
  const spinner = unicode ? SPINNER[state.frame % SPINNER.length] : spinnerAscii(state.frame);
  const ratio = progressRatio(stage);
  const label = stage?.label ?? 'Initializing';
  const count = formatCount(stage);
  const elapsed = formatDuration(now - state.startedAt);
  const reserved = spinner.length + count.length + elapsed.length + 7;
  const labelWidth = Math.max(8, width - reserved);
  return fitAnsi(`${theme.leaf(spinner)} ${theme.bone(truncatePlain(label, labelWidth))} ${theme.moss(count)} ${theme.fog(elapsed)}${ratio === null ? '' : ` ${theme.sun(formatPercent(ratio))}`}`, width);
}

function renderSpatialViewport(state, width, height, unicode, theme) {
  const stage = currentStage(state);
  const ratio = progressRatio(stage);
  const phase = stage?.phase ?? 'discovery';
  const phaseTitle = SPATIAL_PHASE_TITLES[phase] ?? 'SPATIAL ARBOR';
  const right = ratio === null
    ? 'INDETERMINATE LIDAR'
    : `${stage.completed}/${stage.total} · ${formatPercent(ratio)}`;
  const innerWidth = Math.max(1, width - 4);
  const innerHeight = Math.max(1, height - 2);
  const scene = renderSpatialScene({
    width: innerWidth,
    height: innerHeight,
    frame: state.frame,
    phase,
    ratio,
    theme,
    unicode,
  });
  const footer = ratio === null
    ? 'LIDAR LIVE · SEARCHING PHASE DEPTH'
    : `LIDAR LIVE · PHASE DEPTH ${formatPercent(ratio)} · CAMERA FORWARD`;

  return [
    renderTitleBorder(`SPATIAL ARBOR // ${phaseTitle}`, right, width, theme),
    ...scene.map((line) => boxLine(line, width, theme)),
    renderBottomBorder(footer, width, theme),
  ].join('\n');
}

function renderSignalViewport(state, width, height, unicode, theme) {
  const stage = currentStage(state);
  const ratio = progressRatio(stage);
  const phase = stage?.phase ?? 'discovery';
  const phaseTitle = SIGNAL_PHASE_TITLES[phase] ?? 'CELLULAR CARTOGRAPHY';
  const right = ratio === null
    ? 'NO TOTAL // SEEKING'
    : `${stage.completed}/${stage.total} · ${formatPercent(ratio)}`;
  const innerWidth = Math.max(1, width - 4);
  const innerHeight = Math.max(1, height - 2);
  const scene = renderSignalScene({
    width: innerWidth,
    height: innerHeight,
    completed: stage?.completed,
    total: stage?.total,
    frame: state.frame,
    phase,
    ratio,
    theme,
    unicode,
  });
  const footer = ratio === null
    ? 'CELLULAR SWEEP · INDETERMINATE PHASE · NO INVENTED PERCENT'
    : `CELLULAR DEPTH ${formatPercent(ratio)} · PHASE-LOCAL SIGNAL · HARD-EDGE MOTION`;

  return [
    renderTitleBorder(`SIGNAL GARDEN // ${phaseTitle}`, right, width, theme),
    ...scene.map((line) => boxLine(line, width, theme)),
    renderBottomBorder(footer, width, theme),
  ].join('\n');
}

function renderPulseViewport(state, width, height, unicode, theme) {
  const stage = currentStage(state);
  const ratio = progressRatio(stage);
  const phase = stage?.phase ?? 'discovery';
  const phaseTitle = PULSE_PHASE_TITLES[phase] ?? 'FOREST VITALS';
  const right = ratio === null
    ? 'NO TOTAL // ACQUIRING'
    : `${stage.completed}/${stage.total} · ${formatPercent(ratio)}`;
  const innerWidth = Math.max(1, width - 4);
  const innerHeight = Math.max(1, height - 2);
  const scene = renderPulseScene({
    width: innerWidth,
    height: innerHeight,
    completed: stage?.completed,
    total: stage?.total,
    frame: state.frame,
    phase,
    ratio,
    theme,
    unicode,
  });
  const footer = ratio === null
    ? 'TRACE LIVE · INDETERMINATE RHYTHM · NO INVENTED PERCENT'
    : `TRACE LIVE · PHASE DEPTH ${formatPercent(ratio)} · CONDUCTION NOMINAL`;

  return [
    renderTitleBorder(`PULSE OBSERVATORY // ${phaseTitle}`, right, width, theme),
    ...scene.map((line) => boxLine(line, width, theme)),
    renderBottomBorder(footer, width, theme),
  ].join('\n');
}

function renderWaveViewport(state, width, height, unicode, theme) {
  const stage = currentStage(state);
  const ratio = progressRatio(stage);
  const phase = stage?.phase ?? 'discovery';
  const phaseTitle = WAVE_PHASE_TITLES[phase] ?? 'FOREST HARMONICS';
  const right = ratio === null
    ? 'NO TOTAL // ACQUIRING'
    : `${stage.completed}/${stage.total} · ${formatPercent(ratio)}`;
  const innerWidth = Math.max(1, width - 4);
  const innerHeight = Math.max(1, height - 2);
  const scene = renderWaveScene({
    width: innerWidth,
    height: innerHeight,
    completed: stage?.completed,
    total: stage?.total,
    frame: state.frame,
    phase,
    ratio,
    theme,
    unicode,
  });
  const footer = ratio === null
    ? 'WAVE LIVE · INDETERMINATE SWEEP · NO INVENTED PERCENT'
    : `WAVE LIVE · PHASE DEPTH ${formatPercent(ratio)} · CRESTS AMBIENT`;

  return [
    renderTitleBorder(`CENTRE WAVE // ${phaseTitle}`, right, width, theme),
    ...scene.map((line) => boxLine(line, width, theme)),
    renderBottomBorder(footer, width, theme),
  ].join('\n');
}

function renderCompletionSummary(state, options) {
  const theme = createTheme(options.color === true);
  const mark = options.unicode ? '◆' : 'OK';
  const total = Number.isInteger(state.finalTotal)
    ? ` · ${state.finalTotal} ${state.finalTotal === 1 ? 'repository' : 'repositories'} analyzed`
    : '';
  return `${theme.leaf(mark)} ${theme.bold('FOREST MAPPED')}${theme.fog(total)} ${theme.sun(`· ${formatDuration((state.completedAt ?? Date.now()) - state.startedAt, true)}`)}`;
}

function renderPlainProgressLine(event, columns) {
  const maxWidth = Math.max(1, columns - 1);
  const inventoryPrefix = renderInventoryPrefix(event).slice(0, maxWidth);
  const contentWidth = maxWidth - inventoryPrefix.length;
  if (!Number.isInteger(event.completed) || !Number.isInteger(event.total)) {
    const details = event.phase === 'discovery' && Number.isInteger(event.visitedDirectories)
      ? ` · ${event.visitedDirectories} dirs · ${event.discoveredRepositories ?? 0} repos`
      : '';
    return `${inventoryPrefix}${`${event.label}${details}`.slice(0, contentWidth)}`;
  }

  const count = `${event.completed}/${event.total}`;
  const available = contentWidth - event.label.length - count.length - 5;
  const barWidth = Math.max(8, Math.min(30, available));
  const ratio = event.total === 0 ? 1 : Math.min(1, event.completed / event.total);
  const filled = Math.round(ratio * barWidth);
  const progress = `${event.label} [${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}] ${count}`;
  return `${inventoryPrefix}${progress.slice(0, contentWidth)}`;
}

function renderInventoryPrefix(event) {
  if (!Number.isInteger(event.inventoryRoots)) return '';
  const counters = [
    event.inventoryRoots,
    event.inventoryRepositories,
    event.inventoryWorktrees,
  ].map((value) => Number.isInteger(value) ? value : '-');
  return `inventory=${counters.join(',')} | `;
}

function renderPhaseRail(state, width, unicode, theme) {
  const phases = visiblePhases(state);
  const activeIndex = phases.findIndex(({ id }) => id === state.activePhase);
  const separator = theme.fog(unicode ? ' ━ ' : ' - ');
  const nodes = phases.map((phase, index) => {
    const seen = state.stages.get(phase.id);
    const icon = index < activeIndex || seen?.status === 'done'
      ? unicode ? '◆' : '+'
      : index === activeIndex
        ? unicode ? '◉' : '*'
        : unicode ? '◇' : '.';
    const paint = index < activeIndex || seen?.status === 'done'
      ? theme.moss
      : index === activeIndex
        ? theme.sun
        : theme.fog;
    return paint(`${icon} ${phase.short}`);
  });
  return fitAnsi(nodes.join(separator), width);
}

function renderBar(width, ratio, frame, unicode, theme) {
  const full = unicode ? '█' : '#';
  const empty = unicode ? '░' : '-';
  if (ratio === null) {
    const beamWidth = Math.min(10, Math.max(5, Math.floor(width / 5)));
    const travel = width + beamWidth;
    const head = frame % travel;
    let output = '';
    for (let index = 0; index < width; index += 1) {
      const distance = head - index;
      output += distance >= 0 && distance < beamWidth
        ? theme.sun(distance === 0 ? full : unicode ? '▓' : '#')
        : theme.fog(empty);
    }
    return output;
  }

  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  let output = '';
  for (let index = 0; index < width; index += 1) {
    if (index < filled) {
      const mix = width <= 1 ? 0 : index / (width - 1);
      output += theme.gradient(full, mix);
    } else {
      output += theme.fog(empty);
    }
  }
  return output;
}

function renderRadar(width, frame, unicode, theme) {
  if (!unicode) {
    const head = frame % width;
    return Array.from({ length: width }, (_, index) => index === head ? theme.sun('O') : index % 7 === 2 ? theme.moss('^') : theme.fog('.')).join('');
  }

  const head = frame % width;
  return Array.from({ length: width }, (_, index) => {
    const behind = (head - index + width) % width;
    if (behind === 0) return theme.sun('●');
    if (behind === 1 || behind === 2) return theme.sky('━');
    if ((index * 7 + 3) % 13 === 0) return theme.moss('♠');
    return theme.fog('·');
  }).join('');
}

function renderSignal(width, frame, unicode, theme) {
  if (!unicode) {
    return Array.from({ length: width }, (_, index) => theme.moss(String((index + frame) % 4))).join('');
  }
  return Array.from({ length: width }, (_, index) => {
    const level = Math.abs(((index * 3 + frame) % 14) - 7);
    return theme.moss(SPARK[Math.min(7, level)]);
  }).join('');
}

function renderTitleBorder(left, right, width, theme) {
  const start = `╭─ ${left} `;
  const end = ` ${right} ─╮`;
  const available = Math.max(1, width - start.length - end.length);
  const fittedLeft = available === 1 && start.length + end.length > width
    ? truncatePlain(left, Math.max(4, width - right.length - 9))
    : left;
  const fittedStart = `╭─ ${fittedLeft} `;
  const fill = Math.max(1, width - fittedStart.length - end.length);
  return fitAnsi(`${theme.moss(fittedStart)}${theme.fog('─'.repeat(fill))}${theme.sun(end)}`, width);
}

function renderBottomBorder(label, width, theme) {
  const middle = ` ${label} `;
  const fill = Math.max(1, width - middle.length - 2);
  const left = Math.floor(fill / 2);
  const right = fill - left;
  return fitAnsi(`${theme.moss(`╰${'─'.repeat(left)}`)}${theme.sun(middle)}${theme.moss(`${'─'.repeat(right)}╯`)}`, width);
}

function divider(width, theme) {
  return theme.fog(`├${'─'.repeat(Math.max(1, width - 2))}┤`);
}

function boxLine(content, width, theme) {
  return `${theme.fog('│')} ${padAnsi(content, Math.max(1, width - 4))} ${theme.fog('│')}`;
}

function joinSides(left, right, width) {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 1 > width) {
    const keptLeft = Math.max(1, width - rightWidth - 1);
    return `${fitAnsi(left, keptLeft)} ${fitAnsi(right, Math.max(1, width - keptLeft - 1))}`;
  }
  return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
}

function formatCount(stage) {
  if (!stage) return 'warming up';
  if (Number.isInteger(stage.completed) && Number.isInteger(stage.total)) {
    return `${stage.completed} / ${stage.total}`;
  }
  if (stage.phase === 'discovery' && Number.isInteger(stage.visitedDirectories)) {
    return `${stage.visitedDirectories} dirs · ${stage.discoveredRepositories ?? 0} repos`;
  }
  return 'mapping signal';
}

function formatRate(stage, now, theme) {
  const rate = stageRate(stage, now);
  if (rate === null) return theme.fog('RATE warming');
  const unit = PHASES.find(({ id }) => id === stage.phase)?.unit ?? 'items/s';
  return `${theme.fog('RATE')} ${theme.sky(formatDecimal(rate))} ${theme.fog(unit)}`;
}

function formatEta(stage, now) {
  const ratio = progressRatio(stage);
  if (ratio === null || ratio <= 0 || ratio >= 1) return ratio === 1 ? 'ETA done' : 'ETA --';
  const elapsed = now - stage.startedAt;
  return `ETA ${formatDuration((elapsed / ratio) * (1 - ratio))}`;
}

function formatPhasePosition(state) {
  const phases = visiblePhases(state);
  const index = Math.max(0, phases.findIndex(({ id }) => id === state.activePhase));
  return `PHASE ${index + 1}/${phases.length}`;
}

function stageRate(stage, now) {
  if (!stage || !Number.isInteger(stage.completed)) return null;
  const samples = stage.samples ?? [];
  if (samples.length >= 2) {
    const first = samples[0];
    const last = samples.at(-1);
    const seconds = (last.at - first.at) / 1000;
    const delta = last.completed - first.completed;
    if (seconds > 0 && delta > 0) return delta / seconds;
  }
  const seconds = (now - stage.startedAt) / 1000;
  return seconds > 0 && stage.completed > 0 ? stage.completed / seconds : null;
}

function progressRatio(stage) {
  if (!stage || !Number.isInteger(stage.completed) || !Number.isInteger(stage.total)) return null;
  if (stage.total === 0) return 1;
  return Math.max(0, Math.min(1, stage.completed / stage.total));
}

function currentStage(state) {
  return state.stages.get(state.activePhase) ?? null;
}

function visiblePhases(state) {
  return PHASES.filter((phase) => phase.id !== 'owners' || state.stages.has('owners'));
}

function normalizeEvent(event) {
  return {
    ...event,
    phase: LEGACY_PHASES.get(event.phase) ?? event.phase,
  };
}

function plainMilestone(event) {
  if (!Number.isInteger(event.completed) || !Number.isInteger(event.total) || event.total === 0) {
    if (event.phase === 'discovery' && Number.isInteger(event.visitedDirectories)) {
      return `${event.phase}:${Math.floor(event.visitedDirectories / 250)}`;
    }
    return `${event.phase}:start`;
  }
  return `${event.phase}:${Math.floor((event.completed / event.total) * 4)}`;
}

function eraseLines(count) {
  if (count <= 0) return '';
  let output = '\r\u001b[2K';
  for (let index = 1; index < count; index += 1) {
    output += '\u001b[1A\r\u001b[2K';
  }
  return output;
}

function createTheme(enabled) {
  const paint = (value, color, prefix = '') => enabled
    ? `\u001b[${prefix}${prefix ? ';' : ''}38;2;${color.join(';')}m${value}\u001b[0m`
    : String(value);
  return {
    leaf: (value) => paint(value, PALETTE.leaf, '1'),
    moss: (value) => paint(value, PALETTE.moss),
    pine: (value) => paint(value, PALETTE.pine),
    fern: (value) => paint(value, PALETTE.fern),
    mint: (value) => paint(value, PALETTE.mint),
    sun: (value) => paint(value, PALETTE.sun, '1'),
    sky: (value) => paint(value, PALETTE.sky),
    bone: (value) => paint(value, PALETTE.bone),
    fog: (value) => paint(value, PALETTE.fog, '2'),
    bark: (value) => paint(value, PALETTE.bark),
    orchid: (value) => paint(value, PALETTE.orchid),
    bold: (value) => enabled ? `\u001b[1m${value}\u001b[0m` : String(value),
    gradient: (value, mix) => {
      if (!enabled) return String(value);
      const color = PALETTE.leaf.map((channel, index) =>
        Math.round(channel + (PALETTE.sun[index] - channel) * mix));
      return paint(value, color);
    },
  };
}

function padAnsi(value, width) {
  const fitted = fitAnsi(value, width);
  return `${fitted}${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function fitAnsi(value, width) {
  if (width <= 0) return '';
  if (visibleWidth(value) <= width) return value;

  const hasAnsi = value.includes('\u001b[');
  let output = '';
  let visible = 0;
  for (let index = 0; index < value.length && visible < width; ) {
    if (value[index] === '\u001b') {
      const match = value.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const codePoint = String.fromCodePoint(value.codePointAt(index));
    output += codePoint;
    index += codePoint.length;
    visible += 1;
  }
  return hasAnsi ? `${output}\u001b[0m` : output;
}

function visibleWidth(value) {
  return [...stripAnsi(value)].length;
}

function truncatePlain(value, width) {
  const chars = [...String(value)];
  if (chars.length <= width) return chars.join('');
  if (width <= 1) return chars.slice(0, width).join('');
  return `${chars.slice(0, width - 1).join('')}…`;
}

function supportsUnicode(env) {
  const locale = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`.toLowerCase();
  return !locale || locale.includes('utf') || process.platform === 'darwin';
}

function formatDuration(milliseconds, tenths = false) {
  const safe = Math.max(0, milliseconds);
  const totalSeconds = safe / 1000;
  if (totalSeconds < 60) {
    return tenths ? `${totalSeconds.toFixed(1)}s` : `${Math.ceil(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(ratio >= 1 ? 0 : 1)}%`;
}

function formatDecimal(value) {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1);
}

function spinnerAscii(frame) {
  return ['|', '/', '-', '\\'][frame % 4];
}
