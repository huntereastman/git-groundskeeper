import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

function git(args) {
  return execFileSync('git', ['-C', packageRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let commit = null;
let dirty = null;
try {
  commit = git(['rev-parse', 'HEAD']);
  dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
} catch {
  // Source archives can be packed without Git metadata. The runtime reports
  // unavailable provenance instead of inventing a commit.
}

const stamp = {
  schemaVersion: 1,
  name: packageJson.name,
  version: packageJson.version,
  commit,
  dirty,
  source: 'packaged',
  stampedAt: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(packageRoot, 'build-provenance.json'),
  `${JSON.stringify(stamp, null, 2)}\n`,
  { mode: 0o644 },
);
