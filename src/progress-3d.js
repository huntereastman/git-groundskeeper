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
 * Render the framed, full-terminal spatial companion to Deep Forest Telemetry.
 *
 * The scene is deliberately pure: identical inputs always produce identical
 * rows. Progress controls only surveyed depth. The frame clock animates ambient
 * light (and the LIDAR sweep when progress is indeterminate).
 */
export function renderSpatialScene(options = {}) {
  const width = dimension(options.width);
  const height = dimension(options.height);
  if (height === 0) return [];
  if (width === 0) return Array.from({ length: height }, () => '');

  const frame = Number.isFinite(options.frame) ? Math.floor(options.frame) : 0;
  const ratio = Number.isFinite(options.ratio)
    ? clamp(options.ratio, 0, 1)
    : null;
  const phase = asciiLabel(options.phase ?? 'survey', 22);
  const theme = normalizeTheme(options.theme);
  const canvas = createCanvas(width, height);
  const scene = {
    canvas,
    frame,
    height,
    phase,
    ratio,
    width,
  };

  if (width < 12 || height < 5) {
    drawMicroScene(scene);
  } else {
    drawFrame(scene);
    drawSpatialArbor(scene);
  }

  return canvas.map((row) => paintRow(row, theme));
}

function drawSpatialArbor(scene) {
  const { height, width } = scene;
  const left = 1;
  const right = width - 2;
  const top = 1;
  const bottom = height - 2;
  if (left > right || top > bottom) return;

  const innerHeight = bottom - top + 1;
  const horizon = clamp(
    top + Math.round(innerHeight * 0.39),
    top + Math.min(2, innerHeight - 1),
    bottom,
  );
  const drift = width >= 54 ? Math.round(Math.sin(scene.frame / 23) * 1.4) : 0;
  const vanishingX = clamp(Math.floor(width / 2) + drift, left, right);

  fillAtmosphere(scene, left, right, top, bottom);
  drawStars(scene, left, right, top, horizon);
  drawAurora(scene, left, right, top, horizon);
  drawHorizon(scene, left, right, horizon, vanishingX);
  drawGroundGrid(scene, left, right, horizon, bottom, vanishingX);
  drawSurveyPath(scene, horizon, bottom, vanishingX);
  drawDepthTrees(scene, horizon, bottom, vanishingX);
  drawWorldTree(scene, horizon, vanishingX);

  if (scene.ratio === null) {
    drawLidarSweep(scene, horizon, bottom, vanishingX);
  } else {
    drawDepthBeacon(scene, horizon, bottom, vanishingX);
  }

  drawSceneReadouts(scene, left, right, top, bottom);
}

function fillAtmosphere(scene, left, right, top, bottom) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      put(scene, x, y, ' ', 'fog', 0);
    }
  }
}

function drawStars(scene, left, right, top, horizon) {
  for (let y = top + 1; y < horizon; y += 1) {
    for (let x = left + 1; x < right; x += 1) {
      const seed = hash2(x, y);
      if (seed % 79 > 2) continue;
      const pulse = (seed + Math.floor(scene.frame / 4)) % 13;
      const char = pulse === 0 ? '*' : seed % 3 === 0 ? '+' : '.';
      const tone = pulse === 0 ? 'sun' : seed % 2 === 0 ? 'sky' : 'fog';
      put(scene, x, y, char, tone, 2);
    }
  }
}

function drawAurora(scene, left, right, top, horizon) {
  const skyHeight = horizon - top;
  if (skyHeight < 4 || right - left < 28) return;

  const ribbons = Math.min(3, Math.max(1, Math.floor(skyHeight / 5)));
  for (let ribbon = 0; ribbon < ribbons; ribbon += 1) {
    const baseY = top + 1 + Math.floor(((ribbon + 1) * skyHeight) / (ribbons + 2));
    for (let x = left + 2; x <= right - 2; x += 1) {
      const wave = Math.sin((x + scene.frame * 0.22 + ribbon * 17) / (7 + ribbon * 2));
      const echo = Math.sin((x - scene.frame * 0.11) / 19);
      const y = baseY + Math.round(wave + echo * 0.7);
      if (y >= top && y < horizon) {
        const char = (x + ribbon + scene.frame) % 17 === 0 ? '=' : '~';
        put(scene, x, y, char, ribbon % 2 === 0 ? 'orchid' : 'sky', 3);
        if ((x + ribbon) % 9 === 0 && y + 1 < horizon) {
          put(scene, x, y + 1, '.', 'fog', 2);
        }
      }
    }
  }
}

function drawHorizon(scene, left, right, y, vanishingX) {
  for (let x = left; x <= right; x += 1) {
    const distance = Math.abs(x - vanishingX);
    if (distance % 3 === 0) put(scene, x, y, '.', 'moss', 4);
  }
  const glow = scene.frame % 12 < 6 ? 'sun' : 'sky';
  put(scene, vanishingX - 1, y, '<', glow, 8);
  put(scene, vanishingX, y, 'O', glow, 9);
  put(scene, vanishingX + 1, y, '>', glow, 8);
}

function drawGroundGrid(scene, left, right, horizon, bottom, vanishingX) {
  const span = bottom - horizon;
  if (span <= 0) return;

  const raySpacing = Math.max(5, Math.floor((right - left + 1) / 10));
  for (let endpoint = left - raySpacing; endpoint <= right + raySpacing; endpoint += raySpacing) {
    for (let y = horizon + 1; y <= bottom; y += 1) {
      const depth = (y - horizon) / span;
      const x = Math.round(vanishingX + (endpoint - vanishingX) * depth);
      if (x < left || x > right) continue;
      const char = endpoint < vanishingX ? '/' : endpoint > vanishingX ? '\\' : '|';
      put(scene, x, y, char, 'fog', 4);
    }
  }

  const lineCount = Math.max(2, Math.min(12, Math.floor(span / 2)));
  for (let line = 1; line <= lineCount; line += 1) {
    const normalized = line / lineCount;
    const depth = normalized ** 1.72;
    const y = horizon + Math.max(1, Math.round(depth * span));
    const reach = Math.max(2, Math.round((right - left + 1) * depth * 0.52));
    const start = Math.max(left, vanishingX - reach);
    const end = Math.min(right, vanishingX + reach);
    for (let x = start; x <= end; x += 1) {
      const char = (x - start) % 4 === 0 ? '+' : '-';
      put(scene, x, y, char, line % 3 === 0 ? 'moss' : 'fog', 3);
    }
  }
}

function drawSurveyPath(scene, horizon, bottom, vanishingX) {
  const span = bottom - horizon;
  if (span <= 0) return;
  const maxHalfWidth = Math.max(2, Math.floor((scene.width - 4) * 0.14));

  for (let y = horizon + 1; y <= bottom; y += 1) {
    const perspective = (y - horizon) / span;
    const surveyDepth = 1 - perspective;
    const halfWidth = 1 + Math.round(maxHalfWidth * perspective ** 1.22);
    const pathLeft = vanishingX - halfWidth;
    const pathRight = vanishingX + halfWidth;
    const revealed = scene.ratio !== null && surveyDepth <= scene.ratio + 0.0001;
    const railTone = revealed ? (Math.floor(y + scene.frame / 3) % 7 === 0 ? 'sun' : 'leaf') : 'fog';
    put(scene, pathLeft, y, '/', railTone, revealed ? 7 : 5);
    put(scene, pathRight, y, '\\', railTone, revealed ? 7 : 5);

    if (y % Math.max(2, Math.floor(span / 8)) === 0) {
      for (let x = pathLeft + 1; x < pathRight; x += 1) {
        const char = revealed ? (x + y) % 3 === 0 ? '=' : '-' : '.';
        put(scene, x, y, char, revealed ? 'moss' : 'fog', revealed ? 6 : 2);
      }
    } else if ((y + scene.frame) % 5 === 0) {
      put(scene, vanishingX, y, revealed ? ':' : '.', revealed ? 'sky' : 'fog', 5);
    }
  }
}

function drawDepthTrees(scene, horizon, bottom, vanishingX) {
  const span = bottom - horizon;
  if (span < 3) return;
  const depths = [0.1, 0.23, 0.39, 0.58, 0.76, 0.9];
  const maxScale = Math.max(2, Math.min(8, Math.floor(scene.height / 6)));
  const pathSpread = Math.max(4, Math.floor((scene.width - 4) * 0.17));

  for (let index = 0; index < depths.length; index += 1) {
    const surveyDepth = depths[index];
    const perspective = 1 - surveyDepth;
    const groundY = bottom - Math.round(surveyDepth * span);
    const scale = Math.max(1, Math.round(1 + maxScale * perspective * 0.72));
    const lateral = Math.max(3, Math.round(2 + pathSpread * perspective));
    const jitter = (hash2(index, 47) % 3) - 1;
    const illuminated = scene.ratio !== null && surveyDepth <= scene.ratio + 0.0001;
    drawTreePylon(scene, vanishingX - lateral + jitter, groundY, scale, illuminated, index);
    drawTreePylon(scene, vanishingX + lateral - jitter, groundY, scale, illuminated, index + 17);
  }
}

function drawTreePylon(scene, x, groundY, scale, illuminated, seed) {
  const trunkHeight = Math.max(1, scale);
  const trunkTone = illuminated ? 'bark' : 'fog';
  const crownTone = illuminated ? (seed % 3 === 0 ? 'sun' : 'leaf') : 'fog';
  const priority = illuminated ? 10 : 6;

  for (let step = 0; step < trunkHeight; step += 1) {
    const y = groundY - step;
    put(scene, x, y, step === 0 ? 'Y' : '|', trunkTone, priority);
    const reach = Math.max(1, Math.floor((trunkHeight - step) / 2));
    if (step > 0 && step % 2 === seed % 2) {
      put(scene, x - reach, y, '/', crownTone, priority);
      put(scene, x + reach, y, '\\', crownTone, priority);
      for (let branch = 1; branch < reach; branch += 1) {
        put(scene, x - branch, y, '-', crownTone, priority - 1);
        put(scene, x + branch, y, '-', crownTone, priority - 1);
      }
    }
  }
  put(scene, x, groundY - trunkHeight, '^', crownTone, priority + 1);
  if (scale >= 4) {
    put(scene, x - 1, groundY, '/', trunkTone, priority);
    put(scene, x + 1, groundY, '\\', trunkTone, priority);
  }
}

function drawWorldTree(scene, horizon, vanishingX) {
  const crownHeight = Math.max(2, Math.min(
    Math.floor((horizon - 1) * 0.58),
    Math.floor((scene.width - 4) / 15),
  ));
  if (crownHeight < 1) return;
  const awakened = scene.ratio !== null && scene.ratio >= 0.82;
  const trunkTone = awakened ? 'sun' : 'bone';
  const crownTone = awakened ? 'leaf' : 'moss';

  for (let level = 0; level < crownHeight; level += 1) {
    const y = horizon - 1 - level;
    const reach = Math.max(1, Math.round((level + 1) * 1.4));
    put(scene, vanishingX, y, '|', trunkTone, 13);
    put(scene, vanishingX - reach, y, '/', crownTone, 12);
    put(scene, vanishingX + reach, y, '\\', crownTone, 12);
    if (level % 2 === 1) {
      for (let x = vanishingX - reach + 1; x < vanishingX + reach; x += 1) {
        if (Math.abs(x - vanishingX) % 2 === 1) put(scene, x, y, '.', crownTone, 8);
      }
    }
  }

  const crownY = horizon - crownHeight - 1;
  put(scene, vanishingX, crownY, '*', awakened ? 'sun' : 'sky', 14);
  put(scene, vanishingX - 1, crownY + 1, '/', crownTone, 13);
  put(scene, vanishingX + 1, crownY + 1, '\\', crownTone, 13);
  put(scene, vanishingX, horizon, '|', trunkTone, 14);

  const portalRadius = Math.max(2, Math.min(6, Math.floor(scene.width / 20)));
  for (let radius = 2; radius <= portalRadius; radius += 2) {
    const yRadius = Math.max(1, Math.round(radius / 2));
    const tone = radius === portalRadius && scene.frame % 10 < 5 ? 'orchid' : 'sky';
    put(scene, vanishingX - radius, horizon, '<', tone, 9);
    put(scene, vanishingX + radius, horizon, '>', tone, 9);
    put(scene, vanishingX, horizon - yRadius, '^', tone, 9);
    put(scene, vanishingX, horizon + yRadius, 'v', tone, 9);
    drawLine(scene, vanishingX - radius, horizon, vanishingX, horizon - yRadius, '/', tone, 8);
    drawLine(scene, vanishingX, horizon - yRadius, vanishingX + radius, horizon, '\\', tone, 8);
  }
}

function drawDepthBeacon(scene, horizon, bottom, vanishingX) {
  const span = bottom - horizon;
  if (span <= 0) return;
  const surveyDepth = scene.ratio;
  const y = bottom - Math.round(surveyDepth * span);
  const perspective = (y - horizon) / span;
  const halfWidth = Math.max(1, Math.round((scene.width - 4) * 0.14 * perspective ** 1.2));
  const pulseTone = scene.frame % 8 < 4 ? 'sun' : 'sky';

  for (let beamY = Math.max(horizon, y - Math.max(1, Math.floor(scene.height / 12))); beamY < y; beamY += 1) {
    put(scene, vanishingX, beamY, ':', 'sky', 11);
  }
  put(scene, vanishingX, y, '*', pulseTone, 16);
  put(scene, vanishingX - 1, y, '<', 'leaf', 15);
  put(scene, vanishingX + 1, y, '>', 'leaf', 15);
  if (halfWidth >= 3) {
    put(scene, vanishingX - halfWidth, y, '[', 'sun', 11);
    put(scene, vanishingX + halfWidth, y, ']', 'sun', 11);
  }
}

function drawLidarSweep(scene, horizon, bottom, vanishingX) {
  const span = bottom - horizon;
  if (span <= 0) return;
  const cycle = Math.max(2, span * 2);
  const cursor = ((scene.frame % cycle) + cycle) % cycle;
  const step = cursor <= span ? cursor : cycle - cursor;
  const y = bottom - step;
  const perspective = (y - horizon) / span;
  const reach = Math.max(2, Math.round((scene.width - 4) * perspective * 0.47));
  const start = Math.max(1, vanishingX - reach);
  const end = Math.min(scene.width - 2, vanishingX + reach);

  for (let x = start; x <= end; x += 1) {
    const char = x === vanishingX ? 'O' : (x - start) % 5 === 0 ? '+' : '=';
    put(scene, x, y, char, x === vanishingX ? 'sun' : 'sky', 18);
    if ((x + scene.frame) % 11 === 0 && y > 1) put(scene, x, y - 1, ':', 'orchid', 10);
  }
  for (let beamY = horizon; beamY < y; beamY += 1) {
    if ((beamY + scene.frame) % 3 === 0) put(scene, vanishingX, beamY, ':', 'sky', 10);
  }
}

function drawSceneReadouts(scene, left, right, top, bottom) {
  const available = right - left + 1;
  if (available < 22 || bottom - top < 5) return;
  const scanMode = scene.ratio === null ? 'LIDAR:SWEEP' : 'LIDAR:LOCK';
  drawText(scene, left + 1, top, scanMode, scene.ratio === null ? 'sky' : 'leaf', 20);

  const phaseText = `PHASE:${scene.phase}`;
  drawText(scene, Math.max(left + 1, right - phaseText.length), top, phaseText, 'fog', 20);

  if (scene.ratio !== null && available >= 34) {
    const depth = `SURVEY DEPTH ${formatPercent(scene.ratio)}`;
    drawText(scene, Math.max(left + 1, right - depth.length), bottom, depth, 'sun', 20);
  } else if (scene.ratio === null && available >= 34) {
    const signal = 'VOLUMETRIC SIGNAL ACQUIRING';
    drawText(scene, Math.max(left + 1, right - signal.length), bottom, signal, 'orchid', 20);
  }
}

function drawFrame(scene) {
  const { height, ratio, width } = scene;
  if (width === 1) {
    for (let y = 0; y < height; y += 1) put(scene, 0, y, '|', 'moss', 100);
    return;
  }

  for (let x = 0; x < width; x += 1) {
    put(scene, x, 0, x === 0 || x === width - 1 ? '+' : '-', x === 0 ? 'moss' : 'fog', 100);
    if (height > 1) {
      put(scene, x, height - 1, x === 0 || x === width - 1 ? '+' : '-', x === width - 1 ? 'moss' : 'fog', 100);
    }
  }
  for (let y = 1; y < height - 1; y += 1) {
    put(scene, 0, y, '|', 'moss', 100);
    put(scene, width - 1, y, '|', 'moss', 100);
  }

  const title = width >= 50
    ? ' VOLUMETRIC FOREST // PERSPECTIVE ENGINE '
    : width >= 24
      ? ' PERSPECTIVE ENGINE '
      : ' ARBOR ';
  overlayBorderLabel(scene, 0, title, 'bone');
  const footer = ratio === null
    ? ' INDETERMINATE LIDAR '
    : ` DEPTH ${formatPercent(ratio)} `;
  if (height > 1) overlayBorderLabel(scene, height - 1, footer, ratio === null ? 'sky' : 'sun');
}

function overlayBorderLabel(scene, y, label, tone) {
  if (scene.width < 5) return;
  const fitted = label.slice(0, Math.max(0, scene.width - 4));
  const start = Math.max(2, Math.floor((scene.width - fitted.length) / 2));
  drawText(scene, start, y, fitted, tone, 110);
}

function drawMicroScene(scene) {
  const { height, ratio, width } = scene;
  const rows = Array.from({ length: height }, () => ' '.repeat(width));
  const title = width >= 6 ? 'ARBOR' : '*';
  const known = ratio === null ? '' : formatPercent(ratio);
  const labels = height === 1
    ? [known || title]
    : [title, ...Array(Math.max(0, height - 2)).fill(''), known || 'LIDAR'];

  for (let y = 0; y < height; y += 1) {
    const label = labels[y] ?? '';
    rows[y] = center(label, width);
    for (let x = 0; x < width; x += 1) {
      put(scene, x, y, rows[y][x] ?? ' ', label ? (known && label === known ? 'sun' : 'moss') : 'fog', 10);
    }
  }
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

function drawLine(scene, x1, y1, x2, y2, char, tone, priority) {
  const distance = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  if (distance === 0) {
    put(scene, x1, y1, char, tone, priority);
    return;
  }
  for (let step = 0; step <= distance; step += 1) {
    const mix = step / distance;
    put(scene, x1 + (x2 - x1) * mix, y1 + (y2 - y1) * mix, char, tone, priority);
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

function formatPercent(value) {
  return `${(value * 100).toFixed(value >= 1 ? 0 : 1)}%`;
}

function center(value, width) {
  const fitted = String(value).slice(0, width);
  const left = Math.floor((width - fitted.length) / 2);
  return `${' '.repeat(left)}${fitted}${' '.repeat(width - left - fitted.length)}`;
}

function dimension(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function hash2(x, y) {
  let value = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x7f4a, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x27d4eb2d);
  return (value ^ (value >>> 15)) >>> 0;
}
