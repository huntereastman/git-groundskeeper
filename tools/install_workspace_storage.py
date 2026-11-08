#!/usr/bin/env python3
"""Install the local storage accountant without changing hooks or their trust."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import tempfile

START = "<!-- workspace-storage:start -->"
END = "<!-- workspace-storage:end -->"
RULES = """# Workspace storage lifecycle

- Reuse the ongoing task's existing checkout for retries and follow-ups. Inspect existing worktrees before creating another. Keep concurrent source and writable build databases isolated; share dependency downloads only through the tool's supported cache controls.
- Before installing dependencies or starting a substantial build, register its exact checkout with `python3 ~/.codex/tools/workspace-storage.py register --thread THREAD_ID --workspace ABSOLUTE_CHECKOUT --purpose 'TASK'`. The storage hook supplies the actual ledger id. Registration records the baseline; repeating it does not erase growth. This accounting is read-only.
- Use `python3 ~/.codex/tools/workspace-storage.py check --thread THREAD_ID` to include both checkout output and external Xcode DerivedData matched through native `info.plist` workspace metadata. A directory name or measured size is not removal proof.
- Keep at least 30 GiB of working headroom when practical. Under pressure, reuse valid build results, complete independent light work, and clear verified finished output before adding another large build. Run the checks needed for the actual change; do not weaken release, security or runtime verification.
- At a safe checkpoint and closeout, inspect `git-groundskeeper session-complete ABSOLUTE_CHECKOUT --json`. Apply only the exact reviewed, proven disposable output under existing cleanup authority, with fresh active-use and retention checks. Its existing providers do not clean external Xcode DerivedData: review that separately, preserving products, archives, logs and required evidence. Do not replace this with broad `flutter clean`, `git clean` or deletion of a shared root.
- Finish with `python3 ~/.codex/tools/workspace-storage.py closeout --thread THREAD_ID --workspace ABSOLUTE_CHECKOUT --disposition cleaned --reason 'WHAT WAS CLEANED' --evidence 'RECEIPT'`. If Groundskeeper already retired the checkout, add `--retirement-receipt /absolute/path/to/applied-retirement.json`; the helper verifies the registered path is absent, its Git registration is gone and its retired HEAD remains on the retained ref, then still measures matching external output. Use `retained` or `active` with a concrete reason and evidence when output is still required; an absent retired checkout cannot be marked active. The helper rejects a cleaned claim if at least 1 GiB of new output remains. Retention accounting is not source-retention proof or deletion authorization.
- The Codex closeout hook checks registered working/active checkouts and permits one corrective pass for unaccounted growth of at least 1 GiB. Preserve active CI, previews, authored work, credentials, chat history, simulator/emulator data and release/review evidence. Honor stop/pause immediately; do not ask Hunter to approve routine already-authorized cleanup or create cleanup timers.
"""

ADAPTER = '''def storage_accounting(event, result):
    """Storage accounting cannot weaken task-progress denials or waiting states."""
    if event.get("hook_event_name") not in {"SessionStart", "UserPromptSubmit", "Stop"}:
        return result
    if result.get("decision") == "block" or result.get("continue") is False:
        return result
    helper = Path.home() / ".codex/tools/workspace-storage.py"
    if not helper.is_file():
        return result
    try:
        import runpy
        return runpy.run_path(str(helper))["augment_hook"](event, result)
    except Exception as exc:
        # A metering failure must never turn an existing denial into permission.
        output = dict(result)
        output["systemMessage"] = (output.get("systemMessage", "") +
            " Storage accounting unavailable (" + type(exc).__name__ +
            "). Run the storage check explicitly; no cleanup was performed.")
        return output


'''


def updated_rules(raw):
    block = START + "\n" + RULES + END
    if START in raw:
        if raw.count(START) != 1 or raw.count(END) != 1:
            raise ValueError("Ambiguous storage policy markers")
        first = raw.index(START)
        last = raw.index(END, first) + len(END)
        return raw[:first] + block + raw[last:]
    return raw.rstrip() + "\n\n" + block + "\n"


def updated_guard(raw):
    if "def storage_accounting(event, result):" in raw:
        if "result = storage_accounting(event, hook(event))" not in raw:
            raise ValueError("Partial storage adapter; inspect the guard before installation")
        return raw
    if raw.count("def cli(argv):") != 1 or raw.count("result = hook(event)") != 1:
        raise ValueError("Unknown task-progress implementation; refusing to rewrite it")
    return raw.replace("def cli(argv):", ADAPTER + "def cli(argv):").replace(
        "result = hook(event)", "result = storage_accounting(event, hook(event))")


def install(home, source):
    home, source = Path(home), Path(source)
    helper = home / ".codex/tools/workspace-storage.py"
    guard = home / ".codex/guards/task-progress/guard.py"
    codex = home / ".codex/AGENTS.md"
    claude = home / ".claude/CLAUDE.md"
    # Validate every candidate before making the first change.
    before = {p: p.read_bytes() for p in [guard, codex, claude]}
    changes = {guard: updated_guard(before[guard].decode()).encode(),
               codex: updated_rules(before[codex].decode()).encode(),
               claude: updated_rules(before[claude].decode()).encode(),
               helper: source.read_bytes()}
    if helper.exists():
        before[helper] = helper.read_bytes()
    backup = home / ".codex/guards/workspace-storage/backups" / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup.mkdir(parents=True, mode=0o700)
    installed = []
    for p, raw in changes.items():
        if p.exists() and p.read_bytes() != before.get(p):
            raise ValueError("A file changed during installation; preserve it and retry: " + str(p))
        if before.get(p) == raw:
            continue
        # These are code and instructions, never credential-bearing settings.
        if p in before:
            saved = backup / p.relative_to(home)
            saved.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            saved.write_bytes(before[p])
            saved.chmod(0o600)
        p.parent.mkdir(parents=True, exist_ok=True)
        mode = (p.stat().st_mode & 0o777) if p.exists() else 0o700
        fd, name = tempfile.mkstemp(prefix=p.name + ".", dir=p.parent)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
            if p.exists() and p.read_bytes() != before.get(p):
                raise ValueError("Concurrent change detected; refusing replacement: " + str(p))
            os.replace(name, p)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        installed.append({"path": str(p), "sha256": hashlib.sha256(raw).hexdigest()})
    receipt = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "installed": installed,
               "backup": str(backup), "hook_definitions_changed": False,
               "hook_trust_changed": False, "automatic_deletion": False,
               "claude_mechanical_hook_installed": False}
    target = home / ".codex/guards/workspace-storage/installation.json"
    target.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--apply", action="store_true", required=True)
    args = p.parse_args()
    print(json.dumps(install(Path.home(), Path(__file__).with_name("workspace_storage.py")), indent=2))
