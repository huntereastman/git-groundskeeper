import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 10_000;

export function ownersCachePath() {
  if (process.env.GIT_GROUNDSKEEPER_OWNERS_CACHE) {
    return process.env.GIT_GROUNDSKEEPER_OWNERS_CACHE;
  }

  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'git-groundskeeper', 'owners.json');
}

// Asking who you are is a network call, so it is cached for a day. Membership
// changes rarely and a scan should not depend on being online.
export async function detectOwners({ refresh = false } = {}) {
  if (!refresh) {
    const cached = readCache();
    if (cached) return cached;
  }

  const owners = await queryGitHub();
  if (owners.length > 0) {
    writeCache(owners);
  }

  return owners;
}

async function queryGitHub() {
  const login = await ghLines(['api', 'user', '--jq', '.login']);

  // No login means gh is missing, unauthenticated, or offline. Return nothing
  // rather than a partial answer: ownership then reports as "unknown", which
  // shows every repository instead of silently hiding the ones we could not
  // classify. Guessing here would hide real work.
  if (login.length === 0) return [];

  const orgs = await ghLines(['api', 'user/orgs', '--jq', '.[].login']);

  return [...new Set([...login, ...orgs])];
}

async function ghLines(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
    });

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Local ancestry can prove that commits landed, but GitHub supplies the useful
// audit trail: whether a pull request for this branch was merged, and into
// what. Returns null when gh cannot answer -- missing, unauthenticated,
// offline, or not a GitHub remote -- so callers preserve "unknown" rather than
// treating silence as "not merged".
export async function listMergedPullRequestBranches(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', 'merged', '--limit', '200', '--json', 'headRefName,headRefOid,baseRefName,number,mergedAt'],
      { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS },
    );

    const merged = JSON.parse(stdout);
    if (!Array.isArray(merged)) return null;

    const byBranch = new Map();
    for (const pullRequest of merged) {
      const candidate = {
        base: pullRequest.baseRefName,
        head: pullRequest.headRefOid,
        number: pullRequest.number,
        mergedAt: (pullRequest.mergedAt ?? '').slice(0, 10),
      };
      const existing = byBranch.get(pullRequest.headRefName);
      if (!existing || candidate.mergedAt > existing.mergedAt) {
        byBranch.set(pullRequest.headRefName, candidate);
      }
    }

    return byBranch;
  } catch {
    return null;
  }
}

// A clean checkout can still be active work: an open draft PR is an explicit
// repository-level WIP marker. Keep this evidence separate from merged PRs so
// it can block operational cleanup without ever being mistaken for proof that
// the branch landed.
export async function listOpenDraftPullRequestBranches(cwd) {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--draft',
        '--limit',
        '200',
        '--json',
        'headRefName,headRefOid,baseRefName,number,updatedAt,url',
      ],
      { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS },
    );

    const drafts = JSON.parse(stdout);
    if (!Array.isArray(drafts)) return null;

    const byBranch = new Map();
    for (const pullRequest of drafts) {
      const candidate = {
        base: pullRequest.baseRefName,
        head: pullRequest.headRefOid,
        number: pullRequest.number,
        updatedAt: (pullRequest.updatedAt ?? '').slice(0, 10),
        url: pullRequest.url,
      };
      const existing = byBranch.get(pullRequest.headRefName);
      if (!existing || candidate.updatedAt > existing.updatedAt) {
        byBranch.set(pullRequest.headRefName, candidate);
      }
    }

    return byBranch;
  } catch {
    return null;
  }
}

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownersCachePath(), 'utf8'));
    if (!Array.isArray(parsed.owners) || parsed.owners.length === 0) return null;
    if (Date.now() - (parsed.fetchedAt ?? 0) > CACHE_TTL_MS) return null;

    return parsed.owners;
  } catch {
    return null;
  }
}

function writeCache(owners) {
  try {
    fs.mkdirSync(path.dirname(ownersCachePath()), { recursive: true });
    fs.writeFileSync(ownersCachePath(), `${JSON.stringify({ fetchedAt: Date.now(), owners }, null, 2)}\n`);
  } catch {
    // A cache miss costs one gh call. Never fail a scan over it.
  }
}
