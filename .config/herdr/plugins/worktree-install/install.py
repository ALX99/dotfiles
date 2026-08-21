#!/usr/bin/env python3
"""Install JavaScript dependencies in Herdr worktree workspaces.

When Herdr creates or opens a Git worktree, pick the package manager from
the lockfile (bun, then pnpm, then npm) and install in the worktree root,
or in frontend/ when the root has no package.json. Installs run detached
so slow registries never block the event hook; output is logged under the
plugin state directory and reported through Herdr notifications.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

HERDR_COMMAND_TIMEOUT_SECONDS = 10
INSTALL_TIMEOUT_SECONDS = 30 * 60

# Directories to probe relative to the worktree root, in order. The first
# directory containing package.json is the install location.
PROJECT_DIRS: Tuple[Tuple[str, str], ...] = ((".", "root"), ("frontend", "frontend"))

# Lockfiles per package manager, checked in priority order.
PACKAGE_MANAGERS: Tuple[Tuple[Tuple[str, ...], str], ...] = (
    (("bun.lockb", "bun.lock"), "bun"),
    (("pnpm-lock.yaml",), "pnpm"),
    (("package-lock.json", "npm-shrinkwrap.json"), "npm"),
)

INSTALL_ARGS: Dict[str, Tuple[str, ...]] = {
    "bun": ("install",),
    "pnpm": ("install",),
    "npm": ("ci",),
}

# Extra directories searched when a binary is not on PATH, because the
# Herdr server may run without a shell profile that activates mise, bun,
# or pnpm.
EXTRA_BIN_DIRS = (
    "~/.local/share/mise/shims",
    "~/.bun/bin",
    "~/.local/share/pnpm",
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
)

SCRIPT_PATH = Path(__file__).resolve()


class PluginError(RuntimeError):
    """Raised when Herdr or the checkout cannot provide what is needed."""


@dataclass(frozen=True)
class InstallPlan:
    directory: Path
    location: str
    package_manager: str
    binary: str

    @property
    def key(self) -> str:
        """Stable per-checkout identifier for lock and log file names."""
        return hashlib.sha256(str(self.directory).encode()).hexdigest()


def command(
    argv: Sequence[str],
    *,
    timeout: int = HERDR_COMMAND_TIMEOUT_SECONDS,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.setdefault("GIT_TERMINAL_PROMPT", "0")

    try:
        return subprocess.run(
            list(argv),
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

    if "error" in envelope:
        error = envelope["error"]
        message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        raise PluginError(f"herdr {' '.join(args)} failed: {message}")

    value = envelope.get("result", envelope)
    if not isinstance(value, dict):
        raise PluginError(f"herdr {' '.join(args)} returned an unexpected response")
    return value


def show_notification(title: str, body: str) -> None:
    result = command([herdr_binary(), "notification", "show", title, "--body", body])
    if result.returncode != 0:
        print(
            f"notification failed: {result.stderr.strip() or result.stdout.strip()}",
            file=sys.stderr,
        )


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


def worktree_checkout(workspace_id: str) -> Optional[Tuple[str, Path]]:
    """Return (label, checkout path) when the workspace is a linked worktree."""
    payload = herdr_json(["workspace", "get", workspace_id])
    info = payload.get("workspace")
    if not isinstance(info, dict):
        raise PluginError(f"workspace {workspace_id} was not found")

    worktree = info.get("worktree")
    if not isinstance(worktree, dict) or worktree.get("is_linked_worktree") is not True:
        return None

    label = str(info.get("label") or workspace_id)
    checkout_path = worktree.get("checkout_path")
    if not isinstance(checkout_path, str):
        return None
    path = Path(checkout_path)
    return (label, path) if path.is_dir() else None


def resolve_binary(name: str) -> Optional[str]:
    found = shutil.which(name)
    if found:
        return found
    for entry in EXTRA_BIN_DIRS:
        candidate = Path(entry).expanduser() / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def detect_plan(root: Path) -> Optional[InstallPlan]:
    """Pick the install directory and package manager for a checkout.

    Returns None when there is nothing to install. Raises PluginError when
    the matching package manager binary is missing.
    """
    for subdir, location in PROJECT_DIRS:
        directory = Path(os.path.normpath(str(root / subdir)))
        if not (directory / "package.json").is_file():
            continue
        # The first directory with package.json wins; an unrecognized
        # lockfile setup there is skipped instead of guessing a tool.
        for lockfiles, package_manager in PACKAGE_MANAGERS:
            if any((directory / lock).is_file() for lock in lockfiles):
                binary = resolve_binary(package_manager)
                if binary is None:
                    raise PluginError(
                        f"{location}/ uses {package_manager} but "
                        f"{package_manager} is not installed"
                    )
                return InstallPlan(directory, location, package_manager, binary)
        return None
    return None


def state_dir() -> Path:
    value = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    base = Path(value) if value else Path(tempfile.gettempdir()) / "herdr-worktree-install"
    return base


def log_file(plan: InstallPlan) -> Path:
    logs = state_dir() / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    return logs / f"{plan.key[:16]}.log"


def acquire_lock(plan: InstallPlan) -> Optional[int]:
    """Take the per-directory install lock; return its fd or None if held.

    Uses POSIX record locks (fcntl.lockf): they are released automatically
    when the owning process exits, so a crashed installer cannot leave a
    stale lock behind. The fd must stay open for as long as the install
    runs.
    """
    locks = state_dir() / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    fd = os.open(locks / f"{plan.key[:16]}.lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.lockf(fd, fcntl.LOCK_NB | fcntl.LOCK_EX)
    except OSError:
        os.close(fd)
        return None
    return fd


def run_install(plan: InstallPlan, destination: Path) -> Tuple[bool, str]:
    """Run the install synchronously, appending output to destination."""
    started = time.monotonic()
    argv = [plan.binary, *INSTALL_ARGS[plan.package_manager]]
    environment = os.environ.copy()
    environment["CI"] = "1"

    ok = False
    detail: str
    with open(destination, "a", encoding="utf-8") as log:
        log.write(
            f"# {time.strftime('%Y-%m-%dT%H:%M:%S')} "
            f"{' '.join(argv)}\n# directory: {plan.directory}\n\n"
        )
        log.flush()
        try:
            result = subprocess.run(
                argv,
                cwd=str(plan.directory),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=INSTALL_TIMEOUT_SECONDS,
            )
        except FileNotFoundError:
            detail = f"{plan.package_manager} disappeared before install"
        except subprocess.TimeoutExpired:
            detail = f"timed out after {INSTALL_TIMEOUT_SECONDS} seconds"
        else:
            ok = result.returncode == 0
            seconds = time.monotonic() - started
            detail = (
                f"finished in {seconds:.0f}s"
                if ok
                else f"exited {result.returncode}; log: {destination}"
            )
        log.write(f"\n# {'ok' if ok else 'failed'}: {detail}\n")
    return ok, detail


def perform_install(plan: InstallPlan, label: str, *, force: bool) -> Tuple[bool, str]:
    """Guarded, locked install. The single execution path for every mode."""
    if not force and (plan.directory / "node_modules").exists():
        return True, "already installed"

    lock_fd = acquire_lock(plan)
    if lock_fd is None:
        return True, "an install is already running"
    try:
        ok, detail = run_install(plan, log_file(plan))
    finally:
        os.close(lock_fd)

    title = "Worktree install finished" if ok else "Worktree install failed"
    show_notification(title, f"{label}: {plan.package_manager} install {detail}")
    return ok, detail


def spawn_worker(label: str, root: Path, *, force: bool) -> None:
    """Detach the install so slow registries never block the event hook.

    The worker re-detects the plan from the checkout root; detection is a
    cheap pure scan, so no plan state is passed across processes.
    """
    subprocess.Popen(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "_worker",
            str(root),
            label,
            "1" if force else "0",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        cwd="/",
    )


def install_in_workspace(*, force: bool) -> int:
    workspace_id = current_workspace_id()
    if not workspace_id:
        return 0

    try:
        checkout = worktree_checkout(workspace_id)
    except (PluginError, OSError) as error:
        show_notification("Worktree install failed", str(error))
        return 1
    if checkout is None:
        return 0
    label, root = checkout

    try:
        plan = detect_plan(root)
    except PluginError as error:
        show_notification("Worktree install failed", f"{label}: {error}")
        return 1
    if plan is None:
        return 0

    spawn_worker(label, root, force=force)
    return 0


def run_direct(directory: Path) -> int:
    """Install synchronously in an explicit directory without workspace lookup."""
    if not directory.is_dir():
        print(f"not a directory: {directory}", file=sys.stderr)
        return 2

    try:
        plan = detect_plan(directory)
    except PluginError as error:
        print(f"worktree-install: {error}", file=sys.stderr)
        return 1
    if plan is None:
        print(f"worktree-install: no installable JavaScript project in {directory}",
              file=sys.stderr)
        return 1

    ok, detail = perform_install(plan, directory.name, force=True)
    print(f"{'ok' if ok else 'failed'}: {detail}\nlog: {log_file(plan)}")
    return 0 if ok else 1


def run_worker_command(argv: Sequence[str]) -> int:
    if len(argv) != 3:
        raise PluginError("usage: install.py _worker <checkout-root> <label> <force>")
    root, label, force = Path(argv[0]), argv[1], argv[2] == "1"

    plan = detect_plan(root)
    if plan is None:
        return 0
    ok, _ = perform_install(plan, label, force=force)
    return 0 if ok else 1


def run(argv: Sequence[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print("usage: install.py auto | install | run <directory>")
        return 0

    mode = argv[0]
    if mode == "auto":
        return install_in_workspace(force=False)
    if mode == "install":
        return install_in_workspace(force=True)
    if mode == "run":
        if len(argv) != 2:
            print("usage: install.py run <directory>", file=sys.stderr)
            return 2
        return run_direct(Path(argv[1]).expanduser())
    if mode == "_worker":
        return run_worker_command(argv[1:])
    raise PluginError(f"unknown action: {mode}")


if __name__ == "__main__":
    try:
        raise SystemExit(run(sys.argv[1:]))
    except (PluginError, OSError) as error:
        print(f"worktree-install: {error}", file=sys.stderr)
        raise SystemExit(1)
