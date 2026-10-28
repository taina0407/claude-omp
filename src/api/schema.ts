/** Request bodies of the daemon's HTTP API (validated) and the shapes it returns. */
import { z } from "zod";
import type { CommandResult, FeedEntry, Job, Notice, Pending } from "../core/types";
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
});
export type ControlBody = z.infer<typeof controlBody>;

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
}

export interface WaitResponse {
	/** done: every job ended · attention: one needs the orchestrator · timeout: neither yet. */
	reason: "done" | "attention" | "timeout";
	jobs: WaitView[];
}

/** A job in a `wait` answer, with the notices this answer delivered (they are not sent again). */
export interface WaitView extends JobView {
	delivered: Notice[];
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
