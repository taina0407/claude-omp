"""End-to-end tests for omp-task against a fake omp binary. Run: python3 -m unittest discover tests"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "skills" / "delegate" / "scripts" / "omp-task"
FAKE = Path(__file__).resolve().parent / "fake_omp.py"


class OmpTaskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "existing.txt").write_text("hi\n")
        bindir = base / "bin"
        bindir.mkdir()
        fake = bindir / "omp"
        fake.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n")
        fake.chmod(0o755)
        self.log = base / "argv.log"
        self.env = dict(os.environ, OMP_TASK_HOME=str(base / "state"), OMP_TASK_CONFIG=str(base / "config.json"),
                        OMP_TASK_OMP_BIN=str(fake), FAKE_OMP_LOG=str(self.log))
        self.config = base / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, check=True):
        proc = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=60)
        if check and proc.returncode not in (0,):
            self.fail(f"exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}")
        return proc

    def last_argv(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def test_run_reports_result_and_changed_files(self):
        out = json.loads(self.run_cli("run", "--json", "WRITE new.txt please").stdout)
        self.assertEqual(out["status"], "completed")
        self.assertEqual(out["changed_files"], ["new.txt"])
        self.assertEqual(out["tools"], {"write": 1})
        self.assertIn("Did it", out["result"])
        self.assertTrue(out["session_id"])
        self.assertEqual(out["model_used"], "fake/fake-1")

    def test_access_and_model_flags_reach_omp(self):
        self.run_cli("run", "-m", "smol", "-a", "read", "-t", "high", "--timeout", "5m", "hello")
        argv = self.last_argv()
        self.assertIn("--model", argv)
        self.assertEqual(argv[argv.index("--model") + 1], "smol")
        self.assertEqual(argv[argv.index("--tools") + 1].split(",")[0], "read")
        self.assertEqual(argv[argv.index("--max-time") + 1], "5m")
        self.assertIn("--append-system-prompt", argv)

    def test_default_access_is_edit(self):
        self.run_cli("run", "hello")
        argv = self.last_argv()
        self.assertEqual(argv[argv.index("--approval-mode") + 1], "write")

    def test_preset_from_config(self):
        self.config.write_text(json.dumps({"presets": {"rev": {"model": "slow", "access": "full"}}}))
        self.run_cli("run", "--preset", "rev", "hello")
        argv = self.last_argv()
        self.assertEqual(argv[argv.index("--model") + 1], "slow")
        self.assertEqual(argv[argv.index("--approval-mode") + 1], "yolo")

    def test_continue_resumes_same_session(self):
        first = json.loads(self.run_cli("run", "--json", "-m", "smol", "hello").stdout)
        second = json.loads(self.run_cli("continue", first["id"], "--json", "fix it").stdout)
        self.assertEqual(second["session_id"], first["session_id"])
        self.assertEqual(second["parent"], first["id"])
        argv = self.last_argv()
        self.assertEqual(argv[argv.index("--resume") + 1], first["session_id"])
        self.assertEqual(argv[argv.index("--model") + 1], "smol")  # inherited
        self.assertIn("resumed=True", second["result"])

    def test_brief_file_and_stdin(self):
        brief = Path(self.tmp.name) / "brief.md"
        brief.write_text("# Do the thing\nWRITE from_brief.txt\n")
        out = json.loads(self.run_cli("run", "--json", "--brief", str(brief)).stdout)
        self.assertEqual(out["title"], "Do the thing")
        self.assertEqual(out["changed_files"], ["from_brief.txt"])

    def test_failure_is_reported(self):
        proc = self.run_cli("run", "--json", "FAIL", check=False)
        self.assertEqual(proc.returncode, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "failed")
        self.assertTrue(any("boom" in e for e in out["errors"]))

    def test_detach_wait_and_list(self):
        started = json.loads(self.run_cli("run", "--detach", "--json", "WRITE bg.txt").stdout)
        self.assertEqual(started["status"], "running")
        waited = self.run_cli("wait", started["id"], "--interval", "0.2", "--max-wait", "30")
        self.assertIn("COMPLETED", waited.stdout)
        self.assertIn("bg.txt", waited.stdout)
        listed = self.run_cli("list").stdout
        self.assertIn(started["id"], listed)

    def test_cancel_running_job(self):
        started = json.loads(self.run_cli("run", "--detach", "--json", "SLEEP").stdout)
        time.sleep(1.0)
        self.run_cli("cancel", started["id"])
        res = self.run_cli("wait", started["id"], "--interval", "0.2", "--max-wait", "20", "--json", check=False)
        self.assertEqual(json.loads(res.stdout.split("\n\n")[0])["status"], "cancelled")

    def test_doctor(self):
        out = self.run_cli("doctor").stdout
        self.assertIn("omp/0.0.0-fake", out)


if __name__ == "__main__":
    unittest.main()
