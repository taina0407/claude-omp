"""End-to-end tests for omp-task against a fake omp RPC binary. Run: python3 -m unittest discover tests"""

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
        self.tmp = tempfile.TemporaryDirectory(prefix="ot-")
        base = Path(self.tmp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        (self.repo / "existing.txt").write_text("hi\n")
        bindir = base / "bin"
        bindir.mkdir()
        fake = bindir / "omp"
        fake.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE} "$@"\n')
        fake.chmod(0o755)
        self.log = base / "argv.log"
        self.config = base / "config.json"
        self.env = dict(
            os.environ,
            OMP_TASK_HOME=str(base / "state"),
            OMP_TASK_CONFIG=str(self.config),
            OMP_TASK_OMP_BIN=str(fake),
            FAKE_OMP_LOG=str(self.log),
        )

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *args, ok=(0,)):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.repo,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if ok is not None and proc.returncode not in ok:
            self.fail(
                f"{args} exit {proc.returncode}\nstdout:{proc.stdout}\nstderr:{proc.stderr}"
            )
        return proc

    def run_json(self, *args, ok=(0,)):
        return json.loads(self.cli("run", "--json", *args, ok=ok).stdout)

    def start(self, *args):
        return json.loads(self.cli("run", "--detach", "--json", *args).stdout)["id"]

    def wait_json(self, job, *extra, ok=(0, 1)):
        out = self.cli(
            "wait",
            job,
            "--interval",
            "0.2",
            "--max-wait",
            "60",
            "--json",
            *extra,
            ok=ok,
        ).stdout
        return json.loads(out.split("\n\n")[0])

    def omp_argv(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def wait_for_status(self, job, status, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            meta = json.loads(
                (
                    Path(self.env["OMP_TASK_HOME"]) / "jobs" / job / "meta.json"
                ).read_text()
            )
            if meta["status"] == status:
                return meta
            time.sleep(0.1)
        self.fail(f"job never reached {status}")

    # -- basics

    def test_run_reports_result_and_changed_files(self):
        out = self.run_json("WRITE new.txt please")
        self.assertEqual(out["status"], "completed")
        self.assertEqual(out["changed_files"], ["new.txt"])
        self.assertEqual(out["tools"], {"write": 1})
        self.assertIn("Did it", out["result"])
        self.assertTrue(out["session_id"])
        self.assertEqual(out["model_used"], "fake/fake-1")

    def test_flags_reach_omp(self):
        self.run_json("-m", "smol", "-a", "read", "-t", "high", "hello")
        argv = self.omp_argv()
        self.assertEqual(argv[argv.index("--mode") + 1], "rpc")
        self.assertEqual(argv[argv.index("--model") + 1], "smol")
        self.assertEqual(argv[argv.index("--tools") + 1].split(",")[0], "read")
        self.assertEqual(argv[argv.index("--thinking") + 1], "high")
        self.assertIn("--append-system-prompt", argv)

    def test_default_access_is_edit(self):
        self.run_json("hello")
        argv = self.omp_argv()
        self.assertEqual(argv[argv.index("--approval-mode") + 1], "write")

    def test_preset_from_config(self):
        self.config.write_text(
            json.dumps({"presets": {"rev": {"model": "slow", "access": "full"}}})
        )
        self.run_json("--preset", "rev", "hello")
        argv = self.omp_argv()
        self.assertEqual(argv[argv.index("--model") + 1], "slow")
        self.assertEqual(argv[argv.index("--approval-mode") + 1], "yolo")

    def test_brief_file(self):
        brief = Path(self.tmp.name) / "brief.md"
        brief.write_text("# Do the thing\nWRITE from_brief.txt\n")
        out = self.run_json("--brief", str(brief))
        self.assertEqual(out["title"], "Do the thing")
        self.assertEqual(out["changed_files"], ["from_brief.txt"])

    def test_failure_is_reported(self):
        out = self.run_json("FAIL", ok=(1,))
        self.assertEqual(out["status"], "failed")
        self.assertTrue(any("boom" in e for e in out["errors"]))

    def test_continue_resumes_same_session(self):
        first = self.run_json("-m", "smol", "hello")
        second = json.loads(
            self.cli("continue", first["id"], "--json", "fix it").stdout
        )
        self.assertEqual(second["session_id"], first["session_id"])
        self.assertEqual(second["parent"], first["id"])
        argv = self.omp_argv()
        self.assertEqual(argv[argv.index("--resume") + 1], first["session_id"])
        self.assertEqual(argv[argv.index("--model") + 1], "smol")  # inherited
        self.assertIn("resumed=True", second["result"])

    # -- live supervision

    def test_question_returns_attention_then_reply_resumes(self):
        proc = self.cli("run", "ASK then finish", ok=(4,))
        self.assertIn("QUESTION from worker", proc.stdout)
        self.assertIn("option: red", proc.stdout)
        job = proc.stdout.split()[3]
        self.cli("reply", job, "blue please")
        out = self.wait_json(job)
        self.assertEqual(out["status"], "completed")
        self.assertIn("answer=blue please", out["result"])

    def test_approval_flow(self):
        proc = self.cli("run", "BASH", ok=(4,))
        self.assertIn("APPROVAL needed", proc.stdout)
        self.assertIn("make test", proc.stdout)
        job = proc.stdout.split()[3]
        self.cli("approve", job, "--session")
        out = self.wait_json(job)
        self.assertIn("approval=Approve bash for this session", out["result"])

    def test_denied_approval_is_recorded(self):
        job = self.start("BASH")
        self.wait_for_status(job, "waiting")
        self.cli("approve", job, "--deny")
        out = self.wait_json(job)
        self.assertIn("approval=Deny", out["result"])
        self.assertEqual(out["denied_tools"], ["bash"])

    def test_steer_running_job(self):
        job = self.start("SLEEP")
        self.wait_for_status(job, "running")
        self.cli("steer", job, "do something else")
        out = self.wait_json(job)
        self.assertEqual(out["status"], "completed")
        self.assertIn("steered=do something else", out["result"])

    def test_cancel_running_job(self):
        job = self.start("SLEEP")
        self.wait_for_status(job, "running")
        self.cli("cancel", job)
        self.assertEqual(self.wait_json(job)["status"], "cancelled")

    def test_timeout_aborts_job(self):
        job = self.start("--timeout", "2", "SLEEP")
        self.assertEqual(self.wait_json(job)["status"], "timeout")

    def test_unanswered_question_expires(self):
        job = self.start("--answer-timeout", "1", "ASK")
        out = self.wait_json(job, "--no-attention")
        self.assertEqual(out["status"], "completed")
        self.assertIn("answer=No answer from the orchestrator", out["result"])

    def test_watch_streams_feed_and_exits(self):
        job = self.start("NOTIFY WRITE w.txt")
        out = self.cli("watch", job, "--from-start", "--interval", "0.2").stdout
        kinds = [line.split()[2] for line in out.splitlines()]
        self.assertEqual(kinds[0], "STARTED:")
        self.assertIn("PROGRESS:", kinds)
        self.assertIn("TOOL:", kinds)
        self.assertEqual(kinds[-1], "DONE:")
        self.assertIn("changed: w.txt", out)

    def test_watch_quiet_hides_progress(self):
        job = self.start("NOTIFY WRITE w.txt")
        out = self.cli("watch", job, "--from-start", "-q", "--interval", "0.2").stdout
        self.assertNotIn("PROGRESS", out)
        self.assertIn("DONE", out)

    def test_list_and_doctor(self):
        first = self.run_json("hello")
        self.assertIn(first["id"], self.cli("list").stdout)
        self.assertIn("omp/0.0.0-fake", self.cli("doctor").stdout)


if __name__ == "__main__":
    unittest.main()
