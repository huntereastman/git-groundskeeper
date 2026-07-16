import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { classifyOwnership, defaultRoots, discoverWorktrees, parseRemoteOwner, scanRoots } from '../src/scanner.js';

test('scanRoots reports dirty worktrees and branches without upstream', async () => {
  const fixture = createFixture();

  git(fixture.repo, ['checkout', '-b', 'feature/no-upstream']);
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'feature\n');
  git(fixture.repo, ['add', 'feature.txt']);
  git(fixture.repo, ['commit', '-m', 'add feature']);
  fs.writeFileSync(path.join(fixture.repo, 'dirty.txt'), 'dirty\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.status, 'commit-needed');
  assert.equal(repo.worktrees.some((worktree) => worktree.dirty), true);
  assert.equal(repo.branches.some((branch) => branch.name === 'feature/no-upstream' && branch.upstreamStatus === 'none'), true);
});

test('scanRoots reports branch ahead of upstream even when worktree is clean', async () => {
  const fixture = createFixture();

  fs.writeFileSync(path.join(fixture.repo, 'ahead.txt'), 'ahead\n');
  git(fixture.repo, ['add', 'ahead.txt']);
  git(fixture.repo, ['commit', '-m', 'ahead local']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const main = repo.branches.find((branch) => branch.name === 'main');

  assert.equal(repo.status, 'push-needed');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
});

test('scanRoots follows linked worktrees from a discovered repo', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'linked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/linked', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'linked.txt'), 'linked\n');

  const report = await scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));

  assert.ok(repo);
  assert.equal(repo.primaryPath, fixture.repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === linked && worktree.dirty), true);
});

test('scanRoots marks clean gone-upstream worktrees as prune candidates when merged', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'merged-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/merged', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'merged.txt'), 'merged\n');
  git(linked, ['add', 'merged.txt']);
  git(linked, ['commit', '-m', 'merged feature']);
  git(fixture.repo, ['merge', '--ff-only', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(linked, ['push', 'origin', 'feature/merged']);
  git(linked, ['branch', '--set-upstream-to=origin/feature/merged', 'feature/merged']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/merged']);
  git(linked, ['fetch', '--prune', 'origin']);

  const report = await scanRoots([linked], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/merged');

  assert.equal(worktree.upstreamStatus, 'gone');
  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedInto, 'origin/main');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
});

test('an ignored file unique to a worktree is reported whatever it is called', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-unique-file');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'scratch-notes.txt\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore scratch']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/unique', linked, 'main']);

  // A name no precious-pattern list would ever have guessed. That is the point:
  // guessing names means being wrong loses data, so uniqueness is the test.
  fs.writeFileSync(path.join(linked, 'scratch-notes.txt'), 'do not lose me\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.dirty, false);
  assert.deepEqual(worktree.preciousIgnored, ['scratch-notes.txt']);
});

test('editor state is filtered but a secret sitting beside it is not', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-idea');

  // JetBrains does not ignore .idea/ wholesale; it ignores individual files,
  // which is why they are visible here at all. Ignoring the directory would
  // collapse it to a single entry and the tool would see nothing inside.
  fs.writeFileSync(
    path.join(fixture.repo, '.gitignore'),
    '.idea/workspace.xml\n.idea/*.iml\n.idea/dataSources.local.xml\n',
  );
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore idea state']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/idea', linked, 'main']);

  fs.mkdirSync(path.join(linked, '.idea'));
  fs.writeFileSync(path.join(linked, '.idea', 'workspace.xml'), '<project/>\n');
  fs.writeFileSync(path.join(linked, '.idea', 'has-idea.iml'), '<module/>\n');
  // JetBrains keeps database passwords here. Skipping .idea/ wholesale would
  // be tidier and would silence exactly the file worth warning about.
  fs.writeFileSync(path.join(linked, '.idea', 'dataSources.local.xml'), '<password>hunter2</password>\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.deepEqual(worktree.preciousIgnored, ['.idea/dataSources.local.xml']);
});

test('an ignored file duplicated from the primary checkout stays silent', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'has-duplicate');

  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'config.json\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore config']);
  fs.writeFileSync(path.join(fixture.repo, 'config.json'), '{"shared":true}\n');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/dup', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'config.json'), '{"shared":true}\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // Byte-identical to the primary checkout, so nothing is lost by removal and
  // warning about it would be the noise that buries a real finding.
  assert.deepEqual(worktree.preciousIgnored, []);
});

test('a symlinked env file is not reported: removing the worktree cannot lose it', async () => {
  const fixture = createFixture();
  const shared = path.join(fixture.parent, 'shared.env');

  fs.writeFileSync(shared, 'API_KEY=shared\n');
  fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'assets/.env\n');
  git(fixture.repo, ['add', '.gitignore']);
  git(fixture.repo, ['commit', '-m', 'ignore env']);
  fs.mkdirSync(path.join(fixture.repo, 'assets'));
  fs.symlinkSync(shared, path.join(fixture.repo, 'assets', '.env'));

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === fixture.repo);

  // Symlinking .env into each worktree is a normal way to avoid copying it.
  // Warning about those buries the one worktree holding a real file.
  assert.deepEqual(worktree.preciousIgnored, []);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'API_KEY=shared\n');
});

test('a worktree paused mid-rebase is blocked even though it looks clean', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'rebasing');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/rebasing', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'theirs.txt'), 'theirs\n');
  git(linked, ['add', 'theirs.txt']);
  git(linked, ['commit', '-m', 'theirs']);

  fs.writeFileSync(path.join(fixture.repo, 'theirs.txt'), 'ours\n');
  git(fixture.repo, ['add', 'theirs.txt']);
  git(fixture.repo, ['commit', '-m', 'ours']);

  // Deliberately conflicting rebase, left paused.
  try {
    git(linked, ['rebase', 'main']);
  } catch {
    // Expected: the rebase stops on the conflict.
  }
  git(linked, ['checkout', '--ours', '.']);
  git(linked, ['add', '.']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.inProgress, 'rebase');
  assert.equal(worktree.tier, 'blocked');
});

test('a worktree with a checked-out submodule is never proposed for removal', async () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'has-submodule');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/subs', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = await scanRoots([fixture.parent], { maxDepth: 3 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // `git worktree remove` fails outright here: "working trees containing
  // submodules cannot be moved or removed". Offering it proposes a command
  // that cannot work, and the submodule's own branch is unexamined besides.
  assert.equal(worktree.submodules.length, 1);
  assert.equal(worktree.submodules[0].path, 'admin');
  assert.equal(worktree.tier, 'submodule');
});

test('a locked worktree is never proposed for removal', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'locked-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/locked', linked, 'main']);
  git(fixture.repo, ['worktree', 'lock', linked]);

  const report = await scanRoots([fixture.parent], { maxDepth: 4 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  // Locking a worktree is git's own way of saying "do not reap this".
  assert.equal(worktree.locked, true);
  assert.equal(worktree.tier, 'blocked');
});

test('scanRoots detects squash-merged branches that share no history with the base', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'squashed-worktree');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/squashed', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'one.txt'), 'one\n');
  git(linked, ['add', 'one.txt']);
  git(linked, ['commit', '-m', 'first half']);
  fs.writeFileSync(path.join(linked, 'two.txt'), 'two\n');
  git(linked, ['add', 'two.txt']);
  git(linked, ['commit', '-m', 'second half']);

  git(linked, ['push', '-u', 'origin', 'feature/squashed']);

  // Exactly what GitHub's "Squash and merge" does: collapse the branch into one
  // new commit on main that shares no ancestry with it, then drop the remote
  // branch. The work is fully merged; the history says otherwise.
  git(fixture.repo, ['merge', '--squash', 'feature/squashed']);
  git(fixture.repo, ['commit', '-m', 'squashed feature (#1)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/squashed']);
  git(linked, ['fetch', '--prune', 'origin']);

  // Ancestry genuinely cannot see this, which is the whole problem.
  assert.throws(() => git(linked, ['merge-base', '--is-ancestor', 'feature/squashed', 'origin/main']));

  const report = await scanRoots([linked], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.cleanupStatus, 'prune-candidate');
  assert.equal(worktree.mergedVia, 'squash');
  assert.equal(worktree.mergedInto, 'origin/main');
  // Proving the merge does not make `git branch -d` accept it: -d consults
  // ancestry, which is exactly what a squash destroys. This is what tells the
  // reader they will need -D here and nowhere else.
  assert.equal(worktree.ancestryVisible, false);
});

test('a merged branch with no worktree is still found, which is what a prune leaves behind', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'temporary');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/left-behind', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'work.txt'), 'work\n');
  git(linked, ['add', 'work.txt']);
  git(linked, ['commit', '-m', 'the work']);
  git(linked, ['push', '-u', 'origin', 'feature/left-behind']);
  git(fixture.repo, ['merge', '--squash', 'feature/left-behind']);
  git(fixture.repo, ['commit', '-m', 'squashed (#7)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/left-behind']);
  git(fixture.repo, ['fetch', '--prune', 'origin']);

  // Exactly what a cleanup pass produces: the worktree is gone, the branch is
  // not. Scoping candidate detection to worktrees made these invisible the
  // moment they became the only thing left to clean up.
  git(fixture.repo, ['worktree', 'remove', linked]);

  const report = await scanRoots([fixture.repo], { maxDepth: 1 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const branch = repo.branches.find((candidate) => candidate.name === 'feature/left-behind');

  assert.ok(branch, 'the branch outlived its worktree and must still be examined');
  assert.equal(branch.cleanupStatus, 'prune-candidate');
  assert.equal(branch.mergedVia, 'squash');
  assert.equal(branch.ancestryVisible, false);
});

test('squash detection can be disabled to keep the scan strictly read-only', async () => {
  const fixture = createFixture();
  const linked = path.join(fixture.parent, 'squashed-optout');

  git(fixture.repo, ['worktree', 'add', '-b', 'feature/optout', linked, 'main']);
  fs.writeFileSync(path.join(linked, 'thing.txt'), 'thing\n');
  git(linked, ['add', 'thing.txt']);
  git(linked, ['commit', '-m', 'work']);
  git(linked, ['push', '-u', 'origin', 'feature/optout']);
  git(fixture.repo, ['merge', '--squash', 'feature/optout']);
  git(fixture.repo, ['commit', '-m', 'squashed (#2)']);
  git(fixture.repo, ['push', 'origin', 'main']);
  git(fixture.repo, ['push', 'origin', '--delete', 'feature/optout']);
  git(linked, ['fetch', '--prune', 'origin']);

  const report = await scanRoots([linked], { maxDepth: 1, squashDetect: false });
  const repo = report.repos.find((candidate) => candidate.worktrees.some((worktree) => worktree.path === linked));
  const worktree = repo.worktrees.find((candidate) => candidate.path === linked);

  assert.equal(worktree.cleanupStatus, null);
});

test('scanRoots reports nested submodule folders instead of Git storage paths', async () => {
  const fixture = createFixture();
  const adminSource = path.join(fixture.parent, 'admin-source');
  const linked = path.join(fixture.parent, 'linked-with-submodule');
  const nestedAdmin = path.join(linked, 'admin');

  createStandaloneRepo(adminSource);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', adminSource, 'admin']);
  git(fixture.repo, ['commit', '-m', 'add admin submodule']);
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/submodule', linked, 'main']);
  git(linked, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', 'admin']);

  const report = await scanRoots([linked], { maxDepth: 2 });
  const primaryPaths = report.repos.map((repo) => repo.primaryPath);
  const nestedRepo = report.repos.find((repo) => repo.primaryPath === nestedAdmin);

  assert.equal(primaryPaths.some((primaryPath) => primaryPath.includes(`${path.sep}.git${path.sep}`)), false);
  assert.ok(nestedRepo, primaryPaths.join('\n'));
  assert.equal(nestedRepo.worktrees.some((worktree) => worktree.path === nestedAdmin), true);
});

test('defaultRoots discovers from the home directory so no layout knowledge is needed', async () => {
  assert.deepEqual(defaultRoots(), [os.homedir()]);
});

test('discoverWorktrees prunes home-level noise but keeps real project roots', async () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-noise-')));
  const cachedRepo = path.join(parent, 'Library', 'Caches', 'vendor');
  const projectRepo = path.join(parent, 'code', 'app');

  fs.mkdirSync(path.dirname(cachedRepo), { recursive: true });
  fs.mkdirSync(path.dirname(projectRepo), { recursive: true });
  createStandaloneRepo(cachedRepo);
  createStandaloneRepo(projectRepo);

  const found = discoverWorktrees([parent], { maxDepth: 6 });

  assert.equal(found.includes(projectRepo), true);
  assert.equal(found.includes(cachedRepo), false);
});

test('scanRoots attributes agent worktrees in hidden home directories to their repo', async () => {
  const fixture = createFixture();
  const agentWorktree = path.join(fixture.parent, '.codex', 'worktrees', '2e34', 'app');

  fs.mkdirSync(path.dirname(agentWorktree), { recursive: true });
  git(fixture.repo, ['worktree', 'add', '-b', 'agent/task', agentWorktree]);

  const report = await scanRoots([fixture.parent], { maxDepth: 6 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.equal(repo.worktrees.some((worktree) => worktree.path === agentWorktree), true);
});

test('large files hidden inside untracked directories are still weighed', async () => {
  const fixture = createFixture();
  const buildDir = path.join(fixture.repo, 'build-output');

  fs.mkdirSync(buildDir);
  fs.writeFileSync(path.join(buildDir, 'artifact.bin'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(buildDir, 'small.txt'), 'small\n');

  const report = await scanRoots([fixture.parent], { maxDepth: 4, largeFileBytes: 1024 });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);
  const worktree = repo.worktrees.find((candidate) => candidate.path === fixture.repo);

  // The default sweep never looks inside untracked directories, so finding this
  // proves the deep second pass ran for a worktree that needed it.
  assert.equal(worktree.largeFiles.some((file) => file.path === 'build-output/artifact.bin'), true);
  // ...and the summary still reports one untracked directory, not its contents.
  assert.equal(worktree.status.untracked, 1);
});

test('parseRemoteOwner handles every remote URL shape', async () => {
  assert.equal(parseRemoteOwner('git@github.com:huntereastman/git-groundskeeper.git'), 'huntereastman');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus.git'), 'numbus-llc');
  assert.equal(parseRemoteOwner('https://github.com/numbus-llc/numbus'), 'numbus-llc');
  assert.equal(parseRemoteOwner('ssh://git@gitlab.com/group/thing.git'), 'group');
  assert.equal(parseRemoteOwner('https://user@dev.azure.com/org/project'), 'org');
  // Local path remotes have no owner, and must not be mistaken for one.
  assert.equal(parseRemoteOwner('/tmp/fixtures/remote.git'), null);
  assert.equal(parseRemoteOwner('../sibling/remote.git'), null);
});

test('classifyOwnership separates my repos from everything else on the disk', async () => {
  assert.equal(classifyOwnership(['huntereastman'], ['huntereastman', 'numbus-llc']), 'mine');
  // Owner matching is case-insensitive: Git remotes are not consistent here.
  assert.equal(classifyOwnership(['NumBus-LLC'], ['numbus-llc']), 'mine');
  assert.equal(classifyOwnership(['some-vendor'], ['huntereastman']), 'external');
  assert.equal(classifyOwnership([], ['huntereastman']), 'no-remote');
  // With no owners declared the tool must not guess, or it would silently
  // hide repositories it merely failed to recognise.
  assert.equal(classifyOwnership(['huntereastman'], []), 'unknown');
});

test('scanRoots tags repo ownership from its remote', async () => {
  const fixture = createFixture();
  git(fixture.repo, ['remote', 'set-url', 'origin', 'https://github.com/huntereastman/app.git']);

  const report = await scanRoots([fixture.parent], { maxDepth: 4, owners: ['huntereastman'] });
  const repo = report.repos.find((candidate) => candidate.primaryPath === fixture.repo);

  assert.ok(repo);
  assert.deepEqual(repo.owners, ['huntereastman']);
  assert.equal(repo.ownership, 'mine');
});

function createFixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-groundskeeper-')));
  const repo = path.join(parent, 'repo');
  const remote = path.join(parent, 'remote.git');

  createStandaloneRepo(repo);

  git(parent, ['clone', '--bare', repo, remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);

  return { parent, repo, remote };
}

function createStandaloneRepo(repo) {
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'groundskeeper@example.com']);
  git(repo, ['config', 'user.name', 'Git Groundskeeper']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
