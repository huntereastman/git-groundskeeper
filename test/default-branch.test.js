import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectDefaultBranchContainment, inspectLivePrimaryBranch } from '../src/default-branch.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SECRET = 'https://user:private-token@example.invalid/private-repository';
const checked = (head = HEAD) => ({ status: 'checked', branch: 'main', ref: 'origin/main', head });
const success = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const failure = (status, stderr = '', extra = {}) => ({ ok: false, stdout: '', stderr, status, ...extra });
const advertisement = (head = HEAD, branch = 'main') => `ref: refs/heads/${branch}\tHEAD\n${head}\tHEAD\n`;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function commit(cwd, name) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  git(cwd, ['add', name]);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', name]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'groundskeeper-default-branch-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(parent, ['init', '--bare', '-q', '-b', 'main', remote]);
  const first = commit(repo, 'first');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-qu', 'origin', 'main']);
  return { parent, repo, remote, first };
}

function remoteRunner(results) {
  const calls = [];
  const runGit = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    if (args[0] === 'remote') return success('origin\n');
    assert.deepEqual(args, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const result = results.shift();
    assert.ok(result, 'unexpected extra remote attempt');
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, runGit };
}

function comparisonRunner({ ancestry = failure(1), shallow = success('false\n'), history = success('2\n') } = {}) {
  const calls = [];
  const runGit = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    if (args[0] === 'rev-parse' && args[1] === '--verify') return success(args.at(-1).split('^')[0]);
    if (args[0] === 'merge-base') return ancestry;
    if (args[0] === 'rev-parse') return shallow;
    if (args[0] === 'rev-list') return history;
    assert.fail(`unexpected Git command: ${args.join(' ')}`);
  };
  return { calls, runGit };
}

test('live default HEAD and exact captured commit are verified without changing refs or index', async (t) => {
  const { repo, first } = fixture(t);
  const beforeRefs = git(repo, ['show-ref']);
  const beforeIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
  const evidence = await inspectLivePrimaryBranch(repo);
  assert.equal(evidence.status, 'checked');
  assert.equal(evidence.branch, 'main');
  assert.equal(evidence.ref, 'origin/main');
  assert.equal(evidence.head, first);
  assert.equal(evidence.error, null);
  assert.ok(Number.isFinite(Date.parse(evidence.checkedAt)));
  assert.deepEqual(await inspectDefaultBranchContainment(repo, first, evidence), { containment: 'contained', error: null });
  assert.equal(git(repo, ['show-ref']), beforeRefs);
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), beforeIndex);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'FETCH_HEAD')), false);
});

test('stale tracking ref does not hide locally available live default commit', async (t) => {
  const { repo, first } = fixture(t);
  const second = commit(repo, 'second');
  git(repo, ['push', '-q', 'origin', 'main']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', first]);
  const evidence = await inspectLivePrimaryBranch(repo);
  assert.equal(evidence.head, second);
  assert.deepEqual(await inspectDefaultBranchContainment(repo, second, evidence), { containment: 'contained', error: null });
  assert.equal(git(repo, ['rev-parse', 'origin/main']), first);
});

test('exact captured commit wins over a branch moving after capture', async (t) => {
  const { repo, first } = fixture(t);
  const evidence = await inspectLivePrimaryBranch(repo);
  const second = commit(repo, 'unpublished');
  assert.equal((await inspectDefaultBranchContainment(repo, first, evidence)).containment, 'contained');
  assert.deepEqual(await inspectDefaultBranchContainment(repo, second, evidence), { containment: 'not-contained', error: null });
});

test('live commit missing locally stays unknown and is not fetched', async (t) => {
  const { repo, remote, parent, first } = fixture(t);
  const other = path.join(parent, 'other');
  git(parent, ['clone', '-q', remote, other]);
  const unseen = commit(other, 'remote-only');
  git(other, ['push', '-q', 'origin', 'main']);
  const evidence = await inspectLivePrimaryBranch(repo);
  assert.equal(evidence.head, unseen);
  const result = await inspectDefaultBranchContainment(repo, first, evidence);
  assert.equal(result.containment, 'unknown');
  assert.equal(result.error.code, 'missing-object');
  assert.equal(git(repo, ['rev-parse', 'origin/main']), first);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'FETCH_HEAD')), false);
});

test('negative ancestry in a real shallow clone remains unknown', async (t) => {
  const { repo, parent, remote } = fixture(t);
  commit(repo, 'second');
  git(repo, ['push', '-q', 'origin', 'main']);
  const shallow = path.join(parent, 'shallow');
  git(parent, ['clone', '-q', '--depth=1', `file://${remote}`, shallow]);
  const evidence = await inspectLivePrimaryBranch(shallow);
  git(shallow, ['checkout', '-q', '--orphan', 'unrelated']);
  const unrelated = commit(shallow, 'unrelated');
  const result = await inspectDefaultBranchContainment(shallow, unrelated, evidence);
  assert.equal(result.containment, 'unknown');
  assert.equal(result.error.code, 'shallow-history');
});

test('local graft overlays cannot turn unrelated commits into remote containment', async (t) => {
  const { repo, first } = fixture(t);
  const evidence = await inspectLivePrimaryBranch(repo);
  git(repo, ['checkout', '-q', '--orphan', 'unrelated']);
  const unrelated = commit(repo, 'unrelated');
  const graft = path.join(repo, '.git', 'info', 'grafts');
  fs.writeFileSync(graft, `${first} ${unrelated}\n`);
  git(repo, ['merge-base', '--is-ancestor', unrelated, first]);
  const before = fs.readFileSync(graft);
  assert.deepEqual(await inspectDefaultBranchContainment(repo, unrelated, evidence), { containment: 'not-contained', error: null });
  assert.deepEqual(fs.readFileSync(graft), before);
});

test('missing origin is distinguished without probing another remote', async () => {
  const calls = [];
  const result = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: async (cwd, args) => {
    calls.push(args);
    return success('upstream\n');
  } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'missing-origin');
  assert.deepEqual(calls, [['remote']]);
});

for (const [code, result] of [
  ['timeout', failure(null, SECRET, { timedOut: true })],
  ['authentication', failure(128, `fatal: Authentication failed for '${SECRET}'`)],
  ['authentication', failure(128, `fatal: Authentication failed for '${SECRET}/timeout'`)],
  ['authentication', failure(128, `git@example.invalid: Permission denied (publickey). ${SECRET}`)],
  ['sandbox-access', failure('EPERM', `Operation not permitted: ${SECRET}`)],
  ['network', failure(128, `Could not resolve host: ${SECRET}`)],
  ['network', failure('ECONNRESET', SECRET)],
  ['remote-unavailable', failure(128, `Repository not found: ${SECRET}`)],
  ['git-failed', failure(128, `Unrecognized failure containing ${SECRET}`)],
]) {
  test(`remote ${code} is retained as a safe fixed diagnostic`, async () => {
    const fake = remoteRunner([result, result]);
    const evidence = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: fake.runGit, timeoutMs: 25 });
    assert.equal(evidence.status, 'unavailable');
    assert.equal(evidence.error.code, code);
    assert.equal(evidence.error.retryable, ['timeout', 'network'].includes(code));
    assert.equal(JSON.stringify(evidence).includes('private-token'), false);
    assert.equal(fake.calls.filter((call) => call.args[0] === 'ls-remote').length, evidence.error.retryable ? 2 : 1);
    for (const call of fake.calls) {
      assert.equal(call.options.timeoutMs, 25);
      assert.equal(call.options.env.GIT_NO_LAZY_FETCH, '1');
      assert.equal(call.options.env.GIT_NO_REPLACE_OBJECTS, '1');
    }
  });
}

test('one transient retry may succeed', async () => {
  const fake = remoteRunner([failure('ETIMEDOUT'), success(advertisement())]);
  const evidence = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: fake.runGit });
  assert.equal(evidence.status, 'checked');
  assert.equal(evidence.head, HEAD);
  assert.equal(evidence.error, null);
  assert.equal(fake.calls.length, 3);
});

test('throwing injected runner does not expose raw errors', async () => {
  const fake = remoteRunner([Object.assign(new Error(SECRET), { code: 'EACCES' })]);
  const evidence = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: fake.runGit });
  assert.equal(evidence.error.code, 'sandbox-access');
  assert.equal(JSON.stringify(evidence).includes('private-token'), false);
});

test('credential URLs are rejected as a remote argument without leaking them', async () => {
  const evidence = await inspectLivePrimaryBranch('/unused', SECRET, { runGit: () => assert.fail('must not run') });
  assert.equal(evidence.error.code, 'missing-origin');
  assert.equal(JSON.stringify(evidence).includes('private-token'), false);
});

test('SHA-256 advertisements and exact comparisons are supported', async () => {
  const sha = 'c'.repeat(64);
  const fake = remoteRunner([success(advertisement(sha, 'trunk/release'))]);
  const evidence = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: fake.runGit });
  assert.equal(evidence.head, sha);
  assert.equal(evidence.ref, 'origin/trunk/release');
  const compare = comparisonRunner({ ancestry: success() });
  assert.equal((await inspectDefaultBranchContainment('/unused', sha, evidence, { runGit: compare.runGit })).containment, 'contained');
});

test('ambiguous, malformed and unsafe remote advertisements fail closed', async () => {
  for (const stdout of [
    '', advertisement('a'.repeat(39)), advertisement('0'.repeat(40)),
    advertisement(HEAD, '../main'), advertisement(HEAD, 'main.lock'), advertisement(HEAD, '-main'),
    advertisement(HEAD, 'main@{one}'), advertisement(HEAD, 'with space'),
    advertisement() + `${OTHER}\tHEAD\n`, advertisement() + 'ref: refs/heads/other\tHEAD\n',
    `${HEAD}\tHEAD\n`, `ref: refs/tags/main\tHEAD\n${HEAD}\tHEAD\n`,
  ]) {
    const fake = remoteRunner([success(stdout)]);
    const evidence = await inspectLivePrimaryBranch('/unused', 'origin', { runGit: fake.runGit });
    assert.equal(evidence.status, 'unavailable', stdout);
    assert.equal(evidence.error.code, 'invalid-response', stdout);
    assert.equal(fake.calls.length, 2, 'malformed responses must not be retried');
  }
});

test('invalid captured IDs, mixed object formats and unavailable evidence do not run Git', async () => {
  const options = { runGit: () => assert.fail('must not run') };
  for (const head of ['main', HEAD.slice(0, 7), '0'.repeat(40), null]) {
    assert.equal((await inspectDefaultBranchContainment('/unused', head, checked(), options)).error.code, 'invalid-head');
  }
  assert.equal((await inspectDefaultBranchContainment('/unused', 'c'.repeat(64), checked(), options)).error.code, 'invalid-head');
  const result = await inspectDefaultBranchContainment('/unused', HEAD, { status: 'unavailable', error: { code: 'network', message: SECRET } }, options);
  assert.equal(result.error.code, 'network');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('object resolution SHA mismatch never becomes containment', async () => {
  const result = await inspectDefaultBranchContainment('/unused', HEAD, checked(), { runGit: async () => success(OTHER) });
  assert.equal(result.containment, 'unknown');
  assert.equal(result.error.code, 'comparison-failed');
});

test('ancestry errors remain unknown rather than being interpreted as not-contained', async () => {
  for (const ancestry of [failure(128, SECRET), failure(null, SECRET, { timedOut: true })]) {
    const fake = comparisonRunner({ ancestry });
    const result = await inspectDefaultBranchContainment('/unused', OTHER, checked(), { runGit: fake.runGit });
    assert.equal(result.containment, 'unknown');
    assert.equal(result.error.code, 'comparison-failed');
    assert.equal(JSON.stringify(result).includes('private-token'), false);
    assert.deepEqual(fake.calls.at(-1).args, ['merge-base', '--is-ancestor', OTHER, HEAD]);
  }
});

test('incomplete or uninspectable history cannot prove non-containment', async () => {
  for (const config of [
    { shallow: failure(128, SECRET) }, { shallow: success('unexpected\n') },
    { history: failure(128, `Could not read parent ${SECRET}`) }, { history: success('invalid') },
  ]) {
    const fake = comparisonRunner(config);
    const result = await inspectDefaultBranchContainment('/unused', OTHER, checked(), { runGit: fake.runGit });
    assert.equal(result.containment, 'unknown');
    assert.equal(result.error.code, 'comparison-failed');
  }
});

test('missing parent in a real non-shallow repository remains unknown', async (t) => {
  const { repo, first } = fixture(t);
  const second = commit(repo, 'second');
  git(repo, ['checkout', '-q', '--orphan', 'unrelated']);
  const unrelated = commit(repo, 'unrelated');
  fs.unlinkSync(path.join(repo, '.git', 'objects', first.slice(0, 2), first.slice(2)));
  const result = await inspectDefaultBranchContainment(repo, unrelated, checked(second));
  assert.equal(result.containment, 'unknown');
  assert.equal(result.error.code, 'comparison-failed');
});

test('complete exit-1 ancestry uses only exact commit IDs', async () => {
  const fake = comparisonRunner();
  const result = await inspectDefaultBranchContainment('/unused', OTHER, checked(), { runGit: fake.runGit });
  assert.deepEqual(result, { containment: 'not-contained', error: null });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ['rev-parse', '--verify', '--quiet', `${OTHER}^{commit}`],
    ['rev-parse', '--verify', '--quiet', `${HEAD}^{commit}`],
    ['merge-base', '--is-ancestor', OTHER, HEAD],
    ['rev-parse', '--is-shallow-repository'],
    ['rev-list', '--count', HEAD],
  ]);
});
