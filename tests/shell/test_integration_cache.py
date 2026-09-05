"""Exercise shell integration publication across real Bash processes."""

import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


CACHE_SCRIPT = Path(__file__).resolve().parents[2] / "home/.bashrc.d/integration-cache.bash"
INVOKE = 'source "$1"; __cached_integration demo "$2"; printf "%s" "${INTEGRATION_VALUE:-}"'


class IntegrationCacheTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.cache = self.root / "bash-integrations/demo.sh"
        self.generator = self.root / "generator"
        self.environment = {**os.environ, "XDG_CACHE_HOME": str(self.root)}
        self.write_generator("printf 'INTEGRATION_VALUE=generated\n'")

    def write_generator(self, body):
        self.generator.write_text("#!/usr/bin/env bash\n" + body + "\n")
        self.generator.chmod(0o755)

    def invoke(self):
        return subprocess.run(
            ["bash", "-c", INVOKE, "bash", str(CACHE_SCRIPT), str(self.generator)],
            env=self.environment, capture_output=True, text=True, timeout=10,
        )

    def assert_no_temporary_files(self):
        self.assertEqual(list(self.cache.parent.iterdir()), [self.cache])

    def test_generate_then_reuse_without_running_generator(self):
        result = self.invoke()
        self.assertEqual(result.stdout, "generated")
        self.assertEqual(result.stderr, "")
        self.write_generator("exit 42")
        # Keep the binary older than the published cache to exercise a hit.
        os.utime(self.generator, (1, 1))
        self.assertEqual(self.invoke().stdout, "generated")
        self.assert_no_temporary_files()

    def test_binary_upgrade_replaces_cache(self):
        self.invoke()
        self.write_generator("printf 'INTEGRATION_VALUE=upgraded\n'")
        os.utime(self.cache, (1, 1))
        self.assertEqual(self.invoke().stdout, "upgraded")
        self.assert_no_temporary_files()

    def test_failed_empty_or_invalid_generation_preserves_old_cache(self):
        for body in ("printf 'INTEGRATION_VALUE=partial'; exit 1", "exit 0", "printf 'if then\n'"):
            with self.subTest(body=body):
                self.cache.parent.mkdir(exist_ok=True)
                self.cache.write_text("INTEGRATION_VALUE=previous\n")
                os.utime(self.cache, (1, 1))
                self.write_generator(body)
                self.assertEqual(self.invoke().stdout, "previous")
                self.assertEqual(self.cache.read_text(), "INTEGRATION_VALUE=previous\n")
                self.assert_no_temporary_files()

    def test_concurrent_startups_publish_complete_scripts(self):
        self.write_generator('''touch "$XDG_CACHE_HOME/ready-$BASHPID"
while [[ ! -e $XDG_CACHE_HOME/release ]]; do sleep 0.01; done
printf 'INTEGRATION_VALUE=generated\\n'
''')
        processes = [subprocess.Popen(
            ["bash", "-c", INVOKE, "bash", str(CACHE_SCRIPT), str(self.generator)],
            env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ) for _ in range(2)]
        try:
            deadline = time.monotonic() + 5
            while len(list(self.root.glob("ready-*"))) < 2:
                if time.monotonic() > deadline:
                    self.fail("both generators did not start")
                time.sleep(0.01)
            (self.root / "release").touch()
            for process in processes:
                stdout, stderr = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(stdout, "generated")
                self.assertEqual(stderr, "")
            self.assertEqual(self.cache.read_text(), "INTEGRATION_VALUE=generated\n")
            self.assert_no_temporary_files()
        finally:
            (self.root / "release").touch()
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.communicate()


if __name__ == "__main__":
    unittest.main()
