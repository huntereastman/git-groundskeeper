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

The default text output is scoped to the folder you pass in. It renders one
summary table per worktree inside that folder, then separates repository-level
branch and stash cleanup. Use `--details` when you want the full linked-worktree
audit for every worktree Git knows about, including paths outside the scanned
folder.

Color is enabled automatically for interactive terminals and disabled when
output is piped. Use `--color=always` to force it or `--no-color` to disable it.

## Usage

```bash
git-groundskeeper scan
git-groundskeeper scan --details
git-groundskeeper scan .
git-groundskeeper scan ~/Development
git-groundskeeper scan ~/Development --json
git-groundskeeper scan ~/Development --color=always
git-groundskeeper scan ~/Development --fail-on-attention
git-groundskeeper watch ~/Development --interval 30
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
