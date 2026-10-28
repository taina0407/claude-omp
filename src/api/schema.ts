/** Request bodies of the daemon's HTTP API (validated) and the shapes it returns. */
import { z } from "zod";
import type { CommandResult, FeedEntry, Job, Pending } from "../core/types";

const optionalString = z.string().optional();

export const createJobBody = z.object({
	parent: z.string().nullable().optional(),
	options: z.object({
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
	}),
});
export type CreateJobBody = z.infer<typeof createJobBody>;

export const applyBody = z.object({
	threeWay: z.boolean().optional(),
	keep: z.boolean().optional(),
});
export type ApplyBody = z.infer<typeof applyBody>;

export const pruneBody = z.object({
	olderS: z.number().optional(),
	dryRun: z.boolean().optional(),
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
	jobs: JobView[];
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
