// Only classify individual ignored files. An unknown sibling in a tool output
// directory still needs review. Build-time contracts contain no executable code.
import fs from 'node:fs';
import nativePath from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const path = nativePath.posix;
const shippedContracts = typeof GROUNDSKEEPER_GENERATED_CONTRACTS === 'undefined'
  ? [] : GROUNDSKEEPER_GENERATED_CONTRACTS;
const MiB = 1024 * 1024;
const astroSignatures = {
  'content-assets.mjs': /export default new Map\(/,
  'content-modules.mjs': /export default new Map\(/,
  'content.d.ts': /declare module ['"]astro:content['"]\s*\{/,
  'types.d.ts': /^\s*\/\/\/ <reference types="astro\/client" \/>/,
};

function safeRelative(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\0') &&
    !nativePath.win32.isAbsolute(name) && !path.isAbsolute(name) && !name.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}

function memoize(load) {
  const values = new Map();
  return key => {
    if (!values.has(key)) {
      try { values.set(key, load(key)); } catch { values.set(key, null); }
    }
    return values.get(key);
  };
}

export function createGeneratedArtifactClassifier(cwd, contracts = shippedContracts) {
  let root;
  try { root = fs.realpathSync(cwd); } catch { return () => false; }
  // A tracked recipe/input must still be present in this checkout. Do not
  // follow a symlink into a retained sibling, or open special files.
  const regular = memoize(relative => {
    if (!safeRelative(relative)) return null;
    const full = nativePath.join(root, relative);
    try {
      const stat = fs.lstatSync(full);
      return stat.isFile() && fs.realpathSync(full) === full ? stat : null;
    } catch { return null; }
  });
  function bytes(relative, limit = MiB) {
    const stat = regular(relative);
    if (!stat || stat.size > limit) return null;
    return fs.readFileSync(nativePath.join(root, relative));
  }
  function json(relative) {
    const input = bytes(relative);
    try { return input === null ? null : JSON.parse(input.toString('utf8')); } catch { return null; }
  }
  const sha = memoize(relative => {
    const input = bytes(relative, 16 * MiB);
    return input === null ? null : createHash('sha256').update(input).digest('hex');
  });
  const index = memoize(() => {
    const files = execFileSync('git', ['ls-files', '--stage', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * MiB, timeout: 5000, stdio: ['ignore','pipe','ignore'],
    });
    return new Set(files.split('\0').flatMap(entry => {
      const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(entry);
      return match ? [match[1]] : [];
    }));
  });
  const tracked = relative => regular(relative) && index()?.has(relative);

  // Inputs and outputs in a contract are SHA-256 digests from a verified
  // reproduction. Never trust a receipt supplied by the ignored output itself.
  const byOutput = new Map();
  const validInputs = memoize(contract => {
    const inputs = Object.entries(contract.inputs);
    return inputs.length > 0 && inputs.every(([name, digest]) =>
      tracked(name) && /^[a-f0-9]{64}$/.test(digest) && sha(name) === digest);
  });
  for (const contract of contracts) {
    for (const name of Object.keys(contract.outputs)) byOutput.set(name, contract);
  }

  const viteCaches = memoize(() => {
    const caches = new Set();
    for (const config of index() ?? []) {
      if (!/(?:^|\/)vite(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/.test(config)) continue;
      const folder = path.dirname(config);
      const manifest = path.join(folder, 'package.json');
      if (!tracked(manifest)) continue;
      const pkg = json(manifest);
      if (!(pkg?.devDependencies?.vite || pkg?.dependencies?.vite)) continue;
      const source = bytes(config)?.toString('utf8') ?? '';
      // Accept an unambiguous literal declaration in a Vite config.
      // Dynamic config is deliberately left to review.
      const matches = [...source.matchAll(/^\s*cacheDir\s*:\s*(['"])([^'"\\\r\n]+)\1\s*[,}]\s*$/gm)];
      if (matches.length !== 1) continue;
      const cache = path.normalize(path.join(folder, matches[0][2]));
      if (safeRelative(cache)) caches.add(cache);
    }
    return caches;
  });
  const optimizerFiles = memoize(deps => {
    const members = new Set();
    if (!viteCaches()?.has(path.dirname(deps))) return members;
    const data = json(path.join(deps, '_metadata.json'));
    if (!data || ![data.hash, data.configHash, data.lockfileHash].every(value =>
      typeof value === 'string' && /^[0-9a-f]{8,64}$/i.test(value))) return members;
    if (!data.optimized || !data.chunks) return members;
    for (const entry of [...Object.values(data.optimized), ...Object.values(data.chunks)]) {
      if (typeof entry?.file === 'string' && /^[\w.@$-]+\.m?js$/.test(entry.file) &&
          regular(path.join(deps, entry.file))) members.add(entry.file);
    }
    if (members.size) {
      members.add('_metadata.json');
      const pkg = json(path.join(deps, 'package.json'));
      if (pkg?.type === 'module' && Object.keys(pkg).length === 1) members.add('package.json');
    }
    return members;
  });

  // Godot records res:// paths in its editor filesystem index. Include
  // ignored source files from that index: an import cache can coexist with an
  // untracked original. Validate the actual source, import target and hashes.
  const godotSources = memoize(project => {
    const sources = new Map();
    if (!tracked(path.join(project, 'project.godot'))) return sources;
    const folder = path.join(project, '.godot/editor');
    const absoluteFolder = nativePath.join(root, folder);
    if (fs.realpathSync(absoluteFolder) !== absoluteFolder) return sources;
    // Only the latest editor index describes the current import set.
    const indexFiles = fs.readdirSync(absoluteFolder).filter(name => /^filesystem_cache\d{1,4}$/.test(name));
    const file = indexFiles.sort((a, b) => Number(b.slice(16)) - Number(a.slice(16)))[0];
    if (file) {
      const data = bytes(path.join(folder, file), 4 * MiB);
      let directory = null;
      for (const line of (data?.toString('utf8') ?? '').split('\n')) {
        if (line.startsWith('::')) {
          const match = /^::res:\/\/(.*?)::/.exec(line);
          directory = match ? match[1] : null;
        } else if (directory !== null && line.includes('::')) {
          const name = line.split('::', 1)[0];
          const source = directory + name;
          if (!name || name.includes('/') || !safeRelative(source)) continue;
          const nameDigest = createHash('md5').update('res://' + source).digest('hex');
          sources.set(name + '-' + nameDigest, source);
        }
      }
    }
    return sources;
  });

  const godotDestination = memoize(stem => {
    const project = path.dirname(path.dirname(path.dirname(stem)));
    const source = godotSources(project)?.get(path.basename(stem));
    if (!source) return null;
    const descriptor = bytes(path.join(project, source + '.import'), 64 * 1024)?.toString('utf8');
    if (!descriptor?.split(/\r?\n/).includes('source_file="res://' + source + '"')) return null;
    const named = /^path="res:\/\/(\.godot\/imported\/[^"/]+)"$/m.exec(descriptor)?.[1];
    if (!named || !safeRelative(named)) return null;
    const destination = path.join(project, named);
    if (destination.slice(0, -path.extname(destination).length) !== stem) return null;
    const hashes = bytes(stem + '.md5', 1024)?.toString('utf8');
    const expected = /^source_md5="([a-f0-9]{32})"\s+dest_md5="([a-f0-9]{32})"\s*$/.exec(hashes ?? '');
    if (!expected) return null;
    const sourceBytes = bytes(path.join(project, source), 16 * MiB);
    const targetBytes = bytes(destination, 16 * MiB);
    if (!sourceBytes || !targetBytes) return null;
    if (createHash('md5').update(sourceBytes).digest('hex') !== expected[1] ||
        createHash('md5').update(targetBytes).digest('hex') !== expected[2]) return null;
    return destination;
  });

  // Recognize a narrow staging recipe: a Node package copies a named,
  // tracked source file into lib/ during stage/build. Compare actual bytes.
  const copiedOutputs = memoize(folder => {
    const copies = new Map();
    const manifest = path.join(folder, 'package.json');
    if (!tracked(manifest)) return copies;
    const pkg = json(manifest);
    for (const command of [pkg?.scripts?.stage, pkg?.scripts?.build]) {
      const script = /^node (?:\.\/)?([\w./-]+\.[cm]?js)$/.exec(command ?? '')?.[1];
      if (!script || !safeRelative(script) || !tracked(path.join(folder, script))) continue;
      const text = bytes(path.join(folder, script))?.toString('utf8') ?? '';
      const base = /\bconst\s+(\w+)\s*=\s*path\.resolve\(__dirname,\s*['"](\.\.(?:\/\.\.)*)['"]\)/.exec(text);
      if (!base || path.normalize(path.join(path.dirname(script), base[2])) !== '.') continue;
      for (const match of text.matchAll(/\bfs\.copyFileSync\(\s*path\.join\((\w+),\s*['"]([^'"\\]+)['"]\),\s*path\.join\((\w+),\s*['"]([^'"\\]+)['"]\)\s*\)/g)) {
        const [, fromBase, from, toBase, to] = match;
        if (fromBase !== base[1] || toBase !== base[1] || !safeRelative(to)) continue;
        const input = path.join(folder, from);
        if (safeRelative(input) && tracked(input)) copies.set(path.join(folder, to), input);
      }
    }
    return copies;
  });

  return relative => {
    if (nativePath.sep === '\\' && typeof relative === 'string') relative = relative.replaceAll('\\', '/');
    if (!safeRelative(relative)) return false;
    try {
      const contract = byOutput.get(relative);
      if (contract) return Boolean(validInputs(contract) && /^[a-f0-9]{64}$/.test(contract.outputs[relative]) &&
        sha(relative) === contract.outputs[relative]);
      const folder = path.dirname(relative);
      const name = path.basename(relative);
      if (path.basename(folder) === 'deps' && regular(relative)) {
        const members = optimizerFiles(folder);
        if (members?.has(name)) return true;
        if (name.endsWith('.map') && members?.has(name.slice(0, -4))) {
          // Check the source map header without parsing potentially huge maps.
          const fd = fs.openSync(nativePath.join(root, relative), 'r');
          try {
            const header = Buffer.alloc(512);
            const length = fs.readSync(fd, header, 0, header.length, 0);
            return /^\s*\{\s*"version"\s*:\s*3\s*,/.test(header.toString('utf8', 0, length));
          } finally { fs.closeSync(fd); }
        }
      }
      if (path.basename(folder) === 'imported' && path.basename(path.dirname(folder)) === '.godot') {
        const stem = relative.slice(0, -path.extname(relative).length);
        const destination = godotDestination(stem);
        return Boolean(destination && (relative === destination || relative === stem + '.md5'));
      }
      if (path.basename(folder) === '.astro' && Object.hasOwn(astroSignatures, name) && regular(relative)) {
        const manifest = path.join(path.dirname(folder), 'package.json');
        if (!tracked(manifest)) return false;
        const pkg = json(manifest);
        return Boolean((pkg?.dependencies?.astro || pkg?.devDependencies?.astro) &&
          astroSignatures[name].test(bytes(relative)?.toString('utf8') ?? ''));
      }
      if (path.basename(folder) === 'lib' && /\.[cm]?js$/.test(name)) {
        const original = copiedOutputs(path.dirname(folder))?.get(relative);
        return Boolean(original && sha(relative) && sha(original) === sha(relative));
      }
    } catch {
      // Missing inputs, unreadable paths, malformed metadata or a large index
      // are ordinary reasons to keep this individual item visible.
    }
    return false;
  };
}
