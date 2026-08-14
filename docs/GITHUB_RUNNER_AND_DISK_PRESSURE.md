# GitHub Runner Cache And Disk Pressure

Git Groundskeeper has two cleanup surfaces for developer machines under disk
pressure. Both are read-only by default. Neither removes a worktree, Git
history, source file, dependency lockfile, or global SDK installation.

## GitHub Runner Tool Cache

The `runner` reclaim provider inventories a single self-hosted GitHub Actions
runner's `_work/_tool` directory. It reports every tool cache family and its
immediate version directories. At present, it expires only Flutter SDK cache
directories named like `stable-3.47.0-arm64`; other tool caches are inventory
only until they have equally strong workflow-reference proof.

```bash
# Inspect one runner and use live remote workflow refs as retention evidence.
git-groundskeeper reclaim ~/.github-runners/numbus-flutter \
  --tool runner \
  --workflow-root ~/Development/numbus/B2C/numbus

# Delete only a revalidated, superseded Flutter cache entry.
git-groundskeeper reclaim ~/.github-runners/numbus-flutter \
  --tool runner \
  --workflow-root ~/Development/numbus/B2C/numbus \
  --apply --yes
```

`--workflow-root` is required before a runner cache entry can become eligible
for deletion. Groundskeeper reads workflow YAML from `origin/main`,
`origin/master`, `origin/dev`, and `origin/develop` when those refs exist; it
falls back to `HEAD` when no such remote ref is present. Use repeatable
`--workflow-ref <ref>` when a different live reference set is required.

Every `subosito/flutter-action` use must declare an explicit semantic version,
either literally or through an explicitly-versioned workflow environment
variable. A missing `flutter-version`, `stable`, a dynamic expression, an
unreadable workflow, an unavailable workflow root, a recent cache write, a
symlink, or an active `Runner.Worker` process blocks deletion. Versions
referenced by workflow evidence are reported as `retained`; only unreferenced
versions can be candidates.

The apply path rereads workflow references and runner activity, validates the
cache directory identity, and refuses removal if any evidence changed after the
plan was produced.

## Disk Pressure

`disk-pressure` measures every filesystem containing the supplied roots. Its
default threshold is 20 GiB of available space per filesystem, configurable
with `--min-free-gb`.

```bash
# Report only. The plan includes linked worktree Flutter, Xcode, SwiftPM, and
# Node caches only on filesystems below the threshold.
git-groundskeeper disk-pressure ~/Development --min-free-gb 20

# Run that same proven, linked-worktree-only plan only while pressure remains.
git-groundskeeper disk-pressure ~/Development --min-free-gb 20 --apply --yes
```

The command always excludes primary checkouts and uses the existing exact-target
reclaim proof rules. If each measured filesystem meets the threshold, even an
explicit `--apply --yes` performs no deletion. When below the threshold, the
standard per-target evidence and identity revalidation still applies.

Disk-pressure does not run Flutter's broader `flutter clean` mode. Use the
explicit project-scoped reclaim command when that broader cleanup is wanted.
