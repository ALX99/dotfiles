#!/usr/bin/env python3
"""Fetch upstream Git refs so Herdr can render its native Git status."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


FETCH_TIMEOUT_SECONDS = 20
COMMAND_TIMEOUT_SECONDS = 10


class PluginError(RuntimeError):
    """Raised when the plugin cannot complete a refresh."""


@dataclass(frozen=True)
class Workspace:
    label: str
    repo: Optional[Path]


def command(
    argv: Sequence[str],
    *,
    cwd: Optional[Path] = None,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.setdefault("GIT_TERMINAL_PROMPT", "0")

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


def herdr_binary() -> str:
    return os.environ.get("HERDR_BIN_PATH", "herdr")


def herdr_json(args: Sequence[str]) -> Dict[str, Any]:
    result = command([herdr_binary(), *args])
    if result.returncode != 0:
        raise PluginError(
            f"herdr {' '.join(args)} failed: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PluginError(f"herdr returned invalid JSON: {error}") from error

    if not isinstance(envelope, dict):
        raise PluginError(f"herdr {' '.join(args)} returned an unexpected response")

    if "error" in envelope:
        error = envelope["error"]
        message = (
            error.get("message", str(error))
            if isinstance(error, dict)
            else str(error)
        )
        raise PluginError(f"herdr {' '.join(args)} failed: {message}")

    value = envelope.get("result", envelope)
    if not isinstance(value, dict):
        raise PluginError(f"herdr {' '.join(args)} returned an unexpected response")
    return value


def git_command(
    repo: Path,
    args: Sequence[str],
    *,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    return command(["git", *args], cwd=repo, timeout=timeout)


def git_text(repo: Path, args: Sequence[str]) -> Optional[str]:
    result = git_command(repo, args)
    return result.stdout.strip() if result.returncode == 0 else None


def git_repo(path: Optional[Path]) -> Optional[Path]:
    if path is None or not path.is_dir():
        return None

    result = git_command(path, ["rev-parse", "--show-toplevel"], timeout=5)
    if result.returncode != 0:
        return None

    root_text = result.stdout.strip()
    if not root_text:
        return None

    root = Path(root_text)
    return root if root.is_dir() else None


def repository_identity(repo: Path) -> Path:
    common_dir = git_text(repo, ["rev-parse", "--git-common-dir"])
    if common_dir:
        common_path = Path(common_dir)
        if not common_path.is_absolute():
            common_path = repo / common_path
        return common_path.resolve()
    return repo.resolve()


def pane_repo(workspace_id: str) -> Optional[Path]:
    payload = herdr_json(["pane", "list", "--workspace", workspace_id])
    panes = payload.get("panes", [])
    if not isinstance(panes, list):
        raise PluginError("herdr pane list returned no pane list")

    for pane in panes:
        if not isinstance(pane, dict):
            continue
        for key in ("foreground_cwd", "cwd"):
            value = pane.get(key)
            if isinstance(value, str) and value:
                repo = git_repo(Path(value))
                if repo:
                    return repo
    return None


def workspace_from_info(info: Dict[str, Any]) -> Workspace:
    workspace_id = info.get("workspace_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        raise PluginError("herdr workspace data has no workspace id")

    label_value = info.get("label")
    if label_value is None:
        label = workspace_id
    elif isinstance(label_value, str):
        label = label_value or workspace_id
    else:
        raise PluginError(f"workspace {workspace_id} has an invalid label")

    repo: Optional[Path] = None
    worktree = info.get("worktree")
    if isinstance(worktree, dict):
        checkout_path = worktree.get("checkout_path")
        if isinstance(checkout_path, str) and checkout_path:
            repo = git_repo(Path(checkout_path))

    if repo is None:
        repo = pane_repo(workspace_id)

    return Workspace(label, repo)


def workspace_records() -> List[Workspace]:
    payload = herdr_json(["workspace", "list"])
    infos = payload.get("workspaces", [])
    if not isinstance(infos, list):
        raise PluginError("herdr workspace list returned no workspace list")

    workspaces: List[Workspace] = []
    for info in infos:
        if not isinstance(info, dict):
            continue
        if not info.get("workspace_id"):
            continue
        workspaces.append(workspace_from_info(info))
    return workspaces


def workspace_record(workspace_id: str) -> Workspace:
    payload = herdr_json(["workspace", "get", workspace_id])
    info = payload.get("workspace")
    if not isinstance(info, dict):
        raise PluginError(f"workspace {workspace_id} was not found")
    return workspace_from_info(info)


def current_workspace_id() -> Optional[str]:
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
    if not isinstance(context, dict):
        return None

    value = context.get("workspace_id")
    return value if isinstance(value, str) and value else None


def upstream_remote(repo: Path) -> Optional[str]:
    branch = git_text(repo, ["branch", "--show-current"])
    if branch:
        remote = git_text(repo, ["config", "--get", f"branch.{branch}.remote"])
        if remote == ".":
            return None
        if remote and git_text(repo, ["remote", "get-url", remote]):
            return remote

    return "origin" if git_text(repo, ["remote", "get-url", "origin"]) else None


def fetch_repo(repo: Path, remote: str) -> None:
    fetched = git_command(
        repo,
        ["fetch", "--quiet", "--no-tags", remote],
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    if fetched.returncode != 0:
        message = fetched.stderr.strip() or fetched.stdout.strip() or "git fetch failed"
        raise PluginError(message)


def show_notification(title: str, body: str) -> None:
    result = command(
        [
            herdr_binary(),
            "notification",
            "show",
            title,
            "--body",
            body,
        ]
    )
    if result.returncode != 0:
        print(
            f"notification failed: {result.stderr.strip() or result.stdout.strip()}",
            file=sys.stderr,
        )


def refresh(
    workspaces: Sequence[Workspace],
    *,
    notify: bool,
) -> int:
    failures: List[str] = []
    updated = 0
    seen_targets: set[Tuple[Path, str]] = set()

    for workspace in workspaces:
        repo = workspace.repo
        if repo is None:
            continue

        try:
            remote = upstream_remote(repo)
            if remote is None:
                continue

            target = (repository_identity(repo), remote)
            if target in seen_targets:
                continue
            seen_targets.add(target)
            fetch_repo(repo, remote)
        except (PluginError, OSError) as error:
            failures.append(f"{workspace.label}: {error}")
        else:
            updated += 1

    if notify:
        body = f"Refreshed {updated} repositories"
        if failures:
            body += f"; {len(failures)} failed"
        show_notification("Git status refreshed", body)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


def run(argv: Sequence[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print("usage: refresh.py refresh-all [--notify] | refresh-workspace")
        return 0

    action = argv[0]
    notify = "--notify" in argv[1:]
    if action == "refresh-all":
        if notify:
            show_notification(
                "Updating Git status",
                "Fetching open repositories...",
            )
        try:
            return refresh(workspace_records(), notify=notify)
        except (PluginError, OSError) as error:
            if notify:
                show_notification("Git status refresh failed", str(error))
            raise

    if action == "refresh-workspace":
        if notify:
            show_notification(
                "Updating Git status",
                "Fetching the focused repository...",
            )
        try:
            workspace_id = current_workspace_id()
            if not workspace_id:
                raise PluginError("workspace event did not include a workspace id")
            return refresh([workspace_record(workspace_id)], notify=notify)
        except (PluginError, OSError) as error:
            if notify:
                show_notification("Git status refresh failed", str(error))
            raise

    raise PluginError(f"unknown action: {action}")


if __name__ == "__main__":
    try:
        raise SystemExit(run(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"git-main-status: {error}", file=sys.stderr)
        raise SystemExit(1)
