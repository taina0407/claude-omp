/**
 * The omp RPC conversation for one job, without any I/O: frames from omp go in through
 * `onFrame`, frames for omp come out through `send`, and what the runner needs to know comes out
 * as BackendEvents. Kept pure so the recorded fixtures in tests/fixtures/rpc can be replayed
 * through it.
 *
 * Observed protocol (omp 18.12): `ready` → negotiate v2 → commands → `prompt` → agent events →
 * `agent_end` → `prompt_result{status}` → `session_settled`.
 */
import type { ApprovalDecision } from "../../core/types";
import type { BackendEvent, HostTool } from "../types";
import { type Frame, isRecord } from "./framing";
import { ASK_TOOL, HOST_TOOL_NAMES, HOST_TOOLS, NOTIFY_TOOL } from "./host-tools";

/** Feed-worthy tools: the ones that change things or start sub-work. */
const DETAIL_KEYS = ["path", "command", "description", "pattern", "url"] as const;

/** omp refuses longer input lines; a brief this large is handed over as a file instead. */
export const MAX_PROMPT_BYTES = 900 * 1024;

export type Phase = "connecting" | "negotiating" | "prompting" | "running" | "ended";

export interface ProtocolOptions {
	prompt: string;
	send: (frame: Frame) => void;
	emit: (event: BackendEvent) => void;
	/** Host tools offered on top of ask/notify (e.g. submit_review). */
	extraTools?: HostTool[];
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => isRecord(c) && c.type === "text")
		.map((c) => str((c as Frame).text))
		.join("")
		.trim();
}

function textResult(id: string, text: string, isError = false): Frame {
	const frame: Frame = {
		type: "host_tool_result",
		id,
		result: { content: [{ type: "text", text }] },
	};
	if (isError) frame.isError = true;
	return frame;
}

interface ApprovalRequest {
	options: string[];
}

export class OmpRpcProtocol {
	phase: Phase = "connecting";
	sessionId: string | null = null;
	readonly #opts: ProtocolOptions;
	readonly #approvals = new Map<string, ApprovalRequest>();
	#nextId = 0;
	#promptId: string | null = null;
	readonly #extraNames: ReadonlySet<string>;

	constructor(opts: ProtocolOptions) {
		this.#opts = opts;
		this.#extraNames = new Set((opts.extraTools ?? []).map((t) => t.name));
	}

	#command(type: string, fields: Frame = {}): string {
		const id = `host-${++this.#nextId}`;
		this.#opts.send({ id, type, ...fields });
		return id;
	}

	#end(outcome: "completed" | "aborted" | "failed", error: string | null = null): void {
		if (this.phase === "ended") return;
		this.phase = "ended";
		this.#opts.emit({ kind: "end", outcome, error, exitCode: null });
	}

	// ---------------------------------------------------------------- omp → host

	onFrame(f: Frame): void {
		switch (f.type) {
			case "ready":
				this.phase = "negotiating";
				this.#command("negotiate_protocol", { protocolVersion: 2 });
				return;
			case "response":
				this.#onResponse(f);
				return;
			case "host_tool_call":
				this.#onHostToolCall(f);
				return;
			case "host_tool_cancel":
				this.#opts.emit({ kind: "question_withdrawn", ref: str(f.targetId) });
				return;
			case "extension_ui_request":
				this.#onUiRequest(f);
				return;
			case "tool_execution_start":
				this.#onToolStart(f);
				return;
			case "tool_execution_end":
				this.#onToolEnd(f);
				return;
			case "message_end":
				this.#onMessageEnd(f);
				return;
			case "subagent_lifecycle":
			case "subagent_progress":
				this.#onSubagent(f);
				return;
			case "prompt_result":
				if (this.#promptId === null) return;
				this.#end(
					f.status === "completed" ? "completed" : f.status === "aborted" ? "aborted" : "failed",
					f.status === "completed" || f.status === "aborted"
						? null
						: `prompt ended with status ${str(f.status) || "unknown"}`,
				);
				return;
			case "rpc_frame_error":
				this.#opts.emit({ kind: "warning", text: `omp dropped a frame: ${str(f.error)}` });
				return;
			default:
				return; // display-only or informational frames
		}
	}

	#onResponse(f: Frame): void {
		const command = str(f.command);
		if (command === "negotiate_protocol") {
			if (f.success === true) this.#sendSetupAndPrompt();
			else this.#end("failed", `omp does not speak RPC protocol v2 (${str(f.error)}); update omp`);
			return;
		}
		if (command === "get_state" && f.success === true && isRecord(f.data)) {
			this.sessionId = str(f.data.sessionId) || null;
			const model = isRecord(f.data.model) ? f.data.model : null;
			this.#opts.emit({
				kind: "started",
				sessionId: this.sessionId,
				model: model ? `${str(model.provider)}/${str(model.id)}` : null,
			});
			return;
		}
		if (command === "prompt") {
			if (f.success === true) this.phase = "running";
			else this.#end("failed", `prompt rejected: ${str(f.error)}`);
			return;
		}
		if (f.success === false) {
			this.#opts.emit({ kind: "warning", text: `${command}: ${str(f.error)}` });
		}
	}

	#sendSetupAndPrompt(): void {
		this.phase = "prompting";
		const extra = (this.#opts.extraTools ?? []).map((t) => ({ ...t, loadMode: "essential" }));
		this.#command("set_host_tools", { tools: [...HOST_TOOLS, ...extra] });
		this.#command("set_subagent_subscription", { level: "progress" });
		this.#command("get_state");
		this.#promptId = this.#command("prompt", { message: this.#opts.prompt });
	}

	#onHostToolCall(f: Frame): void {
		const id = str(f.id);
		const name = str(f.toolName);
		const args = isRecord(f.arguments) ? f.arguments : {};
		if (name === NOTIFY_TOOL) {
			this.#opts.send(textResult(id, "Noted."));
			this.#opts.emit({
				kind: "progress",
				text: str(args.message),
				checkpoint: args.checkpoint === true,
			});
		} else if (name === ASK_TOOL) {
			this.#opts.emit({
				kind: "question",
				ref: id,
				question: str(args.question),
				options: Array.isArray(args.options) ? args.options.map(String) : [],
				context: str(args.context) || null,
			});
		} else if (this.#extraNames.has(name)) {
			this.#opts.emit({ kind: "tool_call", ref: id, name, args });
		} else {
			this.#opts.send(textResult(id, `unknown host tool ${name}`, true));
		}
	}

	#onUiRequest(f: Frame): void {
		const id = str(f.id);
		const method = str(f.method);
		if (!["select", "confirm", "input", "editor"].includes(method)) return; // display only
		const title = str(f.title);
		const match = /^Allow tool: (\S+)/.exec(title);
		const options = Array.isArray(f.options) ? f.options.map(String) : [];
		if (method === "select" && match) {
			const tool = match[1] as string;
			if (HOST_TOOL_NAMES.has(tool) || this.#extraNames.has(tool)) {
				// Talking to the orchestrator is always allowed.
				const value = options.find((o) => /session/i.test(o)) ?? options[0] ?? "Approve";
				this.#opts.send({ type: "extension_ui_response", id, value });
				return;
			}
			this.#approvals.set(id, { options });
			const newline = title.indexOf("\n");
			const detail = newline >= 0 ? title.slice(newline + 1).trim() : tool;
			this.#opts.emit({ kind: "approval", ref: id, tool, detail: detail || tool, options });
			return;
		}
		// Any other interactive prompt: nobody is there to answer it.
		this.#opts.send({ type: "extension_ui_response", id, cancelled: true });
	}

	#onToolStart(f: Frame): void {
		const args = isRecord(f.args) ? f.args : {};
		const detail = DETAIL_KEYS.map((k) => str(args[k])).find(Boolean) ?? str(f.intent);
		this.#opts.emit({ kind: "tool_start", id: str(f.toolCallId), name: str(f.toolName), detail });
	}

	#onToolEnd(f: Frame): void {
		const result = isRecord(f.result) ? f.result : {};
		this.#opts.emit({
			kind: "tool_end",
			id: str(f.toolCallId),
			name: str(f.toolName),
			isError: f.isError === true,
			text: textOf(result.content) || JSON.stringify(f.result ?? null),
		});
	}

	#onMessageEnd(f: Frame): void {
		const msg = isRecord(f.message) ? f.message : null;
		if (msg?.role !== "assistant") return;
		const usage = isRecord(msg.usage) ? msg.usage : {};
		const cost = isRecord(usage.cost) ? usage.cost : {};
		const provider = str(msg.provider);
		const model = str(msg.model);
		this.#opts.emit({
			kind: "assistant",
			text: textOf(msg.content),
			stopReason: str(msg.stopReason) || null,
			error: str(msg.errorMessage) || null,
			model: provider || model ? `${provider}/${model}` : null,
			costUsd: num(cost.total),
			tokens: num(usage.totalTokens),
		});
	}

	#onSubagent(f: Frame): void {
		const p = isRecord(f.payload) ? f.payload : {};
		const progress = isRecord(p.progress) ? p.progress : {};
		this.#opts.emit({
			kind: "subagent",
			id: str(p.id),
			status: str(p.status) || str(progress.status),
			description: str(p.description) || str(progress.description),
			costUsd: typeof progress.cost === "number" ? progress.cost : null,
		});
	}

	// ---------------------------------------------------------------- host → omp

	steer(text: string): void {
		this.#command("steer", { message: text });
	}

	abort(): void {
		this.#command("abort");
	}

	answer(ref: string, text: string, isError = false): void {
		this.#opts.send(textResult(ref, text, isError));
	}

	decide(ref: string, decision: ApprovalDecision): void {
		const options = this.#approvals.get(ref)?.options ?? [];
		this.#approvals.delete(ref);
		const lower = (o: string) => o.toLowerCase();
		const value =
			decision === "deny"
				? (options.find((o) => lower(o).startsWith("deny")) ?? "Deny")
				: decision === "session"
					? (options.find((o) => lower(o).includes("session")) ?? "Approve")
					: (options.find((o) => lower(o) === "approve") ?? options[0] ?? "Approve");
		this.#opts.send({ type: "extension_ui_response", id: ref, value });
	}

	/** The process is gone. Reports a failure unless the session already ended. */
	onExit(exitCode: number | null, stderrTail: string): void {
		if (this.phase === "ended") return;
		this.phase = "ended";
		const error = stderrTail || `omp exited unexpectedly (code ${exitCode ?? "?"})`;
		this.#opts.emit({ kind: "end", outcome: "failed", error, exitCode });
	}
}
