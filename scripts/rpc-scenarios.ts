/**
 * M0 spike scenarios: each one exercises one part of omp's RPC surface that the omp-rpc
 * backend will depend on. They use the cheap `smol` model role and tiny prompts.
 */
import type { Frame } from "../src/backends/omp-rpc/framing";
import type { Scenario, ScenarioContext } from "./rpc-recorder";

const MODEL = process.env.SPIKE_MODEL ?? "smol";

export const HOST_TOOLS = [
	{
		name: "ask_orchestrator",
		label: "Ask orchestrator",
		description:
			"Ask the orchestrating agent that assigned this task a question and wait for its answer.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "The question, self-contained." },
				options: { type: "array", items: { type: "string" } },
			},
			required: ["question"],
		},
		loadMode: "essential",
	},
	{
		name: "notify_orchestrator",
		label: "Notify orchestrator",
		description: "Send a one-line progress note to the orchestrating agent.",
		parameters: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
		loadMode: "essential",
	},
];

function textResult(id: unknown, text: string): Frame {
	return { type: "host_tool_result", id, result: { content: [{ type: "text", text }] } };
}

/** Answers host tool calls: notes are acknowledged, questions get `answer`. */
function hostToolHandler(answer: string) {
	return (f: Frame, ctx: ScenarioContext) => {
		if (f.type !== "host_tool_call") return;
		if (f.toolName === "notify_orchestrator") ctx.send(textResult(f.id, "Noted."));
		else if (f.toolName === "ask_orchestrator") ctx.send(textResult(f.id, answer));
		else
			ctx.send({ ...textResult(f.id, `unknown host tool ${String(f.toolName)}`), isError: true });
	};
}

function pickOption(options: unknown, pattern: RegExp, fallback = 0): string {
	const list = Array.isArray(options) ? options.map(String) : [];
	return list.find((o) => pattern.test(o)) ?? list[fallback] ?? "";
}

/** About 0.9 MB of todo text by default: fits one input line. */
function bigTodos(count = 900) {
	const tasks = Array.from({ length: count }, (_, i) => ({
		content: `task ${i} ${"x".repeat(1000)}`,
		status: "pending",
	}));
	return [{ name: "bulk", tasks }];
}

async function negotiateV2(ctx: ScenarioContext) {
	const r = await ctx.command("negotiate_protocol", { protocolVersion: 2 });
	if (r.success !== true) throw new Error(`negotiate_protocol failed: ${String(r.error)}`);
}

async function setupSession(ctx: ScenarioContext) {
	await negotiateV2(ctx);
	await ctx.command("set_host_tools", { tools: HOST_TOOLS });
	const state = await ctx.command("get_state");
	const data = (state.data ?? {}) as Frame;
	ctx.vars.lastSessionId = String(data.sessionId ?? "");
	ctx.vars.lastSessionFile = String(data.sessionFile ?? "");
}

async function finish(ctx: ScenarioContext) {
	await ctx.command("get_session_stats");
	await ctx.command("get_last_assistant_text");
}

function sessionExports(prefix: string) {
	return (ctx: ScenarioContext) => ({
		[`${prefix}SessionId`]: ctx.vars.lastSessionId ?? "",
		[`${prefix}SessionFile`]: ctx.vars.lastSessionFile ?? "",
	});
}

export const scenarios: Scenario[] = [
	{
		name: "v1-basic",
		description:
			"Protocol v1 (no negotiation): ready frame, a one-word prompt, stats, then an oversized `get_state` (large todo list + long session name) to see how v1 shrinks a frame over 1 MB.",
		args: () => ["--model", MODEL],
		async run(ctx) {
			await ctx.command("get_state");
			await ctx.command("prompt", { message: "Reply with exactly the word: pong" });
			await ctx.waitForAgentEnd();
			await finish(ctx);
			await ctx.command("set_todos", { phases: bigTodos() });
			await ctx.command("set_session_name", { name: "z".repeat(200_000) });
			await ctx.command("get_state");
		},
	},
	{
		name: "v2-chunking",
		description:
			"Protocol v2: host-run `bash` output is capped by omp; chunked input is rejected; a `get_state` over 1 MB (large todo list + long session name) comes back as `rpc_chunk` frames. No model call.",
		args: () => ["--model", MODEL],
		async run(ctx) {
			await negotiateV2(ctx);
			await ctx.command("bash", { command: "seq 1 400000" });
			// Host → omp: omp does not reassemble chunks it receives; each one is an unknown command.
			ctx.sendChunked({ id: "rec-chunked-input", type: "set_todos", phases: bigTodos(1500) });
			const rejected = await ctx.waitFor(
				(f) => f.type === "response" && f.command === "rpc_chunk",
				10_000,
			);
			ctx.note(`chunked input → ${String(rejected.error)}`);
			await Bun.sleep(500);
			// omp → host: two inputs under 1 MB each (todos, session name) make a get_state over 1 MB, sent as chunks.
			await ctx.command("set_todos", { phases: bigTodos() });
			await ctx.command("set_session_name", { name: "z".repeat(200_000) });
			await ctx.command("get_state");
		},
	},
	{
		name: "v2-host-tools",
		description:
			"Host tools: the worker posts a note, asks the orchestrator which file to read, reads it and answers.",
		args: () => ["--model", MODEL, "--approval-mode", "yolo"],
		onFrame: hostToolHandler("b.txt"),
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("prompt", {
				message: [
					"Do these steps in order:",
					"1. Call notify_orchestrator with message 'starting'.",
					"2. Call ask_orchestrator with question 'Which file should I read?' and options ['a.txt','b.txt'].",
					"3. Read the file the orchestrator names.",
					"4. Reply with that file's first line only.",
				].join("\n"),
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
		exports: sessionExports("hostTools"),
	},
	{
		name: "v2-approval",
		description:
			"`--approval-mode write`: an edit runs freely, then two shell commands ask for approval; the first is approved, the second denied.",
		args: () => ["--model", MODEL, "--approval-mode", "write"],
		onFrame(f, ctx) {
			hostToolHandler("ok")(f, ctx);
			if (f.type !== "extension_ui_request" || f.method !== "select") return;
			const title = String(f.title ?? "");
			if (!title.startsWith("Allow tool")) return;
			const approvals = Number(ctx.vars.approvals ?? "0") + 1;
			ctx.vars.approvals = String(approvals);
			const deny = /rm\b/.test(title);
			const value = deny
				? pickOption(f.options, /deny|reject|no\b/i, -1)
				: pickOption(f.options, /^(allow|approve|yes)(?!.*session)/i);
			ctx.note(`approval #${approvals}: ${deny ? "deny" : "allow"} → ${JSON.stringify(value)}`);
			ctx.send({ type: "extension_ui_response", id: f.id, value });
		},
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("prompt", {
				message: [
					"Do these steps in order, one tool call at a time:",
					"1. Use the edit tool to append a line 'gamma' to a.txt.",
					"2. Run the shell command: cat a.txt",
					"3. Run the shell command: rm b.txt",
					"4. Reply with one line saying which steps succeeded.",
				].join("\n"),
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
	},
	{
		name: "v2-approval-no-ui",
		description:
			"Same prompt as v2-approval but with `--no-ui`: omp has no UI to ask through, so it denies the shell commands itself and never sends an approval request.",
		baseArgs: ["--mode", "rpc", "--no-title", "--no-ui"],
		args: () => ["--model", MODEL, "--approval-mode", "write"],
		onFrame(f, ctx) {
			hostToolHandler("ok")(f, ctx);
			if (f.type !== "extension_ui_request" || f.method !== "select") return;
			const title = String(f.title ?? "");
			if (!title.startsWith("Allow tool")) return;
			const approvals = Number(ctx.vars.approvals ?? "0") + 1;
			ctx.vars.approvals = String(approvals);
			const deny = /rm\b/.test(title);
			const value = deny
				? pickOption(f.options, /deny|reject|no\b/i, -1)
				: pickOption(f.options, /^(allow|approve|yes)(?!.*session)/i);
			ctx.note(`approval #${approvals}: ${deny ? "deny" : "allow"} → ${JSON.stringify(value)}`);
			ctx.send({ type: "extension_ui_response", id: f.id, value });
		},
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("prompt", {
				message: [
					"Do these steps in order, one tool call at a time:",
					"1. Use the edit tool to append a line 'gamma' to a.txt.",
					"2. Run the shell command: cat a.txt",
					"3. Run the shell command: rm b.txt",
					"4. Reply with one line saying which steps succeeded.",
				].join("\n"),
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
	},
	{
		name: "v2-steer",
		description:
			"`steer` mid-run: after the first tool finishes, redirect the worker to a different, shorter answer.",
		args: () => ["--model", MODEL, "--approval-mode", "yolo"],
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("prompt", {
				message:
					"List every file in this directory with the find tool, then read each file one by one, then write a summary of all of them to summary.md.",
			});
			await ctx.waitFor((f) => f.type === "tool_execution_end");
			await ctx.command("steer", {
				message:
					"Change of plan: do NOT read the files and do NOT write summary.md. Just reply with the number of files you found.",
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
	},
	{
		name: "v2-abort",
		description:
			"`abort` while the model is streaming text, then the frames omp sends after an aborted turn. Exports the session for the restore probe.",
		args: () => ["--model", MODEL],
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("prompt", {
				message: "Write a 400-word story about a fox who learns to code. No tools.",
			});
			await ctx.waitFor((f) => f.type === "message_update");
			await ctx.command("abort");
			await ctx.waitForAgentEnd();
			await ctx.command("get_state");
			await finish(ctx);
		},
		exports: sessionExports("abort"),
	},
	{
		name: "v2-subagent",
		description:
			"`set_subagent_subscription events`, then a prompt that makes omp spawn one subagent with its task tool.",
		args: () => ["--model", MODEL, "--approval-mode", "yolo"],
		async run(ctx) {
			await setupSession(ctx);
			await ctx.command("set_subagent_subscription", { level: "events" });
			await ctx.command("prompt", {
				message:
					"Use the task tool to spawn exactly one subagent whose job is to read a.txt and return its first line. Then reply with that line.",
			});
			await ctx.waitForAgentEnd();
			await ctx.command("get_subagents");
			await finish(ctx);
		},
	},
	{
		name: "v2-resume",
		description:
			"`--resume <session>` from v2-host-tools: the worker must remember the earlier answer.",
		args: (vars) => {
			if (!vars.hostToolsSessionId) throw new Error("run v2-host-tools first");
			return ["--model", MODEL, "--resume", vars.hostToolsSessionId];
		},
		async run(ctx) {
			await setupSession(ctx);
			ctx.note(`resumed session id: ${ctx.vars.lastSessionId}`);
			await ctx.command("prompt", {
				message:
					"Which file did the orchestrator tell you to read earlier in this session? Answer with the filename only.",
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
	},
	{
		name: "v2-resume-after-abort",
		description:
			"Crash-recovery strategy (`--restore` is refused in RPC mode): `--resume` the aborted v2-abort session and ask the worker to finish its interrupted answer.",
		args: (vars) => {
			if (!vars.abortSessionId) throw new Error("run v2-abort first");
			return ["--model", MODEL, "--resume", vars.abortSessionId];
		},
		async run(ctx) {
			await setupSession(ctx);
			const page = await ctx.command("get_messages_page", { limit: 5 });
			ctx.note(`resumed history page keys: ${Object.keys((page.data ?? {}) as Frame).join(",")}`);
			await ctx.command("prompt", {
				message:
					"Your previous turn was interrupted. Continue from where you stopped, but keep it under 60 words.",
			});
			await ctx.waitForAgentEnd();
			await finish(ctx);
		},
	},
];
