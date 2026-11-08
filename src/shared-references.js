import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

const MAX_ENTRIES = 500_000;
const TIMEOUT_MS = 30_000;

// A normal directory can be somebody else's dependency store. Never infer
// exclusivity from lstat(target), Git's ignore rules, or an idle process list.
// This inspection is deliberately read-only and is repeated at the mutation
// boundary; a report from an earlier plan is not deletion authority.
export async function inspectIncomingSymlinks(targetPath, options = {}) {
  const roots = new Set();
  const references = [];
  const errors = [];
  const registrations = new Set();
  const inspectedLinks = new Set();
  const visitedDirectories = new Set();
  const pendingRoots = [];
  const referenceRoots = new Set();
  const started = Date.now();
  const timeoutMs = options.referenceTimeoutMs ?? TIMEOUT_MS;
  const maxEntries = options.referenceMaxEntries ?? MAX_ENTRIES;
  let inspectedEntries = 0;
  let target;

  function budget() {
    if (Date.now() - started >= timeoutMs) throw new Error('reference inspection time limit exceeded');
    if (inspectedEntries >= maxEntries) throw new Error('reference inspection entry limit exceeded');
  }

  async function inspectLink(linkPath) {
    if (inside(linkPath, target) || inspectedLinks.has(linkPath)) return;
    inspectedLinks.add(linkPath);
    const { destination, throughTarget } = await resolveLink(linkPath, target, budget);
    if (throughTarget || inside(destination, target) || inside(target, destination)) {
      references.push({ path: linkPath, destination, throughTarget });
    }
  }

  async function addRoot(input, { registered = false, explicit = false } = {}) {
    budget();
    const absolute = path.resolve(input);
    if (explicit) referenceRoots.add(absolute);
    let stat;
    try {
      stat = await fs.promises.lstat(absolute);
    } catch (error) {
      // A prunable registration with no directory cannot contain a live link.
      // An explicitly supplied scope disappearing is not a completed check.
      if (registered && error.code === 'ENOENT') return;
      throw new Error(`cannot inspect reference root ${absolute}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) await inspectLink(absolute);
    const canonical = await fs.promises.realpath(absolute);
    if (explicit) referenceRoots.add(canonical);
    const resolvedStat = stat.isSymbolicLink() ? await fs.promises.stat(absolute) : stat;
    if (!resolvedStat.isDirectory()) throw new Error(`reference root is not a directory: ${absolute}`);
    if (!roots.has(canonical)) {
      roots.add(canonical);
      pendingRoots.push(canonical);
    }
  }

  async function addPeers(root, required = false) {
    budget();
    const result = await git(root, ['worktree', 'list', '--porcelain', '-z'], {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
    });
    if (!result.ok) {
      if (!required && /not a git repository/i.test(result.stderr)) return;
      throw new Error(`cannot enumerate registered worktrees for ${root}: ${result.stderr.trim()}`);
    }
    if (registrations.has(result.stdout)) return;
    registrations.add(result.stdout);
    let worktreePath = null;
    let bare = false;
    const register = async () => {
      if (worktreePath && !bare) await addRoot(worktreePath, { registered: true });
      worktreePath = null;
      bare = false;
    };
    for (const field of result.stdout.split('\0')) {
      if (field.startsWith('worktree ')) {
        await register();
        worktreePath = field.slice('worktree '.length);
      } else if (field === 'bare') bare = true;
      else if (field === '') await register();
    }
    await register();
  }

  function receipt(complete) {
    return {
      safe: complete && errors.length === 0 && references.length === 0,
      complete,
      target: target ?? path.resolve(targetPath),
      roots: [...roots].sort(),
      referenceRoots: [...referenceRoots].sort(),
      references,
      errors,
      inspectedEntries,
    };
  }

  try {
    target = await fs.promises.realpath(targetPath);
    const gitRoots = [...new Set(options.gitRoots ?? [])];
    const suppliedRoots = [...new Set(options.referenceRoots ?? [])];
    if (gitRoots.length === 0 && suppliedRoots.length === 0) {
      throw new Error('no reference inspection scope is available');
    }
    for (const root of gitRoots) {
      await addRoot(root);
      await addPeers(root, true);
    }
    for (const root of suppliedRoots) {
      await addRoot(root, { explicit: true });
      await addPeers(root);
    }

    // Dependency sharing commonly uses the same relative path in a peer.
    // Find that positive proof before walking potentially enormous caches.
    // A negative answer still requires the complete walk below.
    for (const sourceRoot of gitRoots) {
      const canonical = await fs.promises.realpath(sourceRoot);
      const relative = path.relative(canonical, target);
      if (!inside(target, canonical)) continue;
      for (const root of roots) {
        budget();
        const probe = path.join(root, relative);
        if (inside(probe, target)) continue;
        try {
          const stat = await fs.promises.lstat(probe);
          if (stat.isSymbolicLink()) await inspectLink(probe);
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
      }
    }
    if (references.length > 0) return receipt(false);

    while (pendingRoots.length > 0) {
      const pending = [pendingRoots.shift()];
      while (pending.length > 0) {
        budget();
        const directory = pending.pop();
        if (inside(directory, target) || visitedDirectories.has(directory)) continue;
        visitedDirectories.add(directory);
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        // A scan root can be a parent containing several independent repos.
        // Expand every discovered repository's registrations, not just the
        // directory tree beneath the user's cleanup root.
        if (entries.some((entry) => entry.name === '.git')) await addPeers(directory, true);
        for (const entry of entries) {
          budget();
          inspectedEntries += 1;
          const entryPath = path.join(directory, entry.name);
          if (inside(entryPath, target)) continue;
          if (entry.isSymbolicLink()) await inspectLink(entryPath);
          else if (entry.isDirectory() && entry.name !== '.git') pending.push(entryPath);
          if (references.length > 0) return receipt(false);
        }
      }
    }
    return receipt(true);
  } catch (error) {
    errors.push(error.message);
    return receipt(false);
  }
}

export function sharedReferenceBlockers(check) {
  if (check.safe) return [];
  const reasons = check.references.map((reference) => `shared symlink target: ${reference.path} -> ${reference.destination}`);
  reasons.push(...check.errors.map((error) => `incoming symlink inspection incomplete: ${error}`));
  if (reasons.length === 0) reasons.push('incoming symlink inspection incomplete');
  return reasons;
}

// Follow every hop, including existing prefixes of dangling descendants.
// Final realpath alone is insufficient: a chain may pass through the deletion
// target and then point outside it. Removing that middle hop still breaks the
// consumer. Do not collapse '..' before links; that changes POSIX semantics.
async function resolveLink(linkPath, target, budget) {
  let resolved = path.parse(linkPath).root;
  let pending = linkPath.slice(resolved.length).split(path.sep);
  let hops = 0;
  let throughTarget = false;
  while (pending.length > 0) {
    budget();
    const component = pending.shift();
    if (!component || component === '.') continue;
    if (component === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, component);
    if (inside(candidate, target)) throughTarget = true;
    let stat;
    try {
      stat = await fs.promises.lstat(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      resolved = candidate;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    hops += 1;
    if (hops > 40) throw new Error(`symlink chain cannot be resolved safely: ${linkPath}`);
    const destination = await fs.promises.readlink(candidate);
    if (path.isAbsolute(destination)) resolved = path.parse(destination).root;
    pending = [...destination.slice(path.isAbsolute(destination) ? resolved.length : 0).split(path.sep), ...pending];
  }
  return { destination: resolved, throughTarget };
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
