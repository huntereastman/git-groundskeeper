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

const HEX = '0123456789ABCDEF';

/**
 * Render a deterministic matrix of cell-based signal instruments.
 *
 * The scene borrows the grammar of terminal motion studies rather than their
 * literal artwork: one shared lattice, discrete luminance states, hard-edged
 * trails, phase-offset fields, and progress-driven commit boundaries. Known
 * progress never advances on the frame clock. Indeterminate phases animate a
 * clearly labelled sweep without manufacturing a completion percentage.
 */
export function renderSignalScene(options = {}) {
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

  if (width < 48 || height < 12) {
    drawCompactSignal(scene);
  } else {
    drawInstrumentMatrix(scene);
  }

  return scene.canvas.map((row) => paintRow(row, scene.theme));
}

function drawInstrumentMatrix(scene) {
  const splitX = Math.floor(scene.width / 2);
  const splitY = Math.floor(scene.height / 2);
  const panels = [
    panel(0, 0, splitX + 1, splitY + 1, 'LINE SCAN'),
    panel(splitX, 0, scene.width - splitX, splitY + 1, 'CENTRE WAVE'),
    panel(0, splitY, splitX + 1, scene.height - splitY, registerTitle(scene)),
    panel(splitX, splitY, scene.width - splitX, scene.height - splitY, 'ARROW FIELD'),
  ];

  for (const item of panels) drawPanelFrame(scene, item);
  drawLineScan(scene, inset(panels[0]));
  drawCentreWave(scene, inset(panels[1]));
  drawRegister(scene, inset(panels[2]));
  drawArrowField(scene, inset(panels[3]));
}

function drawCompactSignal(scene) {
  const outer = panel(0, 0, scene.width, scene.height, compactTitle(scene));
  drawPanelFrame(scene, outer);
  const inner = inset(outer);
  if (inner.width <= 0 || inner.height <= 0) return;

  const scanHeight = Math.max(1, Math.floor(inner.height / 3));
  drawLineScan(scene, {
    x: inner.x,
    y: inner.y,
    width: inner.width,
    height: scanHeight,
  });

  const fieldY = inner.y + scanHeight;
  const fieldHeight = Math.max(0, inner.height - scanHeight);
  if (fieldHeight > 0) {
    drawArrowField(scene, {
      x: inner.x,
      y: fieldY,
      width: inner.width,
      height: fieldHeight,
    });
  }
}

function drawLineScan(scene, rect) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const y = rect.y + Math.floor(rect.height / 2);
  const cycle = rect.width + 16;
  const head = scene.ratio === null
    ? (positiveMod(scene.frame, cycle) - 8)
    : Math.round(scene.ratio * Math.max(0, rect.width - 1));

  for (let offset = 0; offset < rect.width; offset += 1) {
    const x = rect.x + offset;
    const marker = (offset + phaseSeed(scene.phase)) % 6 === 0 ? ':' : '.';
    put(scene, x, y, marker, 'fog', 2);
  }

  const trail = [
    { char: scene.frame % 6 < 3 ? '#' : '@', tone: 'bone' },
    { char: '#', tone: 'leaf' },
    { char: '=', tone: 'sky' },
    { char: '-', tone: 'moss' },
    { char: '-', tone: 'moss' },
    { char: '.', tone: 'fog' },
    { char: '.', tone: 'fog' },
  ];
  for (let age = 0; age < trail.length; age += 1) {
    const x = rect.x + head - age;
    const state = trail[age];
    put(scene, x, y, state.char, state.tone, 20 - age);
  }

  if (rect.height >= 4) {
    const status = scene.ratio === null
      ? 'NO TOTAL // SIGNAL SEEK'
      : `PHASE DEPTH ${formatPercent(scene.ratio)}`;
    drawText(scene, rect.x, rect.y + rect.height - 1, status.slice(0, rect.width), scene.ratio === null ? 'sky' : 'leaf', 24);
  }
}

function drawCentreWave(scene, rect) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const phase = scene.frame * 0.17 + phaseSeed(scene.phase) * 0.07;
  const midX = rect.x + (rect.width - 1) / 2;
  const midY = (rect.height - 1) / 2;

  for (let row = 0; row < rect.height; row += 1) {
    const relativeY = row - midY;
    const rowPhase = relativeY * 0.72;
    const center = midX
      + Math.sin(phase * 0.43 + rowPhase) * rect.width * 0.075
      + Math.sin(phase * 0.19 - rowPhase * 0.35) * rect.width * 0.035;
    const breath = (Math.sin(phase * 0.31 - Math.abs(relativeY) * 0.56) + 1) / 2;
    const span = Math.max(1, rect.width * (0.12 + breath * 0.22));

    for (let column = 0; column < rect.width; column += 1) {
      const x = rect.x + column;
      const distance = Math.abs(x - center);
      if (distance > span) continue;
      const energy = 1 - distance / span;
      const ridge = Math.abs(Math.sin((column + row * 3) * 0.31 + phase * 0.8));
      const char = energy > 0.78 ? '#' : energy > 0.42 ? '=' : '-';
      const tone = energy > 0.82 && ridge > 0.72
        ? 'bone'
        : energy > 0.58
          ? 'leaf'
          : energy > 0.28
            ? 'moss'
            : 'fog';
      put(scene, x, rect.y + row, char, tone, 8 + Math.round(energy * 5));
    }
  }
}

function drawRegister(scene, rect) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const cellCount = rect.width * rect.height;
  const committed = scene.ratio === null
    ? positiveMod(scene.frame * Math.max(1, Math.floor(rect.width / 9)), cellCount + rect.width)
    : Math.round(scene.ratio * cellCount);
  const seed = phaseSeed(scene.phase);

  for (let row = 0; row < rect.height; row += 1) {
    const settledDigit = HEX[(seed + row * 5) % HEX.length];
    for (let column = 0; column < rect.width; column += 1) {
      const index = row * rect.width + column;
      const distance = committed - index;
      const isHead = distance === 0;
      const isTransition = distance > 0 && distance <= 3;
      const isCommitted = distance > 0;
      const glyph = isTransition
        ? HEX[(seed + row + column + scene.frame + distance) % HEX.length]
        : settledDigit;
      const tone = isHead
        ? scene.frame % 6 < 3 ? 'bone' : 'leaf'
        : isTransition
          ? 'sky'
          : isCommitted
            ? row % 3 === 0 ? 'leaf' : 'moss'
            : 'fog';
      put(scene, rect.x + column, rect.y + row, glyph, tone, isHead ? 20 : isTransition ? 15 : 6);
    }
  }
}

function drawArrowField(scene, rect) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const targetColumn = scene.ratio === null
    ? positiveMod(scene.frame, Math.max(1, rect.width))
    : Math.round(scene.ratio * Math.max(0, rect.width - 1));
  const targetX = rect.x + targetColumn;
  const targetY = rect.y + (rect.height - 1) / 2
    + Math.sin(scene.frame * 0.13 + phaseSeed(scene.phase)) * Math.max(0, rect.height - 1) * 0.2;

  for (let row = 0; row < rect.height; row += 1) {
    for (let column = 0; column < rect.width; column += 1) {
      const x = rect.x + column;
      const y = rect.y + row;
      const dx = targetX - x;
      const dy = targetY - y;
      const nearBeacon = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
      const powered = scene.ratio === null
        ? Math.abs(dx) <= Math.max(1, Math.floor(rect.width / 12))
        : column <= targetColumn;
      const frontier = Math.abs(column - targetColumn) <= 1;
      const tone = nearBeacon
        ? 'bone'
        : frontier
          ? scene.frame % 8 < 4 ? 'bone' : 'sky'
          : powered
            ? ((row + column + scene.frame) % 11 === 0 ? 'leaf' : 'moss')
            : 'fog';
      put(scene, x, y, vectorGlyph(dx, dy), tone, nearBeacon ? 18 : frontier ? 14 : 5);
    }
  }

  put(scene, targetX, Math.round(targetY), scene.frame % 6 < 3 ? '*' : '+', 'bone', 24);
}

function drawPanelFrame(scene, item) {
  if (item.width <= 0 || item.height <= 0) return;
  const right = item.x + item.width - 1;
  const bottom = item.y + item.height - 1;

  for (let x = item.x; x <= right; x += 1) {
    const topChar = x === item.x || x === right ? '+' : '-';
    put(scene, x, item.y, topChar, x === item.x ? 'moss' : 'fog', 100);
    if (bottom !== item.y) {
      put(scene, x, bottom, topChar, x === right ? 'moss' : 'fog', 100);
    }
  }
  for (let y = item.y + 1; y < bottom; y += 1) {
    put(scene, item.x, y, '|', 'moss', 100);
    if (right !== item.x) put(scene, right, y, '|', 'moss', 100);
  }

  if (item.width >= 8) {
    const label = ` ${item.title} `.slice(0, Math.max(0, item.width - 4));
    drawText(scene, item.x + 2, item.y, label, 'bone', 110);
  }
}

function registerTitle(scene) {
  if (scene.completed === null || scene.total === null) return 'PHASE REGISTER';
  return `REGISTER ${scene.completed}/${scene.total}`;
}

function compactTitle(scene) {
  if (scene.ratio === null) return `SIGNAL GARDEN // ${scene.phase} // SEEK`;
  return `SIGNAL GARDEN // ${scene.phase} // ${formatPercent(scene.ratio)}`;
}

function vectorGlyph(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 0.75 && ay < 0.75) return '*';
  if (ax > ay * 1.7) return dx > 0 ? '>' : '<';
  if (ay > ax * 1.7) return dy > 0 ? 'v' : '^';
  return dx * dy >= 0 ? '\\' : '/';
}

function panel(x, y, width, height, title) {
  return { x, y, width, height, title };
}

function inset(item) {
  return {
    x: item.x + 1,
    y: item.y + 1,
    width: Math.max(0, item.width - 2),
    height: Math.max(0, item.height - 2),
  };
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

function phaseSeed(value) {
  let seed = 0;
  for (const char of String(value)) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return seed;
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
