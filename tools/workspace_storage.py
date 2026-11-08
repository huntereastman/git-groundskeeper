#!/usr/bin/env python3
"""Bounded, read-only workspace storage accounting for agent task closeout.

This helper never removes files, runs a cleaner, changes Git, or stops a process.
Use the existing Groundskeeper providers after reviewing their exact targets.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import time
import tomllib

GIB = 1024 ** 3
FREE_RESERVE = 30 * GIB
GROWTH_LIMIT = GIB
MAX_WORKSPACES = 4
LOCAL_OUTPUTS = (
    "build", "DerivedData", ".build", "node_modules", ".next", ".dart_tool",
    ".gradle", "ios/Pods", "macos/Pods", ".agents/skills/gstack",
    ".claude/skills/gstack",
)
POLICY = (
    "Storage lifecycle: before installing dependencies or running a substantial build, "
    "register its exact checkout with python3 ~/.codex/tools/workspace-storage.py "
    "register --thread THREAD_ID --workspace ABSOLUTE_PATH --purpose TASK. "
    "Reuse the task's existing checkout. At closeout, inspect its local and external "
    "Xcode output, clean only verified disposable targets through Groundskeeper, then "
    "record closeout; record a concrete reason and evidence for retained or active output. "
    "Preserve source, sessions, secrets, release/review evidence and other tasks. "
    "Do not share writable DerivedData between concurrent checkouts."
)


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def state_root():
    return Path(os.environ.get("WORKSPACE_STORAGE_STATE_DIR", str(Path.home() / ".codex/state/workspace-storage")))


def state_path(thread):
    if not isinstance(thread, str) or not thread.strip() or len(thread) > 250:
        raise ValueError("An actual thread/session id is required")
    return state_root() / (hashlib.sha256(thread.encode()).hexdigest() + ".json")


def load(thread):
    p = state_path(thread)
    d = json.loads(p.read_text()) if p.exists() else {"version": 1, "thread": thread, "workspaces": {}}
    if d.get("version") != 1 or d.get("thread") != thread:
        raise ValueError("Unknown or mismatched storage ledger")
    return d


@contextlib.contextmanager
def ledger(thread):
    p = state_path(thread)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(p) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + 0.3
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("Storage ledger is busy; retry the accounting command")
                time.sleep(0.01)
        data = load(thread)
        yield data
        out_fd, name = tempfile.mkstemp(prefix=p.name + ".", dir=p.parent)
        try:
            os.fchmod(out_fd, 0o600)
            with os.fdopen(out_fd, "w") as output:
                json.dump(data, output, indent=2)
                output.write("\n")
            os.replace(name, p)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    finally:
        os.close(fd)


def workspace_root(value):
    given = Path(value).expanduser()
    if not given.is_absolute():
        raise ValueError("The workspace must be an absolute Git checkout path")
    root = given.resolve(strict=True)
    if root == Path.home() or root == Path("/"):
        raise ValueError("A home directory or filesystem root is not a task workspace")
    p = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True, timeout=3,
                       env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if p.returncode or Path(p.stdout.strip()).resolve() != root:
        raise ValueError("Register the exact top level of a Git checkout")
    return root


def inside(candidate, parent):
    return candidate == parent or parent in candidate.parents


def no_symlink_path(p):
    return not any(q.is_symlink() for q in [p, *p.parents])


def output_paths(workspace, derived_data_root=None):
    """Find conventional output; names are metering candidates, never deletion proof."""
    root = Path(workspace)
    paths, skipped, errors = [], [], []
    for relative in LOCAL_OUTPUTS:
        p = root / relative
        if p.is_symlink():
            skipped.append({"path": str(p), "reason": "shared or symlinked target"})
        elif p.is_dir() and no_symlink_path(p):
            paths.append(p)
    dd = Path(derived_data_root or os.environ.get("WORKSPACE_STORAGE_DERIVED_DATA", str(Path.home() / "Library/Developer/Xcode/DerivedData")))
    if dd.exists() and not no_symlink_path(dd):
        errors.append("External DerivedData root crosses a symlink; not measured")
    elif dd.is_dir():
        entries = list(dd.iterdir())
        if len(entries) > 512:
            errors.append("External DerivedData inventory exceeds the bounded 512-entry limit")
        for p in entries[:512]:
            info = p / "info.plist"
            if not p.is_dir() or not no_symlink_path(p) or not info.is_file() or info.is_symlink():
                continue
            try:
                if info.stat().st_size > 256_000:
                    continue
                native = plistlib.loads(info.read_bytes())
                source = native.get("WorkspacePath")
                if not isinstance(source, str) or not Path(source).is_absolute():
                    continue
                source_path = Path(source).resolve()
                # A matching name or prefix is insufficient; require the actual workspace.
                if source_path.exists() and inside(source_path, root):
                    paths.append(p)
            except (OSError, ValueError, TypeError, plistlib.InvalidFileException):
                # Unrelated malformed records do not claim ownership of this checkout.
                continue
    # No overlap or symlink traversal; directory allocation is not physical reclaim.
    unique = []
    for p in sorted(set(paths), key=lambda q: (len(q.parts), str(q))):
        if not any(inside(p, q) for q in unique):
            unique.append(p)
    return unique, skipped, errors


def snapshot(workspace, timeout=15, derived_data_root=None):
    paths, skipped, errors = output_paths(workspace, derived_data_root)
    sizes = {}
    if paths:
        try:
            p = subprocess.run(["/usr/bin/du", "-skx", *map(str, paths)],
                               capture_output=True, text=True, timeout=timeout)
            for line in p.stdout.splitlines():
                count, name = line.split("\t", 1)
                if name in set(map(str, paths)):
                    sizes[name] = int(count) * 1024
            if p.returncode:
                errors.append("Size measurement failed: " + p.stderr[:300])
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            errors.append("Size measurement incomplete: " + type(exc).__name__)
    complete = len(sizes) == len(paths) and not errors
    return {"at": stamp(), "workspace": str(workspace), "complete": complete,
            "allocated_bytes": sum(sizes.values()) if complete else None,
            "paths": [{"path": str(p), "allocated_bytes": sizes.get(str(p))} for p in paths],
            "skipped": skipped, "errors": errors,
            "free_bytes": shutil.disk_usage(Path.home()).free,
            "removal_eligibility_established": False}


def register(thread, workspace, purpose, growth_limit_mib=1024):
    root = str(workspace_root(workspace))
    if not purpose.strip():
        raise ValueError("A concrete task purpose is required")
    if not isinstance(growth_limit_mib, int) or not 1 <= growth_limit_mib <= 1024:
        raise ValueError("The growth limit must be 1 to 1024 MiB; it may tighten but never relax the 1 GiB limit")
    with ledger(thread) as data:
        active = [r for r in data["workspaces"].values() if r["disposition"] in {"working", "active"}]
        if root in data["workspaces"]:
            # Re-registering must not reset the baseline to hide accumulated output.
            if data["workspaces"][root]["disposition"] not in {"working", "active"} and len(active) >= MAX_WORKSPACES:
                raise ValueError("Close out an active workspace before reopening another")
            data["workspaces"][root]["disposition"] = "working"
            data["workspaces"][root]["purpose"] = purpose
            data["workspaces"][root]["growth_limit_bytes"] = min(
                data["workspaces"][root].get("growth_limit_bytes", GROWTH_LIMIT), growth_limit_mib * 1024 ** 2)
            return data["workspaces"][root]
        if len(active) >= MAX_WORKSPACES:
            raise ValueError("One task may own at most four simultaneous checkouts; reuse or close out existing workspaces")
        baseline = snapshot(root)
        if not baseline["complete"]:
            raise ValueError("Cannot establish a complete baseline: " + "; ".join(baseline["errors"]))
        row = {"purpose": purpose, "registered_at": stamp(), "baseline": baseline,
               "accounted": baseline, "disposition": "working",
               "growth_limit_bytes": growth_limit_mib * 1024 ** 2}
        data["workspaces"][root] = row
        return row


def closeout(thread, workspace, disposition, reason, evidence):
    root = str(workspace_root(workspace))
    if len(reason.strip()) < 12 or not evidence.strip():
        raise ValueError("Closeout needs a concrete reason and an evidence reference")
    with ledger(thread) as data:
        if root not in data["workspaces"]:
            raise ValueError("Workspace was not registered before this task's build")
        current = snapshot(root)
        if not current["complete"]:
            raise ValueError("Cannot acknowledge an incomplete measurement")
        row = data["workspaces"][root]
        growth = current["allocated_bytes"] - row["baseline"]["allocated_bytes"]
        limit = min(row.get("growth_limit_bytes", GROWTH_LIMIT), GROWTH_LIMIT)
        if disposition == "cleaned" and growth >= limit:
            raise ValueError(f"Output remains above the registered {limit / GIB:g} GiB growth limit; clean proven output or explicitly retain it with evidence")
        row.update(accounted=current, disposition=disposition, reason=reason,
                   evidence=evidence, closed_at=stamp())
        return {"workspace": root, "disposition": disposition, "growth_bytes": growth,
                "snapshot": current, "reason": reason, "evidence": evidence}


def pressure_context(event_name, message):
    return {"hookSpecificOutput": {"hookEventName": event_name, "additionalContext": message}}


def external_wait_pending(thread):
    # Storage accounting never overrides the independent delivery/wait guard.
    p = Path.home() / ".codex/state/task-progress/state.json"
    try:
        d = json.loads(p.read_text())
        for key, c in d.get("automations", {}).items():
            if c.get("threadId") != thread or c.get("mode") not in {
                "external_wait", "recurring_monitor", "scheduled_action", "user_reminder"
            } or not re.fullmatch(r"[A-Za-z0-9_-]+", key):
                continue
            try:
                expires = dt.datetime.fromisoformat(c.get("expiresAt", "").replace("Z", "+00:00"))
                if expires.tzinfo is None or expires <= dt.datetime.now(dt.timezone.utc):
                    continue
                timer = Path.home() / ".codex/automations" / key / "automation.toml"
                config = tomllib.loads(timer.read_text()) if timer.is_file() else {}
                if config.get("status") == "ACTIVE" and config.get("target_thread_id") == thread:
                    return True
            except (OSError, ValueError, TypeError):
                continue
        return False
    except (OSError, ValueError, TypeError):
        return False


def augment_hook(event, original):
    """Add accounting without weakening, delaying or rearming the existing wait guard."""
    name = event.get("hook_event_name")
    if name not in {"SessionStart", "UserPromptSubmit", "Stop"}:
        return original
    if original.get("decision") == "block" or original.get("continue") is False:
        return original
    thread = event.get("session_id")
    if not thread:
        return original
    if name in {"SessionStart", "UserPromptSubmit"}:
        free = shutil.disk_usage(Path.home()).free
        msg = "Storage ledger id: " + str(thread) + ". " + POLICY
        if free < FREE_RESERVE:
            msg += f" Disk headroom is {free / GIB:.1f} GiB, below the 30 GiB reserve. Reuse caches, complete independent light work and reclaim verified finished output before adding another large build. This is not a new approval requirement."
        if name == "UserPromptSubmit":
            with ledger(thread) as data:
                prompt = event.get("prompt", "")
                data["halt_requested"] = bool(re.match(r"\s*(stop|pause|cancel)\b", prompt, re.I))
                data["turn"] = event.get("turn_id")
                correction = "Workspace storage closeout:" in prompt[:200] and data.get("correction_pending")
                if not correction:
                    # Some native hook versions omit turn_id. Real user input still
                    # opens a new bounded closeout pass; hook feedback never loops.
                    data["turn_generation"] = data.get("turn_generation", 0) + 1
                    data.pop("corrected_turn", None)
                    data.pop("correction_pending", None)
        result = dict(original)
        specific = dict(result.get("hookSpecificOutput", {}))
        specific["hookEventName"] = name
        specific["additionalContext"] = specific.get("additionalContext", "") + "\n" + msg
        result["hookSpecificOutput"] = specific
        return result
    data = load(thread)
    if data.get("halt_requested") or event.get("stop_hook_active") or external_wait_pending(thread):
        return original
    key = event.get("turn_id") or data.get("turn") or data.get("turn_generation", "current")
    if data.get("corrected_turn") == key:
        return original
    rows = [(root, row) for root, row in data["workspaces"].items()
            if row["disposition"] in {"working", "active"}]
    if not rows:
        return original
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKSPACES) as pool:
        current = list(pool.map(lambda item: snapshot(item[0], timeout=2), rows))
    changed = []
    for (root, row), measured in zip(rows, current):
        before = row["accounted"]["allocated_bytes"]
        limit = min(row.get("growth_limit_bytes", GROWTH_LIMIT), GROWTH_LIMIT)
        if measured["complete"] and measured["allocated_bytes"] - before >= limit:
            delta = measured['allocated_bytes'] - before
            size = f"{delta / GIB:.2f} GiB" if delta >= GIB else f"{delta / 1024 ** 2:.1f} MiB"
            changed.append(f"{root}: +{size}")
    if not changed:
        return original
    with ledger(thread) as data:
        data["corrected_turn"] = key
        data["correction_pending"] = True
    return {"decision": "block", "reason":
            "Workspace storage closeout: registered task output grew without an updated cleanup/retention receipt: "
            + "; ".join(changed) + ". Run workspace-storage.py check for the exact paths (including external Xcode output). "
            "Use Groundskeeper to inspect and clean only proven disposable output within existing authority, or record "
            "closeout --disposition retained|active with a concrete reason and evidence for what remains. "
            "Do not delete source, evidence, shared targets or active output; do not ask for routine cleanup approval, "
            "stop other tasks, create a timer or repeat this correction. This is one bounded corrective pass."}


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for name in ["register", "check", "closeout"]:
        p = subs.add_parser(name)
        p.add_argument("--thread", required=True)
        if name != "check":
            p.add_argument("--workspace", required=True)
        if name == "register":
            p.add_argument("--purpose", required=True)
            p.add_argument("--growth-limit-mib", type=int, default=1024)
        if name == "closeout":
            p.add_argument("--disposition", choices=["cleaned", "retained", "active"], required=True)
            p.add_argument("--reason", required=True)
            p.add_argument("--evidence", required=True)
    args = parser.parse_args(argv)
    if args.command == "register":
        result = register(args.thread, args.workspace, args.purpose, args.growth_limit_mib)
    elif args.command == "closeout":
        result = closeout(args.thread, args.workspace, args.disposition, args.reason, args.evidence)
    else:
        data = load(args.thread)
        result = {"thread": args.thread, "workspaces": [
            {"workspace": root, "purpose": row["purpose"], "baseline_bytes": row["baseline"]["allocated_bytes"],
             "disposition": row["disposition"], "current": snapshot(root)}
            for root, row in data["workspaces"].items()]}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        cli()
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        raise SystemExit(str(exc))
