#!/usr/bin/env python3
"""Report GitHub pull-request status for Herdr worktree spaces."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


HERDR_COMMAND_TIMEOUT_SECONDS = 10
GITHUB_COMMAND_TIMEOUT_SECONDS = 20
GITHUB_PR_LIMIT = 100
METADATA_SOURCE = "dozy.git-pr-status"
STATUS_TOKENS = ("pr_draft", "pr_open", "pr_merged", "pr_closed")


class PluginError(RuntimeError):
    """Raised when Herdr or GitHub cannot provide workspace data."""


@dataclass
class Workspace:
    workspace_id: str
    label: str
    repo: Optional[Path]
    branch: Optional[str]
    linked_worktree: bool


@dataclass
class PullRequest:
    number: int
    state: str
    is_draft: bool
    merged_at: Optional[str]
    updated_at: str


def command(
    argv: Sequence[str],
    *,
    cwd: Optional[Path] = None,
    timeout: int = HERDR_COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
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


def herdr_binary() -> str:
    return os.environ.get("HERDR_BIN_PATH", "herdr")


def github_binary() -> str:
    return os.environ.get("GH_BIN_PATH", "gh")


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

    if "error" in envelope:
        error = envelope["error"]
        message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        raise PluginError(f"herdr {' '.join(args)} failed: {message}")

    value = envelope.get("result", envelope)
    if not isinstance(value, dict):
        raise PluginError(f"herdr {' '.join(args)} returned an unexpected response")
    return value


def git_command(
    repo: Path,
    args: Sequence[str],
    *,
    timeout: int = HERDR_COMMAND_TIMEOUT_SECONDS,
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

    root = Path(result.stdout.strip())
    return root if root.is_dir() else None


def workspace_from_info(info: Dict[str, Any]) -> Workspace:
    workspace_id = str(info["workspace_id"])
    label = str(info.get("label") or workspace_id)
    worktree = info.get("worktree")
    linked_worktree = False
    repo: Optional[Path] = None

    if isinstance(worktree, dict):
        linked_worktree = worktree.get("is_linked_worktree") is True
        checkout_path = worktree.get("checkout_path")
        if linked_worktree and isinstance(checkout_path, str):
            repo = git_repo(Path(checkout_path))

    branch = git_text(repo, ["branch", "--show-current"]) if repo else None
    return Workspace(workspace_id, label, repo, branch, linked_worktree)


def workspace_records() -> List[Workspace]:
    payload = herdr_json(["workspace", "list"])
    infos = payload.get("workspaces", [])
    if not isinstance(infos, list):
        raise PluginError("herdr workspace list returned no workspace list")

    return [
        workspace_from_info(info)
        for info in infos
        if isinstance(info, dict) and info.get("workspace_id")
    ]


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
    value = context.get("workspace_id") if isinstance(context, dict) else None
    return value if isinstance(value, str) and value else None


def pull_requests(workspace: Workspace) -> List[PullRequest]:
    if workspace.repo is None or workspace.branch is None:
        return []

    result = command(
        [
            github_binary(),
            "pr",
            "list",
            "--state",
            "all",
            "--head",
            workspace.branch,
            "--json",
            "number,state,isDraft,mergedAt,updatedAt",
            "--limit",
            str(GITHUB_PR_LIMIT),
        ],
        cwd=workspace.repo,
        timeout=GITHUB_COMMAND_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise PluginError(result.stderr.strip() or result.stdout.strip() or "gh pr list failed")

    try:
        values = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PluginError(f"gh returned invalid JSON: {error}") from error
    if not isinstance(values, list):
        raise PluginError("gh pr list returned an unexpected response")

    requests: List[PullRequest] = []
    for value in values:
        if not isinstance(value, dict):
            raise PluginError("gh pr list returned an invalid pull request")
        number = value.get("number")
        state = value.get("state")
        is_draft = value.get("isDraft")
        merged_at = value.get("mergedAt")
        updated_at = value.get("updatedAt")
        if (
            not isinstance(number, int)
            or not isinstance(state, str)
            or not isinstance(is_draft, bool)
            or (merged_at is not None and not isinstance(merged_at, str))
            or not isinstance(updated_at, str)
        ):
            raise PluginError("gh pr list returned an invalid pull request")
        requests.append(PullRequest(number, state, is_draft, merged_at, updated_at))
    return requests


def latest_pull_request(requests: Sequence[PullRequest]) -> Optional[PullRequest]:
    if not requests:
        return None

    return max(
        requests,
        key=lambda request: (request.state == "OPEN", request.updated_at),
    )


def status_token(request: Optional[PullRequest]) -> Tuple[Optional[str], Optional[str]]:
    if request is None:
        return None, None
    if request.state == "OPEN":
        token = "pr_draft" if request.is_draft else "pr_open"
        label = "draft" if request.is_draft else "open"
    elif request.merged_at:
        token = "pr_merged"
        label = "merged"
    else:
        token = "pr_closed"
        label = "closed"
    return token, f"{label} #{request.number}"


def report_status(workspace: Workspace, token: Optional[str], value: Optional[str]) -> None:
    args = [
        herdr_binary(),
        "workspace",
        "report-metadata",
        workspace.workspace_id,
        "--source",
        METADATA_SOURCE,
    ]
    for status_token_name in STATUS_TOKENS:
        args.extend(["--clear-token", status_token_name])
    if token is not None and value is not None:
        args.extend(["--token", f"{token}={value}"])

    result = command(args)
    if result.returncode != 0:
        raise PluginError(
            result.stderr.strip() or result.stdout.strip() or "metadata update failed"
        )


def refresh_workspace(workspace: Workspace) -> Tuple[bool, Optional[str]]:
    if not workspace.linked_worktree or workspace.repo is None or workspace.branch is None:
        try:
            report_status(workspace, None, None)
        except PluginError as error:
            return False, f"{workspace.label}: {error}"
        return False, None

    try:
        request = latest_pull_request(pull_requests(workspace))
        token, value = status_token(request)
        report_status(workspace, token, value)
    except PluginError as error:
        return False, f"{workspace.label}: {error}"

    return True, None


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
    checked = 0

    for workspace in workspaces:
        did_check, failure = refresh_workspace(workspace)
        if did_check:
            checked += 1
        if failure:
            failures.append(failure)

    if notify:
        body = f"Checked {checked} worktrees"
        if failures:
            body += f"; {len(failures)} unavailable"
        show_notification("PR status refreshed", body)
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
            show_notification("Checking PR status", "Checking open worktrees...")
        try:
            workspaces = workspace_records()
            return refresh(workspaces, notify=notify)
        except (PluginError, OSError) as error:
            if notify:
                show_notification("PR status refresh failed", str(error))
            raise

    if action == "refresh-workspace":
        workspace_id = current_workspace_id()
        if not workspace_id:
            raise PluginError("workspace event did not include a workspace id")
        if notify:
            show_notification("Checking PR status", "Checking the focused worktree...")
        try:
            workspace = workspace_record(workspace_id)
            return refresh([workspace], notify=notify)
        except (PluginError, OSError) as error:
            if notify:
                show_notification("PR status refresh failed", str(error))
            raise

    raise PluginError(f"unknown action: {action}")


if __name__ == "__main__":
    try:
        raise SystemExit(run(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"git-pr-status: {error}", file=sys.stderr)
        raise SystemExit(1)
