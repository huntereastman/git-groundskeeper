# Safety Audit Working Checklist

This document tracks the confirmed correctness and safety defects found during the July 20-21, 2026 audit of `git-groundskeeper`. It is deliberately a working checklist: an issue is complete only when the implementation, regression coverage, and focused verification boxes are all checked.

## Exit criteria

- [x] Every P1 item below has an implementation fix.
- [x] Every confirmed defect has regression coverage for the unsafe behavior.
- [x] Focused tests pass.
- [x] The full test suite passes.
- [x] A representative real scan is reviewed before cleanup commands are trusted again.

## P1 safety defects

### 1. Ignored directories can contain the only copy of user data

- [x] **Implementation:** inspect ignored directory contents instead of dropping every ignored path ending in `/`; carry unique ignored files into worktree safety classification; do not let merge cleanup bypass `hasPreciousIgnored`.
- [x] **Regression test:** create a clean linked worktree containing an ignored directory with a unique file and prove it cannot enter a removal bucket or receive a removal command.
- [x] **Verification:** confirm individually known regenerable files such as Python bytecode remain eligible, while a large conventional directory is recorded as review-required rather than silently discarded.

Evidence: `git status --ignored=matching --untracked-files=normal` collapses ignored directories to a directory record, while `listPreciousIgnored` discarded every such record. Tier classification also considered merged cleanup before precious ignored content. A synthetic fixture reached a safe tier with `Keeps -`, and `git worktree remove` deleted the ignored file. The audited real output contained 22 nominally safe worktrees with collapsed ignored directories, including `.idea/`, `BlobStorage/`, and `sftp-data/`.

Implemented fix: inspect ordinary ignored directories recursively, record enormous conventional trees as coarse review items, compare files with the primary checkout where practical, and fail closed when inspection is incomplete.

Relevant code: `src/scanner.js` (`inspectPreciousIgnored`, `expandIgnoredCandidate`, `classifyTier`).

### 2. Cleanup output can escape the roots requested by the user

- [x] **Implementation:** carry the in-scope worktree set into bucket formatting and command generation; never render cleanup commands for linked worktrees outside the resolved scan roots.
- [x] **Regression test:** scan one narrow root in a repository with a sibling worktree outside that root and assert the sibling has no bucket row or generated cleanup command.
- [x] **Verification:** confirm repository-level context may still be used for analysis without turning out-of-scope paths into cleanup targets.

Evidence: discovery reports out-of-root linked worktrees as hidden, but bucket rendering used the repository's complete worktree list. A narrow synthetic scan emitted a removal command for a sibling outside the requested root.

Intended fix: distinguish repository context from user-selected cleanup targets all the way through formatting.

Relevant code: `src/format.js` (`formatTierBuckets` and cleanup-command rendering).

### 3. Git and filesystem inspection failures are treated as safe values

- [x] **Implementation:** represent inspection failures explicitly and route unknown state to a blocked/error tier; never coerce a failed status, ignored-file read, content comparison, or reachability query to clean, empty, equal, or zero.
- [x] **Regression test:** inject failed status, ignored-content inspection, and detached-reachability probes and assert that each unknown result becomes an inspection error rather than a reclaimable tier.
- [x] **Verification:** error output identifies the failed safety check and repository/worktree without crashing the entire forest scan.

Evidence: multiple helpers returned benign defaults after command or read failure. Those defaults fed directly into reclaimability decisions.

Intended fix: use a common checked-result/error state and make classification fail closed.

Relevant code: `src/scanner.js` safety-query helpers and `classifyTier`.

### 4. Detached worktrees trust possibly stale remote-tracking refs

- [x] **Implementation:** require a verified durable containing ref for detached cleanup; do not treat a local `refs/remotes/origin/*` record alone as proof that the commit still exists on the remote.
- [x] **Regression test:** create a detached worktree contained only by a stale remote-tracking ref whose remote branch has been deleted and assert cleanup is blocked.
- [x] **Verification:** every detached row in the representative scan was either blocked or named verified local retention evidence; no stale remote-tracking ref alone authorized cleanup.

Evidence: local remote-tracking refs can outlive their server-side branches. Removing the checkout and later pruning the stale ref can leave the commit unreachable even though the report previously described it as kept by `origin/...`.

Intended fix: prefer a live remote check or another durable local branch/tag; treat unverifiable remote containment as review/blocked.

Relevant code: `src/scanner.js` (`inspectContainingRefs`, `inspectDetachedRetention`, detached classification).

### 5. Generated `git branch -d` is not the claimed final integration guard

- [x] **Implementation:** only emit branch deletion when the branch is proven integrated into the selected base, or generate a command that explicitly checks that invariant immediately before deletion.
- [x] **Regression test:** configure a stale upstream containing a branch that is not merged into `main` and prove Groundskeeper does not present plain `git branch -d` as a sufficient integration guard.
- [x] **Verification:** generated commands recheck the named integration base and delete with `update-ref` only at the full object ID observed by the scan.

Evidence: `git branch -d` can delete a branch that is not merged into the current integration branch when its configured upstream contains it. This was reproduced with a stale upstream.

Intended fix: bind deletion to Groundskeeper's selected integration base and keep the operation non-forcing.

Relevant code: `src/format.js` cleanup-command generation.

### 6. Generated-looking ignored directories are assumed disposable

- [x] **Implementation:** never skip `build/`, `dist/`, `target/`, dependency trees, or similar ignored directories as inherently safe; record very large conventional trees as coarse review items instead of recursively walking millions of files.
- [x] **Regression test:** put the only `signing.keystore` inside an ignored `build/` directory and prove the checkout enters `check-first`.
- [x] **Verification:** the output calls these entries ignored content, not proven-unique files or regenerable caches.

Evidence: directory-name allowlisting meant `build/signing.keystore` was never enumerated, so a clean merged checkout could receive a removal command despite holding the only key.

Implemented fix: ordinary ignored directories are inspected recursively; potentially enormous conventional trees produce a `build/`-style review marker and no cleanup command. The scanner remains bounded without converting a naming convention into a data-loss claim.

Relevant code: `src/scanner.js` (`COARSE_IGNORED_DIRECTORIES`, `expandIgnoredCandidate`).

### 7. Detached cleanup commands trust retention only at scan time

- [x] **Implementation:** recheck the exact scanned HEAD and current retaining ref, then create a visible local `git-groundskeeper/retained-detached/<full-object-id>` safety branch before removing the checkout.
- [x] **Regression test:** delete the remote ref before executing an old command and prove removal is refused; separately delete it after `ls-remote` succeeds but before the next command and prove removal leaves the exact commit on the safety branch.
- [x] **Verification:** legacy/incomplete detached evidence emits a retained-checkout comment rather than an unguarded `git worktree remove`, while every accepted detached command names its retained commit locally before removal.

Evidence: a branch, tag, or remote ref could disappear after the scan while the previously generated command still ran plain `git worktree remove`, leaving the detached commit unreferenced.

Implemented fix: commands recheck the checkout HEAD and current retention, create the safety branch with an expected-empty atomic ref update (or verify an existing same-name ref points at the expected commit), recheck HEAD, and only then remove the checkout. Local refs use ancestry; remote-only retention uses a targeted live exact-tip query. The branch is intentionally visible and retained for explicit later review. Concurrent use of the checkout remains outside the command's contract and is covered by the `ready if unused` gate.

Relevant code: `src/format.js` (`detachedWorktreeRemoveCommand`) and `src/scanner.js` detached-retention evidence.

### 8. Checkout-and-branch removal is labeled unconditionally safe

- [x] **Implementation:** replace the `safe` checkout label with `ready if unused` and state the active-task/path-use gate in the bucket note.
- [x] **Regression test:** formatter coverage locks in the conditional label while preserving the stronger `safe: remove branch` label for branch-only cleanup with no checkout path.
- [x] **Verification:** no checkout-removal bucket uses an unconditional `safe:` prefix.

Evidence: Git recoverability does not prove that an IDE, terminal, process, or active task has stopped using the checkout path.

Implemented fix: the first bucket is `ready if unused: remove checkout + branch`; only branch-only retirement retains the `safe` wording.

Relevant code: `src/format.js` (`TIER_BUCKETS`).

## P2 correctness and trust defects

### 9. Differently named upstreams are still mixed into the safest bucket

- [x] **Implementation:** route every differently named upstream to its dedicated review bucket, including otherwise merged-and-gone branches.
- [x] **Regression test:** cover merged branches whose configured upstream has a different branch name.
- [x] **Verification:** no differently named upstream can match the `ready if unused` checkout-and-branch bucket.

Evidence: three differently named-upstream rows remained in the first safe bucket while the legend promised a separate review bucket.

Intended fix: apply the upstream-name split before safe-bucket selection and keep labels consistent with classification.

Relevant code: `src/format.js` tier-to-bucket routing.

### 10. Summary and bucket output contradict or hide material state

- [x] **Implementation:** make hidden-clean counts reflect what bucket mode actually renders; expose dirty primary checkouts; render or clearly summarize all reported repository branches and stashes.
- [x] **Regression test:** cover bucket mode with visible clean rows, dirty primary checkouts, multiple repository-only branches, and stashes.
- [x] **Verification:** all headline counts reconcile with visible buckets and repository-level sections in the representative scan.

Evidence: the audited output said 32 clean worktrees were hidden while listing those 32; reported 58 dirty worktrees while visibly identifying only 29; and announced 11 repository branches plus 8 stashes while displaying two branches and no stashes.

Intended fix: derive counts and omission messages from the exact rendered collection, and add material state columns/sections where the compact view currently suppresses them.

Relevant code: `src/format.js` compact summary, bucket rows, and repository-state sections.

### 11. Clean-only bucket scans can report no outstanding Git state

- [x] **Implementation:** base the empty-state message on the bucket-rendered findings, not only the attention-filtered worktree collection.
- [x] **Regression test:** scan a forest containing only clean reclaimable worktrees in bucket mode and assert that its buckets render instead of the empty-state sentence.
- [x] **Verification:** non-bucket compact behavior retains its intended attention filtering.

Evidence: a scan with only clean removal candidates could still print `No outstanding Git state`.

Intended fix: use mode-specific emptiness checks.

Relevant code: `src/format.js` top-level compact formatter.

### 12. macOS `/tmp` and `/private/tmp` aliases break root scoping

- [x] **Implementation:** canonicalize configured roots and discovered worktree paths through filesystem real paths before containment checks.
- [x] **Regression test:** use a macOS-style symlinked root alias and assert equivalent paths remain in scope without admitting siblings.
- [x] **Verification:** scanner-produced report roots and worktree paths use one canonical vocabulary; formatter fixtures prove a symlink-equivalent candidate stays in scope without admitting a textual-prefix sibling.

Evidence: textual path-prefix comparison treated `/tmp/...` and `/private/tmp/...` as different locations even though they resolve to the same filesystem path.

Implemented fix: canonicalize scanner-produced report roots and worktree paths consistently, and compare filesystem identity again at formatting boundaries for older/synthetic reports.

Relevant code: root resolution and worktree scope filtering in `src/scanner.js`/`src/cli.js`.

### 13. `src/scanner.js` contains literal NUL bytes

- [x] **Implementation:** replace binary NUL delimiters with a source-safe sentinel or structured comparison that cannot collide with normalized paths.
- [x] **Regression test:** cover path-normalized content comparison without embedding NUL bytes in JavaScript source.
- [x] **Verification:** `git diff`, `rg`, and `file` treat `src/scanner.js` as normal text.

Evidence: the source contained literal `00 57 54 00` bytes and common search tools reported the JavaScript file as binary.

Intended fix: preserve comparison semantics with textual source.

Relevant code: `src/scanner.js` (`compareIgnoredFile`, `decodeText`).

### 14. CLI tests leak every temporary repository they create

- [x] **Implementation:** register `t.after(...)` immediately after each CLI fixture parent is created and recursively remove that exact parent.
- [x] **Regression verification:** run `test/cli.test.js` and prove the count of `git-groundskeeper-cli-*` directories is unchanged before and after.
- [x] **Full-suite verification:** run the complete suite after all safety fixes land and prove it creates no persistent fixture directories.

Evidence: every `createDirtyRepo()` call used `fs.mkdtempSync` without teardown. The validated cleanup found 1,497 generated fixture directories using about 320 MiB.

Implemented fix: every fixture-owning CLI test passes its `TestContext` into `createDirtyRepo(t)`, which registers exact-parent teardown before repository setup begins. No other temporary-fixture creator exists in `test/cli.test.js`.

Relevant code: `test/cli.test.js`.

### 15. Bucket tables exceed the terminal viewport

- [x] **Implementation:** reserve a four-cell interactive report gutter, preserve ordinary tables only while every column meets its semantic minimum, switch narrower panes to labeled field/value cards, and wrap surrounding prose to the same safe width.
- [x] **Regression test:** exercise 11-, 80-, 100-, 120-, and 200-column bucket reports with and without ANSI color, including Size, CJK, ordinary emoji, keycap emoji, and combining-mark values; assert every visible line stays inside the safe width and even the smallest layout retains field labels.
- [x] **TTY verification:** run the real CLI with `--sizes --3d-progress` in 80- and 200-column color pseudo-terminals and assert every line after the alternate-screen handoff stays inside the four-cell report gutter (76 and 196 cells respectively).

Evidence: the bucket table's semantic minimum was 122 cells without Size and 131 with Size. `fitColumnWidths` stopped shrinking at those minima even when stdout reported a narrower pane, while explanatory lines reached 148 cells. Writing an exact-width border into the final terminal cell could also trigger a deferred autowrap artifact. A subsequent real Warp run showed that a one-cell reservation was still insufficient: table borders and the final `B |` of Size cells wrapped by one or two cells after the long result block created terminal chrome/scrolling state.

Implemented fix: interactive report formatting uses `stdout.columns - 4`; readable tables remain tabular, narrower layouts retain every datum as a labeled card, and visible width accounts for ANSI escapes and Unicode display cells. The full-screen progress renderer keeps its own one-cell edge convention, while the scrollable final report uses the wider Warp-safe gutter.

Relevant code: `src/format.js` (`resolveOutputWidth`, `renderTableCards`, `terminalCellWidth`, `finalizeCompactOutput`) and `test/cli.test.js`.

### 16. Ignored-content warnings do not understand repository toolchains

- [x] **Implementation:** infer a narrow per-checkout regenerable whitelist from local manifests instead of treating every coarse cache as user data or globally trusting directory names.
- [x] **Regression test:** prove Dart, Flutter, Node, Composer, CocoaPods, Gradle, SwiftPM, Rust, Terraform, .NET, Vercel/Next/Turbo, explicit TypeScript `outDir`, Vite/Astro `dist/`, PHPUnit cache, CodeIgniter file sessions, and Flutter-generated JetBrains library indexes are filtered only when their matching repository evidence exists; retain generic `build/`, unproven `dist/`/`bin/`, logs, test evidence, and `assets/.env`.
- [x] **Verification:** a live numbus scan contains no whitelisted tool-cache path in `preciousIgnored`, while local databases, logs, lockfiles, generated source, secrets, test evidence, and ambiguous build trees remain visible.

Evidence: the reviewed report led nearly every Flutter row with `.dart_tool/`, and Node rows with `node_modules/`, even though the checkout itself contained the manifest proving which tool owned those directories. The same report expanded TypeScript compiler output and Terraform provider caches into hundreds of misleading file-level warnings.

Implemented fix: generated cache/output paths are silent only when repository-local evidence proves their meaning: `pubspec.yaml`, `package.json`, `composer.json`, `Podfile`, Gradle markers, `Package.swift`, `Cargo.toml`, `global.json` beside a repo-local `.dotnet/`, a `.csproj`/`.fsproj`/`.vbproj` beside .NET `bin/` or `obj/`, Terraform configuration, or a strict-JSON TypeScript `outDir`. Additional narrow rules require a Vite/Astro build script before suppressing `dist/`, both Composer and PHPUnit configuration before suppressing `.phpunit.cache/`, an exact CodeIgniter file-session configuration before suppressing `writable/session/`, and `pubspec.yaml` before suppressing only the known generated `Dart_Packages.xml`, `Dart_SDK.xml`, and `Flutter_Plugins.xml` JetBrains indexes. A cache-shaped directory without its proof still enters `check-first`; generic `build/`, generic `dist/`, coverage, logs, databases, lockfiles, generated source, and project-authored IDE settings remain deliberately visible.

Relevant code: `src/scanner.js` (`isRepoRegenerableIgnoredPath`, `isConfiguredTypeScriptOutput`, `terraformCacheHasConfig`, `frontendDistHasBuildManifest`, `phpUnitCacheHasManifest`, `codeIgniterFileSessionHasConfig`, `flutterIdeaIndexHasManifest`).

### 17. Flat output calls ignored-content review rows clean

- [x] **Implementation:** add `review ignored content` to the `Needs` field whenever `preciousIgnored` is non-empty, and describe mixed file/directory warnings as items rather than files.
- [x] **Regression test:** render a `check-first` row with both a directory marker and a file and prove `Needs` is not `clean` and `Keeps` says `items`.
- [x] **Verification:** focused formatter tests pass and the contradictory attached rows are no longer representable.

Evidence: the non-bucket run counted ignored-content rows as needing attention but rendered `Needs: clean`; bucket rows also described coarse directory markers such as `.dart_tool/` as files.

Relevant code: `src/format.js` (`formatNeeds`, `formatPreciousIgnored`).

### 18. Discovery descends into suffixed Xcode and SwiftPM caches

- [x] **Implementation:** centralize directory pruning and exclude `.derivedData-*`, other DerivedData suffix variants, `.build`, and `.terraform` dependency/cache roots in both synchronous and cooperative discovery.
- [x] **Regression test:** put real Git repositories under `.derivedData-3i/SourcePackages/checkouts/` and `.build/checkouts/` and prove neither discovery path reports them.
- [x] **Verification:** the previously failing numbus-root scan completes instead of reaching a corrupt cached `abseil-cpp-binary` checkout.

Evidence: scanning the numbus root without ownership filtering descended into `.derivedData-3i/SourcePackages/checkouts/abseil-cpp-binary`; its missing alternate object made `git for-each-ref` abort the scan. Exact-name `DerivedData` pruning did not cover the suffixed hidden directory.

Relevant code: `src/scanner.js` (`shouldSkipDirectory`, `discoverWorktrees`, `discoverWorktreesAsync`).

### 19. The Keeps column hides what actually needs review

- [x] **Implementation:** add a repository-scoped Keeps review beneath the ignored-content bucket, grouped by path family with checkout and entry counts plus conservative rule advice.
- [x] **Detail mode:** add `--keeps-details`, which implies `--buckets` and prints up to 12 exact paths per checkout while pointing to JSON for the complete list.
- [x] **Safety boundary:** make every recommendation advisory; never suppress content from the formatter, never recommend sensitive paths, and never blanket-trust a coarse directory.
- [x] **Regression test:** cover editor settings, secrets, coarse trees, generated evidence, exact path samples, implicit bucket mode, and terminal-width enforcement.
- [x] **Live verification:** use the new grouping to identify and manifest-gate .NET `bin/`/`obj/`, repo-local `.dotnet/`, Composer `vendor/`, proven Vite/Astro `dist/`, PHPUnit cache, CodeIgniter file sessions, and Flutter-generated JetBrains library-index noise while retaining coverage evidence, unproven build trees, logs, databases, lockfiles, project-authored IDE settings, and unique SFTP PDFs.

Evidence: the table previously rendered `N items: <first basename>`, so a worktree with thousands of .NET compiler outputs could look like a JetBrains-profile question merely because `Project_Default.xml` sorted first. The first live grouped report exposed 6,055 review entries machine-wide and made the actual .NET/Composer families visible. A focused AllServices replay after the initial manifest rules retained 72 entries across 17 check-first worktrees. The next evidence-gated pass reduced that to 62 entries across 16 worktrees by removing only proven Vite output and PHPUnit cache. A Referrals replay removed configured CodeIgniter session files while preserving its log, and a numbus replay removed proven Astro output and Flutter-generated library indexes while leaving authored IDE settings and ambiguous content visible.

Implemented fix: bucket output always includes the compact grouped summary. `--keeps-details` adds bounded checkout-level samples without turning a 48-row machine report into thousands of ungrouped lines. JSON remains the lossless interface.

Relevant code: `src/format.js` (`formatKeepsReview`, `groupKeepsEntries`, `classifyKeepsPath`), `src/cli.js`, `src/scanner.js`, `test/format.test.js`, `test/cli.test.js`, and `test/scanner.test.js`.

## Final verification record

Record exact commands and outcomes here as fixes land.

- [x] `node --test test/cli.test.js` — 9/9 passed, including the real 80-column 3D-to-report pseudo-TTY handoff; the exact count of `git-groundskeeper-cli-*` fixture parents was unchanged before and after the run.
- [x] `node --test test/scanner.test.js` — 52/52 passed, including scan-to-command root scoping, coarse ignored-directory blocking, clean-only scan rendering, path-normalized ignored content, and the executable detached-retention race.
- [x] `node --test test/format.test.js` — 25/25 passed, including executable branch-race guards, detached safety-branch generation, terminal-cell-aware adaptive bucket layouts, branch-only label coverage, and blocked-bucket size suppression.
- [x] `npm test` — 103/103 passed; matching fixture inventory was `0 -> 0`.
- [x] Representative `node bin/git-groundskeeper.js scan --mine --sizes --buckets --no-progress --no-color` (generated `2026-07-21T04:28:31.088Z`) — 143 worktrees rendered across buckets; 59 dirty rows reconciled as 30 blocked worktrees, 28 dirty primary checkouts, and 1 dirty aliased path; 10 repository branches rendered as 1 safe branch-only candidate plus 9 attention; all 8 stashes rendered. This is an operator observation from the live machine scan; the raw path-bearing table remains in the Codex task rather than the repository.
- [x] No cleanup command targets a path outside the requested roots; narrow-root command regression passed.
- [x] No ready-if-unused checkout row contains detected ignored content or unresolved safety-check errors; the live checkout-and-branch bucket had 10 rows with `Keeps -`, while 43 ignored-content worktrees moved to `check first`.
- [x] Historical fixture cleanup — validated and permanently removed 1,497 generated test directories (about 320 MiB); zero matching fixtures remained.
- [x] Focused 2026-07-22 scanner/formatter verification — 81/81 passed after repository-aware Keeps classification, truthful `Needs`, item labeling, and cache-discovery regression coverage.
- [x] Live scoped numbus scan — 3 repositories and 61 worktrees completed; all 22 remaining ignored-content rows retained review-worthy content, with 0 `.dart_tool`, dependency-manager cache, Terraform provider cache, explicit TypeScript output, or Flutter ephemeral entries leaking into `Keeps`.
- [x] `npm test` after the 2026-07-22 accuracy fixes — 107/107 passed; `git diff --check` reported no whitespace errors.
- [x] Exact machine-wide replay of `scan --mine --buckets` (generated `2026-07-22T06:28:00.669Z`) — the same 46 repositories and 145 worktrees completed; 43 `check-first` rows remained because they still hold other review-worthy content, with 0 known tool-cache leaks and 0 ready-tier rows containing ignored content.
- [x] `npm test` after Keeps review and extended manifest gating — 128/128 passed; `git diff --check` reported no whitespace errors.
- [x] Live machine-wide `scan --mine --buckets --keeps-details --no-progress` (generated `2026-07-22T18:44:04.909Z`) — 46 repositories and 149 worktrees completed; the grouped review exposed 6,055 entries and the exact-path mode rendered bounded per-checkout samples without changing tiers or emitting cleanup commands.
- [x] Live scoped AllServices replay after .NET and Composer gating (generated `2026-07-22T18:49:32.202Z`) — 28 in-scope worktrees completed; 17 check-first worktrees retained 72 entries across seven review families, including coverage evidence, `dist/`, IDE settings, `.phpunit.cache`, and unique SFTP PDFs.
- [x] Focused scanner verification after the additional evidence-gated rules — 58/58 passed, including positive and negative Vite/Astro `dist/`, PHPUnit cache, CodeIgniter file-session, and Flutter JetBrains-index coverage.
- [x] Live scoped AllServices replay after the additional gating — 16 check-first worktrees retained 62 entries; proven Vite output and PHPUnit cache disappeared while coverage, authored IDE settings, and unique SFTP documents remained.
- [x] Live scoped Referrals replay — configured CodeIgniter session files disappeared while the runtime log remained review-required.
- [x] Live scoped numbus replay — proven Astro output and Flutter-generated JetBrains library indexes disappeared while generic build trees, lockfiles, generated source, databases, logs, data snapshots, and authored IDE settings remained.
- [x] `npm test` after the evidence-gated Keeps additions — 130/130 passed; `git diff --check` reported no whitespace errors.
