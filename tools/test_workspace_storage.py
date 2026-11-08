import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("workspace_storage", Path(__file__).with_name("workspace_storage.py"))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="workspace-storage-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.dd = self.root / "DerivedData"
        self.dd.mkdir()
        self.env = patch.dict(os.environ, {
            "WORKSPACE_STORAGE_STATE_DIR": str(self.root / "state"),
            "WORKSPACE_STORAGE_DERIVED_DATA": str(self.dd),
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    def fake_snapshot(self, total=0, complete=True):
        return {"at": "fixture", "workspace": str(self.repo), "complete": complete,
                "allocated_bytes": total if complete else None, "paths": [],
                "errors": [] if complete else ["probe failed"]}

    def register_fake(self, total=0):
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(total)):
            storage.register("thread-a", str(self.repo), "Implement scoped feature")

    def stop(self, total, **extra):
        event = {"hook_event_name": "Stop", "session_id": "thread-a", "turn_id": "turn-a", **extra}
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(total)), \
             patch.object(storage, "external_wait_pending", return_value=False):
            return storage.augment_hook(event, {})

    def test_requires_exact_git_root(self):
        sub = self.repo / "sub"
        sub.mkdir()
        with self.assertRaisesRegex(ValueError, "exact top level"):
            storage.workspace_root(sub)
        with self.assertRaisesRegex(ValueError, "absolute"):
            storage.workspace_root(".")

    def test_untracked_and_secret_source_untouched(self):
        secret = self.repo / ".env"
        secret.write_text("fixture-do-not-read")
        source = self.repo / "feature.txt"
        source.write_text("unfinished authored source")
        build = self.repo / "build"
        build.mkdir()
        artifact = build / "artifact.bin"
        artifact.write_bytes(b"output" * 1000)
        measured = storage.snapshot(self.repo)
        self.assertTrue(measured["complete"])
        self.assertGreater(measured["allocated_bytes"], 0)
        self.assertFalse(measured["removal_eligibility_established"])
        self.assertEqual(secret.read_text(), "fixture-do-not-read")
        self.assertEqual(source.read_text(), "unfinished authored source")
        self.assertTrue(artifact.exists())

    def test_local_shared_symlink_target_is_not_followed(self):
        shared = self.root / "shared"
        shared.mkdir()
        (shared / "valuable").write_bytes(b"keep")
        (self.repo / "build").symlink_to(shared, target_is_directory=True)
        result = storage.snapshot(self.repo)
        self.assertEqual(result["allocated_bytes"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual((shared / "valuable").read_bytes(), b"keep")

    def make_external(self, name, workspace):
        p = self.dd / name
        p.mkdir()
        (p / "info.plist").write_bytes(plistlib.dumps({"WorkspacePath": str(workspace)}))
        return p

    def test_external_xcode_uses_native_workspace_path(self):
        project = self.repo / "ios/Runner.xcworkspace"
        project.mkdir(parents=True)
        owned = self.make_external("Runner-arbitrary-hash", project)
        other = self.root / "repo-other/ios/Runner.xcworkspace"
        other.mkdir(parents=True)
        foreign = self.make_external("Runner-same-display-name", other)
        paths, _, errors = storage.output_paths(self.repo)
        self.assertEqual(paths, [owned])
        self.assertNotIn(foreign, paths)
        self.assertFalse(errors)

    def test_external_missing_workspace_is_not_owned(self):
        self.make_external("Runner-stale", self.repo / "missing/Runner.xcworkspace")
        self.assertEqual(storage.output_paths(self.repo)[0], [])

    def test_binary_plist_supported(self):
        project = self.repo / "App.xcodeproj"
        project.mkdir()
        owned = self.make_external("Native", project)
        (owned / "info.plist").write_bytes(plistlib.dumps({"WorkspacePath": str(project)}, fmt=plistlib.FMT_BINARY))
        self.assertEqual(storage.output_paths(self.repo)[0], [owned])

    def test_external_symlink_not_followed(self):
        project = self.repo / "App.xcodeproj"
        project.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "info.plist").write_bytes(plistlib.dumps({"WorkspacePath": str(project)}))
        (self.dd / "linked").symlink_to(outside, target_is_directory=True)
        self.assertEqual(storage.output_paths(self.repo)[0], [])

    def test_prefix_collision_is_not_ownership(self):
        other = self.root / "repo-elsewhere/App.xcodeproj"
        other.mkdir(parents=True)
        self.make_external("Runner", other)
        self.assertEqual(storage.output_paths(self.repo)[0], [])

    def test_same_output_path_not_counted_twice(self):
        build = self.repo / "build"
        project = self.repo / "App.xcodeproj"
        project.mkdir()
        build.mkdir()
        (build / "info.plist").write_bytes(plistlib.dumps({"WorkspacePath": str(project)}))
        paths, _, _ = storage.output_paths(self.repo, derived_data_root=self.repo)
        self.assertEqual(paths, [build])

    def test_timeout_remains_unknown_not_zero(self):
        (self.repo / "build").mkdir()
        with patch.object(storage.subprocess, "run", side_effect=subprocess.TimeoutExpired("du", 2)):
            result = storage.snapshot(self.repo, timeout=2)
        self.assertFalse(result["complete"])
        self.assertIsNone(result["allocated_bytes"])

    def test_failed_baseline_cannot_be_registered(self):
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(complete=False)):
            with self.assertRaisesRegex(ValueError, "complete baseline"):
                storage.register("thread-a", str(self.repo), "Actual task")
        self.assertFalse(storage.state_path("thread-a").exists())

    def test_registration_does_not_reset_existing_baseline(self):
        self.register_fake(100)
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(10 * storage.GIB)):
            row = storage.register("thread-a", str(self.repo), "Same task")
        self.assertEqual(row["baseline"]["allocated_bytes"], 100)

    def test_real_register_check_closeout_preserve_git_and_output(self):
        build = self.repo / "build"
        build.mkdir()
        (build / "fixture").write_bytes(b"x" * 4096)
        before = subprocess.check_output(["git", "-C", str(self.repo), "status", "--porcelain"])
        storage.register("thread-a", str(self.repo), "Meter fixture output")
        result = storage.closeout("thread-a", str(self.repo), "retained",
                                  "Required review fixture is retained", "fixture:review")
        self.assertEqual(result["disposition"], "retained")
        self.assertTrue((build / "fixture").exists())
        self.assertEqual(before, subprocess.check_output(["git", "-C", str(self.repo), "status", "--porcelain"]))
        self.assertEqual(storage.state_path("thread-a").stat().st_mode & 0o777, 0o600)

    def test_unaccounted_gib_causes_one_corrective_pass(self):
        self.register_fake()
        result = self.stop(2 * storage.GIB)
        self.assertEqual(result["decision"], "block")
        self.assertIn("+2.00 GiB", result["reason"])
        self.assertEqual(self.stop(3 * storage.GIB), {})

    def test_existing_output_and_small_growth_do_not_block(self):
        self.register_fake(10 * storage.GIB)
        self.assertEqual(self.stop(10 * storage.GIB + 1000), {})

    def test_stop_hook_recursion_not_blocked(self):
        self.register_fake()
        self.assertEqual(self.stop(2 * storage.GIB, stop_hook_active=True), {})

    def test_human_stop_is_respected(self):
        self.register_fake()
        with storage.ledger("thread-a") as d:
            d["halt_requested"] = True
        self.assertEqual(self.stop(2 * storage.GIB), {})

    def test_external_wait_is_not_replaced_by_cleanup(self):
        self.register_fake()
        with patch.object(storage, "external_wait_pending", return_value=True), \
             patch.object(storage, "snapshot", side_effect=AssertionError("Must not scan pending builds")):
            result = storage.augment_hook({"hook_event_name": "Stop", "session_id": "thread-a"}, {})
        self.assertEqual(result, {})

    def test_existing_guard_denials_and_waiting_user_are_preserved(self):
        for result in [{"decision": "block", "reason": "Original guard"}, {"continue": False, "stopReason": "Waiting on user"}]:
            self.assertEqual(storage.augment_hook({"hook_event_name": "Stop", "session_id": "thread-a"}, result), result)

    def test_retention_receipt_acknowledges_current_bytes(self):
        self.register_fake()
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(2 * storage.GIB)):
            storage.closeout("thread-a", str(self.repo), "active", "Native CI remains in progress", "gh:exact-native-run")
        self.assertEqual(self.stop(2 * storage.GIB), {})
        self.assertEqual(self.stop(4 * storage.GIB)["decision"], "block")

    def test_cleaned_cannot_hide_gibibytes_of_new_output(self):
        self.register_fake()
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(2 * storage.GIB)):
            with self.assertRaisesRegex(ValueError, "1 GiB growth limit"):
                storage.closeout("thread-a", str(self.repo), "cleaned", "Claiming cleanup finished", "fixture:proof")

    def test_incomplete_measurement_cannot_be_acknowledged_or_claim_growth(self):
        self.register_fake()
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(complete=False)):
            with self.assertRaisesRegex(ValueError, "incomplete"):
                storage.closeout("thread-a", str(self.repo), "retained", "Required output retained", "fixture:proof")
            with patch.object(storage, "external_wait_pending", return_value=False):
                self.assertEqual(storage.augment_hook({"hook_event_name": "Stop", "session_id": "thread-a"}, {}), {})

    def test_low_disk_context_is_actionable_without_permission_gate(self):
        usage = type("Usage", (), {"free": 10 * storage.GIB})()
        with patch.object(storage.shutil, "disk_usage", return_value=usage):
            result = storage.augment_hook({"hook_event_name": "SessionStart", "session_id": "thread-a"},
                                          {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "Original policy"}})
        text = result["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Original policy", text)
        self.assertIn("below the 30 GiB reserve", text)
        self.assertIn("not a new approval", text)

    def test_unrelated_pretool_guard_output_is_identical(self):
        original = {"hookSpecificOutput": {"permissionDecision": "deny"}}
        self.assertIs(storage.augment_hook({"hook_event_name": "PreToolUse"}, original), original)

    def test_paused_expired_or_completed_timers_do_not_mask_closeout(self):
        state = self.root / ".codex/state/task-progress/state.json"
        state.parent.mkdir(parents=True)
        timer = self.root / ".codex/automations/test-timer/automation.toml"
        timer.parent.mkdir(parents=True)
        contract = {"threadId": "thread-a", "mode": "external_wait", "expiresAt": "2099-01-01T00:00:00+00:00"}
        for status, expiry, expected in [
            ("PAUSED", "2099-01-01T00:00:00+00:00", False),
            ("ACTIVE", "2000-01-01T00:00:00+00:00", False),
            ("ACTIVE", "2099-01-01T00:00:00+00:00", True),
        ]:
            contract["expiresAt"] = expiry
            state.write_text(json.dumps({"automations": {"test-timer": contract}}))
            timer.write_text('status = "' + status + '"\ntarget_thread_id = "thread-a"\n')
            with patch.object(storage.Path, "home", return_value=self.root):
                self.assertEqual(storage.external_wait_pending("thread-a"), expected)

    def test_reregister_closed_workspace_reopens_accounting_without_reset(self):
        self.register_fake(123)
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(123)):
            storage.closeout("thread-a", str(self.repo), "retained", "Review product remains required", "fixture:proof")
            row = storage.register("thread-a", str(self.repo), "Continue same feature")
        self.assertEqual(row["disposition"], "working")
        self.assertEqual(row["baseline"]["allocated_bytes"], 123)

    def test_new_user_turn_resets_correction_when_native_turn_id_is_missing(self):
        self.register_fake()
        self.assertEqual(self.stop(2 * storage.GIB)["decision"], "block")
        storage.augment_hook({"hook_event_name": "UserPromptSubmit", "session_id": "thread-a", "prompt": "Continue the actual task"}, {})
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(2 * storage.GIB)), \
             patch.object(storage, "external_wait_pending", return_value=False):
            event = {"hook_event_name": "Stop", "session_id": "thread-a"}
            self.assertEqual(storage.augment_hook(event, {})["decision"], "block")
            self.assertEqual(storage.augment_hook(event, {}), {})

    def test_budget_can_tighten_but_not_relax_the_gibibyte_limit(self):
        with patch.object(storage, "snapshot", return_value=self.fake_snapshot(0)):
            row = storage.register("thread-a", str(self.repo), "Small output fixture", growth_limit_mib=1)
            self.assertEqual(row["growth_limit_bytes"], 1024 ** 2)
            row = storage.register("thread-a", str(self.repo), "Same task", growth_limit_mib=1024)
            self.assertEqual(row["growth_limit_bytes"], 1024 ** 2)
            with self.assertRaisesRegex(ValueError, "never relax"):
                storage.register("thread-a", str(self.repo), "Unsafe budget", growth_limit_mib=2048)
        self.assertEqual(self.stop(2 * 1024 ** 2)["decision"], "block")

    def test_reopening_closed_workspaces_does_not_bypass_concurrency_bound(self):
        self.register_fake()
        with storage.ledger("thread-a") as d:
            d["workspaces"][str(self.repo)]["disposition"] = "retained"
            template = copy.deepcopy(d["workspaces"][str(self.repo)])
            template["disposition"] = "working"
            for i in range(storage.MAX_WORKSPACES):
                d["workspaces"][str(self.root / str(i))] = copy.deepcopy(template)
        with self.assertRaisesRegex(ValueError, "before reopening"):
            storage.register("thread-a", str(self.repo), "Reopen after handoff")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="workspace-storage-install-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        s = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install_workspace_storage.py"))
        self.installer = importlib.util.module_from_spec(s)
        s.loader.exec_module(self.installer)
        self.guard = self.root / ".codex/guards/task-progress/guard.py"
        self.guard.parent.mkdir(parents=True)
        self.guard.write_text('from pathlib import Path\ndef cli(argv):\n    result = hook(event)\n')
        self.codex = self.root / ".codex/AGENTS.md"
        self.codex.write_text("Preserve the newest Android and Apple policy.\n")
        self.claude = self.root / ".claude/CLAUDE.md"
        self.claude.parent.mkdir()
        self.claude.write_text("Preserve existing Claude instructions.\n")
        self.hooks = self.root / ".codex/hooks.json"
        self.hooks.write_text('{"keep":"hook definitions and trust untouched"}\n')
        self.source = self.root / "workspace_storage.py"
        self.source.write_text("# fixture helper\n")

    def test_install_preserves_other_rules_and_hook_definitions(self):
        before = self.hooks.read_bytes()
        receipt = self.installer.install(self.root, self.source)
        self.assertFalse(receipt["hook_definitions_changed"])
        self.assertFalse(receipt["hook_trust_changed"])
        self.assertFalse(receipt["automatic_deletion"])
        self.assertEqual(self.hooks.read_bytes(), before)
        self.assertTrue(self.codex.read_text().startswith("Preserve the newest Android and Apple policy."))
        self.assertTrue(self.claude.read_text().startswith("Preserve existing Claude instructions."))
        self.assertIn("result = storage_accounting(event, hook(event))", self.guard.read_text())

    def test_install_is_idempotent(self):
        self.installer.install(self.root, self.source)
        first = [p.read_bytes() for p in [self.guard, self.codex, self.claude]]
        receipt = self.installer.install(self.root, self.source)
        self.assertEqual([p.read_bytes() for p in [self.guard, self.codex, self.claude]], first)
        self.assertEqual(receipt["installed"], [])

    def test_unknown_guard_is_rejected_before_any_global_edit(self):
        self.guard.write_text("# unknown guard; preserve\n")
        with self.assertRaisesRegex(ValueError, "Unknown task-progress"):
            self.installer.install(self.root, self.source)
        self.assertEqual(self.codex.read_text(), "Preserve the newest Android and Apple policy.\n")
        self.assertFalse((self.root / ".codex/tools/workspace-storage.py").exists())


if __name__ == "__main__":
    unittest.main()
