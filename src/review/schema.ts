/**
 * The structured result of a review job. The worker must hand it over by calling the
 * `submit_review` host tool; the runner validates the call against `reviewSchema` and sends the
 * problems back so the worker can fix them.
 */
import { z } from "zod";
import type { HostTool } from "../backends/types";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const VERDICTS = ["approve", "approve_with_comments", "request_changes"] as const;
export const REVIEW_MODES = ["standard", "adversarial"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const findingSchema = z.object({
	severity: z.enum(SEVERITIES),
	file: z.string().min(1),
	line: z.number().int().positive().optional(),
	title: z.string().min(1).max(200),
	detail: z.string().min(1),
	suggestion: z.string().optional(),
	confidence: z.number().min(0).max(1),
});

export const reviewSchema = z.object({
	verdict: z.enum(VERDICTS),
	summary: z.string().min(1),
	findings: z.array(findingSchema),
});

export type Finding = z.infer<typeof findingSchema>;
export type Review = z.infer<typeof reviewSchema>;

/** What a review job reviews, kept on the job. */
export interface ReviewSpec {
	mode: ReviewMode;
	/** Human description of the change, e.g. "uncommitted changes" or "commit 1a2b3c4". */
	target: string;
	focus: string | null;
}

export const SUBMIT_REVIEW = "submit_review";

/** Invalid submissions sent back to the worker before the job gives up. */
export const MAX_REVIEW_RETRIES = 2;

export const SUBMIT_REVIEW_TOOL: HostTool = {
	name: SUBMIT_REVIEW,
	label: "Submit review",
	description:
		"Hand in your review. Call it exactly once, after you have finished reviewing. If the " +
		"call is rejected, fix the fields it names and call it again.",
	parameters: {
		type: "object",
		properties: {
			verdict: {
				type: "string",
				enum: [...VERDICTS],
				description:
					"approve: nothing to fix · approve_with_comments: only minor points · " +
					"request_changes: at least one finding should be fixed before merging.",
			},
			summary: { type: "string", description: "Two to four sentences on the change overall." },
			findings: {
				type: "array",
				description: "Real problems only, most severe first. Empty when there are none.",
				items: {
					type: "object",
					properties: {
						severity: { type: "string", enum: [...SEVERITIES] },
						file: { type: "string", description: "Path relative to the repository root." },
						line: { type: "integer", minimum: 1, description: "1-based line in the new file." },
						title: { type: "string", description: "One line naming the defect." },
						detail: {
							type: "string",
							description: "What goes wrong, with the concrete input or state that triggers it.",
						},
						suggestion: { type: "string", description: "How to fix it, briefly." },
						confidence: {
							type: "number",
							minimum: 0,
							maximum: 1,
							description: "How sure you are that this is a real defect.",
						},
					},
					required: ["severity", "file", "title", "detail", "confidence"],
				},
			},
		},
		required: ["verdict", "summary", "findings"],
	},
};

/** zod issues as short lines the worker can act on ("findings.0.severity: …"). */
export function reviewIssues(error: z.ZodError): string {
	return error.issues
		.map((i) => `- ${i.path.length ? i.path.join(".") : "(payload)"}: ${i.message}`)
		.join("\n");
}
