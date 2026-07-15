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
git-groundskeeper scan ~/Development
git-groundskeeper scan ~/Development --details
git-groundskeeper scan ~/Development --json
git-groundskeeper scan ~/Development --color=always
git-groundskeeper scan ~/Development --fail-on-attention
git-groundskeeper watch ~/Development --interval 30
```

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
