import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame } from "../src/backends/omp-rpc/framing";
import { OmpRpcProtocol } from "../src/backends/omp-rpc/protocol";
import type { BackendEvent } from "../src/backends/types";

/**
 * Replays the omp → host frames of a recorded fixture through the protocol and collects what it
 * emits and what it sends back. Request ids differ from the recording, which is fine: the
 * protocol correlates by command name and by the requests omp itself made.
 */
function replay(name: string) {
	const lines = readFileSync(join(import.meta.dir, "fixtures/rpc", `${name}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.slice(1)
		.map((l) => JSON.parse(l) as { dir: string; frame: Frame });
	const events: BackendEvent[] = [];
	const sent: Frame[] = [];
	const protocol = new OmpRpcProtocol({
		prompt: "replayed prompt",
		send: (f) => sent.push(f),
		emit: (e) => events.push(e),
	});
	for (const l of lines) if (l.dir === "in") protocol.onFrame(l.frame);
	const of = <K extends BackendEvent["kind"]>(kind: K) =>
		events.filter((e): e is Extract<BackendEvent, { kind: K }> => e.kind === kind);
	return { events, sent, protocol, of };
}

describe("handshake", () => {
	test("negotiates v2, registers host tools, subscribes to subagent progress, then prompts", () => {
		const { sent } = replay("v2-host-tools");
		expect(sent.slice(0, 5).map((f) => f.type)).toEqual([
			"negotiate_protocol",
			"set_host_tools",
			"set_subagent_subscription",
			"get_state",
			"prompt",
		]);
		expect(sent[0]?.protocolVersion).toBe(2);
		expect(sent[4]?.message).toBe("replayed prompt");
	});

	test("an omp without protocol v2 fails the job instead of prompting", () => {
		const events: BackendEvent[] = [];
		const sent: Frame[] = [];
		const protocol = new OmpRpcProtocol({
			prompt: "p",
			send: (f) => sent.push(f),
			emit: (e) => events.push(e),
		});
		protocol.onFrame({ type: "ready", protocolVersion: 1 });
		protocol.onFrame({
			id: sent[0]?.id,
			type: "response",
			command: "negotiate_protocol",
			success: false,
			error: "unknown command",
		});
		expect(sent.map((f) => f.type)).toEqual(["negotiate_protocol"]);
		const end = events.find((e) => e.kind === "end");
		expect(end).toMatchObject({ outcome: "failed" });
		expect(JSON.stringify(end)).toContain("update omp");
	});

	test("reports the session id and resolved model", () => {
		const { of } = replay("v2-host-tools");
		const [started] = of("started");
		expect(started?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(started?.model).toMatch(/\//);
	});
});

describe("host tools", () => {
	test("notes become progress and are acknowledged; questions surface with options", () => {
		const { of, sent } = replay("v2-host-tools");
		expect(of("progress").map((e) => e.text)).toEqual(["starting"]);
		const [q] = of("question");
		expect(q?.question).toBe("Which file should I read?");
		expect(q?.options).toEqual(["a.txt", "b.txt"]);
		const acks = sent.filter((f) => f.type === "host_tool_result");
		expect(acks).toHaveLength(1); // the note; the question waits for the orchestrator
	});
});

describe("approvals", () => {
	test("each shell command becomes an approval with its command line", () => {
		const { of } = replay("v2-approval");
		const approvals = of("approval");
		expect(approvals.map((a) => a.tool)).toEqual(["bash", "bash", "bash"]);
		expect(approvals.map((a) => a.detail)).toContain("Command: rm b.txt");
		expect(approvals[0]?.options).toEqual(["Approve", "Approve bash for this session", "Deny"]);
	});

	test("a bash approval carries its call's cwd and env, which omp's prompt leaves out", () => {
		// Recorded: omp announces the call before it asks.
		const { of } = replay("v2-approval");
		expect(of("approval").map((a) => a.shell)).toEqual([
			{ cwd: null, env: false },
			{ cwd: null, env: false },
			{ cwd: null, env: false },
		]);
		const events: BackendEvent[] = [];
		const protocol = new OmpRpcProtocol({
			prompt: "p",
			send: () => {},
			emit: (e) => events.push(e),
		});
		const call = (id: string, args: Frame) => {
			protocol.onFrame({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args });
			protocol.onFrame({
				type: "extension_ui_request",
				id: `ap-${id}`,
				method: "select",
				title: `Allow tool: bash\nCommand: ${String(args.command).slice(0, 20)}`,
				options: ["Approve", "Deny"],
			});
		};
		call("a", { command: "ls", cwd: "/tmp", env: { BASH_ENV: "x" } });
		call("b", { command: "ls" });
		call("c", { command: `cat ${"x".repeat(40)}` }); // shortened in the prompt: no match
		const shells = events.flatMap((e) => (e.kind === "approval" ? [e.shell ?? null] : []));
		expect(shells).toEqual([{ cwd: "/tmp", env: true }, { cwd: null, env: false }, null]);
	});

	test("decide() picks the matching option label", () => {
		const { protocol, of, sent } = replay("v2-approval");
		const refs = of("approval").map((a) => a.ref);
		protocol.decide(refs[0] as string, "session");
		protocol.decide(refs[1] as string, "deny");
		protocol.decide(refs[2] as string, "approve");
		const values = sent.slice(-3).map((f) => f.value);
		expect(values).toEqual(["Approve bash for this session", "Deny", "Approve"]);
	});

	test("with --no-ui omp denies by itself and never asks", () => {
		const { of } = replay("v2-approval-no-ui");
		expect(of("approval")).toHaveLength(0);
		const denied = of("tool_end").filter((e) => e.isError);
		expect(denied.length).toBeGreaterThan(0);
		expect(denied[0]?.text).toContain("requires approval");
	});

	test("display-only UI requests are ignored", () => {
		const { sent } = replay("v2-approval");
		expect(sent.filter((f) => f.type === "extension_ui_response")).toHaveLength(0);
	});
});

describe("endings", () => {
	test.each([
		["v2-host-tools", "completed"],
		["v2-approval", "completed"],
		["v2-steer", "completed"],
		["v2-subagent", "completed"],
		["v2-resume", "completed"],
		["v2-resume-after-abort", "completed"],
		["v2-abort", "aborted"],
	])("%s ends %s via prompt_result", (name, outcome) => {
		const { of, protocol } = replay(name);
		const ends = of("end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe(outcome as "completed");
		expect(protocol.phase).toBe("ended");
	});

	test("an aborted turn reports stopReason aborted", () => {
		const { of } = replay("v2-abort");
		expect(of("assistant").at(-1)?.stopReason).toBe("aborted");
		expect(of("assistant").at(-1)?.error).toBe("Interrupted by user");
	});

	test("a v1 session that never negotiated does not end from a stray prompt_result", () => {
		const { of } = replay("v1-basic");
		expect(of("end")).toHaveLength(0);
	});
});

describe("cost", () => {
	test("assistant messages carry per-message cost and the final text", () => {
		const { of } = replay("v2-host-tools");
		const assistant = of("assistant");
		const total = assistant.reduce((s, e) => s + e.costUsd, 0);
		expect(total).toBeGreaterThan(0);
		expect(assistant.at(-1)?.text).toContain("bravo");
	});

	test("subagent progress reports the subagent's own cost", () => {
		const { of } = replay("v2-subagent");
		const subs = of("subagent");
		expect(subs.length).toBeGreaterThan(0);
		expect(subs.some((s) => (s.costUsd ?? 0) > 0)).toBe(true);
		expect(subs.at(-1)?.status).toBe("completed");
	});
});
