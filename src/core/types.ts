/** Job model shared by the store, the runner and the CLI. */

export const ACTIVE_STATUSES = ["queued", "starting", "running", "waiting"] as const;
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "timeout"] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type JobStatus = ActiveStatus | TerminalStatus;

export const ACCESS_LEVELS = ["read", "edit", "full"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export function isTerminal(status: string): status is TerminalStatus {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isActive(status: string): status is ActiveStatus {
	return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Everything needed to start a job; fixed once the job is created. */
export interface JobSpec {
	title: string;
	cwd: string;
	access: Access;
	model: string | null;
	thinking: string | null;
	timeoutS: number | null;
	answerTimeoutS: number | null;
	approvalTimeoutS: number | null;
	addDirs: string[];
	files: string[];
	extraArgs: string[];
	noPreamble: boolean;
	parentId: string | null;
	resumeSession: string | null;
}

export interface Job extends JobSpec {
	id: string;
	status: JobStatus;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	durationS: number | null;
	runnerPid: number | null;
	ompPid: number | null;
	sessionId: string | null;
	modelResolved: string | null;
	modelUsed: string | null;
	stopReason: string | null;
	costUsd: number;
	tokens: number;
	tools: Record<string, number>;
	toolErrors: Record<string, number>;
	deniedTools: string[];
	errors: string[];
	/** null when the cwd is not a git repo, so changes cannot be detected. */
	changedFiles: string[] | null;
	exitCode: number | null;
}

export type PendingKind = "question" | "approval";

export interface Pending {
	jobId: string;
	/** The backend's request id; the CLI's `--ref`. */
	ref: string;
	kind: PendingKind;
	text: string;
	tool: string | null;
	options: string[];
	context: string | null;
	askedAt: string;
}

export interface FeedEntry {
	jobId: string;
	seq: number;
	ts: string;
	kind: string;
	text: string;
	data: Record<string, unknown>;
}

export type CommandKind = "steer" | "abort" | "reply" | "approve";
export type ApprovalDecision = "approve" | "session" | "deny";

export interface CommandResult {
	ok: boolean;
	error?: string;
	ref?: string;
}
