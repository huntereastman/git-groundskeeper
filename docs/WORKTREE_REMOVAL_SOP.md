# How to Retire Git Worktrees Safely on This Mac

> Git Groundskeeper Worktree Removal SOP

Use this procedure to clear completed Git worktrees from Hunter's Mac without
losing uncommitted work, local-only commits, ignored evidence, active Codex
tasks, or branches that should remain recoverable.

This SOP removes whole worktree checkouts. It does not reorganize Codex's
worktree directories, delete remote branches, clean primary checkouts, or treat
cache cleanup as permission to remove a worktree.

For generated-output cleanup inside a retained worktree, use the
[Worktree Cache Lifecycle Playbook](./WORKTREE_CACHE_LIFECYCLE.md). For a
machine-wide low-disk incident that includes containers, simulators, SDKs, and
application caches, use the
[Disk Reclamation SOP](./DISK_RECLAMATION_SOP.md).

## Default policy

1. Inventory the whole machine read-only.
2. Select one repository and one exact batch for action.
3. Refer to worktrees by project and feature name in reports. Use full paths
   only in the approved removal plan and commands.
4. Preserve local branches during the first removal pass. Branch retirement is
   a later, separate decision.
5. Remove one worktree at a time with `git worktree remove`. Never use direct
   recursive deletion, `--force`, or a shell loop.
6. Recheck Git state, ignored content, task ownership, and active processes
   immediately before each removal.
7. Stop on unknown or changed evidence. Do not turn a failed safety check into
   permission to proceed.

## Safety boundaries

Never remove:

- a primary checkout;
- a dirty, locked, aliased, or inspection-error worktree;
- a worktree with a merge, rebase, cherry-pick, bisect, or other Git operation
  in progress;
- a worktree owned by an active Codex task, IDE, terminal, build, test, or
  simulator process;
- a worktree containing review-required ignored content that has not been
  classified;
- a detached checkout without a verified retaining ref; or
- a worktree merely because it is old, large, or has a merged-looking branch
  name.

Removing a worktree deletes every file beneath that checkout path, including
ignored build output and local evidence. Git commit reachability alone does not
prove the path is operationally unused.

## 1. Record the starting state

Record available disk space:

```bash
df -h /System/Volumes/Data
```

Do not start new builds while preparing a cleanup batch.

## 2. Run the machine-wide read-only inventory

These are the standard worktree-bearing roots on this Mac:

```bash
git-groundskeeper scan \
  /Users/hunter/Development \
  /Users/hunter/.codex/worktrees \
  /Users/hunter/.github-runners \
  /Users/hunter/code \
  --sizes \
  --buckets \
  --keeps-details \
  --no-progress \
  --no-color
```

The command is read-only. `--sizes` measures every discovered worktree,
including primary, dirty, and blocked rows. Individual rows can include nested
repositories; Groundskeeper excludes true descendants from aggregate totals so
the same bytes are not counted twice.

Use `--mine` only when you intentionally want to restrict the report to
detected GitHub owners. A `--mine` report is not proof that no external,
no-remote, or locally owned worktree exists.

## 3. Interpret the buckets

| Bucket | Operator decision |
|---|---|
| `ready if unused` | Candidate only. Confirm task and process inactivity before removal. |
| `review: remove checkout, retain branch` | The checkout may be removable, but preserve the branch and review the named integration or upstream condition. |
| `push first` | Do not remove automatically. Push or otherwise prove the exact tip is retained; preserve the local branch. |
| `check first: ignored content here` | Inspect every reported keep. Preserve evidence or add a narrow repository policy only after proving regeneration. |
| `blocked` / `inspection failed` / `aliased` | Do not remove. Resolve the exact blocker and scan again. |
| `primary checkout` | Never remove through this SOP. |

`Reclaimable after review` is an estimate, not deletion approval.

## 4. Build an exact project-scoped plan

Choose one repository at a time. Record each proposed worktree with:

| Field | Required value |
|---|---|
| Project | Human-readable repository name |
| Feature | Task or feature name, not a generated directory ID |
| Exact path | Absolute path used by Git |
| Owning task | Codex task title and current state, or `none` |
| Branch and tip | Local branch or detached state plus full object ID |
| Groundskeeper bucket | Exact current classification |
| Ignored content | `preciousIgnored`, `policyIgnored`, and disposition |
| Size | Inclusive row size from the scan |
| Planned action | Remove checkout only; preserve branch by default |

The approval must name the exact batch and branch policy. Example:

> Approve removal of the four listed checkout paths only. Preserve every local
> and remote branch. Do not expand the batch, force removal, prune unrelated
> metadata, or remove primary checkouts.

An instruction such as "clean old worktrees" is not an adequate deletion
scope.

## 5. Generate guarded checkout-only candidates

Re-run Groundskeeper against the exact project/worktree roots and request only
commands whose classified action already retains the branch:

```bash
project_root="/absolute/path/to/primary-checkout"
approved_worktree="/absolute/path/to/approved-worktree"

git-groundskeeper scan "$project_root" "$approved_worktree" \
  --sizes \
  --buckets \
  --keeps-details \
  --commands=worktree-only \
  --no-progress \
  --no-color
```

Review the output. Do not pipe it into a shell. Copy and execute no more than
one approved command at a time. Add other worktree roots only when their exact
paths are part of the same approved batch; do not substitute the machine-wide
parent directory in this command-generating pass.

`--commands=worktree-only` does not rewrite checkout-and-branch candidates into
branch-preserving commands. It selects buckets whose existing action retains
the branch. If a `ready if unused: remove checkout + branch` row should keep its
branch, use the manual branch-preserving procedure below instead of running a
generated checkout-and-branch command.

## 6. Recheck one worktree immediately before removal

Set exact, reviewed paths. Do not use unresolved variables or globs:

```bash
primary="/absolute/path/to/primary-checkout"
worktree="/absolute/path/to/approved-worktree"
```

Confirm Git still knows the path:

```bash
git -C "$primary" worktree list --porcelain
```

Confirm the checkout is still clean:

```bash
git -C "$worktree" status --short
```

Any output blocks removal until it is reviewed and preserved.

Record the exact branch and tip:

```bash
branch=$(git -C "$worktree" branch --show-current)
tip=$(git -C "$worktree" rev-parse HEAD)
printf 'branch=%s\ntip=%s\n' "${branch:-detached}" "$tip"
```

Confirm no process is using a file or directory inside the worktree:

```bash
lsof -nP +D "$worktree"
```

Any output means the worktree is active. Use the reported PID to identify the
owner:

```bash
pid=12345
ps -p "$pid" -o pid=,ppid=,etime=,command=
```

Let the owning task or process finish. Do not kill it merely to satisfy the
cleanup plan.

In Codex, confirm the task that owns the feature is landed, rejected,
superseded, or otherwise deliberately closed. `completed awaiting review` and
`completed awaiting approval` are retention states, not cleanup states.

Finally, rerun the exact scoped Groundskeeper scan if any time has passed or
any task, ref, ignored file, or process state changed.

## 7. Remove the checkout while preserving its branch

This manual procedure applies to an attached branch. For a detached checkout,
use the exact `--commands=worktree-only` command emitted by Groundskeeper. That
command rechecks the exact HEAD and retaining ref, creates a visible
`git-groundskeeper/retained-detached/<object-id>` safety branch, rechecks HEAD,
and only then removes the checkout. Do not simplify it to plain removal.

Run Git's ordinary removal command from the primary checkout:

```bash
git -C "$primary" worktree remove "$worktree"
```

Do not add `--force`. If Git refuses, stop and investigate the reported state.
Do not replace the failed command with `rm -rf`.

Immediately verify:

```bash
test ! -e "$worktree"
git -C "$primary" worktree list --porcelain
git -C "$primary" show-ref --verify "refs/heads/$branch"
df -h /System/Volumes/Data
```

The removed path must be absent, its worktree registration must be gone, and
the local branch must still exist when the plan said to preserve it.

Repeat Sections 6 and 7 for the next approved path. Stop when sufficient disk
headroom has been restored; approval for a batch does not require deleting the
entire batch when the objective is already met.

## 8. Handle conservative `push first` rows

`push first` means Groundskeeper could not prove the branch tip is safely
retained upstream. It does not always mean the content is absent from the
integration branch.

Before treating one as a manual checkout-only candidate, verify all of the
following:

1. the worktree is clean and inactive;
2. the exact local tip is already an ancestor of the current integration base;
3. the local integration ref matches the live remote integration tip; and
4. the local branch will be preserved.

For a repository whose integration branch is `main`:

```bash
tip=$(git -C "$worktree" rev-parse HEAD)
local_main=$(git -C "$primary" rev-parse origin/main)
remote_main=$(git -C "$primary" ls-remote origin refs/heads/main | awk '{print $1}')
test "$local_main" = "$remote_main"
git -C "$primary" merge-base --is-ancestor "$tip" "$local_main"
git -C "$primary" rev-list --count "$local_main..$tip"
```

Proceed only when the live and local `main` tips match, the ancestry check exits
successfully, and the final count is `0`. If they do not match, refresh the
repository intentionally and rerun Groundskeeper. Do not infer safety from a
stale `origin/main` ref.

This is an explicit review exception. Keep the branch and record the evidence
with the approved batch.

## 9. Retire branches separately

After checkout removal, scan again before considering local branch deletion:

```bash
project_root="/absolute/path/to/primary-checkout"

git-groundskeeper scan "$project_root" \
  --buckets \
  --commands=branch \
  --no-progress \
  --no-color
```

Review and approve each branch independently. Generated branch commands recheck
the integration base and exact scanned object ID before deleting the local ref.
They never delete a remote branch.

Keeping merged local branches is cheap and is the default when there is any
uncertainty. Never use `git branch -D` as part of routine cleanup.

## 10. Clean caches in worktrees that must remain

If a worktree is retained because of source, review, or task state, its proven
generated output can still be reclaimed separately:

```bash
# Read-only plan for one retained worktree.
git-groundskeeper session-complete /absolute/path/to/worktree

# Execute only supported, proven generated-output cleanup after exact approval.
git-groundskeeper session-complete /absolute/path/to/worktree --apply --yes
```

This never removes the worktree or a branch.

## 11. Finish and record the batch

Run the original scoped scan again and record:

- worktrees removed;
- worktrees retained and why;
- local branches retained or separately retired;
- paths and registrations verified absent;
- free space before and after;
- logical worktree bytes removed versus filesystem available-space gain; and
- any blocked or partial action.

APFS sharing, snapshots, delayed accounting, and concurrent writes can make the
filesystem gain differ from the sum of worktree sizes. Report both numbers.

Update the owning task ledger so no task continues pointing at a removed path.

## Stale registration procedure

If a worktree directory is already missing, do not immediately run a broad
prune. Preview all stale registrations first:

```bash
git -C "$primary" worktree prune --dry-run --verbose
```

Proceed with a real prune only after every item in the preview has been reviewed
and approved. A prune can affect more than the worktree that triggered the
investigation.

## Troubleshooting

### A process still uses the worktree

Identify its task or owner and wait for a normal release. A process wait is not
a Git blocker and does not authorize termination or force removal.

### Groundskeeper reports ignored content

Use `--keeps-details` and JSON to inspect the full `preciousIgnored` inventory.
Preserve evidence, secrets, exports, databases, logs, archives, and generated
configuration unless a repository-local policy proves an exact path disposable.

### The branch has no upstream

Keep the worktree or follow the explicit `push first` review in Section 8. A
populated local branch and a similar-looking commit on `main` are not enough;
verify the exact tip and live integration ref.

### Git refuses ordinary removal

Stop. Check dirty state, submodules, locks, Git operations, aliases, and active
tasks. Do not escalate to `--force`, direct filesystem deletion, or automatic
submodule deinitialization inside this SOP.

### Free space did not increase as expected

Compare `df -h /System/Volumes/Data` with the recorded worktree sizes. Check for
APFS sharing or snapshots and whether active tools recreated caches elsewhere.
Do not describe inclusive `du` totals as filesystem space gained.

## Definition of done

A worktree cleanup batch is complete only when:

- every removed path was explicitly approved;
- every worktree passed a fresh Git, ignored-content, task, and process check;
- ordinary `git worktree remove` succeeded without force;
- local and remote branches match the approved retention policy;
- removed paths and registrations are absent;
- no task ledger points to a removed worktree;
- a final Groundskeeper scan records remaining attention items; and
- logical bytes removed and filesystem free-space change are reported
  separately.
