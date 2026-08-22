"""Shared Herdr client plumbing for the plugins in this directory.

Herdr links each plugin directory individually, so `_shared` is not a
plugin itself; plugin scripts prepend it to sys.path and import this
module. It owns the pieces every plugin needs: subprocess execution with
missing-binary and timeout mapping, `herdr` CLI calls and JSON envelope
parsing, notifications, invocation-context workspace ids, workspace
list/get parsing, and Git helpers.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

DEFAULT_TIMEOUT_SECONDS = 10


class PluginError(RuntimeError):
    """Raised when Herdr or the surrounding environment cannot serve a request."""


def run(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    """Run argv to completion, mapping spawn failure and timeout to codes.

    A missing binary yields exit code 127 and a timeout yields 124, so
    callers can treat both as ordinary failed commands.
    """
    environment = os.environ.copy()
    # Git must never stop to prompt, and gh must never page or prompt.
    environment.setdefault("GIT_TERMINAL_PROMPT", "0")
    environment.setdefault("GH_PAGER", "cat")
    environment.setdefault("GH_PROMPT_DISABLED", "1")

    try:
        return subprocess.run(
            list(argv),
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        return subprocess.CompletedProcess(list(argv), 127, "", str(error))
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(
            list(argv),
            124,
            "",
            f"timed out after {timeout} seconds",
        )


def herdr_path() -> str:
    return os.environ.get("HERDR_BIN_PATH", "herdr")


def herdr(*args: str) -> subprocess.CompletedProcess[str]:
    return run([herdr_path(), *args])


def herdr_json(args: Sequence[str]) -> dict[str, Any]:
    """Run a `herdr` command and unwrap its result envelope."""
    call = " ".join(["herdr", *args])

    result = herdr(*args)
    if result.returncode != 0:
        raise PluginError(
            f"{call} failed: {result.stderr.strip() or result.stdout.strip()}"
        )

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PluginError(f"herdr returned invalid JSON: {error}") from error
    if not isinstance(envelope, dict):
        raise PluginError(f"{call} returned an unexpected response")

    if "error" in envelope:
        error = envelope["error"]
        message = (
            error.get("message", str(error))
            if isinstance(error, dict)
            else str(error)
        )
        raise PluginError(f"{call} failed: {message}")

    value = envelope.get("result", envelope)
    if not isinstance(value, dict):
        raise PluginError(f"{call} returned an unexpected response")
    return value


def notify(title: str, body: str) -> None:
    """Show a Herd notification; a failed notification is logged, not fatal."""
    result = herdr("notification", "show", title, "--body", body)
    if result.returncode != 0:
        print(
            f"notification failed: {result.stderr.strip() or result.stdout.strip()}",
            file=sys.stderr,
        )


def workspace_id_from_context() -> str | None:
    """Return the workspace id Herdr injected for this invocation, if any."""
    value = os.environ.get("HERDR_WORKSPACE_ID")
    if value:
        return value

    raw_context = os.environ.get("HERDR_PLUGIN_CONTEXT_JSON")
    if not raw_context:
        return None
    try:
        context = json.loads(raw_context)
    except json.JSONDecodeError:
        return None
    value = context.get("workspace_id") if isinstance(context, dict) else None
    return value if isinstance(value, str) and value else None


@dataclass(frozen=True)
class WorkspaceRef:
    """The validated subset of a workspace payload every plugin relies on."""

    workspace_id: str
    label: str
    worktree: dict[str, Any] | None


def _workspace_ref(info: Any) -> WorkspaceRef | None:
    if not isinstance(info, dict):
        return None
    workspace_id = info.get("workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        return None
    label = info.get("label")
    if not isinstance(label, str) or not label:
        label = workspace_id
    worktree = info.get("worktree")
    return WorkspaceRef(
        workspace_id,
        label,
        worktree if isinstance(worktree, dict) else None,
    )


def workspace_list() -> list[WorkspaceRef]:
    """Return validated refs for every workspace; malformed entries are skipped."""
    infos = herdr_json(["workspace", "list"]).get("workspaces", [])
    if not isinstance(infos, list):
        raise PluginError("herdr workspace list returned no workspace list")
    return [
        ref for info in infos if (ref := _workspace_ref(info)) is not None
    ]


def workspace_get(workspace_id: str) -> WorkspaceRef:
    """Return the validated ref for one workspace."""
    info = herdr_json(["workspace", "get", workspace_id]).get("workspace")
    ref = _workspace_ref(info)
    if ref is None:
        raise PluginError(f"workspace {workspace_id} was not found")
    return ref


def git_run(
    repo: Path,
    args: Sequence[str],
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], cwd=repo, timeout=timeout)


def git_text(repo: Path, args: Sequence[str]) -> str | None:
    result = git_run(repo, args)
    return result.stdout.strip() if result.returncode == 0 else None


def git_repo(path: Path | None) -> Path | None:
    """Return the working-tree root at path, or None when it is not a repo."""
    if path is None or not path.is_dir():
        return None

    result = git_run(path, ["rev-parse", "--show-toplevel"], timeout=5)
    if result.returncode != 0:
        return None

    root_text = result.stdout.strip()
    if not root_text:
        return None
    root = Path(root_text)
    return root if root.is_dir() else None
