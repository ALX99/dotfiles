"""Behavioral tests for the git-main-status plugin."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

import refresh  # noqa: E402

GIT_IDENTITY = ("-c", "user.email=test@example.com", "-c", "user.name=test")

STUB_HERDR = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
here = Path(__file__).parent
with (here / "herdr.log").open("a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["workspace", "list"]:
    payload = json.loads((here / "workspace-list.json").read_text())
    print(json.dumps({"result": payload}))
elif sys.argv[1:3] == ["workspace", "get"]:
    payload = json.loads((here / "workspace-get.json").read_text())
    print(json.dumps({"result": payload}))
else:
    print(json.dumps({"result": {}}))
"""

# Logs every git invocation, then runs the real git. Lets assertions observe
# what the plugin subprocess actually executed.
STUB_GIT = """#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/git.log"
exec /usr/bin/git "$@"
"""


def git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ("git", *GIT_IDENTITY, *args),
        cwd=str(cwd) if cwd else None,
        check=True,
        capture_output=True,
    )


class RepoFixture:
    """A local bare origin plus one clone with a committed branch."""

    def __init__(self, base: Path) -> None:
        self.origin = base / "origin.git"
        self.work = base / "work"
        subprocess.run(
            ("git", "init", "--bare", "-b", "main", str(self.origin)),
            check=True,
            capture_output=True,
        )
        self.work.mkdir()
        git("init", "-b", "main", cwd=self.work)
        (self.work / "file.txt").write_text("hi\n")
        git("add", ".", cwd=self.work)
        git("commit", "-m", "init", cwd=self.work)
        git("remote", "add", "origin", str(self.origin), cwd=self.work)
        git("push", "-u", "origin", "main", cwd=self.work)

    def workspace(self, workspace_id: str, label: str, path: Path) -> dict:
        return {
            "workspace_id": workspace_id,
            "label": label,
            "worktree": {
                "is_linked_worktree": path != self.work,
                "checkout_path": str(path),
            },
        }


class UpstreamRemoteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.fixture = RepoFixture(self.tmp)
        self.work = self.fixture.work

    def test_configured_branch_remote_wins(self) -> None:
        self.assertEqual(refresh.upstream_remote(self.work), "origin")

    def test_in_repo_remote_is_ignored(self) -> None:
        git("remote", "add", "selfrepo", ".", cwd=self.work)
        git("config", "branch.main.remote", ".", cwd=self.work)
        self.assertIsNone(refresh.upstream_remote(self.work))

    def test_falls_back_to_origin_without_branch_config(self) -> None:
        git("config", "--unset", "branch.main.remote", cwd=self.work)
        self.assertEqual(refresh.upstream_remote(self.work), "origin")

    def test_no_remote_at_all(self) -> None:
        git("config", "--unset", "branch.main.remote", cwd=self.work)
        git("remote", "remove", "origin", cwd=self.work)
        self.assertIsNone(refresh.upstream_remote(self.work))


class RepositoryIdentityTest(unittest.TestCase):
    def test_linked_worktree_shares_identity_with_main_checkout(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        fixture = RepoFixture(tmp)
        worktree = tmp / "wt"
        git("worktree", "add", "-b", "wt-topic", str(worktree), "main", cwd=fixture.work)
        self.assertEqual(
            refresh.repository_identity(fixture.work),
            refresh.repository_identity(worktree),
        )

    def test_distinct_repos_have_distinct_identities(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        first = RepoFixture(tmp / "a")
        second = RepoFixture(tmp / "b")
        self.assertNotEqual(
            refresh.repository_identity(first.work),
            refresh.repository_identity(second.work),
        )


class RefreshAllTest(unittest.TestCase):
    """End-to-end refresh-all runs against a stubbed herdr binary."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.fixture = RepoFixture(self.tmp)
        self.bin_dir = self.tmp / "bin"
        self.bin_dir.mkdir()
        for name, body in (("herdr", STUB_HERDR), ("git", STUB_GIT)):
            stub = self.bin_dir / name
            stub.write_text(body)
            stub.chmod(0o755)

    def git_calls(self) -> list:
        log = self.bin_dir / "git.log"
        if not log.exists():
            return []
        return [line for line in log.read_text().splitlines()]

    def write_workspaces(self, infos: list) -> None:
        (self.bin_dir / "workspace-list.json").write_text(
            json.dumps({"workspaces": infos})
        )

    def run_refresh(self, *args: str, workspace_id: str | None = None) -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        environment["PATH"] = f"{self.bin_dir}{os.pathsep}{environment['PATH']}"
        environment["HERDR_BIN_PATH"] = str(self.bin_dir / "herdr")
        if workspace_id:
            environment["HERDR_WORKSPACE_ID"] = workspace_id
        else:
            environment.pop("HERDR_WORKSPACE_ID", None)
        return subprocess.run(
            [sys.executable, str(PLUGIN_DIR / "refresh.py"), *args],
            capture_output=True,
            encoding="utf-8",
            env=environment,
            timeout=120,
        )

    def notifications(self) -> list:
        log = self.bin_dir / "herdr.log"
        if not log.exists():
            return []
        calls = [json.loads(line) for line in log.read_text().splitlines()]
        return [call for call in calls if call[:2] == ["notification", "show"]]

    def test_fetches_each_repository_once_and_notifies(self) -> None:
        # A linked worktree shares repository identity with its main checkout,
        # so both workspaces must collapse into a single fetch.
        worktree = self.tmp / "wt"
        git("worktree", "add", "-b", "wt-topic", str(worktree), "main",
            cwd=self.fixture.work)
        self.write_workspaces(
            [
                self.fixture.workspace("w1", "main", self.fixture.work),
                self.fixture.workspace("w2", "wt", worktree),
                self.fixture.workspace("w3", "plain", self.bin_dir),
            ]
        )
        result = self.run_refresh("refresh-all", "--notify")

        self.assertEqual(result.returncode, 0, result.stderr)
        fetches = [call for call in self.git_calls() if call.split()[0:2] == ["fetch", "--quiet"]]
        self.assertEqual(len(fetches), 1)
        bodies = [call[-1] for call in self.notifications()]
        self.assertTrue(any("Refreshed 1 repositories" in body for body in bodies))

    def test_reports_failures_and_exits_nonzero(self) -> None:
        broken = self.tmp / "broken"
        result_clone = subprocess.run(
            ("git", "clone", str(self.fixture.origin), str(broken)),
            capture_output=True,
        )
        self.assertEqual(result_clone.returncode, 0, result_clone.stderr)
        git("remote", "set-url", "origin", str(self.tmp / "missing.git"), cwd=broken)
        self.write_workspaces([self.fixture.workspace("w1", "broken", broken)])

        result = self.run_refresh("refresh-all", "--notify")

        self.assertEqual(result.returncode, 1)
        self.assertIn("broken", result.stderr)
        bodies = [call[-1] for call in self.notifications()]
        self.assertTrue(any("1 failed" in body for body in bodies))

    def test_refresh_workspace_uses_context_workspace(self) -> None:
        (self.bin_dir / "workspace-get.json").write_text(
            json.dumps(
                {
                    "workspace": self.fixture.workspace(
                        "w9", "focused", self.fixture.work
                    )
                }
            )
        )
        result = self.run_refresh("refresh-workspace", workspace_id="w9")

        self.assertEqual(result.returncode, 0, result.stderr)
        fetches = [call for call in self.git_calls() if call.split()[0:2] == ["fetch", "--quiet"]]
        self.assertEqual(len(fetches), 1)

    def test_unknown_action_fails(self) -> None:
        result = self.run_refresh("bogus")
        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown action", result.stderr)


if __name__ == "__main__":
    unittest.main()
