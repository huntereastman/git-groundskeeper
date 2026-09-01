# Git Worktree Retirement SOP

Use this seven-phase procedure to remove completed linked worktree checkouts from
Hunter's Mac without losing uncommitted work, ignored evidence, local-only
commits, active task state, or branches that should remain recoverable.

This SOP removes whole linked checkouts. It never removes primary checkouts,
local branches, remote branches, or unrelated worktree metadata. For generated
output inside a retained checkout, use the
[Worktree Cache Lifecycle Playbook](./WORKTREE_CACHE_LIFECYCLE.md). For a wider
low-disk incident, use the [Disk Reclamation SOP](./DISK_RECLAMATION_SOP.md).

## Non-negotiable boundaries

- Work one exact path at a time. Never use a shell loop or broad glob.
- Preserve the branch during the first pass. Branch retirement is a separate
  future decision and is outside `retire`.
- Never use direct recursive deletion, `git worktree remove --force`, or
  `git branch -D`.
- Never use `git restore`, `git checkout --`, `git clean`, reset, forced
  removal, or an equivalent discard operation to make a worktree eligible.
- A dirty checkout is presumed to contain valuable work. Preserve all
  human-authored, non-secret tracked and untracked changes in a verified local
  archival commit on a retained branch before reconsidering retirement.
- A preservation commit is a recovery checkpoint, not approval to merge it.
- Credentials, caches, dependencies, build products, and disposable generated
  artifacts may be excluded only after explicit classification. Record every
  exclusion; leave uncertain or sensitive files untouched.
- A dirty, locked, aliased, inspection-error, in-progress, submodule-bearing,
  active, or review-required-ignored-content checkout is blocked.
- A detached checkout requires a verified retaining ref and receives a visible
  local safety branch before removal.
- Old age, large size, or a merged-looking name is context, not permission.
- Stop when evidence changes or becomes unknown.

## Phase 1 — Inventory the worktree forest

Record free space, then run a read-only bucket scan across the standard
worktree-bearing roots:

```bash
df -h /System/Volumes/Data

git-groundskeeper scan \
  /Users/hunter/Development \
  /Users/hunter/.codex/worktrees \
  /Users/hunter/.github-runners \
  /Users/hunter/code \
  --sizes \
  --scope-strict \
  --buckets \
  --keeps-details \
  --no-progress \
  --no-color
```

The default scan is read-only, including squash-merge detection: synthetic
comparison objects are isolated in a temporary object database. Add
`--no-squash-detect` only when speed matters more than squash-merge coverage.

Every report records the running package version, commit, dirty state, and
source mode. Stop if the operator expected the packaged stable CLI but the
report says `development-checkout` or `dirty`.

`--scope-strict` keeps repository-wide Git safety context but limits expensive
size walks to the explicit roots. `--mine` is optional and must not be treated
as proof that no external or no-remote worktree exists.

## Phase 2 — Triage the buckets

| Bucket | SOP decision |
|---|---|
| `ready if unused` | Candidate only; continue to task/process confirmation. |
| `review: remove checkout, retain branch` | Candidate only; preserve the branch and named integration context. |
| `push first` | Stop. Push or otherwise establish durable retention, then rescan. |
| `check first: ignored content here` | Stop. Preserve or explicitly classify every reported keep. |
| `blocked`, `inspection failed`, `WIP`, `submodule`, `aliased` | Stop and resolve the named blocker. |
| `primary checkout` | Never remove through this SOP. |

Treat `Reclaimable after review` as an estimate, not deletion approval. Select
one repository and one exact linked-worktree path. Refer to it by project and
feature in discussion, then include the absolute Git path in the action record.

## Phase 3 — Preserve dirty work

If the selected worktree is dirty, stop retirement and inventory it completely:

```bash
git -C /absolute/path/to/selected-worktree status \
  --short \
  --untracked-files=all
```

Classify every item before staging. Preserve all human-authored, non-secret
work, including intentional deletions and untracked files, in a local archival
commit on the existing retained branch. If the checkout is detached, create a
named local recovery branch first. Do not stage credentials or proven
regenerable artifacts merely to make the status clean; record each exclusion
and keep the checkout until excluded sensitive or uncertain data has been moved
to an appropriate recoverable location.

Before resuming retirement, verify and record all of the following:

- the retained branch name;
- the archival commit's full object ID;
- the exact staged and committed path list;
- every excluded path and its classification; and
- a clean worktree status, with no discarded files.

Later commits can refine, revert, or split the checkpoint. Do not rewrite the
archival commit until another durable reference or bundle preserves it.

## Phase 4 — Produce the exact retirement receipt

Run `retire` against only the selected path:

```bash
git-groundskeeper retire /absolute/path/to/selected-worktree \
  --retain-branch \
  --json > /approved/location/worktree-retirement-receipt.json
```

Without `--apply`, this changes nothing. The receipt records:

- canonical target and primary paths;
- branch or detached state and full HEAD object ID;
- current bucket and measured bytes;
- dirty state, locks, Git operations, aliases, and initialized submodules;
- the complete tracked and untracked preservation inventory for dirty targets;
- the required archival-checkpoint policy and prohibited discard shortcuts;
- review-required and policy-classified ignored content;
- detached-retention evidence;
- active-process inspection;
- an evidence fingerprint; and
- tool version and source provenance.

In Codex, separately confirm that the owning task is landed, rejected,
superseded, or deliberately closed. `Completed awaiting review` and `completed
awaiting approval` are retention states. The CLI cannot infer task ownership;
`--yes` is the operator's assertion that this check was completed.

If process inspection lists a PID, identify it and let it finish:

```bash
ps -p 12345 -o pid=,ppid=,etime=,command=
```

Do not kill a task merely to make the receipt eligible.

## Phase 5 — Approve one immutable target and policy

Approval must name the exact path and branch policy. Use this form:

> Approve removal of `/absolute/path/to/selected-worktree` only. Preserve its
> local branch, create a safety branch if detached, do not delete any remote
> branch, do not force removal, and do not expand the target.

An instruction such as “clean old worktrees” is not an adequate action scope.
If the path, branch, HEAD, owning task, or receipt changes after approval,
return to Phase 4.

## Phase 6 — Apply with immediate revalidation

Run exactly one approved action from outside the target checkout:

```bash
git-groundskeeper retire /absolute/path/to/selected-worktree \
  --retain-branch \
  --apply \
  --yes \
  --json
```

The command runs the full plan twice, compares evidence fingerprints, then
checks the branch and full HEAD again immediately before ordinary
`git worktree remove`. It never passes `--force`. An attached branch is retained.
A detached HEAD is first named as
`git-groundskeeper/retained-detached/<full-object-id>` using an expected-old ref
update. Any mismatch blocks removal and leaves the checkout in place.

Generated `scan --commands` output remains useful for auditing individual Git
guards, but it is not the primary SOP action path. Never pipe generated commands
into a shell.

## Phase 7 — Verify, record, and stop

An applied receipt must report `status: removed` and both postconditions:

- `targetRemoved: true`
- `retainedRefExists: true`

Independently verify the selected path, registry, retained branch, and disk:

```bash
test ! -e /absolute/path/to/selected-worktree
git -C /absolute/path/to/primary worktree list --porcelain
git -C /absolute/path/to/primary show-ref --verify refs/heads/feature/name
df -h /System/Volumes/Data
```

For a detached checkout, verify the safety ref named in the receipt instead.
Record the receipt with the task or maintenance log. Stop when the stated disk
or hygiene objective is met; approval for one target never authorizes another.

If the result is `blocked` or `partial`, do not use `rm -rf`, `--force`, manual
metadata pruning, or branch deletion as a fallback. Preserve the checkout,
investigate the exact reason, and restart at Phase 1 or Phase 3.
