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
import stat
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
    "For an already retired checkout, add --retirement-receipt PATH pointing to "
    "verified retirement JSON; missing paths alone are not cleanup proof. "
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
                # Native metadata still identifies output after its source
                # checkout is retired. Missing source must not hide DerivedData.
                if (source_path.exists() or not root.exists()) and inside(source_path, root):
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
            "workspace_present": Path(workspace).exists(),
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
            data["workspaces"][root]["last_registered_at"] = stamp()
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


def retired_workspace_root(value):
    given = Path(value).expanduser()
    if not given.is_absolute():
        raise ValueError("The workspace must be an absolute Git checkout path")
    if not no_symlink_path(given):
        raise ValueError("Retired workspace path crosses a symlink")
    root = given.resolve()
    if root in {Path.home(), Path("/")} or os.path.lexists(root):
        raise ValueError("Retirement closeout requires an absent checkout path")
    return root


def read_retirement_json(receipt_path):
    receipt_file = Path(receipt_path).expanduser()
    fd = os.open(receipt_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 ** 2:
            raise ValueError("Retirement receipt must be a regular JSON file of at most 2 MiB")
        with os.fdopen(fd, "rb") as source:
            fd = None
            raw = source.read(2 * 1024 ** 2 + 1)
        if len(raw) > 2 * 1024 ** 2:
            raise ValueError("Retirement receipt exceeds 2 MiB")
        receipt = json.loads(raw)
    finally:
        if fd is not None:
            os.close(fd)
    return receipt, {"receipt": str(receipt_file.resolve()),
                     "receipt_sha256": hashlib.sha256(raw).hexdigest()}


def verify_completion_time(completed_at, registered_at):
    try:
        completed = dt.datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
        registered = dt.datetime.fromisoformat(registered_at.replace("Z", "+00:00"))
        if completed.utcoffset() is None or registered.utcoffset() is None \
                or completed < registered or completed > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1):
            raise ValueError("stale or future retirement")
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("Retirement receipt must have a valid completion time after this workspace's registration") from exc


def verify_retirement(root, receipt_path, registered_at):
    """Verify completed removal and live local retention, never authorize removal."""
    receipt, evidence = read_retirement_json(receipt_path)
    if isinstance(receipt, dict) and receipt.get("kind") == "managed-workspace-retirement-reconciliation":
        return verify_managed_retirement(root, receipt, evidence, registered_at)
    if not isinstance(receipt, dict) or receipt.get("kind") != "worktree-retirement-receipt" \
            or receipt.get("schemaVersion") != 2 or receipt.get("apply") is not True \
            or receipt.get("status") != "removed" or receipt.get("error"):
        raise ValueError("Retirement receipt must prove a successful applied Groundskeeper removal")
    if receipt.get("target") != str(root):
        raise ValueError("Retirement receipt does not match the registered workspace")
    verify_completion_time(receipt.get("completedAt"), registered_at)
    verification = receipt.get("verification")
    if not isinstance(verification, dict) or verification.get("targetRemoved") is not True \
            or verification.get("retainedRefExists") is not True:
        raise ValueError("Retirement receipt has incomplete removal or retention verification")
    head, retained_ref, branch = (receipt.get(key) for key in ["head", "retainedRef", "branch"])
    if not isinstance(head, str):
        raise ValueError("Retirement receipt requires the full retired HEAD")
    expected_ref = "refs/heads/" + branch if isinstance(branch, str) and branch else \
        "refs/heads/git-groundskeeper/retained-detached/" + head
    if retained_ref != expected_ref:
        raise ValueError("Retirement receipt does not name its retained branch")
    return {**evidence,
            **verify_git_retirement(root, receipt.get("primaryPath"), head, retained_ref),
            "completed_at": receipt["completedAt"], "verified_at": stamp()}


def verify_git_retirement(root, primary_value, head, retained_ref):
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", head):
        raise ValueError("Retirement receipt requires the full retired HEAD")
    if not isinstance(retained_ref, str) or not retained_ref.startswith("refs/heads/"):
        raise ValueError("Retirement receipt requires a retained local branch")
    if not isinstance(primary_value, str):
        raise ValueError("Retirement receipt requires the retained primary checkout")
    primary = workspace_root(primary_value)

    def read_git(*args):
        result = subprocess.run(["git", "-C", str(primary), *args],
                                capture_output=True, text=True, timeout=5,
                                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0",
                                     "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1"})
        if result.returncode:
            raise ValueError("Retirement verification failed: git " + args[0])
        return result.stdout

    registered = read_git("worktree", "list", "--porcelain", "-z")
    if any(field.startswith("worktree ") and Path(field[9:]).resolve() == root
           for field in registered.split("\0")):
        raise ValueError("Retired workspace is still registered with Git")
    retained_head = read_git("show-ref", "--verify", "--hash", retained_ref).strip()
    read_git("merge-base", "--is-ancestor", head, retained_ref)
    # Receipt fields alone never establish that a currently absent checkout
    # stayed absent. Check again after the bounded Git probes.
    if os.path.lexists(root) or not no_symlink_path(root):
        raise ValueError("Retired workspace path reappeared during verification")
    return {"primary_path": str(primary), "head": head, "retained_ref": retained_ref,
            "retained_head": retained_head, "target_absent": True,
            "git_registration_absent": True, "head_retained": True}


def verify_managed_retirement(root, receipt, evidence, registered_at):
    """Reconcile legacy receipts-only-v1 snapshots without impersonating a GG removal."""
    if receipt.get("schemaVersion") != 1 or receipt.get("target") != str(root):
        raise ValueError("Managed retirement evidence does not match the registered workspace")

    def pinned_json(name):
        pin = receipt.get(name)
        if not isinstance(pin, dict) or not isinstance(pin.get("path"), str) \
                or not Path(pin["path"]).is_absolute():
            raise ValueError("Managed retirement requires a pinned " + name + " receipt")
        data, proof = read_retirement_json(pin["path"])
        if pin.get("sha256") != proof["receipt_sha256"] or not isinstance(data, dict):
            raise ValueError("Managed retirement " + name + " receipt digest mismatch")
        return data, proof

    cleanup, cleanup_proof = pinned_json("cleanup")
    manager, manager_proof = pinned_json("manager")
    lease = manager.get("lease")
    source = manager.get("source")
    if not isinstance(lease, dict) or not isinstance(source, dict):
        raise ValueError("Managed retirement is missing its lease or source identity")
    head = receipt.get("head")
    if manager.get("policy") != "receipts-only-v1" or lease.get("workspace") != str(root) \
            or lease.get("kind") not in {"qa", "release"} or source.get("head") != head \
            or source.get("tracked_diff_sha256") != hashlib.sha256(b"").hexdigest():
        raise ValueError("Managed receipt does not prove a source-only task snapshot")
    if cleanup.get("workspace") != str(root) or cleanup.get("source_sha") != head \
            or cleanup.get("managed_receipt") != lease.get("id") \
            or cleanup.get("all_original_input_receipts_match") is not True \
            or cleanup.get("result") != "Removed only reviewed generated additions and the verified redundant source snapshot":
        raise ValueError("Managed cleanup does not prove completed redundant-snapshot retirement")
    verify_completion_time(cleanup.get("completed_at"), registered_at)
    verify_completion_time(manager.get("completed_at"), registered_at)
    if dt.datetime.fromisoformat(manager["completed_at"].replace("Z", "+00:00")) \
            > dt.datetime.fromisoformat(cleanup["completed_at"].replace("Z", "+00:00")):
        raise ValueError("Managed cleanup predates its build completion receipt")

    # Bind the active-lease check to the manager's native on-volume layout.
    # A different current CI/release lease is observed but never changed.
    manager_file = Path(manager_proof["receipt"])
    if manager_file.name != "receipt.json" or manager_file.parent.name != lease.get("id") \
            or manager_file.parent.parent.name != "managed" or manager_file.parent.parent.parent.name != "retained":
        raise ValueError("Managed receipt is outside its native retained-record layout")
    project_root = manager_file.parent.parent.parent.parent
    if not inside(root, project_root / "qa"):
        raise ValueError("Managed snapshot is outside the manager's QA root")
    lease_file = project_root.parent / ".build-storage/lease.json"

    def inactive_lease():
        if lease_file.is_symlink():
            raise ValueError("Managed lease file is a symlink")
        if lease_file.exists():
            current, _ = read_retirement_json(lease_file)
            if not isinstance(current, dict) or not isinstance(current.get("id"), str) \
                    or not current["id"] or not isinstance(current.get("workspace"), str) \
                    or not Path(current["workspace"]).is_absolute() or current.get("workspace") == str(root) \
                    or current.get("id") == lease.get("id"):
                raise ValueError("Managed snapshot still has an active or unknown lease")

    inactive_lease()
    artifact = receipt.get("artifact")
    if not isinstance(artifact, dict) or artifact.get("sha256") != cleanup.get("retained_artifact_sha256") \
            or not isinstance(artifact.get("path"), str) or not Path(artifact["path"]).is_absolute() \
            or inside(Path(artifact["path"]).resolve(), root):
        raise ValueError("Managed retirement requires the original retained release artifact")
    # Read bytes only; release artifacts are never moved, rewritten or deleted.
    fd = os.open(artifact["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 4 * GIB:
            raise ValueError("Retained artifact must be a regular file of at most 4 GiB")
        with os.fdopen(fd, "rb") as output:
            fd = None
            digest = hashlib.sha256()
            deadline = time.monotonic() + 15
            while chunk := output.read(1024 ** 2):
                if time.monotonic() > deadline:
                    raise ValueError("Retained release artifact verification timed out")
                digest.update(chunk)
            actual_digest = digest.hexdigest()
            after = os.fstat(output.fileno())
        if actual_digest != artifact.get("sha256") or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Retained release artifact is missing, changed or has the wrong digest")
    finally:
        if fd is not None:
            os.close(fd)
    verified = verify_git_retirement(root, receipt.get("primaryPath"), head, receipt.get("retainedRef"))
    inactive_lease()
    return {**evidence, **verified, "provider": "repository-managed-reconciliation",
            "cleanup": cleanup_proof, "manager": manager_proof,
            "artifact": {"path": str(Path(artifact["path"]).resolve()), "sha256": actual_digest, "bytes": after.st_size},
            "completed_at": cleanup["completed_at"], "verified_at": stamp()}


def closeout(thread, workspace, disposition, reason, evidence, retirement_receipt=None):
    if disposition not in {"cleaned", "retained", "active"}:
        raise ValueError("Unknown closeout disposition")
    if retirement_receipt and disposition == "active":
        raise ValueError("A retired checkout cannot be marked active; retain required external output explicitly")
    if retirement_receipt:
        root = str(retired_workspace_root(workspace))
    else:
        try:
            root = str(workspace_root(workspace))
        except FileNotFoundError as exc:
            raise ValueError("Checkout is absent; supply --retirement-receipt with verified Groundskeeper or managed retirement JSON") from exc
    if len(reason.strip()) < 12 or not evidence.strip():
        raise ValueError("Closeout needs a concrete reason and an evidence reference")
    with ledger(thread) as data:
        if root not in data["workspaces"]:
            raise ValueError("Workspace was not registered before this task's build")
        row = data["workspaces"][root]
        retirement = verify_retirement(Path(root), retirement_receipt,
                                       row.get("last_registered_at", row.get("registered_at"))) if retirement_receipt else None
        current = snapshot(root)
        if not current["complete"]:
            raise ValueError("Cannot acknowledge an incomplete measurement")
        growth = current["allocated_bytes"] - row["baseline"]["allocated_bytes"]
        limit = min(row.get("growth_limit_bytes", GROWTH_LIMIT), GROWTH_LIMIT)
        if disposition == "cleaned" and growth >= limit:
            raise ValueError(f"Output remains above the registered {limit / GIB:g} GiB growth limit; clean proven output or explicitly retain it with evidence")
        if retirement and (os.path.lexists(root) or not no_symlink_path(Path(root))):
            raise ValueError("Retired workspace path reappeared during measurement")
        row.update(accounted=current, disposition=disposition, reason=reason,
                   evidence=evidence, closed_at=stamp())
        if retirement:
            row["retirement"] = retirement
        return {"workspace": root, "disposition": disposition, "growth_bytes": growth,
                "snapshot": current, "reason": reason, "evidence": evidence,
                **({"retirement": retirement} if retirement else {})}


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
            p.add_argument("--retirement-receipt", help="Applied Groundskeeper retirement JSON or pinned managed-snapshot reconciliation JSON for an already removed checkout")
    args = parser.parse_args(argv)
    if args.command == "register":
        result = register(args.thread, args.workspace, args.purpose, args.growth_limit_mib)
    elif args.command == "closeout":
        result = closeout(args.thread, args.workspace, args.disposition, args.reason, args.evidence,
                          args.retirement_receipt)
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
