/** Job model shared by the store, the runner and the CLI. */
import type { ReviewSpec } from "../review/schema";

/** `blocked`: waiting for the jobs in `after` · `queued`: waiting for a free slot. */
export const ACTIVE_STATUSES = ["blocked", "queued", "starting", "running", "waiting"] as const;
/** `skipped`: a dependency did not complete · `over_budget`: a spending limit was reached. */
export const TERMINAL_STATUSES = [
	"completed",
	"failed",
	"cancelled",
	"timeout",
	"skipped",
	"over_budget",
] as const;

/** The daemon stopped while the job ran; `omp-task resume` continues its omp session. */
export const INTERRUPTED = "interrupted" as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type JobStatus = ActiveStatus | TerminalStatus | typeof INTERRUPTED;

export const ALL_STATUSES: readonly JobStatus[] = [
	...ACTIVE_STATUSES,
	INTERRUPTED,
	...TERMINAL_STATUSES,
];

export const ACCESS_LEVELS = ["read", "edit", "full"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

export const ISOLATE_MODES = ["auto", "worktree", "none"] as const;
/** How the user asked for isolation; `auto` is resolved when the job is created. */
export type IsolateMode = (typeof ISOLATE_MODES)[number];
/** Where a job runs: in the user's checkout, or in a git worktree of it. */
export type Isolation = "none" | "worktree";

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
	/** Omitted means `none`; the store fills the column in. */
	isolate?: Isolation;
	carryDirty?: boolean;
	/** Jobs that must end first; omitted means none. */
	after?: string[];
	/** Start after the dependencies end whatever their outcome (default: only if all completed). */
	afterAny?: boolean;
	groupName?: string | null;
	budgetUsd?: number | null;
	/** Approval globs the daemon decides by itself (see core/policy.ts). */
	allow?: string[];
	deny?: string[];
	/** No worker activity for this long raises a `stalled` notice; null disables it. */
	stallTimeoutS?: number | null;
	/** Set for review jobs (`omp-task review`): they must hand in a review with submit_review. */
	review?: ReviewSpec | null;
	/** The Claude Code session that started the job, when the plugin's hooks are active. */
	claudeSession?: string | null;
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
	/**
	 * Changed files the worker's edit/write tools never touched: its shell commands made them, or
	 * another process (the user, another session) did. null when changes cannot be detected.
	 */
	otherChanges: string[] | null;
	exitCode: number | null;
	isolate: Isolation;
	carryDirty: boolean;
	/** The job's worktree, once the runner created it; null when it runs in the user's checkout. */
	worktreePath: string | null;
	/** The commit the worktree started from; the diff base. */
	baseRef: string | null;
	branch: string | null;
	repoRoot: string | null;
	after: string[];
	afterAny: boolean;
	groupName: string | null;
	budgetUsd: number | null;
	allow: string[];
	deny: string[];
	stallTimeoutS: number | null;
	/** Things the orchestrator should see that are not questions or approvals; `wait` consumes them. */
	notices: Notice[];
	review: ReviewSpec | null;
	claudeSession: string | null;
}

export type NoticeKind = "checkpoint" | "stalled";

export interface Notice {
	kind: NoticeKind;
	text: string;
	at: string;
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

/** What a bash call sets besides its command; omp's approval prompt shows the command only. */
export interface ShellCall {
	/** The working directory the call asked for, as given; null for the worker's own. */
	cwd: string | null;
	/** Whether it sets environment variables. */
	env: boolean;
}

export type ControlKind = "steer" | "abort" | "reply" | "approve";
export type ApprovalDecision = "approve" | "session" | "deny";

/** Who settled a question or approval: the orchestrator, the user (through the UI), an allow/deny
 * rule, the answer/approval timeout, or the job's end (cancel, timeout, budget). */
export type ResolvedBy = "claude" | "user" | "rule" | "expired" | "aborted";
export type AnsweredBy = "claude" | "user";

/** A question or approval that is no longer pending, and how it was settled. */
export interface ResolvedItem {
	jobId: string;
	ref: string;
	kind: PendingKind;
	by: ResolvedBy;
	/** Approvals: approve | session | deny; null for questions. */
	decision: ApprovalDecision | null;
	/** Approvals: the allow rule added with it (or the rule that decided it, for `rule`). */
	rule: string | null;
	/** Questions: the start of the answer sent. */
	answerPreview: string | null;
	resolvedAt: string;
}

export interface ControlRequest {
	kind: ControlKind;
	/** reply/approve: who answers (default claude); `user` needs the UI's token (checked by the daemon). */
	by?: AnsweredBy | undefined;
	message?: string | undefined;
	ref?: string | null | undefined;
	decision?: ApprovalDecision | undefined;
	/** approve: also add this allow rule to the job; it must approve the request. */
	rule?: string | undefined;
	/** approve: also add a rule matching exactly this request's command. */
	same?: boolean | undefined;
	/**
	 * reply/approve by the user: Claude already learns the outcome another way (the UI's ask_user
	 * result), so the next `wait` does not report it as RESOLVED.
	 */
	quiet?: boolean | undefined;
}

/** Why a control request was refused, for callers that act on it (the CLI exits 2 on these). */
export type ControlErrorCode = "already_resolved" | "ref_required" | "ui_token_required";

export interface CommandResult {
	ok: boolean;
	error?: string;
	ref?: string;
	code?: ControlErrorCode;
	/** With code already_resolved: how the item was settled. */
	resolved?: ResolvedItem;
}
