#!/usr/bin/env python3
"""Fetch upstream Git refs so Herdr can render its native Git status."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

_SHARED = Path(__file__).resolve().parent.parent / "_shared"
sys.path.insert(0, str(_SHARED))

from herdrlib import (  # noqa: E402
    PluginError,
    WorkspaceRef,
    git_run,
    git_repo,
    git_text,
    herdr_json,
    notify,
    workspace_get,
    workspace_id_from_context,
    workspace_list,
)

FETCH_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class Workspace:
    label: str
    repo: Path | None
    error: str | None = None


def repository_identity(repo: Path) -> Path:
    """Return the shared Git directory so worktrees of one repo deduplicate."""
    common_dir = git_text(repo, ["rev-parse", "--git-common-dir"])
    if common_dir:
        common_path = Path(common_dir)
        if not common_path.is_absolute():
            common_path = repo / common_path
        return common_path.resolve()
    return repo.resolve()


def pane_repo(workspace_id: str) -> Path | None:
    panes = herdr_json(["pane", "list", "--workspace", workspace_id]).get("panes", [])
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


def workspace_record(ref: WorkspaceRef) -> Workspace:
    """Resolve the repository a workspace is anchored to.

    Workspaces report their worktree checkout when they have one; otherwise
    the panes' current directories are probed for a repository.
    """
    try:
        repo: Path | None = None
        checkout_path = ref.worktree.get("checkout_path") if ref.worktree else None
        if isinstance(checkout_path, str) and checkout_path:
            repo = git_repo(Path(checkout_path))

        if repo is None:
            repo = pane_repo(ref.workspace_id)
    except (PluginError, OSError) as error:
        return Workspace(ref.label, None, str(error))
    return Workspace(ref.label, repo)


def all_workspaces() -> list[Workspace]:
    return [workspace_record(ref) for ref in workspace_list()]


def upstream_remote(repo: Path) -> str | None:
    branch = git_text(repo, ["branch", "--show-current"])
    if branch:
        remote = git_text(repo, ["config", "--get", f"branch.{branch}.remote"])
        if remote == ".":
            return None
        if remote and git_text(repo, ["remote", "get-url", remote]):
            return remote

    return "origin" if git_text(repo, ["remote", "get-url", "origin"]) else None


def fetch_repo(repo: Path, remote: str) -> None:
    fetched = git_run(
        repo,
        ["fetch", "--quiet", "--no-tags", remote],
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    if fetched.returncode != 0:
        message = fetched.stderr.strip() or fetched.stdout.strip() or "git fetch failed"
        raise PluginError(message)


def refresh(workspaces: Sequence[Workspace], *, notify_user: bool) -> int:
    failures: list[str] = []
    updated = 0
    seen_targets: set[tuple[Path, str]] = set()

    for workspace in workspaces:
        if workspace.error:
            failures.append(f"{workspace.label}: {workspace.error}")
            continue

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

    if notify_user:
        body = f"Refreshed {updated} repositories"
        if failures:
            body += f"; {len(failures)} failed"
        notify("Git status refreshed", body)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


USAGE = "usage: refresh.py refresh-all [--notify] | refresh-workspace"


def main(argv: Sequence[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(USAGE)
        return 0

    action = argv[0]
    notify_user = "--notify" in argv[1:]
    if action not in {"refresh-all", "refresh-workspace"}:
        raise PluginError(f"unknown action: {action}")

    if notify_user:
        progress = (
            "Fetching open repositories..."
            if action == "refresh-all"
            else "Fetching the focused repository..."
        )
        notify("Updating Git status", progress)

    try:
        if action == "refresh-workspace":
            workspace_id = workspace_id_from_context()
            if not workspace_id:
                raise PluginError("workspace event did not include a workspace id")
            workspaces = [workspace_record(workspace_get(workspace_id))]
        else:
            workspaces = all_workspaces()
        return refresh(workspaces, notify_user=notify_user)
    except (PluginError, OSError) as error:
        if notify_user:
            notify("Git status refresh failed", str(error))
        raise


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"git-main-status: {error}", file=sys.stderr)
        raise SystemExit(1)
