"""Tests for the worktree-install plugin."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

import install  # noqa: E402

VALID_PACKAGE_LOCK = json.dumps(
    {"name": "demo", "version": "1.0.0", "lockfileVersion": 3, "packages": {}}
)

STUB_HERDR = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
with Path(__file__).with_suffix('.log').open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['workspace', 'get']:
    payload = json.loads(Path(__file__).with_suffix('.json').read_text())
    print(json.dumps({'result': payload}))
"""

STUB_NPM = """#!/usr/bin/env python3
from pathlib import Path
Path(__file__).with_name('npm-called').write_text('called\\n')
"""


def write_files(directory: Path, contents: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name, text in contents.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def wait_for(path: Path, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(0.05)
    return False


class DetectPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def test_prefers_bun_then_pnpm_then_npm(self) -> None:
        write_files(
            self.tmp,
            {
                "package.json": "{}",
                "bun.lock": "",
                "pnpm-lock.yaml": "",
                "package-lock.json": VALID_PACKAGE_LOCK,
            },
        )
        self.assertEqual(install.detect_plan(self.tmp).package_manager, "bun")

    def test_prefers_pnpm_over_npm(self) -> None:
        write_files(
            self.tmp,
            {"package.json": "{}", "pnpm-lock.yaml": "", "package-lock.json": VALID_PACKAGE_LOCK},
        )
        self.assertEqual(install.detect_plan(self.tmp).package_manager, "pnpm")

    def test_uses_npm_ci_for_package_lock(self) -> None:
        write_files(self.tmp, {"package.json": "{}", "package-lock.json": VALID_PACKAGE_LOCK})
        plan = install.detect_plan(self.tmp)
        self.assertEqual(plan.package_manager, "npm")
        self.assertEqual(plan.location, "root")
        self.assertEqual(plan.directory, self.tmp)

    def test_falls_back_to_frontend(self) -> None:
        write_files(self.tmp / "frontend", {"package.json": "{}", "pnpm-lock.yaml": ""})
        plan = install.detect_plan(self.tmp)
        self.assertEqual(plan.location, "frontend")
        self.assertEqual(plan.directory, self.tmp / "frontend")

    def test_root_wins_over_frontend(self) -> None:
        write_files(self.tmp, {"package.json": "{}", "package-lock.json": VALID_PACKAGE_LOCK})
        write_files(self.tmp / "frontend", {"package.json": "{}", "pnpm-lock.yaml": ""})
        self.assertEqual(install.detect_plan(self.tmp).location, "root")

    def test_unrecognized_lockfile_is_skipped(self) -> None:
        write_files(self.tmp, {"package.json": "{}", "yarn.lock": ""})
        self.assertIsNone(install.detect_plan(self.tmp))

    def test_no_project_returns_none(self) -> None:
        self.assertIsNone(install.detect_plan(self.tmp))

    def test_missing_binary_raises(self) -> None:
        write_files(self.tmp, {"package.json": "{}", "pnpm-lock.yaml": ""})
        with mock.patch.object(install, "resolve_binary", return_value=None):
            with self.assertRaises(install.PluginError):
                install.detect_plan(self.tmp)


class WorkspaceFlowTest(unittest.TestCase):
    """End-to-end runs of install.py auto against stubbed Herdr and npm."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.repo = self.tmp / "repo"
        self.bin_dir = self.tmp / "bin"
        self.state = self.tmp / "state"
        write_files(
            self.repo,
            {"package.json": '{"name": "demo", "private": true}', "package-lock.json": VALID_PACKAGE_LOCK},
        )
        self.bin_dir.mkdir()
        for name, body in (("herdr", STUB_HERDR), ("npm", STUB_NPM)):
            stub = self.bin_dir / name
            stub.write_text(body)
            stub.chmod(0o755)
        self.workspace_payload = {
            "workspace": {
                "workspace_id": "w1",
                "label": "demo",
                "worktree": {
                    "is_linked_worktree": True,
                    "checkout_path": str(self.repo),
                },
            }
        }
        (self.bin_dir / "herdr.json").write_text(json.dumps(self.workspace_payload))

    def run_auto(self) -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        environment["PATH"] = f"{self.bin_dir}{os.pathsep}{environment.get('PATH', '')}"
        environment["HERDR_BIN_PATH"] = str(self.bin_dir / "herdr")
        environment["HERDR_PLUGIN_STATE_DIR"] = str(self.state)
        environment["HERDR_WORKSPACE_ID"] = "w1"
        return subprocess.run(
            [sys.executable, str(PLUGIN_DIR / "install.py"), "auto"],
            capture_output=True,
            encoding="utf-8",
            env=environment,
            timeout=60,
        )

    @property
    def marker(self) -> Path:
        return self.bin_dir / "npm-called"

    def herdr_calls(self) -> list:
        log = self.bin_dir / "herdr.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def test_auto_installs_detached_and_notifies(self) -> None:
        result = self.run_auto()
        self.assertEqual(result.returncode, 0, result.stderr)

        self.assertTrue(wait_for(self.marker), "stub npm never ran")
        # The worker notifies only after the install completes.
        deadline = time.monotonic() + 30
        notifications: list = []
        while time.monotonic() < deadline:
            calls = self.herdr_calls()
            notifications = [call for call in calls if call[:2] == ["notification", "show"]]
            if notifications:
                break
            time.sleep(0.05)
        self.assertTrue(notifications, "no notification was sent")
        self.assertIn("finished", notifications[0][-1])
        self.assertIn(["workspace", "get", "w1"], self.herdr_calls())

        logs = list((self.state / "logs").glob("*.log"))
        self.assertEqual(len(logs), 1)
        self.assertIn("# ok:", logs[0].read_text())

    def test_auto_skips_already_installed_checkout(self) -> None:
        (self.repo / "node_modules").mkdir()
        result = self.run_auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        time.sleep(0.5)
        self.assertFalse(self.marker.exists())
        self.assertNotIn(["notification", "show"], [call[:2] for call in self.herdr_calls()])

    def test_auto_skips_while_another_install_holds_the_lock(self) -> None:
        plan = install.detect_plan(self.repo)
        with mock.patch.dict(os.environ, {"HERDR_PLUGIN_STATE_DIR": str(self.state)}):
            lock_fd = install.acquire_lock(plan)
        self.assertIsNotNone(lock_fd)
        try:
            result = self.run_auto()
            self.assertEqual(result.returncode, 0, result.stderr)
            time.sleep(0.5)
            self.assertFalse(self.marker.exists())
        finally:
            os.close(lock_fd)

    def test_auto_ignores_non_worktree_workspace(self) -> None:
        self.workspace_payload["workspace"]["worktree"]["is_linked_worktree"] = False
        (self.bin_dir / "herdr.json").write_text(json.dumps(self.workspace_payload))
        result = self.run_auto()
        self.assertEqual(result.returncode, 0, result.stderr)
        time.sleep(0.5)
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
