#!/usr/bin/env python3
"""Stand-in for `omp -p --mode json` used by the tests.

Behaviour is driven by words in the prompt file (the last @arg):
  WRITE <name>  create <name> in the cwd
  SLEEP         sleep 30s (for cancel/timeout tests)
  FAIL          exit 1 with an error on stderr
It records its argv to $FAKE_OMP_LOG when set.
"""
import json
import os
import sys
import time
import uuid
from pathlib import Path

argv = sys.argv[1:]
if os.environ.get("FAKE_OMP_LOG"):
    with open(os.environ["FAKE_OMP_LOG"], "a") as fh:
        fh.write(json.dumps(argv) + "\n")

if argv == ["--version"]:
    print("omp/0.0.0-fake")
    sys.exit(0)

prompt = Path(argv[-1][1:]).read_text() if argv and argv[-1].startswith("@") else ""
session = argv[argv.index("--resume") + 1] if "--resume" in argv else str(uuid.uuid4())


def emit(obj):
    print(json.dumps(obj), flush=True)


emit({"type": "session", "id": session, "cwd": os.getcwd()})
emit({"type": "agent_start"})

if "FAIL" in prompt:
    print("boom: provider error", file=sys.stderr)
    sys.exit(1)
if "SLEEP" in prompt:
    time.sleep(30)

for word, nxt in zip(prompt.split(), prompt.split()[1:]):
    if word == "WRITE":
        emit({"type": "tool_execution_start", "toolName": "write", "toolCallId": "1", "args": {}, "intent": ""})
        Path(nxt).write_text("written by fake omp\n")
        emit({"type": "tool_execution_end", "toolName": "write", "toolCallId": "1", "isError": False, "result": {}})

text = f"## Summary\nDid it. resumed={'--resume' in argv}"
emit({"type": "message_end", "message": {
    "role": "assistant", "provider": "fake", "model": "fake-1", "stopReason": "stop",
    "content": [{"type": "text", "text": text}],
    "usage": {"totalTokens": 100, "cost": {"total": 0.001}},
}})
emit({"type": "agent_end", "isTerminal": True, "messages": []})
