# Reclaim Command Contract

This reference defines the implemented `git-groundskeeper reclaim` capability. It
translates the manual [Disk Reclamation SOP](./DISK_RECLAMATION_SOP.md) into an
evidence-gated command without weakening Groundskeeper's existing Git cleanup
safety.

## Purpose

`reclaim` discovers, ranks, and optionally removes project-generated output.
Its providers support Flutter build output, project-local Xcode DerivedData,
SwiftPM `.build`, and Node `node_modules`. Later providers may support other
toolchains or selected developer-tool storage only when their cleanup targets
and regeneration evidence can be proven locally.

Provider development and session behavior must also follow the
[Worktree Cache Lifecycle Playbook](./WORKTREE_CACHE_LIFECYCLE.md). In
particular, multi-provider cleanup must preserve provider-specific proof and
must not infer ownership from conventional cache directory names.

The command must keep two questions separate:

1. **Can this data be regenerated?** Answered by the reclaim provider.
2. **Is this the right time and place to remove it?** Answered by active-use,
   scope, context, and freshness checks.

## Interface

```bash
# Read-only inventory, sorted by potential savings.
git-groundskeeper reclaim ~/Development --tool flutter

# Explicit execution after displaying the candidate report.
git-groundskeeper reclaim ~/Development --tool flutter --apply --yes

# Delegate Flutter's broader canonical cleanup when requested.
git-groundskeeper reclaim ~/Development --tool flutter --full-clean --apply --yes

# Machine-readable evidence and results.
git-groundskeeper reclaim ~/Development --tool flutter --json

# Inventory project-local Xcode DerivedData.
git-groundskeeper reclaim ~/Development --tool xcode

# Permanently remove proven project-local Xcode DerivedData.
git-groundskeeper reclaim ~/Development --tool xcode --apply --yes

# Combine every supported provider, excluding canonical checkouts.
git-groundskeeper reclaim ~/Development --tool auto --worktrees-only
```

Permanent cleanup requires both `--apply --yes` and at least one explicit root.
`--min-age-minutes` defaults to 10; `0` explicitly disables the freshness hold.

## Provider lifecycle

Every provider follows the same state machine:

```text
discover -> prove -> estimate -> block -> plan -> apply -> verify
                \-> blocked --------------------------> report
```

| Phase | Required behavior |
|---|---|
| Discover | Find candidate projects and exact tool-owned paths inside the requested roots. |
| Prove | Establish repository-local or tool-native evidence that each target is regenerable. |
| Estimate | Measure allocated bytes without changing the target. |
| Block | Refuse unsafe paths, active use, recent writes, tracked content, failed probes, and ambiguous ownership. |
| Plan | Render the exact action, scope, consequences, and expected savings. |
| Apply | Re-run all evidence checks, then perform only the approved exact action. |
| Verify | Measure target removal and filesystem-space change, capture exit status, and confirm repository state. |

## Global invariants

1. The default operation is read-only.
2. Discovery stays inside the requested filesystem roots and treats every
   Flutter manifest found there, including linked worktrees beneath those
   roots, as an independent project candidate.
3. Every candidate names its project root, output paths, size, age, proof, and
   blocking reasons.
4. Candidates are sorted by reclaimable bytes, not repository name.
5. Failed or incomplete evidence produces `blocked`, never `candidate`.
6. `--apply --yes` re-runs every safety check and refuses changed evidence.
7. Generic `build/` remains review-required outside a proven provider.
8. Active or recently modified output is blocked by default.
9. Permanent deletion requires both execution flags and at least one explicit
   filesystem root.
10. JSON output retains complete evidence, action results, and partial failures.
11. Container actions require an explicit Docker context, Podman connection, or
    Podman machine name.
12. Human-authored files and stateful data receive no generated deletion action.
13. One failed target does not hide successful or untouched targets.
14. The command reports planned target removal, verified target bytes removed,
    and filesystem available-space gain as separate measurements.
15. Unrelated dirty, untracked, or ignored worktree content does not block
    reclaim. Eligibility is determined from the exact provider-owned targets;
    unrelated content must remain unchanged.

## Candidate result model

Text and JSON reports must be generated from the same underlying result:

```json
{
  "tool": "flutter",
  "projectRoot": "/path/to/project",
  "targets": [
    {
      "relativePath": "build",
      "bytes": 0,
      "ignored": true,
      "tracked": false,
      "insideProject": true,
      "symlink": false
    }
  ],
  "estimatedBytes": 0,
  "proof": [
    "Flutter SDK dependency",
    "targets are ignored",
    "no tracked files"
  ],
  "blockedReasons": [],
  "action": "flutter clean",
  "status": "candidate"
}
```

Supported statuses are:

- `candidate`: all evidence passed; no action has run;
- `blocked`: one or more safety checks failed;
- `cleaned`: the action succeeded and verification completed;
- `partial`: the action failed or left one or more targets behind; and
- `unchanged`: the approved target no longer existed at apply time.

## Flutter provider

### Discovery evidence

A project is Flutter-owned only when its `pubspec.yaml` proves a Flutter SDK
dependency. The presence of `pubspec.yaml`, `build/`, an `ios/` directory, or a
Flutter-looking filename alone is insufficient.

Nested Flutter packages are independent candidates with their own project
roots and output paths.

### Cleanup modes

The provider distinguishes two actions:

| Mode | Intended behavior | Consequence |
|---|---|---|
| Build-output reclaim | Remove only exact, proven Flutter build output. | Fastest disk recovery with the smallest project disturbance. |
| Full clean | Delegate to the installed `flutter clean`. | Can also remove `.dart_tool`, generated platform files, and ephemeral platform directories, and can run Xcode workspace cleanup. |

The candidate report must state which mode will run. A full clean must not be
presented as if it only deletes `build/`.

Apply reports use `verifiedTargetBytesRemoved` for target allocation that was
present before the action and absent afterward. A separate `filesystemSpace`
object records before/after available bytes once per affected filesystem and
their delta. Concurrent writes and APFS accounting can make that delta differ
from removed target bytes; neither measurement is labelled "actual reclaimed."

### Required proof

Before either cleanup mode becomes a candidate, verify:

- the exact project root;
- a Flutter SDK dependency in `pubspec.yaml`;
- the configured build directory, including a non-default relative setting;
- every cleanup path resolves inside the project root;
- no cleanup path crosses a symlink boundary;
- each target is ignored by Git;
- no tracked file exists below any target;
- every filesystem and Git probe completed successfully; and
- no matching active or recently modified build is present.

The apply phase repeats all checks. A changed manifest, path, file-tracking
state, process state, or target identity blocks the stale plan.

### Required tests

- accepts a Flutter project with a proven SDK dependency;
- rejects a Dart-only `pubspec.yaml`;
- rejects a generic ignored `build/` directory;
- rejects any tracked file below a cleanup target;
- blocks a symlink that resolves outside the project;
- handles project paths containing spaces;
- treats a nested Flutter package as its own project;
- detects a configured non-default Flutter build directory;
- blocks an active or recently modified build;
- fails closed when a Git or filesystem probe fails;
- rechecks all evidence before applying;
- reports partial `flutter clean` failures;
- reports planned target removal, verified target bytes removed, and filesystem
  available-space gain separately;
- keeps text and JSON status consistent; and
- preserves existing ignored-content and worktree cleanup classifications.

## Xcode provider

The Xcode provider discovers project roots containing an `.xcodeproj`,
`.xcworkspace`, `project.yml`, or `Package.swift`, and considers only a
project-local `DerivedData/` directory. It does not inspect or remove Xcode's
global DerivedData, archives, exports, or arbitrary build directories.

Before `DerivedData/` becomes a candidate, the provider requires a Git
worktree, an Xcode/Swift project marker, an ignored and untracked target,
project containment without symlink boundaries, successful size and freshness
probes, and no active build process using the project. Apply repeats the full
analysis and target-identity checks before exact deletion.

Dirty source and unrelated ignored or untracked content do not block Xcode
reclaim and must remain untouched. `--full-clean` is not supported for Xcode;
Groundskeeper does not guess schemes, destinations, configurations, or custom
build settings for `xcodebuild clean`.

### Required Xcode tests

- discovers supported project markers and ignores roots without DerivedData;
- rejects non-Git projects, unignored targets, and tracked target content;
- blocks symlink boundaries, active builds, recent writes, and failed probes;
- rechecks evidence and target identity before applying;
- preserves unrelated dirty, untracked, and ignored content; and
- reports planned target removal, verified target bytes removed, and filesystem
  available-space gain consistently in text and JSON.

## SwiftPM and Node providers

The SwiftPM provider requires `Package.swift` and considers only the sibling
`.build/` directory. The Node provider requires `package.json` and considers
only the sibling `node_modules/` directory. Both require Git worktree ownership,
ignored and untracked target content, containment without symlinks, successful
size/freshness/process probes, and apply-time revalidation.

These providers do not remove lockfiles, global SwiftPM/npm caches, package
manager configuration, generated source outside their exact target, or release
artifacts. Dirty source and unrelated keeps remain eligible and untouched.

`--tool auto` combines Flutter, Xcode, SwiftPM, and Node candidates into one
ranked report and one apply verification pass. `--exclude-primary` omits every
repository's primary worktree. `--worktrees-only` is the stricter operational
name for selecting only linked worktrees and implies `--exclude-primary`.

## Relationship to existing scan behavior

The existing scanner intentionally keeps generic `build/` directories in
ignored-content review because an apparently generated directory can contain
the only copy of a signing key or other user data. The Flutter provider adds a
separate proven action. It must not turn `build/` into a global regenerable
whitelist or suppress the existing warning before the provider has completed
its proof.

Worktree retirement and output reclamation also remain separate actions. A
dirty, unpushed, primary, locked, or otherwise retained worktree may still have
regenerable build output, but cleaning that output must not change the
worktree's Git classification.

This is an intentional eligibility rule, not an exception. Reclaim must inspect
and mutate only the provider's exact targets. Dirty source files and unrelated
untracked or ignored keeps remain visible to `scan`, but do not block cache
cleanup and must be byte-for-byte untouched by the provider action. Tracked
content inside a cleanup target still blocks that target.

## Future providers

A new provider requires:

1. exact local ownership evidence;
2. a documented cleanup action and side effects;
3. a bounded path model;
4. active-use and freshness checks;
5. pre-apply evidence revalidation;
6. failure and partial-result reporting; and
7. positive, negative, symlink, tracked-file, path-with-spaces, and race tests.

Providers must also test that unrelated dirty, untracked, and ignored content
survives successful reclaim.

No provider may be added solely because a directory has a conventional cache
or build name.
