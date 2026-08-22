#!/usr/bin/env python3
"""Report GitHub pull-request status for Herdr worktree spaces."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

_SHARED = Path(__file__).resolve().parent.parent / "_shared"
sys.path.insert(0, str(_SHARED))

from herdrlib import (  # noqa: E402
    PluginError,
    WorkspaceRef,
    git_repo,
    git_text,
    herdr,
    notify,
    run,
    workspace_get,
    workspace_id_from_context,
    workspace_list,
)

GITHUB_TIMEOUT_SECONDS = 20
GITHUB_PR_LIMIT = 100
METADATA_SOURCE = "dozy.git-pr-status"
STATUS_TOKENS = ("pr_draft", "pr_open", "pr_merged", "pr_closed")


@dataclass(frozen=True)
class Workspace:
    workspace_id: str
    label: str
    repo: Path | None
    branch: str | None
    linked_worktree: bool


@dataclass(frozen=True)
class PullRequest:
    number: int
    state: str
    is_draft: bool
    merged_at: str | None
    updated_at: str


def github_binary() -> str:
    return os.environ.get("GH_BIN_PATH", "gh")


def workspace_record(ref: WorkspaceRef) -> Workspace:
    """Resolve the linked worktree checkout and its current branch."""
    worktree = ref.worktree or {}
    linked_worktree = worktree.get("is_linked_worktree") is True

    repo: Path | None = None
    if linked_worktree:
        checkout_path = worktree.get("checkout_path")
        if isinstance(checkout_path, str) and checkout_path:
            repo = git_repo(Path(checkout_path))

    branch = git_text(repo, ["branch", "--show-current"]) if repo else None
    return Workspace(ref.workspace_id, ref.label, repo, branch, linked_worktree)


def pull_requests(workspace: Workspace) -> list[PullRequest]:
    if workspace.repo is None or workspace.branch is None:
        return []

    result = run(
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
        timeout=GITHUB_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise PluginError(
            result.stderr.strip() or result.stdout.strip() or "gh pr list failed"
        )

    try:
        values = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PluginError(f"gh returned invalid JSON: {error}") from error
    if not isinstance(values, list):
        raise PluginError("gh pr list returned an unexpected response")

    requests: list[PullRequest] = []
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


def latest_pull_request(requests: Sequence[PullRequest]) -> PullRequest | None:
    """Prefer an open PR; break ties by recency."""
    if not requests:
        return None

    return max(
        requests,
        key=lambda request: (request.state == "OPEN", request.updated_at),
    )


def open_pull_request(workspace: Workspace) -> PullRequest:
    if workspace.repo is None or workspace.branch is None:
        raise PluginError(
            f"{workspace.label}: no Git repository is associated with this workspace"
        )

    request = latest_pull_request(pull_requests(workspace))
    if request is None:
        raise PluginError(
            f"{workspace.label}: no GitHub pull request found for branch {workspace.branch}"
        )

    result = run(
        [github_binary(), "pr", "view", str(request.number), "--web"],
        cwd=workspace.repo,
        timeout=GITHUB_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise PluginError(
            result.stderr.strip() or result.stdout.strip() or "gh pr view failed"
        )
    return request


def status_token(request: PullRequest | None) -> tuple[str | None, str | None]:
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


def report_status(
    workspace: Workspace, token: str | None, value: str | None
) -> None:
    args = [
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

    result = herdr(*args)
    if result.returncode != 0:
        raise PluginError(
            result.stderr.strip() or result.stdout.strip() or "metadata update failed"
        )


def refresh_workspace(workspace: Workspace) -> tuple[bool, str | None]:
    """Update one workspace's tokens; returns (checked, failure message).

    Only workspaces with a real PR lookup count as checked; workspaces
    outside Git worktrees just get their stale tokens cleared.
    """
    if not workspace.linked_worktree or workspace.repo is None or workspace.branch is None:
        try:
            report_status(workspace, None, None)
        except (PluginError, OSError) as error:
            return False, f"{workspace.label}: {error}"
        return False, None

    try:
        request = latest_pull_request(pull_requests(workspace))
        token, value = status_token(request)
        report_status(workspace, token, value)
    except (PluginError, OSError) as error:
        return False, f"{workspace.label}: {error}"
    return True, None


def refresh(workspaces: Sequence[Workspace], *, notify_user: bool) -> int:
    failures: list[str] = []
    checked = 0

    for workspace in workspaces:
        did_check, failure = refresh_workspace(workspace)
        if did_check:
            checked += 1
        if failure:
            failures.append(failure)

    if notify_user:
        body = f"Checked {checked} worktrees"
        if failures:
            body += f"; {len(failures)} unavailable"
        notify("PR status refreshed", body)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


USAGE = "usage: refresh.py refresh-all [--notify] | refresh-workspace | open"


def context_workspaces(action: str) -> list[Workspace]:
    """Resolve the workspaces a refresh action covers."""
    if action == "refresh-all":
        refs: Sequence[WorkspaceRef] = workspace_list()
    else:
        workspace_id = workspace_id_from_context()
        if not workspace_id:
            raise PluginError("workspace event did not include a workspace id")
        refs = [workspace_get(workspace_id)]
    return [workspace_record(ref) for ref in refs]


def open_action() -> int:
    workspace_id = workspace_id_from_context()
    if not workspace_id:
        raise PluginError("workspace action did not include a workspace id")

    try:
        workspace = workspace_record(workspace_get(workspace_id))
        request = open_pull_request(workspace)
    except (PluginError, OSError) as error:
        notify("Open GitHub PR failed", str(error))
        raise

    notify("Opened GitHub PR", f"{workspace.label}: #{request.number}")
    return 0


def main(argv: Sequence[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(USAGE)
        return 0

    action = argv[0]
    notify_user = "--notify" in argv[1:]

    if action == "open":
        return open_action()
    if action not in {"refresh-all", "refresh-workspace"}:
        raise PluginError(f"unknown action: {action}")

    if notify_user:
        progress = (
            "Checking open worktrees..."
            if action == "refresh-all"
            else "Checking the focused worktree..."
        )
        notify("Checking PR status", progress)

    try:
        return refresh(context_workspaces(action), notify_user=notify_user)
    except (PluginError, OSError) as error:
        if notify_user:
            notify("PR status refresh failed", str(error))
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"git-pr-status: {error}", file=sys.stderr)
        raise SystemExit(1)
