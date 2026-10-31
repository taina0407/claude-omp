/** Request bodies of the daemon's HTTP API (validated) and the shapes it returns. */
import { z } from "zod";
import { DECIDERS, type Decider, type UiSettings } from "../core/config";
import type {
	CommandResult,
	FeedEntry,
	Job,
	JobStatus,
	Notice,
	Pending,
	ResolvedBy,
	ResolvedItem,
} from "../core/types";
import { REVIEW_MODES } from "../review/schema";

const optionalString = z.string().optional();

export const jobOptions = z.object({
	prompt: z.string().min(1),
	clientCwd: z.string().startsWith("/"),
	model: optionalString,
	preset: optionalString,
	access: optionalString,
	thinking: optionalString,
	timeout: optionalString,
	answerTimeout: optionalString,
	approvalTimeout: optionalString,
	cwd: optionalString,
	addDirs: z.array(z.string()).optional(),
	files: z.array(z.string()).optional(),
	title: optionalString,
	ompArgs: optionalString,
	noPreamble: z.boolean().optional(),
	isolate: optionalString,
	carryDirty: z.boolean().optional(),
	after: z.array(z.string()).optional(),
	afterAny: z.boolean().optional(),
	group: optionalString,
	budget: z.union([z.string(), z.number()]).optional(),
	allow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	stallTimeout: optionalString,
	claudeSession: optionalString,
});

export const sessionEndBody = z.object({ cancel: z.boolean() });

export interface SessionEndResponse {
	/** Active jobs of the session that were cancelled. */
	cancelled: string[];
}

export const createJobBody = z.object({
	parent: z.string().nullable().optional(),
	options: jobOptions,
});
export type CreateJobBody = z.infer<typeof createJobBody>;

export const reviewBody = z.object({
	target: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("uncommitted") }),
		z.object({ kind: z.literal("staged") }),
		z.object({ kind: z.literal("base"), ref: z.string().min(1) }),
		z.object({ kind: z.literal("commit"), ref: z.string().min(1) }),
		z.object({ kind: z.literal("job"), ref: z.string().min(1) }),
	]),
	mode: z.enum(REVIEW_MODES),
	focus: z.string().nullable().optional(),
	options: jobOptions.omit({ prompt: true }),
});
export type ReviewBody = z.infer<typeof reviewBody>;

/** A whole DAG at once (`omp-task plan apply`); `after` names other tasks or existing jobs. */
export const planBody = z.object({
	group: z.string().min(1),
	maxConcurrent: z.number().int().positive().optional(),
	budgetUsd: z.number().positive().optional(),
	tasks: z
		.array(
			z.object({
				name: z.string().regex(/^[\w.-]+$/, "task names use letters, digits, '.', '-', '_'"),
				after: z.array(z.string()).default([]),
				options: jobOptions,
			}),
		)
		.min(1),
});
export type PlanBody = z.infer<typeof planBody>;

export interface PlanResponse {
	group: string;
	jobs: { name: string; id: string; status: string }[];
}

export interface GroupSummary {
	group: string;
	maxConcurrent: number | null;
	budgetUsd: number | null;
	spentUsd: number;
	jobs: Job[];
}

export const applyBody = z.object({
	threeWay: z.boolean().optional(),
	keep: z.boolean().optional(),
});
export type ApplyBody = z.infer<typeof applyBody>;

export const pruneBody = z.object({
	olderS: z.number().optional(),
	dryRun: z.boolean().optional(),
	/** Delete finished jobs and their files instead of worktrees. */
	jobs: z.boolean().optional(),
});
export type PruneBody = z.infer<typeof pruneBody>;

export const controlBody = z.object({
	kind: z.enum(["steer", "abort", "reply", "approve"]),
	message: optionalString,
	ref: z.string().nullable().optional(),
	decision: z.enum(["approve", "session", "deny"]).optional(),
	rule: optionalString,
	same: z.boolean().optional(),
	/** reply/approve: who answers; `user` is accepted only with the UI's token for the job's session. */
	by: z.enum(["claude", "user"]).optional(),
	quiet: z.boolean().optional(),
	token: optionalString,
});
export type ControlBody = z.infer<typeof controlBody>;

/** PUT /v1/sessions/<id>/ui: the session's own decider (null: back to the config's). */
export const uiModeBody = z.object({
	decider: z.enum(DECIDERS).nullable(),
	token: z.string(),
});

export const shutdownBody = z.object({ force: z.boolean().optional() });

export interface Health {
	ok: true;
	version: string;
	pid: number;
	startedAt: string;
	activeJobs: number;
}

export interface JobView {
	job: Job;
	pending: Pending[];
	/** Queued jobs: what holds the job back (a limit, another job in the same checkout). */
	queueReason?: string | null;
	/** Things the creator should know (e.g. a group shared with another Claude session). */
	warnings?: string[];
	/** Shell commands approved as read-only (builtin:read-only) without asking. */
	shellReads?: number;
}

export interface WaitResponse {
	/** done: every job ended · attention: one needs the orchestrator · timeout: neither yet. */
	reason: "done" | "attention" | "timeout";
	jobs: WaitView[];
}

/** A job in a `wait` answer, with the notices this answer delivered (they are not sent again). */
export interface WaitView extends JobView {
	delivered: Notice[];
	/**
	 * Questions and approvals an earlier `wait` reported (PENDING:) that someone other than the
	 * orchestrator settled since: the user, a rule, or the timeout. Each is reported once.
	 */
	resolved: ResolvedItem[];
}

export type ControlResponse = CommandResult;

export interface DiffResponse {
	patch: string;
	files: string[];
}

export interface ApplyResponse {
	ok: boolean;
	files: string[];
	error?: string;
	/** With --3way: files left with conflict markers in the main checkout. */
	conflicts?: string[];
}

export interface PruneResponse {
	/** The jobs whose worktrees were (or, with dryRun, would be) removed. */
	removed: string[];
}

/** One server-sent event on GET /v1/feed. */
export type FeedEvent =
	| { type: "feed"; entry: FeedEntry }
	| { type: "end"; jobs: { id: string; status: string }[] };

/** What the Claude Code UI (the plugin's mod) shows of one job. */
export interface UiJob {
	id: string;
	title: string | null;
	status: JobStatus;
	model: string | null;
	access: string;
	group: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	durationS: number | null;
	costUsd: number;
	budgetUsd: number | null;
	queueReason: string | null;
	worktreePath: string | null;
	/** The job's latest feed line (text cut to 200 characters). */
	lastActivity: { ts: string; kind: string; text: string } | null;
	pending: UiPending[];
	changedFiles: number | null;
	/** The directory the worker runs in (its worktree for an isolated job). */
	cwd: string;
}

/** A question or approval as the UI shows it. */
export interface UiPending extends Pending {
	/** An approval whose command omp shortened: no `--same` or `--rule` can vouch for it. */
	shortened: boolean;
	/** What an allow rule is matched against: the command without omp's `Command:` label. */
	subject: string;
}

/** GET /v1/ui and each `snapshot` event of GET /v1/ui/stream. */
export interface UiSnapshot {
	daemon: "up";
	version: string;
	generatedAt: string;
	/** Who decides the session's questions and approvals now: the session's choice, else the config's. */
	decider: Decider;
	/** Whether `decider` is the session's own choice (`ui-mode`) rather than the config's. */
	deciderSource: "session" | "config";
	/** The config's `ui` block, defaults filled in. */
	ui: UiSettings;
	/** The session's jobs that are active or interrupted, or ended within `recent`. */
	jobs: UiJob[];
}

/** One server-sent event on GET /v1/ui/stream: the UI token first, then snapshots, then end. */
export type UiStreamEvent =
	| { type: "token"; token: string }
	| { type: "snapshot"; snapshot: UiSnapshot }
	| { type: "end" };

/** GET /v1/jobs/<id>/pending/<ref>: whether a question or approval is still open. */
export type PendingState =
	| { state: "open" }
	| {
			state: "resolved";
			by: ResolvedBy;
			decision: string | null;
			rule: string | null;
			answerPreview: string | null;
			at: string;
	  }
	| { state: "gone" };
