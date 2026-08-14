# How to Reclaim Developer Disk Space Safely

> Git Groundskeeper Disk Reclamation SOP

This standard operating procedure defines how to reclaim developer disk space
without confusing generated output with user data. It is both:

- an operator runbook that can be followed manually; and
- the operating contract for the implemented `git-groundskeeper reclaim`
  command.

`reclaim` currently automates Flutter output, project-local Xcode DerivedData,
SwiftPM `.build`, and Node `node_modules`. Container, global IDE/package-manager
storage, simulator, shared SDK, and human-owned storage remain explicit manual
decisions.

For the normal creation, use, and retirement of worktree-local caches, follow
the [Worktree Cache Lifecycle Playbook](./WORKTREE_CACHE_LIFECYCLE.md). That
playbook applies proactively whenever Groundskeeper is installed or known to be
available; this SOP remains the incident-oriented procedure for low disk space.

## Operating policy

Use this procedure when free space is low, a build fails for lack of space, or
the machine becomes unstable under developer workloads.

Starting thresholds for a developer Mac:

| State | Free space | Required response |
|---|---:|---|
| Monitor | 25-50 GiB | Inventory and schedule cleanup. |
| Urgent | 10-25 GiB | Stop new builds and reclaim proven generated output. |
| Emergency | Below 10 GiB, or the machine is crashing | Stop active producers, reclaim the safest large targets first, and verify after every action. |

The thresholds are operational defaults, not filesystem guarantees. Adjust
them for the machine and workload.

## Non-negotiable safety rules

1. **Inventory before deletion.** Record the owner, location, size, and active
   context for every proposed target.
2. **Prove regeneration locally.** A directory name such as `build/`, `dist/`,
   or `cache/` is not proof. Require a matching project manifest or a tool's
   own inventory.
3. **Fail closed.** A failed status check, unreadable directory, unresolved
   symlink, unknown container context, or missing manifest blocks cleanup.
4. **Recheck immediately before acting.** Scan evidence can become stale while
   a build, container, IDE, or agent is running.
5. **Use exact targets.** Never apply a recursive deletion to a broad root such
   as the home directory, `~/Development`, `/`, or an unresolved variable.
6. **Keep local and remote container state separate.** Never run a bare prune
   until the selected Docker context or Podman connection is named and shown.
7. **Do not empty Trash as a shortcut.** Trash may contain unrelated source,
   credentials, state files, or recovery material.
8. **Do not automate personal-file decisions.** Archives, videos, exports,
   databases, and backups require human review even when they are large.

These rules extend the ignored-content guarantees in
[the safety audit](./SAFETY_AUDIT_CHECKLIST.md). A generic `build/` directory
must remain review-required unless a separate reclaim provider proves its
ownership and exact cleanup behavior.

## A. Measure and stabilize

### A1. Record free space

On macOS:

```bash
df -h /System/Volumes/Data
```

Record the available space before any cleanup. Use the same command after each
major action so reported savings reflect actual filesystem space, not only a
tool's estimate.

### A2. Stop active space producers

Do not kill processes blindly. First inspect likely builders and container
engines:

```bash
pgrep -fl 'flutter|dart|xcodebuild|gradle|podman|docker' || true
```

Finish or intentionally stop active builds before cleaning their output.
Running application containers may hold databases or other state and require a
separate decision.

### A3. Run the Groundskeeper Git inventory

From the repository checkout:

```bash
node bin/git-groundskeeper.js scan ~/Development \
  --mine \
  --sizes \
  --buckets \
  --keeps-details \
  --no-progress \
  --no-color
```

This scan answers the Git and worktree questions. Use the separate `reclaim`
inventory for Flutter build output, then continue through the remaining storage
lanes below.

## B. Reclaim in risk-ranked order

Start with the largest target in the earliest applicable lane. Re-run the free
space check after each lane and stop when the machine has enough headroom.

### Lane 1: Proven project-generated output

This is the preferred first action because the source remains in Git and the
toolchain can rebuild the output.

#### Flutter projects

Start with the read-only inventory:

```bash
node bin/git-groundskeeper.js reclaim ~/Development --tool flutter
```

It ranks candidates by allocated bytes and changes nothing. A candidate must
prove the Flutter manifest, configured build directory, Git ignore and tracking
state, path containment, absence of symlink boundaries, successful probes, no
matching active build, and no write in the last ten minutes.

To permanently remove only the proven configured build directories:

```bash
node bin/git-groundskeeper.js reclaim ~/Development \
  --tool flutter \
  --apply \
  --yes
```

For Flutter's broader canonical cleanup, opt in explicitly:

```bash
node bin/git-groundskeeper.js reclaim ~/Development \
  --tool flutter \
  --full-clean \
  --apply \
  --yes
```

Both permanent modes require explicit roots, repeat all evidence checks before
each action, verify remaining targets, and separately report planned target
removal, verified target bytes removed, and filesystem available-space gain.
Without `--full-clean`, Groundskeeper deletes only the configured Flutter build
directory. With it, Groundskeeper delegates to `flutter clean`.

The following manual procedure is the fallback when reviewing one project or
when the automated provider blocks it.

Run these checks from one Flutter project root at a time:

```bash
test -f pubspec.yaml
rg -n '^[[:space:]]+sdk:[[:space:]]+flutter[[:space:]]*$' pubspec.yaml
git check-ignore -q build && echo 'build/ is ignored'
test -z "$(git ls-files -- build .dart_tool)" && echo 'no tracked build files'
du -sh build .dart_tool 2>/dev/null
pgrep -fl 'flutter|dart|xcodebuild|gradle' || true
```

Proceed only when all of the following are true:

- the current directory is the intended project root;
- `pubspec.yaml` proves a Flutter SDK dependency;
- `build/` is ignored by Git;
- Git reports no tracked files under `build/` or `.dart_tool/`;
- the target is a real directory inside the project, not a symlink to another
  location; and
- no active build is using the project.

Then run Flutter's canonical cleanup:

```bash
flutter clean
```

`flutter clean` is broader than deleting `build/`. Depending on the installed
Flutter version and enabled platforms, it can run Xcode workspace cleanup and
remove `.dart_tool`, the configured build directory, generated platform files,
and ephemeral platform directories. The next build may need dependency
resolution and will take longer.

Verify the result:

```bash
du -sh build .dart_tool 2>/dev/null || true
git status --short
df -h /System/Volumes/Data
```

`git status --short` must not show unexpected source changes. If it does, stop
and inspect them before continuing to another project.

#### Xcode projects

Start with the read-only inventory:

```bash
git-groundskeeper reclaim ~/Development --tool xcode
```

To permanently remove only proven project-local `DerivedData/` directories:

```bash
git-groundskeeper reclaim ~/Development --tool xcode --apply --yes
```

The provider requires an Xcode, XcodeGen, or Swift package marker; a Git
worktree; ignored and untracked DerivedData; path containment without symlinks;
no matching active build; and no recent writes. It repeats those checks before
deletion. Dirty source and unrelated keeps do not block or get changed.

The provider does not touch global Xcode DerivedData, archives, exports, or
custom build directories, and does not invoke `xcodebuild clean`.

#### Other project toolchains

Do not infer cleanup from the directory name alone. Use the owning tool only
after its manifest and exact output paths are proven. Future reclaim providers
may cover Gradle, SwiftPM, Node, Vite/Astro, Composer, Rust, Terraform, and .NET,
but each provider needs its own evidence and tests.

### Lane 2: Local container storage

Container cleanup can recover large amounts of space, but context mistakes can
delete state on another machine. Inventory first:

```bash
podman system connection list
podman machine list --all-providers
docker context ls
```

Measure an explicitly named target:

```bash
podman --connection <connection-name> system df
docker --context <context-name> system df
```

Before pruning, inspect containers, images, and volumes on that same explicit
target:

```bash
podman --connection <connection-name> ps --all
podman --connection <connection-name> volume ls
docker --context <context-name> ps --all
docker --context <context-name> volume ls
```

Rules:

- Never run `podman system prune` or `docker system prune` without naming the
  intended connection or context.
- Never include volumes until each volume has been classified as regenerable or
  disposable. Volumes often contain database state.
- Treat a local Podman machine as a separate target from a Windows or remote
  Podman connection.

If an entire local Podman machine is confirmed disposable, remove that exact
machine rather than performing a vague machine-wide prune:

```bash
podman machine stop <machine-name>
podman machine rm <machine-name>
```

This permanently removes the machine's local containers, images, networks, and
volumes. It does not remove resources from a separately named remote
connection. Re-list machines and recheck disk space afterward.

### Lane 3: IDE caches and crash artifacts

Close the owning application before touching its files. Measure the candidate:

```bash
du -sh "$HOME/Library/Caches/JetBrains" 2>/dev/null
find "$HOME" -maxdepth 2 -name 'java_error_in_*.hprof' -print
```

Rules:

- JetBrains directories under `~/Library/Caches/JetBrains/` are caches and can
  be regenerated after the application is closed.
- JetBrains directories under `~/Library/Application Support/JetBrains/` may
  contain plugins and configuration. An old version can be a cleanup candidate,
  but it is not equivalent to a cache.
- Java `.hprof` files are crash heap dumps. Remove them only when the crash is
  no longer being diagnosed.
- Prefer a recoverable Trash move when the machine has enough headroom. A file
  in Trash still consumes disk space, so an emergency permanent deletion needs
  explicit confirmation for the exact path.

### Lane 4: Apple simulator and Xcode storage

Inventory devices and runtimes with Apple's supported tools:

```bash
xcrun simctl list devices -j
xcrun simctl runtime list -v
```

Safe first step:

```bash
xcrun simctl delete unavailable
```

Preview old runtime removal before deleting anything:

```bash
xcrun simctl runtime delete --notUsedSinceDays 30 --dry-run
```

Delete only an approved runtime identifier:

```bash
xcrun simctl runtime delete <runtime-identifier>
```

Removing a runtime can shut down its simulators and requires a later download
to use that OS version again. A recently used runtime or a runtime required by
an active Xcode task is not a cleanup candidate.

Simulator dyld shared caches are regenerable but can be expensive to rebuild:

```bash
xcrun simctl runtime dyld_shared_cache remove --all
```

Use that command only after confirming no simulator-dependent task is active.
Review `DerivedData`, archives, device support, installed Xcode versions, and
simulator devices separately. Do not treat them as one cache.

### Lane 5: SDK versions and application caches

Examples include old Android NDKs, CocoaPods downloads, browser caches, and
application updaters.

For Android NDKs, prove that no project requests the version before using the
Android SDK manager to uninstall it:

```bash
rg -n 'ndkVersion|ndkPath' "$HOME/Development" -g '*.gradle' -g '*.gradle.kts'
du -sh "$HOME/Library/Android/sdk/ndk/"* 2>/dev/null
```

Application caches are candidates only when the owning application is closed.
An active updater or installation directory must be left alone until it
finishes.

### Lane 6: Human-review-only files

Never automate deletion of:

- ZIP archives, exports, videos, photos, and downloads;
- local databases, Terraform state, signing files, keychains, or credentials;
- Backblaze databases or backup indexes;
- logs still needed for an active incident; or
- unrelated items already in Trash.

Groundskeeper may report these files and their sizes, but it must label them
`human review` and emit no deletion command.

## C. Verify and record

### C1. Confirm recovered space

```bash
df -h /System/Volumes/Data
```

Record:

- free space before and after;
- the exact targets cleaned;
- planned target removal, verified target bytes removed, and filesystem space
  gained;
- any cleanup failure or partial result; and
- anything intentionally retained.

### C2. Confirm project integrity

For every cleaned project:

```bash
git status --short
```

Do not describe the procedure as successful if unexpected tracked changes
appeared. Rebuild one representative active project when practical; a clean
build is the proof that the deleted output was regenerable.

### C3. Re-run Groundskeeper

```bash
node bin/git-groundskeeper.js scan ~/Development \
  --mine \
  --sizes \
  --buckets \
  --no-progress \
  --no-color
```

The final report should still surface dirty worktrees, ignored content, stashes,
and unpushed branches independently of the disk cleanup.

## Automation contract

The manual A/B/C procedure is the source workflow implemented by the Flutter
provider. See the [reclaim command contract](./RECLAIM_COMMAND_CONTRACT.md) for
its interface, provider lifecycle, safety invariants, result model, and test
requirements.

## Quick decision order

When time is short, use this order:

1. Measure free space and stop active builders.
2. Reclaim proven Flutter build output.
3. Remove a confirmed-unused local container machine or explicitly scoped
   unused images.
4. Remove closed-application caches and obsolete crash dumps.
5. Remove approved simulator runtimes or shared caches.
6. Remove proven-unused SDK versions.
7. Escalate personal files and stateful data for human review.
8. Verify free space, Git status, container contexts, and one representative
   rebuild.

## Troubleshooting

### `--mine` reports that no owner is available

Authenticate GitHub CLI or pass the owner explicitly:

```bash
gh auth status
node bin/git-groundskeeper.js scan ~/Development --owner <github-owner> --sizes --buckets
```

Do not remove `--mine` merely to make the error disappear. Doing so can pull
vendored, external, and tool-managed repositories into the report.

### A Flutter project fails one of the proof checks

Do not run the cleanup from that directory. Confirm the project root, inspect
the full `pubspec.yaml`, and review any tracked file reported by:

```bash
git ls-files -- build .dart_tool
```

A tracked output means `flutter clean` could change repository state. The
provider classifies that project as blocked.

### `flutter clean` fails or only partially cleans

Keep the failure attached to that project. Recheck running Flutter, Dart,
Gradle, and Xcode processes, then inspect the remaining directory sizes. Do not
replace the failed tool cleanup with a broad recursive deletion.

### Podman or Docker reports the wrong machine

Stop immediately and re-list contexts and connections:

```bash
podman system connection list
podman machine list --all-providers
docker context ls
```

Resume only with the intended target named explicitly in every command.

### Free space does not increase as expected

Check whether the target was moved to Trash rather than permanently removed,
whether a sparse container disk still owns allocated blocks, and whether an
application recreated its cache. Compare the actual Data-volume result rather
than relying on a directory's previous `du` estimate:

```bash
df -h /System/Volumes/Data
```

### A simulator runtime cannot be removed

List the runtime and attached devices again. A booted or active simulator task
may need to finish or shut down before the specific runtime is reconsidered.
Do not switch to direct filesystem deletion; keep using `simctl runtime`.
