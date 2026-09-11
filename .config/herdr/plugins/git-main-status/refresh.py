#!/usr/bin/env python3
"""Fetch upstream refs and safely pull open checkouts.

The plugin refreshes the focused workspace whenever focus changes, and every
open workspace once at startup. A repository is fetched once, then its
checkout advances onto the tracking branch: fast-forward when possible,
otherwise a rebase of the local commits. A checkout only moves when the
update applies cleanly; dirty worktrees, conflicting rebases, and
in-progress operations are left alone and reported as skipped.
"""

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
    workspace_get,
    workspace_id_from_context,
    workspace_list,
)

FETCH_TIMEOUT_SECONDS = 20
PULL_TIMEOUT_SECONDS = 60


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
        repo = git_repo(ref.checkout_path)

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


def has_tracked_changes(repo: Path) -> bool:
    """Return True when staged, unstaged, or unmerged changes exist."""
    result = git_run(
        repo, ["status", "--porcelain", "--untracked-files=no"], timeout=5
    )
    if result.returncode != 0:
        return True
    return bool(result.stdout.strip())


def operation_in_progress(repo: Path) -> str | None:
    """Name an in-progress merge-like operation, if the checkout has one."""
    for ref in ("MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"):
        check = git_run(
            repo, ["rev-parse", "--verify", "--quiet", ref], timeout=5
        )
        if check.returncode == 0:
            name = ref.replace("_HEAD", "").lower().replace("_", " ")
            return f"{name} in progress"
    for state in ("rebase-merge", "rebase-apply"):
        resolved = git_run(
            repo, ["rev-parse", "--git-path", state], timeout=5
        )
        if resolved.returncode != 0:
            continue
        if (repo / resolved.stdout.strip()).exists():
            return "rebase in progress"
    return None


def ahead_behind(repo: Path) -> tuple[int, int] | None:
    """Return (ahead, behind) commit counts against the tracking branch."""
    text = git_text(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])
    if not text:
        return None
    counts = text.split()
    if len(counts) != 2:
        return None
    try:
        return int(counts[0]), int(counts[1])
    except ValueError:
        return None


def shorten_error(message: str, limit: int = 160) -> str:
    """Compress multi-line Git stderr down to one readable line."""
    for line in message.splitlines():
        line = line.strip()
        if line.startswith("error: "):
            line = line[len("error: "):].strip()
        if line:
            return line if len(line) <= limit else line[: limit - 1] + "…"
    return "update failed"


def abort_rebase(repo: Path) -> None:
    git_run(repo, ["rebase", "--abort"], timeout=10)


def pull_checkout(repo: Path) -> str | None:
    """Advance one checkout onto its tracking branch when it is safe.

    Returns None when the checkout was updated or there is nothing to do
    (already current, no upstream, no commits yet). Returns a short reason
    when it was left untouched and a human should look. Only hard failures
    raise PluginError.
    """
    if not git_text(repo, ["branch", "--show-current"]):
        return "detached HEAD"
    if (
        git_text(repo, ["rev-parse", "--verify", "--symbolic-full-name", "@{u}"])
        is None
    ):
        return None
    busy = operation_in_progress(repo)
    if busy is not None:
        return busy
    if has_tracked_changes(repo):
        return "uncommitted changes"
    if git_text(repo, ["rev-parse", "--verify", "HEAD"]) is None:
        return None

    counts = ahead_behind(repo)
    if counts is None:
        raise PluginError("could not compare with upstream")
    ahead, behind = counts
    if behind == 0:
        return None

    if ahead == 0:
        fast_forward = git_run(
            repo,
            ["merge", "--ff-only", "--quiet", "@{u}"],
            timeout=PULL_TIMEOUT_SECONDS,
        )
        if fast_forward.returncode != 0:
            message = fast_forward.stderr.strip() or fast_forward.stdout.strip()
            raise PluginError(
                shorten_error(message) if message else "fast-forward failed"
            )
        return None

    rebased = git_run(
        repo,
        ["rebase", "--autostash", "@{u}"],
        timeout=PULL_TIMEOUT_SECONDS,
    )
    if rebased.returncode == 0:
        return None
    abort_rebase(repo)
    message = rebased.stderr.strip() or rebased.stdout.strip()
    detail = shorten_error(message) if message else "automatic rebase failed"
    return f"needs manual rebase ({detail})"


def refresh(workspaces: Sequence[Workspace]) -> int:
    failures: list[str] = []
    skipped: list[str] = []
    # Fetch state per shared repository: target -> failure message or None.
    # Pulls run per checkout (each worktree tracks its own branch), while
    # fetches are deduplicated per shared repository.
    fetched: dict[tuple[Path, str], str | None] = {}
    seen_checkouts: set[Path] = set()

    for workspace in workspaces:
        if workspace.error:
            failures.append(f"{workspace.label}: {workspace.error}")
            continue
        repo = workspace.repo
        if repo is None:
            continue
        try:
            key = repo.resolve()
        except OSError:
            continue
        if key in seen_checkouts:
            continue
        seen_checkouts.add(key)

        try:
            remote = upstream_remote(repo)
            if remote is not None:
                target = (repository_identity(repo), remote)
                if target not in fetched:
                    try:
                        fetch_repo(repo, remote)
                    except (PluginError, OSError) as error:
                        fetched[target] = str(error)
                        failures.append(f"{workspace.label}: {error}")
                    else:
                        fetched[target] = None
                if fetched[target] is not None:
                    continue
            reason = pull_checkout(repo)
        except (PluginError, OSError) as error:
            failures.append(f"{workspace.label}: {error}")
            continue
        if reason is not None:
            skipped.append(f"{workspace.label}: {reason}")

    details = failures + [f"skipped {entry}" for entry in skipped]
    if details:
        print("\n".join(details), file=sys.stderr)
        return 1 if failures else 0
    return 0


USAGE = "usage: refresh.py refresh-all | refresh-workspace"


def main(argv: Sequence[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(USAGE)
        return 0
    if len(argv) != 1:
        raise PluginError(f"unexpected arguments: {' '.join(argv[1:])}")

    action = argv[0]
    if action == "refresh-workspace":
        workspace_id = workspace_id_from_context()
        if not workspace_id:
            raise PluginError("workspace event did not include a workspace id")
        return refresh([workspace_record(workspace_get(workspace_id))])
    if action == "refresh-all":
        return refresh(all_workspaces())
    raise PluginError(f"unknown action: {action}")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"git-main-status: {error}", file=sys.stderr)
        raise SystemExit(1)
