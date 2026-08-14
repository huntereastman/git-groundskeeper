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

/**
 * Render a deterministic, phase-offset field inspired by the Centre Wave
 * motion study. The wave geometry is ambient; only the vertical phase gate is
 * progress-bearing. Discovery substitutes a travelling acquisition gate and
 * labels it explicitly instead of manufacturing a percentage.
 */
export function renderWaveScene(options = {}) {
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
    drawCompactWave(scene);
  } else {
    drawWaveArray(scene);
  }

  return scene.canvas.map((row) => paintRow(row, scene.theme));
}

function drawWaveArray(scene) {
  const gate = phaseGate(scene, scene.width);
  drawSides(
    scene,
    0,
    `INTERFERENCE FIELD // ${scene.phase}`,
    scene.ratio === null
      ? 'NO TOTAL // ACQUIRING'
      : `${formatCount(scene)} // ${formatPercent(scene.ratio)}`,
    'bone',
    scene.ratio === null ? 'sky' : 'leaf',
  );
  drawRule(scene, 1, gate, scene.ratio === null ? 'sky' : 'leaf');

  const plot = {
    x: 0,
    y: 2,
    width: scene.width,
    height: Math.max(0, scene.height - 5),
  };
  drawWaveField(scene, plot, gate, 2);

  drawRule(scene, scene.height - 3, gate, scene.ratio === null ? 'sky' : 'leaf');
  drawSides(
    scene,
    scene.height - 2,
    'ROW PHASE OFFSET // BLACK CHANNELS LIVE',
    scene.ratio === null ? 'ACQUISITION SWEEP' : `PHASE GATE ${formatPercent(scene.ratio)}`,
    'fog',
    scene.ratio === null ? 'sky' : 'leaf',
  );
  drawSides(
    scene,
    scene.height - 1,
    `HARMONIC ${String(phaseSeed(scene.phase) % 97).padStart(2, '0')} // CRESTS AMBIENT`,
    scene.ratio === null ? 'DEPTH UNRESOLVED' : 'DEPTH LOCKED',
    'moss',
    scene.ratio === null ? 'fog' : 'bone',
  );
}

function drawCompactWave(scene) {
  const gate = phaseGate(scene, scene.width);
  const title = scene.ratio === null
    ? `CENTRE WAVE // ${scene.phase} // SEEK`
    : `CENTRE WAVE // ${scene.phase} // ${formatPercent(scene.ratio)}`;
  drawText(scene, 0, 0, title.slice(0, scene.width), 'bone', 80);

  const plot = {
    x: 0,
    y: 1,
    width: scene.width,
    height: Math.max(0, scene.height - 2),
  };
  drawWaveField(scene, plot, gate, scene.height >= 7 ? 2 : 3);

  const status = scene.ratio === null
    ? 'NO TOTAL // ACQUISITION SWEEP'
    : `${formatCount(scene)} // PHASE GATE ${formatPercent(scene.ratio)}`;
  drawText(scene, 0, scene.height - 1, status.slice(0, scene.width), scene.ratio === null ? 'sky' : 'leaf', 90);
}

function drawWaveField(scene, rect, gate, channelStride) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const time = scene.frame * 0.16 + phaseSeed(scene.phase) * 0.013;
  const middleX = rect.x + (rect.width - 1) / 2;
  const bandCount = Math.max(1, Math.ceil(rect.height / channelStride));
  const middleBand = (bandCount - 1) / 2;

  for (let row = 0; row < rect.height; row += 1) {
    const y = rect.y + row;
    const channel = row % channelStride !== 0;
    if (channel) {
      drawGateCell(scene, gate, y, row === Math.floor(rect.height / 2));
      continue;
    }

    const band = Math.floor(row / channelStride);
    const relativeBand = band - middleBand;
    const rowPhase = relativeBand * 0.73;
    const verticalNorm = middleBand === 0 ? 0 : relativeBand / middleBand;
    const center = middleX
      + Math.sin(time * 0.41 + rowPhase) * rect.width * 0.065
      + Math.sin(time * 0.17 - rowPhase * 0.39) * rect.width * 0.035;
    const breath = (Math.sin(time * 0.33 - Math.abs(relativeBand) * 0.54) + 1) / 2;
    const body = rect.width * (0.09 + breath * 0.27) * (1 - Math.abs(verticalNorm) * 0.12);
    const leftSpan = Math.max(1, body * (0.82 + Math.sin(time * 0.21 + rowPhase) * 0.18));
    const rightSpan = Math.max(1, body * (0.84 + Math.cos(time * 0.19 - rowPhase * 0.81) * 0.16));

    for (let column = 0; column < rect.width; column += 1) {
      const x = rect.x + column;
      const distance = x < center
        ? (center - x) / leftSpan
        : (x - center) / rightSpan;
      if (distance > 1) {
        if (distance < 1.15 && (column + band + phaseSeed(scene.phase)) % 7 === 0) {
          put(scene, x, y, '.', 'fog', 2);
        }
        continue;
      }

      const energy = 1 - distance;
      const ridge = (Math.sin(column * 0.34 + rowPhase * 1.7 - time * 0.87) + 1) / 2;
      const active = waveCellIsActive(scene, column, gate, rect.width);
      const char = energy > 0.82
        ? ridge > 0.72 ? '@' : '#'
        : energy > 0.5
          ? '='
          : energy > 0.2
            ? '-'
            : '.';
      const tone = waveTone(energy, ridge, active);
      put(scene, x, y, char, tone, 8 + Math.round(energy * 8));
    }

    drawGateCell(scene, gate, y, row === Math.floor(rect.height / 2));
  }
}

function waveCellIsActive(scene, column, gate, width) {
  if (scene.ratio !== null) return column <= gate;
  const radius = Math.max(3, Math.floor(width * 0.18));
  return wrappedDistance(column, gate, width) <= radius;
}

function waveTone(energy, ridge, active) {
  if (!active) return 'fog';
  if (energy > 0.76 && ridge > 0.86) return 'bone';
  if (energy > 0.58 && ridge > 0.54) return 'leaf';
  if (energy > 0.22) return 'moss';
  return 'fog';
}

function drawGateCell(scene, x, y, isCenter) {
  const pulse = scene.frame % 8 < 4;
  const char = isCenter ? (pulse ? '@' : 'O') : (pulse ? '|' : ':');
  const tone = isCenter ? 'bone' : scene.ratio === null ? 'sky' : 'leaf';
  put(scene, x, y, char, tone, isCenter ? 60 : 40);
}

function drawRule(scene, y, gate, gateTone) {
  if (y < 0 || y >= scene.height) return;
  for (let x = 0; x < scene.width; x += 1) {
    put(scene, x, y, x % 12 === 0 ? '+' : '-', 'fog', 4);
  }
  put(scene, gate, y, '+', gateTone, 50);
}

function drawSides(scene, y, left, right, leftTone, rightTone) {
  if (y < 0 || y >= scene.height) return;
  const leftText = String(left).slice(0, scene.width);
  const available = Math.max(0, scene.width - leftText.length - 1);
  const rightText = available === 0 ? '' : String(right).slice(-available);
  drawText(scene, 0, y, leftText, leftTone, 70);
  if (rightText) drawText(scene, scene.width - rightText.length, y, rightText, rightTone, 70);
}

function phaseGate(scene, width) {
  if (width <= 1) return 0;
  if (scene.ratio !== null) return Math.round(scene.ratio * (width - 1));
  return positiveMod(scene.frame * 2 + phaseSeed(scene.phase), width);
}

function formatCount(scene) {
  if (scene.completed === null || scene.total === null) return 'PHASE LOCK';
  return `${scene.completed}/${scene.total}`;
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

function wrappedDistance(left, right, modulus) {
  const distance = Math.abs(left - right);
  return Math.min(distance, modulus - distance);
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
