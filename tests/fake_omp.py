#!/usr/bin/env python3
"""Stand-in for `omp --mode rpc` used by the tests. Speaks the same JSON-lines frames.

Behaviour is driven by words in the prompt message:
  WRITE <name>  create <name> in the cwd
  ASK           call the ask_orchestrator host tool and put the answer in the final text
  BASH          request approval for a bash command; record the decision in the final text
  NOTIFY        call notify_orchestrator
  SLEEP         idle up to 30s; a steer ends it early (final text includes the steer),
                an abort ends it with stopReason "aborted"
  FAIL          exit 1 with an error on stderr
It records its argv to $FAKE_OMP_LOG when set.
"""

import json
import os
import queue
import sys
import threading
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

session = argv[argv.index("--resume") + 1] if "--resume" in argv else str(uuid.uuid4())
inbox: queue.Queue = queue.Queue()


def emit(obj):
    print(json.dumps(obj), flush=True)


def reader():
    for line in sys.stdin:
        try:
            inbox.put(json.loads(line))
        except json.JSONDecodeError:
            pass
    inbox.put(None)


def wait_for(pred, timeout=30.0):
    """Return the first inbound frame matching pred; queue others for the main loop."""
    deadline = time.time() + timeout
    skipped = []
    try:
        while time.time() < deadline:
            try:
                f = inbox.get(timeout=0.1)
            except queue.Empty:
                continue
            if f is None:
                sys.exit(0)
            if pred(f):
                return f
            skipped.append(f)
        return None
    finally:
        for f in skipped:
            inbox.put(f)


def run_prompt(prompt):
    emit({"type": "agent_start"})
    if "FAIL" in prompt:
        print("boom: provider error", file=sys.stderr, flush=True)
        os._exit(1)
    notes = [f"resumed={'--resume' in argv}"]
    stop = "stop"
    words = prompt.split()
    for word, nxt in zip(words, words[1:] + [""]):
        if word == "WRITE":
            emit(
                {
                    "type": "tool_execution_start",
                    "toolName": "write",
                    "toolCallId": "w",
                    "args": {"path": nxt},
                }
            )
            Path(nxt).write_text("written by fake omp\n")
            emit(
                {
                    "type": "tool_execution_end",
                    "toolName": "write",
                    "toolCallId": "w",
                    "isError": False,
                    "result": {},
                }
            )
        elif word == "NOTIFY":
            emit(
                {
                    "type": "host_tool_call",
                    "id": "n1",
                    "toolCallId": "n",
                    "toolName": "notify_orchestrator",
                    "arguments": {"message": "halfway"},
                }
            )
            wait_for(
                lambda f: f.get("type") == "host_tool_result" and f.get("id") == "n1"
            )
        elif word == "ASK":
            emit(
                {
                    "type": "extension_ui_request",
                    "id": "ap-ask",
                    "method": "select",
                    "title": "Allow tool: ask_orchestrator",
                    "options": [
                        "Approve",
                        "Approve ask_orchestrator for this session",
                        "Deny",
                    ],
                }
            )
            wait_for(
                lambda f: (
                    f.get("type") == "extension_ui_response" and f.get("id") == "ap-ask"
                )
            )
            emit(
                {
                    "type": "host_tool_call",
                    "id": "q1",
                    "toolCallId": "q",
                    "toolName": "ask_orchestrator",
                    "arguments": {
                        "question": "Which color?",
                        "options": ["red", "blue"],
                    },
                }
            )
            res = wait_for(
                lambda f: f.get("type") == "host_tool_result" and f.get("id") == "q1",
                timeout=60,
            )
            answer = res["result"]["content"][0]["text"] if res else "<none>"
            notes.append(f"answer={answer}")
        elif word == "BASH":
            emit(
                {
                    "type": "tool_execution_start",
                    "toolName": "bash",
                    "toolCallId": "b",
                    "args": {"command": "make test"},
                }
            )
            emit(
                {
                    "type": "extension_ui_request",
                    "id": "ap-bash",
                    "method": "select",
                    "title": "Allow tool: bash\nCommand: make test",
                    "options": ["Approve", "Approve bash for this session", "Deny"],
                }
            )
            res = wait_for(
                lambda f: (
                    f.get("type") == "extension_ui_response"
                    and f.get("id") == "ap-bash"
                ),
                timeout=60,
            )
            notes.append(f"approval={res.get('value') if res else '<none>'}")
        elif word == "SLEEP":
            f = wait_for(lambda f: f.get("type") in ("steer", "abort"), timeout=30)
            if f and f["type"] == "steer":
                notes.append(f"steered={f['message']}")
            elif f and f["type"] == "abort":
                stop = "aborted"
    text = "## Summary\nDid it. " + " ".join(notes)
    msg = {
        "role": "assistant",
        "provider": "fake",
        "model": "fake-1",
        "stopReason": stop,
        "content": [{"type": "text", "text": text}],
        "usage": {"totalTokens": 100, "cost": {"total": 0.001}},
    }
    emit({"type": "message_end", "message": msg})
    emit({"type": "agent_end", "messages": [msg]})


threading.Thread(target=reader, daemon=True).start()
emit({"type": "ready", "protocolVersion": 1})
emit(
    {
        "type": "extension_ui_request",
        "id": "s",
        "method": "setStatus",
        "statusKey": "x",
        "statusText": "hi",
    }
)
while True:
    f = inbox.get()
    if f is None:
        break
    t = f.get("type")
    if t == "set_host_tools":
        emit(
            {
                "id": f.get("id"),
                "type": "response",
                "command": t,
                "success": True,
                "data": {"toolNames": [x["name"] for x in f["tools"]]},
            }
        )
    elif t == "get_state":
        emit(
            {
                "id": f.get("id"),
                "type": "response",
                "command": t,
                "success": True,
                "data": {
                    "sessionId": session,
                    "model": {"provider": "fake", "id": "fake-1"},
                },
            }
        )
    elif t == "prompt":
        emit({"id": f.get("id"), "type": "response", "command": t, "success": True})
        run_prompt(f["message"])
