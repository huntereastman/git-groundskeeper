const TONES = new Set([
  'fog',
  'moss',
  'leaf',
  'bone',
  'sky',
  'sun',
  'bark',
  'orchid',
]);

const BEAT_WIDTH = 46;

/**
 * Render a deterministic ECG-inspired progress instrument.
 *
 * The waveform is ambient and may keep moving while a phase waits. The gate,
 * illuminated history, count, and percentage are derived only from observed
 * phase progress. Indeterminate phases use a travelling acquisition gate and
 * never expose a made-up completion value.
 */
export function renderPulseScene(options = {}) {
  const width = dimension(options.width);
  const height = dimension(options.height);
  if (height === 0) return [];
  if (width === 0) return Array.from({ length: height }, () => '');

  const scene = {
    canvas: createCanvas(width, height),
    completed: Number.isInteger(options.completed) ? options.completed : null,
    frame: Number.isFinite(options.frame) ? Math.floor(options.frame) : 0,
    height,
    phase: asciiLabel(options.phase ?? 'survey', 18),
    ratio: Number.isFinite(options.ratio) ? clamp(options.ratio, 0, 1) : null,
    theme: normalizeTheme(options.theme),
    total: Number.isInteger(options.total) ? options.total : null,
    width,
  };

  if (width < 28 || height < 7) {
    drawMicroPulse(scene);
  } else {
    drawPulseFrame(scene);
  }

  return scene.canvas.map((row) => paintRow(row, scene.theme));
}

function drawPulseFrame(scene) {
  drawFrame(scene);

  const plot = {
    x: 2,
    y: 2,
    width: Math.max(1, scene.width - 4),
    height: Math.max(1, scene.height - 4),
  };
  drawTimingGrid(scene, plot);
  drawBaseline(scene, plot);
  drawWaveform(scene, plot);
  drawProgressGate(scene, plot);
  drawBeatReadouts(scene, plot);
}

function drawTimingGrid(scene, plot) {
  const verticalStep = Math.max(6, Math.min(12, Math.floor(plot.width / 10)));
  const horizontalStep = Math.max(3, Math.min(5, Math.floor(plot.height / 4)));

  for (let row = 0; row < plot.height; row += 1) {
    for (let column = 0; column < plot.width; column += 1) {
      const vertical = column % verticalStep === 0;
      const horizontal = row % horizontalStep === 0;
      if (!vertical && !horizontal) continue;
      const char = vertical && horizontal ? '+' : vertical ? ':' : '.';
      put(scene, plot.x + column, plot.y + row, char, 'fog', 1);
    }
  }
}

function drawBaseline(scene, plot) {
  const y = baselineY(plot);
  for (let column = 0; column < plot.width; column += 1) {
    const char = column % 8 === 0 ? '+' : column % 2 === 0 ? '-' : '.';
    put(scene, plot.x + column, y, char, 'fog', 3);
  }
}

function drawWaveform(scene, plot) {
  const baseline = baselineY(plot);
  const verticalScale = Math.max(2, Math.floor(plot.height * 0.38));
  let previousY = null;

  for (let column = 0; column < plot.width; column += 1) {
    const sample = column + scene.frame;
    const amplitude = ecgAmplitude(positiveMod(sample, BEAT_WIDTH));
    const y = clamp(
      baseline - Math.round(amplitude * verticalScale),
      plot.y,
      plot.y + plot.height - 1,
    );
    const x = plot.x + column;
    const tone = waveformTone(scene, plot, column, amplitude);

    if (previousY === null) {
      put(scene, x, y, '-', tone, 14);
      previousY = y;
      continue;
    }

    const delta = y - previousY;
    const char = delta < 0 ? '/' : delta > 0 ? '\\' : '-';
    drawVerticalConnection(scene, x, previousY, y, tone);
    put(scene, x, y, Math.abs(amplitude) > 0.78 ? '^' : char, tone, 16);

    if (amplitude > 0.78 && plot.height >= 9) {
      for (let echoY = plot.y; echoY < y - 1; echoY += 2) {
        put(scene, x, echoY, ':', 'fog', 4);
      }
    }
    previousY = y;
  }
}

function drawProgressGate(scene, plot) {
  const gateColumn = progressColumn(scene, plot.width);
  const x = plot.x + gateColumn;
  const pulse = scene.frame % 8 < 4;

  for (let row = 0; row < plot.height; row += 1) {
    const y = plot.y + row;
    const char = row % 3 === 0 ? ':' : '.';
    put(scene, x, y, char, pulse ? 'sky' : 'leaf', 20);
  }

  const sample = gateColumn + scene.frame;
  const y = clamp(
    baselineY(plot) - Math.round(ecgAmplitude(positiveMod(sample, BEAT_WIDTH)) * Math.max(2, Math.floor(plot.height * 0.38))),
    plot.y,
    plot.y + plot.height - 1,
  );
  put(scene, x, y, pulse ? '*' : '+', 'bone', 30);
  if (x > plot.x) put(scene, x - 1, y, '<', 'sky', 24);
  if (x < plot.x + plot.width - 1) put(scene, x + 1, y, '>', 'sky', 24);
}

function drawBeatReadouts(scene, plot) {
  if (plot.width < 24 || plot.height < 5) return;
  const lock = scene.ratio === null ? 'ACQUIRING' : 'PHASE LOCK';
  drawText(scene, plot.x + 1, plot.y, `LEAD 01 // ${lock}`, scene.ratio === null ? 'sky' : 'leaf', 40);

  const right = scene.ratio === null
    ? 'NO TOTAL'
    : `DEPTH ${formatPercent(scene.ratio)}`;
  drawText(
    scene,
    Math.max(plot.x + 1, plot.x + plot.width - right.length - 1),
    plot.y,
    right,
    scene.ratio === null ? 'fog' : 'bone',
    40,
  );

  if (plot.height >= 8) {
    const beat = positiveMod(scene.frame, BEAT_WIDTH);
    const phase = beat < 8
      ? 'REST'
      : beat < 15
        ? 'P-WAVE'
        : beat < 23
          ? 'QRS'
          : beat < 38
            ? 'T-WAVE'
            : 'REST';
    const rhythm = `RHYTHM:${phase}`;
    drawText(scene, plot.x + 1, plot.y + plot.height - 1, rhythm, phase === 'QRS' ? 'bone' : 'moss', 40);
  }
}

function drawFrame(scene) {
  if (scene.width === 1) {
    for (let y = 0; y < scene.height; y += 1) put(scene, 0, y, '|', 'moss', 100);
    return;
  }

  const bottom = scene.height - 1;
  for (let x = 0; x < scene.width; x += 1) {
    const char = x === 0 || x === scene.width - 1 ? '+' : '-';
    put(scene, x, 0, char, x === 0 ? 'moss' : 'fog', 100);
    if (bottom > 0) put(scene, x, bottom, char, x === scene.width - 1 ? 'moss' : 'fog', 100);
  }
  for (let y = 1; y < bottom; y += 1) {
    put(scene, 0, y, '|', 'moss', 100);
    put(scene, scene.width - 1, y, '|', 'moss', 100);
  }

  const title = scene.width >= 54
    ? ` PULSE OBSERVATORY // ${scene.phase} `
    : ' PULSE OBSERVATORY ';
  overlayBorderLabel(scene, 0, title, 'bone');
  const footer = scene.ratio === null
    ? ' RHYTHM LIVE // NO TOTAL '
    : ` SINUS RHYTHM // ${countLabel(scene)} `;
  if (bottom > 0) overlayBorderLabel(scene, bottom, footer, scene.ratio === null ? 'sky' : 'leaf');
}

function drawMicroPulse(scene) {
  const y = Math.floor(scene.height / 2);
  const gate = progressColumn(scene, scene.width);
  for (let x = 0; x < scene.width; x += 1) {
    const sample = x + scene.frame;
    const amplitude = ecgAmplitude(positiveMod(sample, BEAT_WIDTH));
    const char = Math.abs(amplitude) > 0.7 ? '^' : x % 2 === 0 ? '-' : '.';
    const tone = Math.abs(x - gate) <= 1 ? 'bone' : x <= gate ? 'moss' : 'fog';
    put(scene, x, y, char, tone, 8);
  }
  put(scene, gate, y, '*', 'sky', 20);

  if (scene.height >= 2) {
    const title = scene.ratio === null ? 'PULSE // SEEK' : `PULSE // ${formatPercent(scene.ratio)}`;
    drawText(scene, 0, 0, title.slice(0, scene.width), scene.ratio === null ? 'sky' : 'leaf', 30);
  }
}

function waveformTone(scene, plot, column, amplitude) {
  const gate = progressColumn(scene, plot.width);
  const peak = Math.abs(amplitude) > 0.72;
  if (Math.abs(column - gate) <= 1) return peak ? 'bone' : 'sky';
  if (scene.ratio === null) {
    const behind = gate - column;
    if (behind >= 0 && behind <= Math.max(4, Math.floor(plot.width / 9))) {
      return peak ? 'bone' : behind <= 2 ? 'leaf' : 'moss';
    }
    return 'fog';
  }
  if (column <= gate) return peak ? 'bone' : (column + scene.frame) % 13 === 0 ? 'leaf' : 'moss';
  return 'fog';
}

function progressColumn(scene, width) {
  if (width <= 1) return 0;
  if (scene.ratio !== null) return Math.round(scene.ratio * (width - 1));
  const cycle = width * 2 - 2;
  const cursor = positiveMod(scene.frame, Math.max(1, cycle));
  return cursor < width ? cursor : cycle - cursor;
}

function baselineY(plot) {
  return plot.y + Math.round((plot.height - 1) * 0.62);
}

function ecgAmplitude(sample) {
  if (sample < 7) return 0;
  if (sample < 10) return interpolate(sample, 7, 10, 0, 0.18);
  if (sample < 13) return interpolate(sample, 10, 13, 0.18, 0);
  if (sample < 17) return 0;
  if (sample < 18) return -0.12;
  if (sample < 19) return 0.92;
  if (sample < 20) return -0.34;
  if (sample < 22) return interpolate(sample, 20, 22, -0.34, 0);
  if (sample < 27) return 0;
  if (sample < 32) return interpolate(sample, 27, 32, 0, 0.28);
  if (sample < 37) return interpolate(sample, 32, 37, 0.28, 0);
  return 0;
}

function drawVerticalConnection(scene, x, fromY, toY, tone) {
  if (fromY === toY) return;
  const start = Math.min(fromY, toY);
  const end = Math.max(fromY, toY);
  for (let y = start + 1; y < end; y += 1) {
    put(scene, x, y, '|', tone, 15);
  }
}

function overlayBorderLabel(scene, y, label, tone) {
  if (scene.width < 5) return;
  const fitted = label.slice(0, Math.max(0, scene.width - 4));
  const start = Math.max(2, Math.floor((scene.width - fitted.length) / 2));
  drawText(scene, start, y, fitted, tone, 110);
}

function countLabel(scene) {
  if (scene.completed === null || scene.total === null) return 'PHASE LOCK';
  return `${scene.completed}/${scene.total} // ${formatPercent(scene.ratio)}`;
}

function createCanvas(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: ' ', priority: -1, tone: 'fog' })));
}

function put(scene, x, y, char, tone, priority) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (iy < 0 || iy >= scene.height || ix < 0 || ix >= scene.width) return;
  const cell = scene.canvas[iy][ix];
  if (priority < cell.priority) return;
  cell.char = asciiChar(char);
  cell.tone = TONES.has(tone) ? tone : 'bone';
  cell.priority = priority;
}

function drawText(scene, x, y, value, tone, priority) {
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    put(scene, x + index, y, text[index], tone, priority);
  }
}

function paintRow(row, theme) {
  if (row.length === 0) return '';
  let output = '';
  let run = row[0].char;
  let tone = row[0].tone;
  for (let index = 1; index < row.length; index += 1) {
    const cell = row[index];
    if (cell.tone === tone) {
      run += cell.char;
    } else {
      output += theme[tone](run);
      tone = cell.tone;
      run = cell.char;
    }
  }
  return `${output}${theme[tone](run)}`;
}

function normalizeTheme(theme = {}) {
  const identity = (value) => String(value);
  return Object.fromEntries([...TONES].map((tone) => [
    tone,
    typeof theme[tone] === 'function' ? theme[tone] : identity,
  ]));
}

function asciiLabel(value, width) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, width) || 'SURVEY';
}

function asciiChar(value) {
  const char = String(value || ' ')[0] ?? ' ';
  const code = char.charCodeAt(0);
  return code >= 32 && code <= 126 ? char : '?';
}

function interpolate(value, from, to, start, end) {
  const mix = (value - from) / Math.max(1, to - from);
  return start + (end - start) * mix;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(value >= 1 ? 0 : 1)}%`;
}

function dimension(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveMod(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
