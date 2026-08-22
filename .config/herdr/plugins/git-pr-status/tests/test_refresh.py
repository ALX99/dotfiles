"""Behavioral tests for the git-pr-status plugin."""

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

STUB_GH = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
here = Path(__file__).parent
with (here / "gh.log").open("a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
scenario = (here / "gh-pr-list.json").read_text().strip()
if scenario == '"__fail__"':
    print("gh exploded", file=sys.stderr)
    raise SystemExit(1)
if sys.argv[1:3] == ["pr", "list"]:
    print(scenario)
else:
    print(json.dumps({"result": {}}))
"""


def git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(
        ("git", "-c", "user.email=test@example.com", "-c", "user.name=test", *args),
        cwd=str(cwd) if cwd else None,
        check=True,
        capture_output=True,
    )


class PluginRunner(unittest.TestCase):
    """Runs refresh.py against stubbed herdr and gh binaries."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.work = self.tmp / "work"
        self.work.mkdir()
        git("init", "-b", "feature-branch", cwd=self.work)
        (self.work / "file.txt").write_text("hi\n")
        git("add", ".", cwd=self.work)
        git("commit", "-m", "init", cwd=self.work)

        self.bin_dir = self.tmp / "bin"
        self.bin_dir.mkdir()
        for name, body in (("herdr", STUB_HERDR), ("gh", STUB_GH)):
            stub = self.bin_dir / name
            stub.write_text(body)
            stub.chmod(0o755)

        # Default registration: one workspace linked to a worktree checkout.
        payload = {"workspace": self.linked_workspace()}
        (self.bin_dir / "workspace-get.json").write_text(json.dumps(payload))
        (self.bin_dir / "workspace-list.json").write_text(
            json.dumps({"workspaces": [payload["workspace"]]})
        )

    def linked_workspace(self, workspace_id: str = "w1", label: str = "demo") -> dict:
        return {
            "workspace_id": workspace_id,
            "label": label,
            "worktree": {
                "is_linked_worktree": True,
                "checkout_path": str(self.work),
            },
        }

    def set_pr_scenario(self, scenario) -> None:
        text = json.dumps(scenario) if not isinstance(scenario, str) else scenario
        (self.bin_dir / "gh-pr-list.json").write_text(text)

    def run_plugin(self, *args: str, workspace_id: str | None = "w1") -> subprocess.CompletedProcess:
        environment = os.environ.copy()
        environment["PATH"] = f"{self.bin_dir}{os.pathsep}{environment['PATH']}"
        environment["HERDR_BIN_PATH"] = str(self.bin_dir / "herdr")
        environment["GH_BIN_PATH"] = str(self.bin_dir / "gh")
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

    def herdr_calls(self) -> list:
        log = self.bin_dir / "herdr.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def report_metadata_calls(self) -> list:
        return [
            call
            for call in self.herdr_calls()
            if call[:3] == ["workspace", "report-metadata", "w1"]
        ]

    def tokens_of(self, call: list) -> tuple[set, list]:
        clears = []
        tokens = []
        for index, value in enumerate(call):
            if value == "--clear-token":
                clears.append(call[index + 1])
            if value == "--token":
                tokens.append(call[index + 1])
        return set(clears), tokens

    def notification_texts(self) -> list:
        return [
            " ".join(call)
            for call in self.herdr_calls()
            if call[:2] == ["notification", "show"]
        ]

    def test_open_pull_request_wins_over_newer_closed(self) -> None:
        self.set_pr_scenario(
            [
                {
                    "number": 7,
                    "state": "CLOSED",
                    "isDraft": False,
                    "mergedAt": None,
                    "updatedAt": "2024-05-01T00:00:00Z",
                },
                {
                    "number": 5,
                    "state": "OPEN",
                    "isDraft": False,
                    "mergedAt": None,
                    "updatedAt": "2024-01-01T00:00:00Z",
                },
            ]
        )
        result = self.run_plugin("refresh-all", "--notify")

        self.assertEqual(result.returncode, 0, result.stderr)
        clears, tokens = self.tokens_of(self.report_metadata_calls()[0])
        self.assertEqual(
            clears, {"pr_draft", "pr_open", "pr_merged", "pr_closed"}
        )
        self.assertEqual(tokens, ["pr_open=open #5"])

    def test_draft_pull_request_token(self) -> None:
        self.set_pr_scenario(
            [
                {
                    "number": 9,
                    "state": "OPEN",
                    "isDraft": True,
                    "mergedAt": None,
                    "updatedAt": "2024-01-01T00:00:00Z",
                }
            ]
        )
        result = self.run_plugin("refresh-all")

        self.assertEqual(result.returncode, 0, result.stderr)
        _, tokens = self.tokens_of(self.report_metadata_calls()[0])
        self.assertEqual(tokens, ["pr_draft=draft #9"])

    def test_merged_pull_request_token(self) -> None:
        self.set_pr_scenario(
            [
                {
                    "number": 3,
                    "state": "MERGED",
                    "isDraft": False,
                    "mergedAt": "2024-02-01T00:00:00Z",
                    "updatedAt": "2024-02-01T00:00:00Z",
                }
            ]
        )
        result = self.run_plugin("refresh-workspace")

        self.assertEqual(result.returncode, 0, result.stderr)
        _, tokens = self.tokens_of(self.report_metadata_calls()[0])
        self.assertEqual(tokens, ["pr_merged=merged #3"])

    def test_no_matching_pull_request_clears_tokens(self) -> None:
        self.set_pr_scenario([])
        result = self.run_plugin("refresh-all", "--notify")

        self.assertEqual(result.returncode, 0, result.stderr)
        clears, tokens = self.tokens_of(self.report_metadata_calls()[0])
        self.assertEqual(clears, {"pr_draft", "pr_open", "pr_merged", "pr_closed"})
        self.assertEqual(tokens, [])
        self.assertTrue(any("Checked 1 worktrees" in text for text in self.notification_texts()))

    def test_non_worktree_workspace_only_clears_tokens(self) -> None:
        (self.bin_dir / "workspace-list.json").write_text(
            json.dumps(
                {
                    "workspaces": [
                        {
                            "workspace_id": "w1",
                            "label": "plain",
                            "worktree": {
                                "is_linked_worktree": False,
                                "checkout_path": str(self.bin_dir),
                            },
                        }
                    ]
                }
            )
        )
        result = self.run_plugin("refresh-all", "--notify")

        self.assertEqual(result.returncode, 0, result.stderr)
        _, tokens = self.tokens_of(self.report_metadata_calls()[0])
        self.assertEqual(tokens, [])
        self.assertTrue(any("Checked 0 worktrees" in text for text in self.notification_texts()))

    def test_gh_failure_is_reported_and_exits_nonzero(self) -> None:
        self.set_pr_scenario("__fail__")
        result = self.run_plugin("refresh-all", "--notify")

        self.assertEqual(result.returncode, 1)
        self.assertIn("demo", result.stderr)
        self.assertTrue(any("1 unavailable" in text for text in self.notification_texts()))

    def test_open_action_views_the_best_pull_request(self) -> None:
        self.set_pr_scenario(
            [
                {
                    "number": 2,
                    "state": "OPEN",
                    "isDraft": False,
                    "mergedAt": None,
                    "updatedAt": "2024-01-01T00:00:00Z",
                },
                {
                    "number": 11,
                    "state": "OPEN",
                    "isDraft": False,
                    "mergedAt": None,
                    "updatedAt": "2024-06-01T00:00:00Z",
                },
            ]
        )
        result = self.run_plugin("open")

        self.assertEqual(result.returncode, 0, result.stderr)
        gh_calls = [
            json.loads(line)
            for line in (self.bin_dir / "gh.log").read_text().splitlines()
        ]
        view_calls = [call for call in gh_calls if call[:3] == ["pr", "view", "11"]]
        self.assertTrue(view_calls)
        self.assertIn("--web", view_calls[0])
        self.assertTrue(any("Opened GitHub PR" in text for text in self.notification_texts()))

    def test_open_action_without_repository_fails_with_notification(self) -> None:
        (self.bin_dir / "workspace-get.json").write_text(
            json.dumps(
                {
                    "workspace": {
                        "workspace_id": "w1",
                        "label": "plain",
                        "worktree": {
                            "is_linked_worktree": False,
                            "checkout_path": str(self.bin_dir),
                        },
                    }
                }
            )
        )
        result = self.run_plugin("open")

        self.assertEqual(result.returncode, 1)
        self.assertTrue(any("Open GitHub PR failed" in text for text in self.notification_texts()))


if __name__ == "__main__":
    unittest.main()
