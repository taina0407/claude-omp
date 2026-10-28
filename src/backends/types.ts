/**
 * The contract between the job runner and a worker backend. v1 ships one backend (omp over its
 * RPC mode); an ACP backend can implement the same interface later.
 */
import type { Access, ApprovalDecision } from "../core/types";

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
	stderrPath: string;
}

export type EndOutcome = "completed" | "aborted" | "failed";

export type BackendEvent =
	| { kind: "spawned"; pid: number; argv: string[] }
	| { kind: "started"; sessionId: string | null; model: string | null }
	| { kind: "progress"; text: string }
	| { kind: "tool_start"; id: string; name: string; detail: string }
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
	| { kind: "approval"; ref: string; tool: string; detail: string; options: string[] }
	| { kind: "warning"; text: string }
	| { kind: "end"; outcome: EndOutcome; error: string | null; exitCode: number | null };

export interface BackendSession {
	steer(text: string): void;
	abort(): void;
	answer(ref: string, text: string): void;
	decide(ref: string, decision: ApprovalDecision): void;
	/** Ends the worker process; resolves once it has exited. */
	close(): Promise<void>;
}

export interface Backend {
	readonly id: string;
	/** Starts a session. Startup failures arrive as an `end` event, never as a throw. */
	start(spec: SessionSpec, onEvent: (e: BackendEvent) => void): BackendSession;
}
