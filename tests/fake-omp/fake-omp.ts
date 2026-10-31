#!/usr/bin/env bun
/**
 * Stand-in for `omp --mode rpc` in the tests. It speaks the protocol as recorded from omp 18.12
 * (tests/fixtures/rpc): a v1 `ready` frame, `negotiate_protocol` to v2, per-message usage cost,
 * and `agent_end` followed by `prompt_result{status}`.
 *
 * Behaviour is driven by words in the prompt:
 *   WRITE <name>  create <name> in the cwd (write tool)
 *   SHELLWRITE <name>  create <name> in the cwd through a bash call (no edit/write tool)
 *   ENV           write the worker's environment as JSON to $FAKE_OMP_ENV_LOG
 *   ASK           ask_orchestrator (after omp's own approval prompt for it); answer goes in the text
 *   BASH          request approval for `make test`; the decision goes in the text
 *   BASHCHAIN     the same for `make test && rm -rf build`
 *   PAIR          two approvals open at once (`make a`, `make b`); the decisions go in the text
 *   SH <b64>      bash calls from base64url JSON [{command, cwd?, env?}], each asking approval;
 *                 the decisions go in the text as sh<n>=<decision>
 *   NOTIFY        notify_orchestrator
 *   CHECKPOINT    notify_orchestrator with checkpoint: true (a 600-character note ending in END)
 *   TOOLS <n>     n quick read tool calls
 *   FLAKY         run `bun test` three times, failing each time
 *   SUBAGENT      report one subagent that costs $0.002
 *   REVIEW        submit_review with a valid review (one high finding)
 *   REVIEWBAD     submit an invalid review first, then a valid one
 *   REVIEWWORSE   keep submitting invalid reviews (three times)
 *   SLEEP         idle up to 30s; `steer` ends it early, `abort` ends the run as aborted
 *   SLOWSTART     take 3s to accept the prompt (the session is not saved until then)
 *   ERROR         the final message has stopReason "error"
 *   FAIL          exit 1 with an error on stderr
 * Records its argv to $FAKE_OMP_LOG when set. With FAKE_OMP_IGNORE_EOF it keeps running after
 * stdin closes, as real omp does in the middle of a turn.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

type Frame = Record<string, unknown>;

const argv = process.argv.slice(2);
if (process.env.FAKE_OMP_LOG) appendFileSync(process.env.FAKE_OMP_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === "--version") {
	console.log("omp/18.12.6-fake");
	process.exit(0);
}
const resumeAt = argv.indexOf("--resume");
const session = resumeAt >= 0 ? (argv[resumeAt + 1] as string) : crypto.randomUUID();

// Like omp, a session is saved once a prompt has been accepted; resuming an unsaved one fails.
const sessionsFile = process.env.FAKE_OMP_SESSIONS;
const savedSessions = () =>
	sessionsFile && existsSync(sessionsFile) ? readFileSync(sessionsFile, "utf8").split("\n") : [];
if (resumeAt >= 0 && sessionsFile && !savedSessions().includes(session)) {
	process.stderr.write(`Error: Session "${session}" not found.\n`);
	process.exit(1);
}

function emit(frame: Frame): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// ---------------------------------------------------------------- inbound frames

const inbox: Frame[] = [];
/** Wakes `waitFor` when a frame arrives; held in an object so TS does not narrow it away. */
const wake: { fn: (() => void) | null } = { fn: null };
let stdinClosed = false;

(async () => {
	let buf = "";
	const decoder = new TextDecoder();
	for await (const chunk of Bun.stdin.stream()) {
		buf += decoder.decode(chunk, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) inbox.push(JSON.parse(line) as Frame);
			nl = buf.indexOf("\n");
		}
		wake.fn?.();
	}
	stdinClosed = true;
	wake.fn?.();
})();

/** Next inbound frame matching `pred` (others stay queued), or null on timeout / EOF. */
async function waitFor(pred: (f: Frame) => boolean, timeoutMs = 30_000): Promise<Frame | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const i = inbox.findIndex(pred);
		if (i >= 0) return inbox.splice(i, 1)[0] as Frame;
		// Real omp keeps working on its turn after stdin closes; FAKE_OMP_IGNORE_EOF mimics that.
		if (stdinClosed && !process.env.FAKE_OMP_IGNORE_EOF) process.exit(0);
		await new Promise<void>((resolve) => {
			wake.fn = resolve;
			setTimeout(resolve, 50);
		});
		wake.fn = null;
	}
	return null;
}

function respond(f: Frame, data?: unknown): void {
	const frame: Frame = { id: f.id, type: "response", command: f.type, success: true };
	if (data !== undefined) frame.data = data;
	emit(frame);
}

// ---------------------------------------------------------------- one prompt

const VALID_REVIEW = {
	verdict: "request_changes",
	summary: "The greeting changed without a test.",
	findings: [
		{
			severity: "high",
			file: "existing.txt",
			line: 1,
			title: "Greeting is wrong",
			detail: "It says bye.",
			suggestion: "Say hi.",
			confidence: 0.9,
		},
	],
};

/** Calls submit_review with each payload in turn; returns what the host answered each time. */
async function submitReviews(payloads: unknown[]): Promise<string[]> {
	const answers: string[] = [];
	for (const [i, payload] of payloads.entries()) {
		const id = `rv${i}`;
		emit({
			type: "host_tool_call",
			id,
			toolCallId: id,
			toolName: "submit_review",
			arguments: payload,
		});
		const res = await waitFor((f) => f.type === "host_tool_result" && f.id === id);
		answers.push(res?.isError ? "rejected" : "accepted");
		if (res?.isError) {
			// Echo the host's complaint as a progress note, so tests can see what the worker was told.
			const text = (res.result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
			emit({
				type: "host_tool_call",
				id: `${id}-note`,
				toolCallId: `${id}-note`,
				toolName: "notify_orchestrator",
				arguments: { message: `told: ${text.replaceAll("\n", " ")}` },
			});
			await waitFor((f) => f.type === "host_tool_result" && f.id === `${id}-note`);
		}
	}
	return answers;
}

async function runPrompt(prompt: Frame): Promise<void> {
	const text = String(prompt.message);
	if (text.includes("SLOWSTART")) {
		await Bun.sleep(3_000); // omp can sit on a prompt for a while before it takes it
		if (stdinClosed) process.exit(0);
	}
	respond(prompt);
	if (sessionsFile && !savedSessions().includes(session))
		appendFileSync(sessionsFile, `${session}\n`);
	emit({ type: "agent_start" });
	if (text.includes("FAIL")) {
		process.stderr.write("boom: provider error\n");
		process.exit(1);
	}
	const notes = [`resumed=${resumeAt >= 0}`];
	let stop = text.includes("ERROR") ? "error" : "stop";
	const words = text.split(/\s+/);
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const next = words[i + 1] ?? "";
		if (word === "WRITE") {
			emit({
				type: "tool_execution_start",
				toolName: "write",
				toolCallId: "w",
				args: { path: next },
			});
			writeFileSync(next, "written by fake omp\n");
			emit({
				type: "tool_execution_end",
				toolName: "write",
				toolCallId: "w",
				isError: false,
				result: {},
			});
		} else if (word === "SHELLWRITE") {
			const call = { toolName: "bash", toolCallId: "sw" };
			emit({ type: "tool_execution_start", ...call, args: { command: `touch ${next}` } });
			writeFileSync(next, "written by a shell command\n");
			emit({ type: "tool_execution_end", ...call, isError: false, result: {} });
		} else if (word === "ENV") {
			if (process.env.FAKE_OMP_ENV_LOG) {
				writeFileSync(process.env.FAKE_OMP_ENV_LOG, JSON.stringify(process.env));
			}
		} else if (word === "NOTIFY" || word === "CHECKPOINT") {
			const checkpoint = word === "CHECKPOINT";
			emit({
				type: "host_tool_call",
				id: "n1",
				toolCallId: "n",
				toolName: "notify_orchestrator",
				arguments: checkpoint
					? { message: `design done: ${"x".repeat(580)} END`, checkpoint }
					: { message: "halfway" },
			});
			await waitFor((f) => f.type === "host_tool_result" && f.id === "n1");
		} else if (word === "TOOLS") {
			for (let n = 0; n < Number(next); n++) {
				const call = { toolName: "read", toolCallId: `r${n}` };
				emit({ type: "tool_execution_start", ...call, args: { path: `f${n}.ts` } });
				emit({ type: "tool_execution_end", ...call, isError: false, result: {} });
			}
		} else if (word === "FLAKY") {
			for (let n = 0; n < 3; n++) {
				const call = { toolName: "bash", toolCallId: `t${n}` };
				emit({ type: "tool_execution_start", ...call, args: { command: "bun test" } });
				emit({
					type: "tool_execution_end",
					...call,
					isError: true,
					result: { content: [{ type: "text", text: "1 fail" }] },
				});
			}
		} else if (word === "ASK") {
			emit({
				type: "extension_ui_request",
				id: "ap-ask",
				method: "select",
				title: "Allow tool: ask_orchestrator",
				options: ["Approve", "Approve ask_orchestrator for this session", "Deny"],
			});
			await waitFor((f) => f.type === "extension_ui_response" && f.id === "ap-ask");
			emit({
				type: "host_tool_call",
				id: "q1",
				toolCallId: "q",
				toolName: "ask_orchestrator",
				arguments: { question: "Which color?", options: ["red", "blue"] },
			});
			const res = await waitFor((f) => f.type === "host_tool_result" && f.id === "q1", 60_000);
			const content = (res?.result as { content?: { text?: string }[] } | undefined)?.content;
			notes.push(`answer=${content?.[0]?.text ?? "<none>"}`);
		} else if (word === "BASH" || word === "BASHCHAIN") {
			const command = word === "BASH" ? "make test" : "make test && rm -rf build";
			emit({
				type: "tool_execution_start",
				toolName: "bash",
				toolCallId: "b",
				args: { command },
			});
			emit({
				type: "extension_ui_request",
				id: "ap-bash",
				method: "select",
				title: `Allow tool: bash\nCommand: ${command}`,
				options: ["Approve", "Approve bash for this session", "Deny"],
			});
			const res = await waitFor(
				(f) => f.type === "extension_ui_response" && f.id === "ap-bash",
				60_000,
			);
			const value = String(res?.value ?? "<none>");
			notes.push(`approval=${value}`);
			const denied = value === "Deny";
			emit({
				type: "tool_execution_end",
				toolName: "bash",
				toolCallId: "b",
				isError: denied,
				result: { content: [{ type: "text", text: denied ? "Tool call denied by user" : "ok" }] },
			});
		} else if (word === "PAIR") {
			for (const n of ["a", "b"]) {
				emit({
					type: "extension_ui_request",
					id: `ap-pair-${n}`,
					method: "select",
					title: `Allow tool: bash\nCommand: make ${n}`,
					options: ["Approve", "Approve bash for this session", "Deny"],
				});
			}
			for (const n of ["a", "b"]) {
				const res = await waitFor(
					(f) => f.type === "extension_ui_response" && f.id === `ap-pair-${n}`,
					60_000,
				);
				notes.push(`pair-${n}=${String(res?.value ?? "<none>")}`);
			}
		} else if (word === "SH") {
			const calls = JSON.parse(Buffer.from(next, "base64url").toString()) as Frame[];
			for (const [n, args] of calls.entries()) {
				const id = `sh${n}`;
				emit({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args });
				emit({
					type: "extension_ui_request",
					id: `ap-${id}`,
					method: "select",
					title: `Allow tool: bash\nCommand: ${String(args.command)}`,
					options: ["Approve", "Approve bash for this session", "Deny"],
				});
				const res = await waitFor(
					(f) => f.type === "extension_ui_response" && f.id === `ap-${id}`,
					60_000,
				);
				const value = String(res?.value ?? "<none>");
				notes.push(`${id}=${value}`);
				emit({
					type: "tool_execution_end",
					toolName: "bash",
					toolCallId: id,
					isError: value === "Deny",
					result: { content: [{ type: "text", text: "ok" }] },
				});
			}
			i++;
		} else if (word === "REVIEW" || word === "REVIEWBAD" || word === "REVIEWWORSE") {
			const bad = { verdict: "maybe", summary: "", findings: [{ severity: "huge" }] };
			const payloads =
				word === "REVIEW"
					? [VALID_REVIEW]
					: word === "REVIEWBAD"
						? [bad, VALID_REVIEW]
						: [bad, bad, bad];
			notes.push(`review=${(await submitReviews(payloads)).join(",")}`);
		} else if (word === "SUBAGENT") {
			const base = { id: "Helper", agent: "sonic", description: "Read a file", index: 0 };
			emit({ type: "subagent_lifecycle", payload: { ...base, status: "started" } });
			emit({
				type: "subagent_progress",
				payload: { ...base, progress: { status: "completed", cost: 0.002 } },
			});
			emit({ type: "subagent_lifecycle", payload: { ...base, status: "completed" } });
		} else if (word === "SLEEP") {
			const f = await waitFor((x) => x.type === "steer" || x.type === "abort");
			if (f?.type === "steer") {
				respond(f);
				notes.push(`steered=${String(f.message)}`);
			} else if (f?.type === "abort") {
				respond(f);
				stop = "aborted";
			}
		}
	}
	const message = {
		role: "assistant",
		provider: "fake",
		model: "fake-1",
		stopReason: stop,
		content: [{ type: "text", text: `## Summary\nDid it. ${notes.join(" ")}` }],
		usage: { totalTokens: 100, cost: { total: 0.001 } },
		...(stop === "error" ? { errorMessage: "provider exploded" } : {}),
		...(stop === "aborted" ? { errorMessage: "Interrupted by user" } : {}),
	};
	emit({ type: "message_end", message });
	emit({ type: "agent_end", messages: [message], isTerminal: true, yielded: true });
	emit({
		type: "prompt_result",
		id: prompt.id,
		agentInvoked: true,
		status: stop === "aborted" ? "aborted" : "completed",
		sessionSettled: true,
	});
	emit({ type: "session_settled" });
}

// ---------------------------------------------------------------- main loop

emit({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});
// Extensions chatter on the UI channel; the host must ignore it.
emit({
	type: "extension_ui_request",
	id: "s",
	method: "setStatus",
	statusKey: "x",
	statusText: "hi",
});

while (true) {
	const f = await waitFor(() => true, 24 * 3600_000);
	if (!f) continue;
	switch (f.type) {
		case "negotiate_protocol":
			respond(f, { protocolVersion: 2 });
			break;
		case "set_host_tools":
			respond(f, { toolNames: (f.tools as { name: string }[]).map((t) => t.name) });
			break;
		case "set_subagent_subscription":
			respond(f, { level: f.level });
			break;
		case "get_state":
			respond(f, { sessionId: session, model: { provider: "fake", id: "fake-1" } });
			break;
		case "prompt":
			await runPrompt(f);
			break;
		case "steer":
		case "abort":
			respond(f);
			break;
		default:
			if (
				typeof f.id === "string" &&
				f.type !== "host_tool_result" &&
				f.type !== "extension_ui_response"
			) {
				emit({
					id: f.id,
					type: "response",
					command: f.type,
					success: false,
					error: `Unknown command: ${String(f.type)}`,
				});
			}
	}
}
