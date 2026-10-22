# Git Groundskeeper

`git-groundskeeper` scans local folders for Git state that needs attention:

- dirty worktrees
- staged, unstaged, and untracked files
- large dirty files that deserve review before commit
- branches ahead of upstream
- branches with no upstream
- branches whose upstream is gone
- stashes
- nested repositories
- linked worktrees outside the scanned folder

It is intentionally a CLI first. The JSON output is meant to power a future
desktop or menubar app.

Use `git-groundskeeper verify /absolute/path/to/repository --json` to recheck
the live `origin` default branch for one repository and its registered
worktrees. This skips discovery, size scans, ignored-file scans, and GitHub PR
queries. It compares captured full commit IDs against the immutable live
default-branch commit, even when a local tracking ref is stale but that object
is already available. It never fetches or changes references. Missing objects,
incomplete history, and failed Git commands remain unknown; they never become
proof that a branch is merged or unmerged.

Verification reports include the default branch, exact remote commit, check
time, and fixed, credential-free diagnostic codes for unavailable evidence.
Transient network or timeout failures get at most one retry. These facts are
also included in bucket scans. A verification report describes commit history;
it does not replace retirement's content, ownership, activity, and approval
checks.

The default text output is scoped to the folder you pass in. It renders one
summary table per worktree inside that folder, then separates repository-level
branch and stash cleanup. Use `--details` when you want the full linked-worktree
audit for every worktree Git knows about, including paths outside the scanned
folder.

Color is enabled automatically for interactive terminals and disabled when
output is piped. Use `--color=always` to force it or `--no-color` to disable it.

Interactive reports reserve a four-cell right gutter so borders do not trigger
deferred autowrap or collide with terminal block chrome and scrollbars that can
briefly reduce Warp's usable content width without updating the reported PTY
width. When a bucket table cannot preserve the minimum
readable width of every safety field, it switches to labeled field/value cards
instead of crushing identifiers into a few ambiguous characters. Explanatory
text is wrapped deliberately to the same safe width. ANSI color, CJK paths,
combining marks, ordinary emoji, and keycap emoji are measured by visible
terminal cells rather than JavaScript string length.

Interactive scans open the **Deep Forest Telemetry** dashboard on stderr: an
animated phase rail, neon progress bar, throughput, phase ETA, elapsed time,
activity trace, and live canopy radar. The layout contracts from the full
command center to a compact status line as the terminal narrows. Percentages
are always phase-local completed/total counts; the dashboard never invents a
misleading whole-scan percentage.

Discovery yields periodically so the display keeps moving even while mapping a
large filesystem. Because the dashboard stays on stderr, stdout remains safe to
pipe or parse as JSON. `--progress` forces an escape-free milestone log when
stderr is not interactive, `--no-progress` disables progress, and `--no-color`
keeps the dashboard monochrome.

For the maximal version, pass `--3d-progress`. It keeps the complete Deep
Forest Telemetry dashboard and adds a framed, animated ASCII environment that
expands across the terminal's available width and height. The scene visualizes
the current phase and phase-local progress rather than serving as a decorative
loading loop, and recomposes itself as the terminal is resized. Spatial mode
uses the terminal's alternate screen, then restores the original screen and
cursor before printing the final report. The flag implies `--progress`;
redirected stderr still receives only the restrained, escape-free milestone
log.

For a sharper, graphic alternative, pass `--signal-progress`. It opens the
full-terminal **Signal Garden**, a responsive 2×2 instrument matrix inspired by
cell-based ASCII motion systems: Line Scan, Centre Wave, Phase Register, and
Arrow Field. Known phase progress controls the scan head, committed register
cells, and powered vector boundary. Discovery is labelled indeterminate and
never fabricates a percentage. Signal Garden uses the same alternate-screen,
resize, pipe-safety, and cleanup guarantees as `--3d-progress`; narrow or short
terminals collapse into a single signal instrument instead of wrapping.

For a focused, cinematic instrument, pass `--pulse-progress`. It opens the
full-terminal **Pulse Observatory**, built around a continuously moving ECG
trace on a faint timing grid. A fixed conduction gate marks actual phase-local
completion: trace history before the gate is illuminated while the future stays
dim. The heartbeat may keep moving while a slow command waits, but the progress
gate advances only when completed/total evidence changes. Discovery uses a
travelling acquisition gate labelled `NO TOTAL`, with no fabricated percentage.
It shares the same resize, alternate-screen restoration, pipe safety, and narrow
terminal fallbacks as the other immersive modes.

For a fluid topographic treatment, pass `--wave-progress`. It opens the
full-terminal **Centre Wave**, adapted from the row-offset wave system in the
ASCII motion reference: narrow bands breathe asymmetrically around the centre,
adjacent rows lag one another, black channels remain structural, and pale crest
cells stay rare. The waves remain ambient while a separate vertical gate carries
the truthful phase-local completed/total position. Discovery replaces that gate
with a travelling acquisition sweep labelled `NO TOTAL`, so visual motion never
pretends to be measured progress. Centre Wave shares the alternate-screen,
resize, pipe-safety, and narrow-terminal guarantees of the other immersive modes.

## Usage

```bash
git-groundskeeper scan
git-groundskeeper scan --details
git-groundskeeper scan .
git-groundskeeper scan ~/Development
git-groundskeeper scan ~/Development --json
git-groundskeeper scan ~/Development --color=always
git-groundskeeper scan ~/Development --3d-progress
git-groundskeeper scan ~/Development --signal-progress
git-groundskeeper scan ~/Development --pulse-progress
git-groundskeeper scan ~/Development --wave-progress
git-groundskeeper scan ~/Development --fail-on-attention
git-groundskeeper watch ~/Development --interval 30
git-groundskeeper reclaim ~/Development --tool flutter
git-groundskeeper reclaim ~/Development --tool xcode
git-groundskeeper session-complete /path/to/worktree
git-groundskeeper retire /path/to/worktree --retain-branch
git-groundskeeper --version
```

Every text and JSON report includes tool provenance: package version, source
commit, dirty state, and whether the command is running from a development
checkout or a packaged install. Keep `git-groundskeeper` installed from a
package for stable operations; use `npm run dev -- ...` (or a separate local
`git-groundskeeper-dev` launcher) when deliberately testing checkout changes.

## Retire one worktree

`retire` is the single-path, branch-preserving operator workflow. Its default
is a read-only receipt. It rechecks the exact branch and full HEAD, Git status,
ignored content, locks, in-progress operations, submodules, detached retention,
and active processes immediately before ordinary `git worktree remove`.

If tracked or untracked work exists, the receipt inventories every status item
and blocks retirement until human-authored, non-secret work has been preserved
in a verified local archival commit on a retained branch. Do not make a dirty
checkout appear clean with `git restore`, `git checkout --`, `git clean`, reset,
forced removal, or an equivalent discard operation. A preservation commit is a
recovery checkpoint; it is not approval to merge the preserved work.

```bash
# Inspect and save the structured evidence receipt.
git-groundskeeper retire /path/to/worktree --retain-branch --json

# After confirming the owning task is inactive, remove only this checkout.
git-groundskeeper retire /path/to/worktree --retain-branch --apply --yes
```

The apply form never forces removal and never deletes local or remote branches.
A detached clean checkout first receives a visible
`git-groundskeeper/retained-detached/<object-id>` safety branch. Any changed or
unknown evidence blocks the action and leaves the path in place.

## Reclaim Flutter build output

`reclaim` inventories proven Flutter-generated output and is read-only by
default. It requires a Flutter SDK dependency in `pubspec.yaml`, ignored and
untracked targets, paths contained inside the project without symlink
boundaries, successful size and process probes, and no recent writes.

```bash
# Read-only inventory, largest candidates first.
git-groundskeeper reclaim ~/Development --tool flutter

# Permanently remove only each project's configured Flutter build directory.
git-groundskeeper reclaim ~/Development --tool flutter --apply --yes

# Opt into Flutter's broader canonical clean behavior.
git-groundskeeper reclaim ~/Development --tool flutter --full-clean --apply --yes
```

Permanent cleanup requires both `--apply --yes` and at least one explicit root.
Immediately before each action, Groundskeeper repeats the manifest, Git,
filesystem, freshness, process, and target-identity checks. `--full-clean`
delegates to `flutter clean`; without it, Groundskeeper removes only the exact
configured build output. Use `--json` for the same evidence and result model in
machine-readable form.

Apply reports distinguish three measurements: planned target removal, verified
target bytes removed, and the before/after available-space change for each
affected filesystem. The filesystem delta can differ because of APFS sharing,
snapshots, delayed accounting, and concurrent disk activity.

## Reclaim project-local Xcode DerivedData

The Xcode provider discovers `.xcodeproj`, `.xcworkspace`, `project.yml`, and
`Package.swift` roots and considers only an ignored, untracked, project-local
`DerivedData/` directory. It preserves dirty source and unrelated keeps.

```bash
# Read-only inventory, largest candidates first.
git-groundskeeper reclaim ~/Development --tool xcode

# Permanently remove exact proven DerivedData targets.
git-groundskeeper reclaim ~/Development --tool xcode --apply --yes
```

It does not remove global Xcode data or run `xcodebuild clean`.

## Reclaim SwiftPM and Node output

The SwiftPM and Node providers use the same evidence gates and exact-target
model. They remove only `.build/` beside `Package.swift` or `node_modules/`
beside `package.json`; they do not change lockfiles or global package caches.

```bash
git-groundskeeper reclaim ~/Development --tool swiftpm
git-groundskeeper reclaim ~/Development --tool node
git-groundskeeper reclaim ~/Development --tool auto --worktrees-only
```

`--tool auto` combines Flutter, Xcode, SwiftPM, and Node into one ranked plan.
`--exclude-primary` omits canonical checkouts, while `--worktrees-only` keeps
only linked worktrees. Both remain read-only unless `--apply --yes` is present.

## GitHub runner caches and disk pressure

The GitHub runner provider inventories one runner's `_work/_tool` cache and
keeps Flutter versions named by live workflow refs. It treats `stable`, missing,
or dynamic Flutter version configuration as a deletion hold, so version drift
cannot silently expire an SDK that a workflow might still use.

```bash
git-groundskeeper reclaim ~/.github-runners/numbus-flutter \
  --tool runner \
  --workflow-root ~/Development/numbus/B2C/numbus
```

`disk-pressure` turns the same exact-target reclaim proof into an emergency
response: it reports linked-worktree caches on filesystems below a configurable
free-space threshold, then cleans only when `--apply --yes` is explicitly
provided and pressure still exists.

```bash
git-groundskeeper disk-pressure ~/Development --min-free-gb 20
git-groundskeeper disk-pressure ~/Development --min-free-gb 20 --apply --yes
```

See [GitHub runner and disk-pressure operations](docs/GITHUB_RUNNER_AND_DISK_PRESSURE.md)
for workflow-reference and revalidation details.

## Complete a worktree session

`session-complete` gives project managers and agents one standardized cache
teardown boundary. It runs all supported reclaim providers against exactly one
worktree, remains read-only by default, and never removes Git state or the
worktree itself.

```bash
git-groundskeeper session-complete /path/to/worktree
git-groundskeeper session-complete /path/to/worktree --apply --yes
```

## Discovery

A bare `scan` takes no roots and defaults to your home directory, so it works
on a machine whose layout you know nothing about. Noise that never holds real
work is pruned by name: `Library`, `Applications`, media folders, and package
manager caches whose registry checkouts are themselves Git repositories.

Hidden directories are never pruned by pattern, only by name, because agent
tools check out real linked worktrees inside them. Codex, for example, puts
worktrees in `~/.codex/worktrees/<hash>/<repo>` — nowhere near where you keep
your projects, and therefore the easiest kind of worktree to forget.

You do not need to discover every worktree yourself. Git records each linked
worktree in the main repository, so finding one entry point per repository is
enough: the scanner resolves each hit to its common Git directory, groups by
that identity, and then asks Git for the full worktree list. Worktrees living
outside the scanned folder still appear, which is what `--details` reports.

## Ownership

Most repositories on a developer's disk are not theirs. Vendored dependencies,
cloned references, plugin marketplaces, and agent scratch all contain real Git
repositories, and reporting them as needing attention is how a scanner becomes
noise. Each repository is tagged by the owner in its remote URL:

```bash
git-groundskeeper scan --mine
git-groundskeeper scan --owner your-name --owner your-org
```

Your accounts are detected with `gh api user` and `gh api user/orgs` and cached
for a day, so `scan --mine` needs no arguments and no knowledge of the machine.
Pass `--owner` to skip detection, `--no-detect-owners` to forbid it, or
`--refresh-owners` to re-query. If `gh` is missing, unauthenticated, or offline,
detection returns nothing and every repository reports as `unknown` rather than
being hidden.

- `mine` — a remote points at one of your accounts
- `external` — it has a remote, but not yours
- `no-remote` — nothing to push to, so nothing to compare against
- `unknown` — no `--owner` given; the tool will not guess

`--mine` is applied before any repository is scanned, not after. That ordering
is deliberate and it is also the performance fix: repositories you do not own
are reliably the slowest on the disk, because a vendored dependency with a huge
working tree can hold the whole scan open on its own while `git status` walks
it. Filtering afterwards would still pay for every one of them.

From the repo:

```bash
npm test
node bin/git-groundskeeper.js scan ~/Development
node bin/git-groundskeeper.js scan ~/Development --details
```

## Design Notes

Folder watching alone is not enough. Uncommitted changes live in checked-out
worktrees, but unpushed commits live on branches, including branches that are
not currently checked out anywhere. The scanner therefore inspects both:

1. worktree filesystem state
2. whole-repo branch/upstream state

The scanner shells out to `git` instead of parsing `.git` internals directly.
That keeps it compatible with normal repositories, linked worktrees, nested
repositories, and future Git behavior.

Bucket tables separate Git recoverability from checkout visibility. Clean,
pushed checkouts are split by integration state. A clean checkout whose branch
is integrated, synchronized with its same-named remote branch, and has no
review-required ignored content is `ready if unused`: Git state is recoverable,
and the remaining check is whether an active task, IDE, terminal, or process
still uses the path. A live GitHub merged-PR check then separates branches that
can be retired from branches that should remain after checkout removal. The PR head
must equal the branch's current tip, so reusing a branch name after an older PR
merged does not retire newer work. Exact live merge evidence proves the content
landed, but it does not erase the original branch history. A nonzero `Unmerged`
count therefore moves the checkout to a review bucket and retains the source
branch, even for a merged PR. Remote branch deletion is deliberately a separate
action; the bucket does not perform it or silently add it to cleanup commands.

An open draft pull request is treated separately as explicit WIP. A matching
draft puts the checkout in `blocked: open draft PR marks active WIP`, names the
PR and base branch, and suppresses every worktree or branch removal command.
This applies even when the checkout is clean and its current commits already
appear in an integration branch: Git recoverability does not cancel the task
owner's stated intent to continue the work. Draft detection is part of ordinary
cleanup classification and does not require bucket output. `--no-pr-check`
disables both merged-PR and draft-WIP evidence.

For those cleanup candidates, the scanner also runs a targeted, read-only
`git ls-remote --heads` against only their configured remotes. This catches a
branch deleted on GitHub even when the local `refs/remotes/...` entry is stale.
It does not run `fetch`, update `FETCH_HEAD`, prune tracking refs, or change the
working tree. A successful live result outranks the local cache; if the remote
is unavailable, the scanner falls back conservatively to local state. Use
`--no-live-remote-check` for an entirely local bucket scan.

`Keep unmerged branch`, `integration unknown`, and differently named upstream
cases remain review buckets. For example, a local `fix/foo` tracking
`origin/main` is not presented as if it tracked `origin/fix/foo`.

A directory copied from a linked worktree can carry the original `.git`
pointer with it. Those paths are not independent checkouts: removing the
registered worktree can delete metadata the copy still needs. When multiple
paths resolve to the same worktree Git directory, every non-primary path is
placed in `blocked: aliased worktree metadata` and receives no cleanup command.

Ignored content is inspected before a checkout is called reclaimable. Ordinary
directories are walked recursively. Conventional build/dependency trees that
could contain millions of files are recorded as a whole review item instead of
being walked or assumed disposable: a name like `build/` is not proof that a
`signing.keystore` inside it can be regenerated. Content that differs from the
primary checkout, or any such coarse directory, moves the worktree to
`check first: ignored content here`. If a required Git or filesystem safety
probe fails, the worktree instead enters `blocked: inspection failed`; an
unknown result is never treated as clean.

That bucket is followed by a compact **Keeps review** grouped by repository and
path family. It separates coarse uninspected trees, sensitive paths, generated
test evidence, editor settings, and unknown content, then gives conservative
rule advice. `--keeps-details` appends the same review plus exact path samples
to the selected compact, detailed, or bucketed report; it does not change the
report layout. The JSON report always retains the complete `preciousIgnored`
list. Advice is never an automatic whitelist: generic `build/` trees are not
trusted by name, and sensitive or record-like content is never recommended for
suppression. Known tool output is suppressed only with repository-local
proof—for example a matching manifest or exact runtime configuration. This
includes narrowly proven Vite/Astro `dist/`, PHPUnit cache, CodeIgniter file
sessions, and generated Flutter JetBrains library indexes; generic output
trees, coverage, logs, databases, lockfiles, generated source, and authored IDE
settings stay visible.

### Repository-local ignored-content policy

When a repository has additional locally disposable output that cannot be
proven from a standard tool manifest, place `groundskeeper-policy.json` in its
common Git directory (normally `.git/groundskeeper-policy.json` in the primary
checkout). Because linked worktrees share that directory, one policy applies to
the whole repository without changing any branch.

```json
{
  "schemaVersion": 1,
  "ignoredContent": {
    "disposable": [
      {
        "path": "build/",
        "reason": "Project-owned build output regenerated by the local build workflow"
      },
      {
        "path": "ios/Podfile.lock",
        "reason": "This repository intentionally regenerates the ignored CocoaPods lock"
      },
      {
        "gitignorePattern": "exportedData-profile-*/",
        "reason": "Project-owned emulator exports are disposable"
      }
    ]
  }
}
```

Each rule defines either an exact `path` or a root-relative
`gitignorePattern`. A trailing slash declares a directory subtree. Pattern
rules support literal POSIX path text plus `*`, `**`, and `?`; negation,
character classes, parent traversal, absolute paths, and Git metadata fail
closed. Patterns are applied only to paths Git already reports as ignored, so
an exemption in `.gitignore` remains visible as ordinary untracked content.
Symlinked policy files, malformed JSON, and partial schema errors also fail
closed. Declared paths stop blocking checkout retirement, but remain auditable
as `policyIgnored` entries in JSON and on the `policy-ignored` line in the
detailed text report. Groundskeeper never infers that databases, exports, or
secrets are disposable; those require an explicit repository-local decision.

Generated branch-retirement commands do not rely on `git branch -d`'s upstream
semantics. Immediately after Git accepts the worktree removal, Groundskeeper
rechecks the branch against the integration base recorded by the scan, then
deletes the ref only if it still points at the exact scanned object ID. A moved
branch, a changed base relationship, or missing scan evidence leaves the branch
intact. Commands never use `--force` or `-D`.

Attached-checkout commands also verify the checked-out branch and full HEAD
before removal. This prevents a clean checkout whose branch or tip changed
after the report from disappearing under stale approval.

Detached-checkout commands are guarded too. They recheck the checkout's exact
HEAD and then prove that the containing local branch/tag still reaches it, or
that the exact live remote ref verified by the scan still exists. Before Git is
allowed to remove the worktree, the command creates a visible local safety
branch named `git-groundskeeper/retained-detached/<full-object-id>` and rechecks
HEAD. The safety branch deliberately remains for later review, so the commit is
still named even if its original local or remote ref changes immediately after
the retention check. If the evidence is already gone, the checkout remains in
place. As with every `ready if unused` command, do not run it while another
process or person is operating on the checkout.

In every reclaimable case the commits are retained by a branch, tag, or verified
live remote, but removing the checkout still makes its path disappear from
normal filesystem, IDE, and task views. The `Upstream` column names the
configured tracking branch; `Remote` shows its observed ahead/behind state, and
`GitHub` names the merged pull
request and target branch when found. `No exact-name merged PR match` is not
proof that the branch was not merged: a pull request can use a differently
named head branch, the GitHub query is capped, and some work lands without a
pull request. `Push` is the exact number of commits ahead of that
upstream; a live exact-tip match can correct a stale local ahead count, while a
changed live tip is shown as `?` until fetched. `Unmerged` counts commits absent
from the repository integration base (`origin/dev`, `origin/main`, or
`origin/master`). It remains the raw ancestry count even when separate PR or
squash evidence confirms the content landed. Squash-merged history can remain
nonzero because Git cannot see the equivalent squash commit as ancestry; those
branches remain outside automatic deletion buckets. `?`
means there is no comparable upstream or base. `Age` is the HEAD commit age and
is context only, not proof that a worktree is inactive.

Bucket output also includes **Repository integration evidence**. It names the
canonical `owner/repository`, the integration base actually used for `Unmerged`,
the remote default branch and live default-branch SHA, and an ancestry summary
for the displayed worktrees. This keeps `origin/dev` as valid integration
evidence without implying that the same commits are already contained in a
repository whose primary branch is `master`. The JSON report carries the exact
worktree tip (`head`), integration-base SHA (`unmergedBaseHead`), default branch
and SHA (`defaultBranch`, `defaultBranchHead`), live upstream state, and
`defaultBranchContainment` for row-level review. A primary containment result is
only reported when the local `origin/<default>` tip exactly matches the live
remote default SHA; otherwise it stays unknown rather than trusting stale refs.

`--sizes` runs `du` for every discovered worktree, including primary, dirty,
locked, in-progress, submodule-bearing, aliased, and otherwise blocked rows.
This makes the flag independent of cleanup classification and can make a broad
scan materially slower. A failed `du` remains visible as `-`. Bucket reports
label non-reclaimable bucket totals as `on disk`; those measurements never
contribute to `Reclaimable after review`. The non-bucket report totals the
measured rows it displays and discloses partial coverage if any measurement
failed. Individual row sizes are inclusive, so a parent worktree includes any
nested submodule or repository row beneath it. Totals count only non-overlapping
measured paths and disclose excluded nested rows instead of counting the same
disk usage twice.

Add `--scope-strict` to a sized scan when only the exact requested roots need
disk measurements. Groundskeeper still reads repository-wide Git metadata so
outside linked worktrees and checked-out branches cannot become invisible, but
it skips their expensive `du` walks. Live remote-default evidence is likewise
deferred until a repository has an actual removal candidate.

Squash detection remains read-only: its synthetic comparison commit is written
to a temporary object directory and the repository object database is mounted
only as an alternate. `--no-squash-detect` is therefore a speed/coverage trade,
not a repository-write safety requirement.

## Operations

- [Worktree Removal SOP](docs/WORKTREE_REMOVAL_SOP.md) — the standard
  machine-inventory, exact-approval, branch-retention, and verification
  procedure for retiring whole worktree checkouts.
- [Disk Reclamation SOP](docs/DISK_RECLAMATION_SOP.md) — the manual A/B/C
  procedure for safely recovering developer disk space.
- [Worktree Cache Lifecycle Playbook](docs/WORKTREE_CACHE_LIFECYCLE.md) — the
  standard session lifecycle for preventing worktree caches from accumulating.
- [Reclaim Command Contract](docs/RECLAIM_COMMAND_CONTRACT.md) — provider
  lifecycle, invariants, result model, and Flutter-provider requirements.
- [Safety Audit Checklist](docs/SAFETY_AUDIT_CHECKLIST.md) — evidence and
  regression coverage behind cleanup classifications and generated commands.
