/**
 * The contract between the job runner and a worker backend. v1 ships one backend (omp over its
 * RPC mode); an ACP backend can implement the same interface later.
 */
import type { Access, ApprovalDecision, ShellCall } from "../core/types";

/** A tool the host offers the worker on top of the built-in ones (JSON-schema parameters). */
export interface HostTool {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** See `event_log` in the config. */
export type EventLogMode = "compact" | "full" | "off";

export interface SessionSpec {
	cwd: string;
	access: Access;
	model: string | null;
	thinking: string | null;
	/** Resume this backend session instead of starting a new one. */
	resumeSession: string | null;
	/** File appended to the system prompt of a new session (the worker preamble). */
	systemPromptFile: string | null;
	addDirs: string[];
	extraArgs: string[];
	prompt: string;
	/** Where the backend writes the raw protocol frames and the worker's stderr. */
	rawLogPath: string;
	/** How much of the protocol goes to `rawLogPath` (default compact). */
	eventLog?: EventLogMode;
	stderrPath: string;
	/** Extra host tools for this session; their calls arrive as `tool_call` events. */
	hostTools?: HostTool[];
	/** The worker's environment (default: the daemon's). */
	env?: Record<string, string>;
}

export type EndOutcome = "completed" | "aborted" | "failed";

export type BackendEvent =
	| { kind: "spawned"; pid: number; argv: string[] }
	| { kind: "started"; sessionId: string | null; model: string | null }
	/** A note from the worker; `checkpoint` asks for the orchestrator's attention. */
	| { kind: "progress"; text: string; checkpoint?: boolean }
	/** `paths`: the files an edit/write call changes, as the worker named them. */
	| { kind: "tool_start"; id: string; name: string; detail: string; paths?: string[] }
	| { kind: "tool_end"; id: string; name: string; isError: boolean; text: string }
	| {
			kind: "assistant";
			text: string;
			stopReason: string | null;
			error: string | null;
			model: string | null;
			costUsd: number;
			tokens: number;
	  }
	| { kind: "subagent"; id: string; status: string; description: string; costUsd: number | null }
	| { kind: "question"; ref: string; question: string; options: string[]; context: string | null }
	| { kind: "question_withdrawn"; ref: string }
	/** A call of one of the session's extra host tools; answer it with `answer(ref, …)`. */
	| { kind: "tool_call"; ref: string; name: string; args: Record<string, unknown> }
	| {
			kind: "approval";
			ref: string;
			tool: string;
			detail: string;
			options: string[];
			/** The bash call this approval is for, when its full command matched one that started. */
			shell?: ShellCall;
	  }
	| { kind: "warning"; text: string }
	| { kind: "end"; outcome: EndOutcome; error: string | null; exitCode: number | null };

export interface BackendSession {
	steer(text: string): void;
	abort(): void;
	/** Replies to a question or an extra host tool call; `isError` marks the call as failed. */
	answer(ref: string, text: string, isError?: boolean): void;
	decide(ref: string, decision: ApprovalDecision): void;
	/** Ends the worker process; resolves once it has exited. */
	close(): Promise<void>;
}

export interface Backend {
	readonly id: string;
	/** Starts a session. Startup failures arrive as an `end` event, never as a throw. */
	start(spec: SessionSpec, onEvent: (e: BackendEvent) => void): BackendSession;
}
