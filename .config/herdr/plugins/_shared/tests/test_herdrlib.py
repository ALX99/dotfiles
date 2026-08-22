"""Tests for the shared Herdr client library."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED_DIR))

import herdrlib  # noqa: E402

STUB_HERDR = """#!/usr/bin/env python3
import json, sys
from pathlib import Path
here = Path(__file__).parent
with (here / "herdr.log").open("a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
mode = (here / "mode").read_text().strip() if (here / "mode").exists() else "ok"
if mode == "fail":
    print("boom", file=sys.stderr)
    raise SystemExit(3)
if mode == "bad-json":
    print("not json")
    raise SystemExit(0)
if mode == "error-envelope":
    print(json.dumps({"error": {"message": "no such workspace"}}))
    raise SystemExit(0)
print(json.dumps({"result": json.loads((here / "payload.json").read_text())}))
"""


class StubbedHerdr(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.bin_dir = self.tmp / "bin"
        self.bin_dir.mkdir()
        stub = self.bin_dir / "herdr"
        stub.write_text(STUB_HERDR)
        stub.chmod(0o755)
        os.environ["HERDR_BIN_PATH"] = str(stub)
        (self.bin_dir / "payload.json").write_text(json.dumps({"value": 1}))

    def tearDown(self) -> None:
        os.environ.pop("HERDR_BIN_PATH", None)

    def set_mode(self, mode: str) -> None:
        (self.bin_dir / "mode").write_text(mode)

    def calls(self) -> list:
        log = self.bin_dir / "herdr.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]

    def test_herdr_json_unwraps_result_envelope(self) -> None:
        self.assertEqual(
            herdrlib.herdr_json(["workspace", "list"]), {"value": 1}
        )
        self.assertIn("workspace", self.calls()[0])

    def test_herdr_json_surfaces_error_envelopes(self) -> None:
        self.set_mode("error-envelope")
        with self.assertRaisesRegex(herdrlib.PluginError, "no such workspace"):
            herdrlib.herdr_json(["workspace", "get", "w1"])

    def test_herdr_json_rejects_invalid_output(self) -> None:
        self.set_mode("bad-json")
        with self.assertRaisesRegex(herdrlib.PluginError, "invalid JSON"):
            herdrlib.herdr_json(["workspace", "list"])

    def test_herdr_json_reports_nonzero_exits(self) -> None:
        self.set_mode("fail")
        with self.assertRaisesRegex(herdrlib.PluginError, "boom"):
            herdrlib.herdr_json(["workspace", "list"])

    def test_notify_tolerates_failures(self) -> None:
        self.set_mode("fail")
        herdrlib.notify("title", "body")  # Must not raise.
        self.assertEqual(self.calls()[0][:2], ["notification", "show"])


class RunTest(unittest.TestCase):
    def test_missing_binary_maps_to_127(self) -> None:
        result = herdrlib.run(["definitely-not-a-real-binary-xyz"])
        self.assertEqual(result.returncode, 127)

    def test_timeout_maps_to_124(self) -> None:
        result = herdrlib.run(["sleep", "5"], timeout=0.2)
        self.assertEqual(result.returncode, 124)


class WorkspaceContextTest(unittest.TestCase):
    def tearDown(self) -> None:
        for name in ("HERDR_WORKSPACE_ID", "HERDR_PLUGIN_CONTEXT_JSON"):
            os.environ.pop(name, None)

    def test_env_var_wins_over_context_json(self) -> None:
        os.environ["HERDR_WORKSPACE_ID"] = "w-env"
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = json.dumps(
            {"workspace_id": "w-ctx"}
        )
        self.assertEqual(herdrlib.workspace_id_from_context(), "w-env")

    def test_falls_back_to_context_json(self) -> None:
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = '{"workspace_id": "w-ctx"}'
        self.assertEqual(herdrlib.workspace_id_from_context(), "w-ctx")

    def test_malformed_context_yields_none(self) -> None:
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = "{not json"
        self.assertIsNone(herdrlib.workspace_id_from_context())
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = '["nope"]'
        self.assertIsNone(herdrlib.workspace_id_from_context())


class WorkspaceParsingTest(unittest.TestCase):
    def ref_from(self, info) -> herdrlib.WorkspaceRef | None:
        return herdrlib._workspace_ref(info)

    def test_valid_info_keeps_worktree_and_label(self) -> None:
        ref = self.ref_from(
            {
                "workspace_id": "w1",
                "label": "demo",
                "worktree": {"is_linked_worktree": True},
            }
        )
        assert ref is not None
        self.assertEqual(ref.workspace_id, "w1")
        self.assertEqual(ref.label, "demo")
        self.assertEqual(ref.worktree, {"is_linked_worktree": True})

    def test_missing_or_empty_label_defaults_to_id(self) -> None:
        self.assertEqual(self.ref_from({"workspace_id": "w1"}).label, "w1")
        self.assertEqual(self.ref_from({"workspace_id": "w1", "label": ""}).label, "w1")

    def test_non_string_labels_default_to_id(self) -> None:
        self.assertEqual(self.ref_from({"workspace_id": "w1", "label": 7}).label, "w1")

    def test_entries_without_ids_are_dropped(self) -> None:
        self.assertIsNone(self.ref_from({"label": "orphan"}))
        self.assertIsNone(self.ref_from("not a dict"))


class GitHelpersTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        subprocess.run(
            ("git", "init", "-q", "-b", "main", str(self.tmp)),
            check=True,
            capture_output=True,
        )

    def test_git_repo_returns_working_tree_root(self) -> None:
        self.assertEqual(herdrlib.git_repo(self.tmp), self.tmp.resolve())

    def test_git_repo_rejects_directories_outside_repositories(self) -> None:
        outside = Path(tempfile.mkdtemp())
        self.assertIsNone(herdrlib.git_repo(outside))
        self.assertIsNone(herdrlib.git_repo(None))


if __name__ == "__main__":
    unittest.main()
