import { git } from './git.js';
import { devNull } from 'node:os';

const DEFAULT_TIMEOUT_MS = 10_000;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MESSAGES = {
  timeout: 'The default-branch remote check timed out.',
  authentication: 'Authentication prevented the default-branch remote check.',
  'sandbox-access': 'Local access restrictions prevented the default-branch remote check.',
  network: 'A network failure prevented the default-branch remote check.',
  'remote-unavailable': 'The configured remote could not be reached as a Git repository.',
  'missing-origin': 'The requested Git remote is not configured.',
  'invalid-response': 'The remote did not advertise one valid default branch and full commit ID.',
  'git-failed': 'Git could not complete the default-branch remote check.',
  'invalid-head': 'Containment requires a valid full captured commit ID.',
  'missing-object': 'A required commit is not available locally; containment is unknown.',
  'shallow-history': 'The repository has shallow history; non-containment cannot be verified.',
  'comparison-failed': 'Git could not verify complete commit ancestry; containment is unknown.',
};

function diagnostic(code) {
  return { code, message: MESSAGES[code], retryable: code === 'timeout' || code === 'network' };
}

function isFullObjectId(value) {
  return typeof value === 'string' && FULL_OBJECT_ID.test(value) && !/^0+$/.test(value);
}

function isBranchName(value) {
  return typeof value === 'string' && value.length > 0 && value !== '@'
    && !value.startsWith('-') && !value.endsWith('.')
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    && !value.includes('..') && !value.includes('@{')
    && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function invocation(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 60_000)
    : DEFAULT_TIMEOUT_MS;
  const runner = options.runGit ?? git;
  return async (cwd, args) => {
    try {
      return await runner(cwd, args, {
        timeoutMs,
        maxBuffer: 1024 * 1024,
        // Commit inspection must not fetch missing promisor objects or read a
        // replacement graph. These commands never update refs or the index.
        env: {
          GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
          GIT_GRAFT_FILE: devNull, GIT_OPTIONAL_LOCKS: '0',
        },
      });
    } catch (error) {
      return {
        ok: false,
        stdout: '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : error?.message ?? '',
        status: error?.code,
        timedOut: error?.timedOut === true || error?.code === 'ETIMEDOUT'
          || (error?.killed === true && ['SIGTERM', 'SIGKILL'].includes(error?.signal)),
      };
    }
  };
}

function remoteFailure(result) {
  // Raw diagnostics are used only for classification. Never return stderr,
  // exception text, remote URLs, or environment values in public evidence.
  const detail = typeof result?.stderr === 'string' ? result.stderr : '';
  if (result?.timedOut || result?.status === 'ETIMEDOUT') return diagnostic('timeout');
  if (/authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey|invalid (?:username|password)|access denied|http[^\n]*\b(?:401|403)\b/i.test(detail)) {
    return diagnostic('authentication');
  }
  if (['EACCES', 'EPERM'].includes(result?.status)
      || /operation not permitted|permission denied|sandbox|dubious ownership/i.test(detail)) return diagnostic('sandbox-access');
  if (/\btimed? out\b|\btimeout (?:expired|after)\b/i.test(detail)) return diagnostic('timeout');
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(result?.status)
      || /could not resolve (?:host|hostname)|network is unreachable|no route to host|failed to connect|connection (?:refused|reset|closed)|temporary failure in name resolution|remote end hung up unexpectedly/i.test(detail)) {
    return diagnostic('network');
  }
  if (/repository[^\n]*not found|does not appear to be a git repository|could not read from remote repository|not a git repository|repository[^\n]*does not exist/i.test(detail)) {
    return diagnostic('remote-unavailable');
  }
  return diagnostic('git-failed');
}

function parseAdvertisement(stdout) {
  if (typeof stdout !== 'string') return null;
  let branch = null;
  let head = null;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 2 || fields[1] !== 'HEAD') return null;
    const value = fields[0];
    if (value.startsWith('ref: refs/heads/')) {
      if (branch !== null) return null;
      branch = value.slice('ref: refs/heads/'.length);
    } else {
      if (head !== null || !isFullObjectId(value)) return null;
      head = value.toLowerCase();
    }
  }
  return isBranchName(branch) && head ? { branch, head } : null;
}

/** Read the live remote HEAD without fetching or changing repository state. */
export async function inspectLivePrimaryBranch(cwd, remote = 'origin', options = {}) {
  const run = invocation(options);
  const evidence = {
    remote, branch: null, ref: null, head: null, status: 'unavailable',
    checkedAt: new Date().toISOString(), error: null,
  };
  // Only named remotes are accepted: a caller cannot inject a URL (possibly
  // containing credentials) into the evidence or use an option as a remote.
  if (typeof remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) {
    return { ...evidence, remote: null, error: diagnostic('missing-origin') };
  }
  const remotes = await run(cwd, ['remote']);
  if (!remotes?.ok) return { ...evidence, error: remoteFailure(remotes) };
  if (!String(remotes.stdout).split(/\r?\n/).includes(remote)) {
    return { ...evidence, error: diagnostic('missing-origin') };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await run(cwd, ['ls-remote', '--symref', remote, 'HEAD']);
    if (!result?.ok) {
      const error = remoteFailure(result);
      if (attempt === 0 && error.retryable) continue;
      return { ...evidence, checkedAt: new Date().toISOString(), error };
    }
    const parsed = parseAdvertisement(result.stdout);
    if (!parsed) return { ...evidence, error: diagnostic('invalid-response') };
    return {
      ...evidence, ...parsed, ref: `${remote}/${parsed.branch}`, status: 'checked',
      checkedAt: new Date().toISOString(),
    };
  }
}

function unknown(error) {
  return { containment: 'unknown', error };
}

/** Compare immutable captured commit IDs, never tracking refs or branch names. */
export async function inspectDefaultBranchContainment(cwd, exactHead, primaryEvidence, options = {}) {
  if (!isFullObjectId(exactHead)) return unknown(diagnostic('invalid-head'));
  if (primaryEvidence?.status !== 'checked' || !isFullObjectId(primaryEvidence?.head)) {
    // Do not trust arbitrary callers to supply a sanitized diagnostic object.
    const code = primaryEvidence?.error?.code;
    return unknown(diagnostic(Object.hasOwn(MESSAGES, code) ? code : 'comparison-failed'));
  }
  const run = invocation(options);
  const capturedHead = exactHead.toLowerCase();
  const defaultHead = primaryEvidence.head.toLowerCase();
  if (capturedHead.length !== defaultHead.length) return unknown(diagnostic('invalid-head'));
  for (const head of new Set([capturedHead, defaultHead])) {
    const object = await run(cwd, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
    if (!object?.ok) {
      return unknown(diagnostic(object?.status === 1 && !object.stderr?.trim()
        ? 'missing-object' : 'comparison-failed'));
    }
    // Reject tags, replacement/misresolved objects and inconsistent injected
    // responses: the comparison must use precisely the captured commit IDs.
    if (object.stdout?.trim().toLowerCase() !== head) return unknown(diagnostic('comparison-failed'));
  }
  const ancestry = await run(cwd, ['merge-base', '--is-ancestor', capturedHead, defaultHead]);
  if (ancestry?.ok) return { containment: 'contained', error: null };
  if (ancestry?.status !== 1) return unknown(diagnostic('comparison-failed'));

  const shallow = await run(cwd, ['rev-parse', '--is-shallow-repository']);
  if (!shallow?.ok) return unknown(diagnostic('comparison-failed'));
  if (shallow.stdout?.trim() === 'true') return unknown(diagnostic('shallow-history'));
  if (shallow.stdout?.trim() !== 'false') return unknown(diagnostic('comparison-failed'));
  // Exit 1 is conclusive only when the remote commit's ancestry is complete.
  // A missing parent may otherwise be mistaken for a disconnected history.
  const history = await run(cwd, ['rev-list', '--count', defaultHead]);
  if (!history?.ok || !/^[1-9]\d*$/.test(history.stdout?.trim() ?? '')) {
    return unknown(diagnostic('comparison-failed'));
  }
  return { containment: 'not-contained', error: null };
}
