# Worktree Cache Lifecycle Playbook

> Standard operating policy for agents, project managers, and developers using
> Git Groundskeeper on a local machine.

## Purpose

Git worktrees isolate source and Git state, but build systems also create large
per-checkout caches. Without a matching retirement lifecycle, short-lived
worktrees can consume hundreds of gigabytes even after their branches have
merged.

This playbook makes cache management part of normal worktree management. It
applies whenever `git-groundskeeper` is installed or the operator or agent knows
it is available. Project-specific instructions may add stricter protections;
they must not weaken this policy.

## Core policy

1. **Every worktree has an owner and lifecycle.** Record the task or session
   that created it and whether it is active, retained, completed, or abandoned.
2. **Every worktree cache is disposable only after proof.** A conventional name
   such as `build`, `DerivedData`, or `node_modules` is not enough.
3. **Cache reclamation and worktree removal are separate decisions.** A retained
   or dirty worktree may have safely reclaimable output. A merged worktree may
   still contain ignored evidence, credentials, or generated configuration that
   blocks removal.
4. **Default to a dry run.** Inventory and rank candidates before changing
   anything. Permanent cleanup requires explicit scope and confirmation.
5. **Recheck active use immediately before cleanup.** A stale inventory must
   never authorize deletion while a compiler, IDE, test runner, simulator, or
   agent session is using the worktree.
6. **Preserve source, secrets, evidence, and release artifacts.** Cache policy
   never implies permission to remove local changes, signing material, `.env`
   files, screenshots, audit output, archives, or exports.

### Dirty worktrees remain eligible for cache cleanup

Uncommitted work does not by itself block reclaim. A dirty, unpushed, primary,
locked, or intentionally retained worktree may still contain provider-proven
generated output that can be cleaned safely. Groundskeeper evaluates the exact
cleanup targets rather than requiring the entire worktree to be clean.

The boundary is strict:

- tracked content inside a proposed cleanup target blocks reclaim;
- unrelated modified source, untracked files, and ignored keeps remain in place;
- cache cleanup does not change the worktree's Git cleanup classification; and
- whole-worktree removal still requires independent Git, keeps, and active-use
  review.

## Required session lifecycle

Project manager and agent sessions should treat worktree setup and teardown as
one operation with two halves.

### Session start

- Create or adopt one explicitly named worktree.
- Record the repository, worktree path, branch, owning task or session, and
  creation time.
- Record cache roots created by the project's build and test commands.
- Prefer cache locations that can be attributed to that session or worktree.
- Mark the session active before starting compilers or long-running processes.

### During work

- Keep source and Git state inside the worktree.
- Keep build output isolated when concurrent worktrees could otherwise race.
- Share only caches whose owning tool explicitly supports concurrent sharing.
- Do not run broad cleanup while another session owns or uses the same cache.
- Store durable QA evidence and release artifacts outside disposable cache roots
  or classify them explicitly before session completion.

### Session completion

1. Stop or finish build, test, IDE, and simulator processes using the worktree.
2. Record the final Git state, branch retention, and merge or handoff evidence.
3. Run a read-only Groundskeeper scan and tool-specific reclaim inventory.
4. Reclaim proven generated output that is no longer useful.
5. Remove the worktree only when the independent Git and ignored-content checks
   permit it.
6. Verify paths, worktree registration, retained refs, and free disk space.
7. Mark the session completed only after teardown or an explicit retention
   decision.

Follow the [Worktree Removal SOP](./WORKTREE_REMOVAL_SOP.md) for the independent
approval, active-use recheck, branch-retention, removal, and verification steps.

Groundskeeper exposes this lifecycle boundary directly:

```bash
# Read-only completion plan for one session worktree.
git-groundskeeper session-complete /absolute/path/to/worktree

# Execute only supported, proven cache cleanup. Git state and the worktree stay.
git-groundskeeper session-complete /absolute/path/to/worktree --apply --yes
```

Project managers should call the read-only form before marking a session
complete. They may call the apply form only within an existing cleanup approval
envelope. Worktree removal remains a separate Groundskeeper scan/review action.

### Abandoned sessions

An abandoned session is not automatically disposable. Mark it inactive, check
Git and process state, then apply the same evidence gates as a completed
session. A time-to-live may trigger review, but age alone must never trigger
permanent deletion.

## Cache-sharing policy

Use the narrowest safe sharing boundary:

| Cache class | Default boundary | Policy |
|---|---|---|
| Build products and intermediates | One active worktree/session | Isolate; reclaim when the session ends. |
| IDE indexes | One worktree unless the IDE proves safe sharing | Treat as rebuildable but potentially active. |
| Dependency downloads | Machine or user | Share when the package manager supports locking and concurrent access. |
| Dependency checkouts | Tool-specific | Share only through an official tool option, not an ad hoc symlink. |
| Release archives and exports | Explicit artifact directory | Preserve until release retention permits removal. |
| Screenshots, QA, and audit evidence | Explicit evidence directory | Never classify as cache by location alone. |
| Credentials and generated configuration | Project/session secret storage | Preserve; never sweep with cache output. |

### Xcode and Swift projects

Do not point concurrent worktrees at one shared DerivedData directory. Build
databases, indexes, generated files, and intermediates can contain checkout
paths and can race or contaminate incremental builds.

Recommended model:

- give each active worktree or session its own DerivedData root;
- place those roots under a centrally discoverable cache directory when
  practical, for example
  `~/.cache/git-groundskeeper/xcode/<repo>/<session>/<destination>`;
- share Swift package downloads or checkouts only through Xcode or SwiftPM's
  supported cache controls, such as `-clonedSourcePackagesDirPath`;
- retain a persistent DerivedData cache for a canonical long-lived checkout if
  its incremental-build value justifies the space; and
- remove short-lived integration, screenshot, landing, and release-validation
  DerivedData after the owning session completes.

Never replace per-worktree DerivedData with symlinks to one common writable
directory.

### Flutter projects

Groundskeeper already implements an evidence-gated Flutter provider:

```bash
# Read-only inventory
git-groundskeeper reclaim ~/Development --tool flutter

# Remove only proven configured Flutter build output
git-groundskeeper reclaim ~/Development --tool flutter --apply --yes

# Delegate to Flutter's broader canonical clean
git-groundskeeper reclaim ~/Development --tool flutter --full-clean --apply --yes
```

Use build-output reclaim for routine space recovery. Use `--full-clean` only
when the broader effects of `flutter clean` are intended.

## Groundskeeper provider policy

Groundskeeper should automate cache cleanup through tool-specific reclaim
providers, not by entering every worktree and guessing a clean command.

Each provider must implement:

```text
discover -> prove ownership -> estimate -> check active use -> plan
         -> recheck -> apply exact action -> verify -> report
```

The preferred interface is:

```bash
# Existing provider
git-groundskeeper reclaim <roots...> --tool flutter

# Additional providers
git-groundskeeper reclaim <roots...> --tool xcode
git-groundskeeper reclaim <roots...> --tool swiftpm
git-groundskeeper reclaim <roots...> --tool node

# Multi-provider inventory; still read-only by default
git-groundskeeper reclaim <roots...> --tool auto
```

`--tool auto` should discover applicable providers and produce one ranked plan.
It must not weaken provider evidence or turn conventional directory names into
global deletion rules. Applying a plan must retain the existing `--apply --yes`
gate, explicit roots, freshness checks, active-use checks, and per-target
verification.

Canonical tool cleanup commands such as `flutter clean`, `xcodebuild clean`, or
package-manager clean commands should be optional provider modes. Routine
reclaim should prefer exact proven output paths because canonical clean commands
may remove generated configuration, dependency state, or other data beyond the
largest cache target.

## Routine commands

Inventory worktrees and ignored content:

```bash
git-groundskeeper scan ~/Development ~/.codex/worktrees \
  --sizes --buckets --keeps-details --no-progress
```

Inventory supported generated output:

```bash
git-groundskeeper reclaim ~/Development ~/.codex/worktrees --tool flutter
```

Record free space before and after approved cleanup:

```bash
df -h /System/Volumes/Data
```

## Definition of done

A session cleanup is complete only when:

- no active process uses the selected cache or worktree;
- Git state and ignored-content evidence were checked immediately before action;
- only explicitly classified generated output was reclaimed;
- retained branches, commits, secrets, evidence, and release artifacts remain;
- removal and remaining-path verification succeeded; and
- planned target removal, verified target bytes removed, and filesystem
  available-space gain were reported separately.
