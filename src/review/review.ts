/**
 * `omp-task review`: turns a diff into a read-only job whose worker must hand in a structured
 * review. The diff is always saved as review.diff in the job directory; small diffs are also
 * pasted into the prompt.
 */
import { createJob, type JobOptions } from "../core/jobs";
import type { Store } from "../core/store";
import type { Job } from "../core/types";
import ADVERSARIAL from "./prompts/adversarial.md" with { type: "text" };
import STANDARD from "./prompts/standard.md" with { type: "text" };
import type { ReviewMode } from "./schema";
import { collectDiff, type ReviewTarget } from "./target";

/** Diffs up to this size go into the prompt; larger ones are only referenced. */
export const REVIEW_INLINE_BYTES = 150_000;

const TEMPLATES: Record<ReviewMode, string> = { standard: STANDARD, adversarial: ADVERSARIAL };

/** A code fence longer than any backtick run in `text`. */
function fenceFor(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	return "`".repeat(longest + 1);
}

export function reviewPrompt(
	mode: ReviewMode,
	target: { label: string; diff: string; files: string[] },
	focus: string | null,
): string {
	const template = TEMPLATES[mode];
	const size = Buffer.byteLength(target.diff);
	let diff: string;
	if (size <= REVIEW_INLINE_BYTES) {
		const fence = fenceFor(target.diff);
		diff = [
			`The diff (${target.files.length} file(s)) follows; it is also saved at {{job_dir}}/review.diff.`,
			"",
			`${fence}diff`,
			target.diff.trimEnd(),
			fence,
		].join("\n");
	} else {
		diff = [
			`The diff is too large to paste here (${Math.round(size / 1024)} KB). Read it from`,
			"{{job_dir}}/review.diff in parts. Changed files:",
			...target.files.map((f) => `- ${f}`),
		].join("\n");
	}
	return template
		.replace("{{target}}", target.label)
		.replace("{{focus}}", focus ? `\nFocus especially on: ${focus}\n` : "")
		.replace("{{diff}}", diff);
}

export interface ReviewRequest {
	target: ReviewTarget;
	mode: ReviewMode;
	focus: string | null;
	/** Model, preset, timeout, group, budget… as for `run`; access and isolation are fixed. */
	options: Omit<JobOptions, "prompt">;
}

export function createReviewJob(store: Store, req: ReviewRequest): Job {
	const collected = collectDiff(req.target, req.options.cwd ?? req.options.clientCwd);
	const short = collected.label.replace(/ \(.*$/, "");
	return createJob(store, {
		...req.options,
		prompt: reviewPrompt(req.mode, collected, req.focus),
		cwd: collected.cwd,
		access: "read",
		isolate: "none",
		title:
			req.options.title ??
			`${req.mode === "adversarial" ? "adversarial " : ""}review: ${short}`.slice(0, 80),
		review: { mode: req.mode, target: short, focus: req.focus },
		attachments: { "review.diff": collected.diff },
	});
}
