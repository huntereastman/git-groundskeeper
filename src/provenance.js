import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = readJson(path.join(packageRoot, 'package.json')) ?? {
  name: 'git-groundskeeper',
  version: 'unknown',
};

export function getToolProvenance() {
  const stamped = readJson(path.join(packageRoot, 'build-provenance.json')) ?? {};
  const live = inspectLiveCheckout();

  return {
    name: packageJson.name,
    version: packageJson.version,
    commit: live?.commit ?? stamped.commit ?? null,
    dirty: live?.dirty ?? stamped.dirty ?? null,
    source: live ? 'development-checkout' : stamped.source ?? 'package',
  };
}

export function attachToolProvenance(report) {
  // Reclaim reports already use `tool` for the selected provider (for example
  // "auto" or "xcode"). Keep execution provenance in its own stable field.
  return { ...report, provenance: getToolProvenance() };
}

export function formatToolProvenance(tool = getToolProvenance()) {
  const commit = tool.commit ? tool.commit.slice(0, 12) : 'commit-unavailable';
  const state = tool.dirty === true ? 'dirty' : tool.dirty === false ? 'clean' : 'state-unknown';
  return `${tool.name} ${tool.version} (${commit}, ${state}, ${tool.source})`;
}

function inspectLiveCheckout() {
  try {
    const commit = execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync(
      'git',
      ['-C', packageRoot, 'status', '--porcelain', '--untracked-files=no'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return { commit, dirty: status !== '' };
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
