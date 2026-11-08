# Shared agent storage accounting

Short tasks can create multiple gigabytes of dependencies and compiler output.
Checkout-local inventories miss Xcode's default user-level DerivedData. This
read-only helper meters both locations and connects registered task output to
the existing Codex completion hook. It never deletes files, changes Git, stops
processes, creates devices, or creates timers.

Install after running the Python tests:

```sh
python3 -m unittest discover -s tools -p 'test_workspace_storage*.py' -v
python3 tools/install_workspace_storage.py --apply
```

The installer adds a small adapter to the existing task-progress implementation
and appends the shared policy to Codex and Claude instructions. Existing hook
definitions, trust settings, automation behavior and unrelated configuration are
preserved. Code/instruction backups and an installation receipt are kept under
`~/.codex/guards/workspace-storage/`. Credential-bearing settings are not read
or backed up by the installer. Claude receives instructions; this installer
does not install a native Claude hook.

Before the task's first dependency install or substantial build, use the actual
ledger id supplied by the Codex hook:

```sh
python3 ~/.codex/tools/workspace-storage.py register \
  --thread THREAD_ID --workspace /absolute/checkout --purpose 'Task purpose'
python3 ~/.codex/tools/workspace-storage.py check --thread THREAD_ID
```

Registration does not reset an existing baseline. Metered paths include local
build/dependency directories and external Xcode directories whose native XML or
binary `info.plist` names an existing workspace inside that exact checkout.
Symlink targets are skipped. Size failures remain unknown rather than zero.
This mapping establishes metering attribution, not deletion eligibility.
An optional `register --growth-limit-mib N` accepts 1 through 1024 MiB for a
stricter per-task threshold. It cannot relax the default 1 GiB limit. This also
allows native hook qualification with a small real output fixture.

At closeout, inspect the existing Groundskeeper provider plan, perform only
already-authorized exact-path cleanup, and record what remains:

```sh
git-groundskeeper session-complete /absolute/checkout --json
python3 ~/.codex/tools/workspace-storage.py closeout \
  --thread THREAD_ID --workspace /absolute/checkout \
  --disposition cleaned --reason 'Verified disposable output removed' \
  --evidence /absolute/cleanup-receipt.json
```

Use `retained` or `active` with a concrete reason and evidence when required
output must remain. A `cleaned` claim is rejected if at least 1 GiB remains
above the original baseline. Receipt reasons are operator assertions, not
verified remote retention or permission to discard files.

The native Stop adapter permits one corrective pass per turn when a registered
working/active checkout grows at least 1 GiB above its last acknowledged
measurement. It respects Stop recursion, explicit halt requests, existing guard
denials, human waits and active unexpired registered external waits. Its
measurements are bounded and cannot remove anything. Four working/active
checkouts can be registered simultaneously; closed receipts remain in the
ledger for history. A timeout does not create a blocking cleanup decision.

The helper warns below 30 GiB of working headroom without adding a human approval
gate. It does not replace actual build-budget reservation or CI concurrency
control. It does not intercept every possible command or retroactively qualify
all existing directories. Unregistered legacy checkouts still need the bounded
retention inventory and a fresh per-target review. Native execution and policy
delivery must be tested on the actual installed Codex runtime; an already-open
desktop chat may retain cached hooks or instructions.

External Xcode output is now visible in accounting. The existing Groundskeeper
Xcode provider still applies only to project-local DerivedData. Never pass a
shared DerivedData root as a substitute project or remove external products,
archives, logs or review evidence based only on this helper's measured size.
