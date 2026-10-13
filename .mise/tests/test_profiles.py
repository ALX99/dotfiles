import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dotfiles-profiles-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.env = os.environ.copy()
        for name in list(self.env):
            if name.startswith(("GIT_", "MISE_")) or name in (
                "EMAIL",
                "XDG_RUNTIME_DIR",
                "__dotfiles_mise_env",
            ):
                del self.env[name]
        self.env.update(
            HOME=str(self.home),
            XDG_CONFIG_HOME=str(self.home / ".config"),
            XDG_CACHE_HOME=str(self.home / ".cache"),
            XDG_DATA_HOME=str(self.home / ".local/share"),
            XDG_STATE_HOME=str(self.home / ".state"),
            BASH_ENV="/dev/null",
            GIT_CONFIG_NOSYSTEM="1",
        )
        # The real installer and Stow run against an isolated home. Host plugin
        # registration and desktop startup are outside the profile contract.
        commands = self.home / "test-bin"
        commands.mkdir()
        (commands / "herdr").symlink_to(shutil.which("true"))
        (commands / "uwsm").symlink_to(shutil.which("false"))
        self.env["PATH"] = f"{commands}:{self.env['PATH']}"

    def run_command(self, command, *, cwd=REPO, env=None, success=True):
        result = subprocess.run(
            command,
            cwd=cwd,
            env=self.env if env is None else env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def install(self, *arguments, success=True):
        return self.run_command(
            ["bash", str(REPO / ".mise/tasks/install"), *arguments], success=success
        )

    def shell_profile(self, **overrides):
        env = self.env | overrides
        result = self.run_command(
            [
                "sh",
                "-c",
                '. "$HOME/.profile"; printf "%s|%s" "$DOTFILES_PROFILE" "${MISE_ENV-unset}"',
            ],
            env=env,
        )
        return result.stdout

    def identity(self, key, *, success=True):
        return self.run_command(
            ["git", "config", "--global", "--includes", "--get", f"user.{key}"],
            success=success,
        ).stdout.strip()

    def test_new_machine_defaults_to_base_without_a_personal_identity(self):
        self.install()
        self.assertEqual(self.shell_profile(), "base|unset")
        self.assertFalse((self.home / ".gitconfig.personal").exists())
        self.assertFalse((self.home / ".config/mise/mise.personal.toml").exists())
        self.identity("name", success=False)
        self.identity("email", success=False)
        self.assertTrue((self.home / ".agents/skills/go-code").is_symlink())
        self.assertTrue((self.home / ".config/nvim/init.lua").is_file())
        project = self.home / "project"
        project.mkdir()
        self.run_command(["git", "init", "--quiet", str(project)])
        result = self.run_command(
            ["git", "var", "GIT_AUTHOR_IDENT"], cwd=project, success=False
        )
        self.assertIn("auto-detection is disabled", result.stderr)

    def test_personal_is_opt_in_and_remembered_on_reinstall(self):
        self.install("personal")
        self.install()
        self.assertEqual(self.shell_profile(), "personal|personal")
        self.assertEqual(self.shell_profile(MISE_ENV="linux"), "personal|linux")
        self.assertEqual(self.identity("name"), "ALX99")
        self.assertEqual(
            self.identity("email"), "46844683+ALX99@users.noreply.github.com"
        )
        self.assertTrue((self.home / ".gitconfig.personal").is_symlink())
        self.assertTrue((self.home / ".config/mise/mise.personal.toml").is_symlink())

    def test_switching_to_base_removes_personal_links_and_keeps_local_settings(self):
        self.install("personal")
        local = self.home / ".gitconfig.local"
        local.write_text('[includeIf "gitdir:~/work/"]\n  path = ~/.gitconfig.work\n')
        work = self.home / ".gitconfig.work"
        work.write_text("[user]\n  name = Work Name\n  email = work@example.com\n")
        project = self.home / "work/project"
        project.mkdir(parents=True)
        self.run_command(["git", "init", "--quiet", str(project)])
        self.assertEqual(
            self.run_command(
                ["git", "config", "--get", "user.email"], cwd=project
            ).stdout.strip(),
            "work@example.com",
        )
        self.assertEqual(
            self.identity("email"), "46844683+ALX99@users.noreply.github.com"
        )
        self.install("base")
        self.install()
        self.assertFalse((self.home / ".gitconfig.personal").is_symlink())
        self.assertFalse((self.home / ".config/mise/mise.personal.toml").is_symlink())
        self.assertEqual(
            self.shell_profile(MISE_ENV="personal", __dotfiles_mise_env="personal"),
            "base|unset",
        )
        self.assertEqual(self.shell_profile(MISE_ENV="linux"), "base|linux")
        self.identity("email", success=False)
        self.assertEqual(
            work.read_text(), "[user]\n  name = Work Name\n  email = work@example.com\n"
        )
        self.assertEqual(
            self.run_command(
                ["git", "config", "--get", "user.email"], cwd=project
            ).stdout.strip(),
            "work@example.com",
        )

    def test_local_identity_overrides_personal_defaults(self):
        local = self.home / ".gitconfig.local"
        local.write_text("[user]\n  name = Local Name\n  email = local@example.com\n")
        self.install("personal")
        self.assertEqual(self.identity("email"), "local@example.com")
        self.install("base")
        self.assertEqual(self.identity("email"), "local@example.com")

    def test_base_preserves_foreign_personal_config(self):
        config = self.home / ".config/mise/mise.personal.toml"
        config.parent.mkdir(parents=True)
        config.write_text("# locally owned\n")
        self.install("base")
        self.assertEqual(config.read_text(), "# locally owned\n")
        config.unlink()
        foreign = self.home / "foreign.toml"
        foreign.write_text("# foreign config\n")
        config.symlink_to(foreign)
        self.install("base")
        self.assertTrue(config.is_symlink())
        self.assertEqual(config.read_text(), "# foreign config\n")

    def test_upgrade_removes_the_former_personal_tools_link(self):
        config = self.home / ".config/mise/mise.personal.toml"
        config.parent.mkdir(parents=True)
        legacy = REPO / ".config/mise/mise.personal.toml"
        config.symlink_to(os.path.relpath(legacy, config.parent))
        self.install("base")
        self.assertFalse(config.is_symlink())
        self.identity("email", success=False)
        config.symlink_to(legacy)
        self.install("personal")
        self.assertEqual(
            config.resolve(), REPO / "profiles/personal/.config/mise/mise.personal.toml"
        )

    def test_invalid_profiles_do_not_change_the_installation(self):
        self.install("personal")
        for arguments in (("work",), ("../personal",), ("base", "personal")):
            with self.subTest(arguments=arguments):
                self.install(*arguments, success=False)
                self.assertEqual(self.shell_profile(), "personal|personal")
                self.assertEqual(self.identity("name"), "ALX99")


if __name__ == "__main__":
    unittest.main()
